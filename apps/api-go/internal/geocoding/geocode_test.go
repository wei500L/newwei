package geocoding

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testClient(t *testing.T, serverURL string, cache Cache) *Client {
	t.Helper()
	client := NewClient(cache, nil, nil, Config{
		BaseURL:        serverURL,
		UserAgent:      "test-agent",
		AcceptLanguage: "en",
		Timeout:        2 * time.Second,
	})
	client.now = func() time.Time { return time.UnixMilli(1_700_000_000_000) }
	return client
}

func TestCacheKeyMatchesNestLayout(t *testing.T) {
	sum := sha256.Sum256([]byte("Berlin"))
	want := "geo:geocode:v1:de:" + hex.EncodeToString(sum[:])
	if got := CacheKey("Berlin", "DE"); got != want {
		t.Fatalf("key = %q, want %q", got, want)
	}
	if got := CacheKey("Berlin", ""); !strings.Contains(got, ":any:") {
		t.Fatalf("country-less key = %q", got)
	}
}

func TestNormalizeQueryCollapsesAndTruncates(t *testing.T) {
	if got := NormalizeQuery("  New\t York\n USA  "); got != "New York USA" {
		t.Fatalf("normalized = %q", got)
	}
	long := strings.Repeat("a", 250)
	if got := NormalizeQuery(long); len([]rune(got)) != 200 {
		t.Fatalf("truncated length = %d", len([]rune(got)))
	}
}

func TestGeocodePositiveCacheAndBounds(t *testing.T) {
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Query().Get("q") != "Berlin" {
			t.Errorf("q = %q", r.URL.Query().Get("q"))
		}
		if r.Header.Get("User-Agent") != "test-agent" {
			t.Errorf("user agent = %q", r.Header.Get("User-Agent"))
		}
		_, _ = w.Write([]byte(`[{"lat":"52.5","lon":"13.4","display_name":"Berlin","boundingbox":["52.3","52.7","13.0","13.8"],"address":{"country_code":"de"}}]`))
	}))
	defer server.Close()

	cache := NewMemoryCache()
	client := testClient(t, server.URL, cache)
	hit, err := client.Geocode(context.Background(), "Berlin", "")
	if err != nil {
		t.Fatal(err)
	}
	if hit == nil || hit.Lat != 52.5 || hit.CountryCodeAlpha2 != "DE" || hit.Provider != "nominatim" {
		t.Fatalf("hit = %+v", hit)
	}
	if hit.Bounds == nil || hit.Bounds.MaxLat != 52.7 || hit.Bounds.MinLng != 13.0 {
		t.Fatalf("bounds = %+v", hit.Bounds)
	}
	again, err := client.Geocode(context.Background(), "Berlin", "")
	if err != nil {
		t.Fatal(err)
	}
	if again == nil || again.Lat != 52.5 {
		t.Fatalf("cached hit = %+v", again)
	}
	if hits.Load() != 1 {
		t.Fatalf("nominatim hits = %d, want 1", hits.Load())
	}
}

func TestGeocodeNegativeCacheOnlyForEmptyTwoHundred(t *testing.T) {
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	cache := NewMemoryCache()
	client := testClient(t, server.URL, cache)
	for index := 0; index < 2; index++ {
		hit, err := client.Geocode(context.Background(), "Nowhere", "")
		if err != nil || hit != nil {
			t.Fatalf("call %d: hit=%+v err=%v", index, hit, err)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("nominatim hits = %d, want 1 (negative cache)", hits.Load())
	}
}

func TestGeocodeTransientFailureIsNotCached(t *testing.T) {
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`[{"lat":1,"lon":2,"display_name":"Place","address":{"country_code":"fr"}}]`))
	}))
	defer server.Close()

	client := testClient(t, server.URL, NewMemoryCache())
	if hit, err := client.Geocode(context.Background(), "Place", ""); err != nil || hit != nil {
		t.Fatalf("first call hit=%+v err=%v", hit, err)
	}
	hit, err := client.Geocode(context.Background(), "Place", "")
	if err != nil || hit == nil {
		t.Fatalf("second call hit=%+v err=%v (transient failure must not be cached)", hit, err)
	}
	if hits.Load() != 2 {
		t.Fatalf("nominatim hits = %d, want 2", hits.Load())
	}
}

func TestCountryNameQueryUsesCanonicalNameAndCountryCode(t *testing.T) {
	var query, country string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.Query().Get("q")
		country = r.URL.Query().Get("countrycodes")
		_, _ = w.Write([]byte(`[{"lat":1,"lon":2,"display_name":"Washington"}]`))
	}))
	defer server.Close()

	client := testClient(t, server.URL, NewMemoryCache())
	hit, err := client.Geocode(context.Background(), "USA", "")
	if err != nil || hit == nil {
		t.Fatalf("hit=%+v err=%v", hit, err)
	}
	if query != "United States" {
		t.Fatalf("effective q = %q", query)
	}
	if country != "us" {
		t.Fatalf("countrycodes = %q", country)
	}
}

func TestProbeSkipsCacheReadAndDoesNotWriteNegative(t *testing.T) {
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if hits.Load() == 1 {
			_, _ = w.Write([]byte(`[{"lat":9,"lon":9,"display_name":"Fresh"}]`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	cache := NewMemoryCache()
	client := testClient(t, server.URL, cache)
	key := CacheKey("Paris", "")
	if err := cache.Set(context.Background(), key, []byte(`{"ok":true,"cachedAt":1,"result":{"lat":1,"lng":1,"provider":"nominatim","query":"Paris"}}`), time.Hour); err != nil {
		t.Fatal(err)
	}
	hit, err := client.Probe(context.Background(), "Paris", "")
	if err != nil || hit == nil || hit.Lat != 9 {
		t.Fatalf("probe hit=%+v err=%v (must bypass the cached entry)", hit, err)
	}
	// A temporary failure after a successful probe must not overwrite the
	// positive entry with a negative one.
	raw, ok, err := cache.Get(context.Background(), CacheKey("Paris", ""))
	if err != nil || !ok {
		t.Fatalf("cache get ok=%v err=%v", ok, err)
	}
	var cached cachedGeocode
	if json.Unmarshal(raw, &cached) != nil || !cached.OK {
		t.Fatalf("cache payload = %s", raw)
	}
	if _, err := client.Probe(context.Background(), "Paris", ""); err != nil {
		t.Fatal(err)
	}
	raw, _, _ = cache.Get(context.Background(), CacheKey("Paris", ""))
	if json.Unmarshal(raw, &cached) != nil || !cached.OK {
		t.Fatalf("transient probe wrote a negative cache: %s", raw)
	}
}
