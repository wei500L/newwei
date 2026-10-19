//go:build integration

package geocoding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// TestGeocodeRedisCacheAndRateLimitIntegration proves that the Redis structure
// is byte-compatible with NestJS and that the global limiter is the same key.
func TestGeocodeRedisCacheAndRateLimitIntegration(t *testing.T) {
	rdb := integrationRedis(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`[{"lat":"48.8","lon":"2.3","display_name":"Paris","address":{"country_code":"fr"}}]`))
	}))
	defer server.Close()

	_ = rdb.Del(ctx, "rate:geocode:nominatim", "rate:geocode:nominatim:seq").Err()
	unique := "Integration Paris " + time.Now().Format("150405.000000")
	fixed := time.UnixMilli(1_700_000_000_000)
	client := NewClient(RedisCache{Client: rdb}, rdb, nil, Config{
		BaseURL:       server.URL,
		UserAgent:     "integration-test",
		RatePerSecond: 1,
	})
	client.now = func() time.Time { return fixed }

	hit, err := client.Geocode(ctx, unique, "")
	if err != nil || hit == nil {
		t.Fatalf("geocode hit=%+v err=%v", hit, err)
	}
	if hit.CountryCodeAlpha2 != "FR" {
		t.Fatalf("country = %q", hit.CountryCodeAlpha2)
	}

	raw, err := rdb.Get(ctx, CacheKey(NormalizeQuery(unique), "")).Bytes()
	if err != nil {
		t.Fatalf("cache key missing: %v", err)
	}
	var cached cachedGeocode
	if err := json.Unmarshal(raw, &cached); err != nil || !cached.OK || cached.Result == nil {
		t.Fatalf("cache payload = %s err=%v", raw, err)
	}
	if cached.Result.Provider != "nominatim" || cached.Result.Lat != 48.8 {
		t.Fatalf("cache result = %+v", cached.Result)
	}

	// The limiter is global: a different query inside the same second returns
	// null without reaching Nominatim and without writing a cache entry.
	blockedQuery := "Integration Blocked " + time.Now().Format("150405.000000")
	blocked, err := client.Geocode(ctx, blockedQuery, "")
	if err != nil || blocked != nil {
		t.Fatalf("rate-limited hit=%+v err=%v", blocked, err)
	}
	if hits.Load() != 1 {
		t.Fatalf("nominatim hits = %d, want 1", hits.Load())
	}
	if exists, err := rdb.Exists(ctx, CacheKey(blockedQuery, "")).Result(); err != nil || exists != 0 {
		t.Fatalf("rate-limited query wrote a cache entry: exists=%d err=%v", exists, err)
	}
	if exists, err := rdb.Exists(ctx, "rate:geocode:nominatim").Result(); err != nil || exists != 1 {
		t.Fatalf("rate limiter key missing: exists=%d err=%v", exists, err)
	}

	// A transient failure must not write a negative cache entry (D2).
	_ = rdb.Del(ctx, "rate:geocode:nominatim", "rate:geocode:nominatim:seq").Err()
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer failing.Close()
	failClient := NewClient(RedisCache{Client: rdb}, rdb, nil, Config{BaseURL: failing.URL, RatePerSecond: 10})
	failClient.now = func() time.Time { return fixed }
	failQuery := "Integration Failure " + time.Now().Format("150405.000000")
	if result, err := failClient.Geocode(ctx, failQuery, ""); err != nil || result != nil {
		t.Fatalf("transient result=%+v err=%v", result, err)
	}
	if exists, err := rdb.Exists(ctx, CacheKey(failQuery, "")).Result(); err != nil || exists != 0 {
		t.Fatalf("transient failure wrote a negative cache entry: exists=%d err=%v", exists, err)
	}
}
