package vectorclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// rawMessage builds a stored JSON member for the settings tests.
func rawMessage(t *testing.T, value string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(value)) {
		t.Fatalf("invalid JSON literal %q", value)
	}
	return json.RawMessage(value)
}

// noSleep replaces the retry sleep so tests stay fast.
func noSleep(context.Context, time.Duration) error { return nil }

// newSearchClient builds a client pointed at the test server.
func newSearchClient(t *testing.T, server *httptest.Server, mutate func(*SearcherOptions)) *SearchClient {
	t.Helper()
	options := SearcherOptions{
		Env: SearcherEnv{
			Enabled:         true,
			FallbackToMongo: true,
			BaseURL:         server.URL,
			Token:           "secret",
			TimeoutMS:       1_000,
			MaxRetries:      0,
		},
		Random: func() float64 { return 0.5 },
	}
	if mutate != nil {
		mutate(&options)
	}
	client := NewSearcher(options)
	client.sleep = noSleep
	return client
}

func TestSearchSendsVectorServiceProtocol(t *testing.T) {
	var gotPath, gotMethod, gotContentType, gotToken, gotTrace string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotContentType = r.Header.Get("content-type")
		gotToken = r.Header.Get("x-internal-token")
		gotTrace = r.Header.Get("x-trace-id")
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"collection":"processed_items","matches":[{"processedItemId":"pid-1","itemMetaId":"meta-1","score":0.93,"createdAtMs":1700000000000}]}`))
	}))
	defer server.Close()

	client := newSearchClient(t, server, nil)
	minScore := 0.8
	lookback := int64(3_600_000)
	matches, err := client.SearchBestEffort(context.Background(), SearchRequest{
		OrgID:          "org-1",
		EmbeddingModel: "embed-v1",
		Vector:         []float64{0.1, 0.2, 0.3},
		Limit:          5,
		MinScore:       &minScore,
		LookbackMS:     &lookback,
		TraceID:        "trace-1",
	})
	if err != nil {
		t.Fatalf("SearchBestEffort error = %v", err)
	}
	if gotPath != "/v1/search" || gotMethod != http.MethodPost {
		t.Errorf("request = %s %s, want POST /v1/search", gotMethod, gotPath)
	}
	if gotContentType != "application/json" {
		t.Errorf("content-type = %q", gotContentType)
	}
	if gotToken != "secret" {
		t.Errorf("x-internal-token = %q", gotToken)
	}
	if gotTrace != "trace-1" {
		t.Errorf("x-trace-id = %q", gotTrace)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("request body is not JSON: %v (%s)", err, string(gotBody))
	}
	if len(body) != 6 {
		t.Errorf("body keys = %v, want orgId, embeddingModel, vector, limit, minScore, lookbackMs", body)
	}
	assertRawJSON(t, body, "orgId", `"org-1"`)
	assertRawJSON(t, body, "embeddingModel", `"embed-v1"`)
	assertRawJSON(t, body, "vector", `[0.1,0.2,0.3]`)
	assertRawJSON(t, body, "limit", `5`)
	assertRawJSON(t, body, "minScore", `0.8`)
	assertRawJSON(t, body, "lookbackMs", `3600000`)

	if len(matches) != 1 {
		t.Fatalf("matches = %+v", matches)
	}
	want := SearchMatch{ProcessedItemID: "pid-1", ItemMetaID: "meta-1", CreatedAtMS: 1_700_000_000_000, Score: 0.93}
	if matches[0] != want {
		t.Errorf("match = %+v, want %+v", matches[0], want)
	}
}

func TestSearchOmitsAbsentOptionalMembers(t *testing.T) {
	var body map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		if r.Header.Get("x-trace-id") != "" {
			t.Errorf("unexpected x-trace-id = %q", r.Header.Get("x-trace-id"))
		}
		_, _ = w.Write([]byte(`{"collection":"processed_items"}`))
	}))
	defer server.Close()

	client := newSearchClient(t, server, nil)
	matches, err := client.SearchBestEffort(context.Background(), SearchRequest{
		OrgID:          "org-1",
		EmbeddingModel: "embed-v1",
		Vector:         []float64{1},
		Limit:          1,
	})
	if err != nil {
		t.Fatalf("SearchBestEffort error = %v", err)
	}
	if matches == nil || len(matches) != 0 {
		t.Errorf("matches = %#v, want empty non-nil slice", matches)
	}
	if _, ok := body["minScore"]; ok {
		t.Error("minScore must be omitted when nil")
	}
	if _, ok := body["lookbackMs"]; ok {
		t.Error("lookbackMs must be omitted when nil")
	}
	if len(body) != 4 {
		t.Errorf("body keys = %v", body)
	}
}

func TestSearchRetriesOnServerError(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"collection":"processed_items","matches":[]}`))
	}))
	defer server.Close()

	var delays []time.Duration
	client := newSearchClient(t, server, func(options *SearcherOptions) {
		options.Env.MaxRetries = 2
	})
	client.sleep = func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org-1", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err != nil {
		t.Fatalf("SearchBestEffort error = %v", err)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2", calls.Load())
	}
	if len(delays) != 1 || delays[0] != 200*time.Millisecond {
		t.Errorf("delays = %v, want one 200ms backoff", delays)
	}
}

func TestSearchDoesNotRetryTerminalFailures(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		payload  string
		wantName string
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, wantName: "VectorUnauthorizedError"},
		{name: "forbidden", status: http.StatusForbidden, wantName: "VectorUnauthorizedError"},
		{name: "bad request", status: http.StatusBadRequest, wantName: "VectorBadResponseError"},
		{name: "invalid payload", status: http.StatusOK, payload: `{"collection":""}`, wantName: "VectorBadResponseError"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if testCase.status != http.StatusOK {
					w.WriteHeader(testCase.status)
					return
				}
				_, _ = w.Write([]byte(testCase.payload))
			}))
			defer server.Close()
			client := newSearchClient(t, server, func(options *SearcherOptions) {
				options.Env.MaxRetries = 2
			})
			_, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org-1", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1})
			if err == nil {
				t.Fatal("want an error")
			}
			named, ok := err.(interface{ Name() string })
			if !ok || named.Name() != testCase.wantName {
				t.Errorf("error name = %v, want %s", err, testCase.wantName)
			}
			if calls.Load() != 1 {
				t.Errorf("calls = %d, want 1 (terminal failures are not retried)", calls.Load())
			}
		})
	}
}

func TestSearchAppliesPerAttemptTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(300 * time.Millisecond):
		}
		_, _ = w.Write([]byte(`{"collection":"processed_items","matches":[]}`))
	}))
	defer server.Close()

	client := newSearchClient(t, server, func(options *SearcherOptions) {
		options.Env.TimeoutMS = 30
	})
	started := time.Now()
	_, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org-1", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1})
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("want a timeout error")
	}
	if elapsed < 20*time.Millisecond {
		t.Errorf("elapsed = %s, want the 30ms attempt timeout to fire", elapsed)
	}
	if elapsed > 250*time.Millisecond {
		t.Errorf("elapsed = %s, want the request aborted near the timeout", elapsed)
	}
}

func TestSearchUnavailableBranches(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*SearcherOptions)
	}{
		{name: "disabled", mutate: func(options *SearcherOptions) { options.Env.Enabled = false }},
		{name: "missing token", mutate: func(options *SearcherOptions) { options.Env.Token = "" }},
		{name: "missing base url", mutate: func(options *SearcherOptions) { options.Env.BaseURL = "" }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = w.Write([]byte(`{"collection":"processed_items","matches":[]}`))
			}))
			defer server.Close()
			client := newSearchClient(t, server, testCase.mutate)
			if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org-1", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
				t.Fatal("want an unavailable error")
			}
			if calls.Load() != 0 {
				t.Errorf("calls = %d, want 0", calls.Load())
			}
		})
	}
}

func TestDecodeSearchResponseValidation(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		wantErr bool
	}{
		{name: "valid with matches", payload: `{"collection":"c","matches":[{"processedItemId":"p","itemMetaId":"m","score":0.5,"createdAtMs":1}]}`},
		{name: "valid without matches", payload: `{"collection":"c"}`},
		{name: "valid empty matches", payload: `{"collection":"c","matches":[]}`},
		{name: "missing collection", payload: `{"matches":[]}`, wantErr: true},
		{name: "empty collection", payload: `{"collection":"","matches":[]}`, wantErr: true},
		{name: "null matches", payload: `{"collection":"c","matches":null}`, wantErr: true},
		{name: "matches not array", payload: `{"collection":"c","matches":{}}`, wantErr: true},
		{name: "blank processed item id", payload: `{"collection":"c","matches":[{"processedItemId":"","itemMetaId":"m","score":0.5,"createdAtMs":1}]}`, wantErr: true},
		{name: "blank item meta id", payload: `{"collection":"c","matches":[{"processedItemId":"p","itemMetaId":" ","score":0.5,"createdAtMs":1}]}`, wantErr: true},
		{name: "missing score", payload: `{"collection":"c","matches":[{"processedItemId":"p","itemMetaId":"m","createdAtMs":1}]}`, wantErr: true},
		{name: "missing created at", payload: `{"collection":"c","matches":[{"processedItemId":"p","itemMetaId":"m","score":0.5}]}`, wantErr: true},
		{name: "fractional created at", payload: `{"collection":"c","matches":[{"processedItemId":"p","itemMetaId":"m","score":0.5,"createdAtMs":1.5}]}`, wantErr: true},
		{name: "negative created at", payload: `{"collection":"c","matches":[{"processedItemId":"p","itemMetaId":"m","score":0.5,"createdAtMs":-1}]}`, wantErr: true},
		{name: "not json", payload: `not-json`, wantErr: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			matches, err := decodeSearchResponse([]byte(testCase.payload))
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("want an error, got matches = %+v", matches)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error = %v", err)
			}
			if matches == nil {
				t.Fatal("matches must be a non-nil slice")
			}
		})
	}
}

func TestSearchJSONCoercion(t *testing.T) {
	positive := []struct {
		raw  string
		want int
		ok   bool
	}{
		{raw: `5000`, want: 5000, ok: true},
		{raw: `1500.9`, want: 1500, ok: true},
		{raw: `"2500"`, want: 2500, ok: true},
		{raw: `true`, want: 1, ok: true},
		{raw: `0`, ok: false},
		{raw: `-3`, ok: false},
		{raw: `"abc"`, ok: false},
		{raw: `null`, ok: false},
	}
	for _, testCase := range positive {
		value, ok := searchJSONPositiveInt(rawMessage(t, testCase.raw))
		if ok != testCase.ok || value != testCase.want {
			t.Errorf("searchJSONPositiveInt(%s) = %d, %v; want %d, %v", testCase.raw, value, ok, testCase.want, testCase.ok)
		}
	}

	if value, ok := searchJSONNonNegativeInt(rawMessage(t, `0`)); !ok || value != 0 {
		t.Errorf("searchJSONNonNegativeInt(0) = %d, %v", value, ok)
	}
	if _, ok := searchJSONNonNegativeInt(rawMessage(t, `-1`)); ok {
		t.Error("searchJSONNonNegativeInt(-1) must fail")
	}
	if value, ok := searchJSONBoolean(rawMessage(t, `false`)); !ok || value {
		t.Errorf("searchJSONBoolean(false) = %v, %v", value, ok)
	}
	if _, ok := searchJSONBoolean(rawMessage(t, `"true"`)); ok {
		t.Error("searchJSONBoolean must require a JSON boolean")
	}
	if value, ok := searchJSONString(rawMessage(t, `" http://x "`)); !ok || value != " http://x " {
		t.Errorf("searchJSONString = %q, %v", value, ok)
	}
	if _, ok := searchJSONString(rawMessage(t, `12`)); ok {
		t.Error("searchJSONString must require a JSON string")
	}
}

func TestResolveConfigOverlaysStoredSettings(t *testing.T) {
	stored := &storedSearchSettings{
		Enabled:         rawMessage(t, `true`),
		FallbackToMongo: rawMessage(t, `false`),
		BaseURL:         rawMessage(t, `" http://vector.internal/ "`),
		Token:           rawMessage(t, `"stored-token"`),
		TimeoutMS:       rawMessage(t, `1500`),
		MaxRetries:      rawMessage(t, `0`),
	}
	client := NewSearcher(SearcherOptions{Env: SearcherEnv{
		Enabled:         false,
		FallbackToMongo: true,
		BaseURL:         "http://env.internal",
		Token:           "env-token",
		TimeoutMS:       5000,
		MaxRetries:      2,
	}})
	client.settingsLoader = func(context.Context) (*storedSearchSettings, bool) { return stored, true }

	config := client.resolveConfig(context.Background())
	if !config.Enabled {
		t.Error("stored enabled=true must override the env default")
	}
	if config.FallbackToMongo {
		t.Error("stored fallbackToMongo=false must override the env default")
	}
	if config.BaseURL != "http://vector.internal" {
		t.Errorf("base url = %q", config.BaseURL)
	}
	if config.Token != "stored-token" {
		t.Errorf("token = %q", config.Token)
	}
	if config.TimeoutMS != 1500 || config.MaxRetries != 0 {
		t.Errorf("timeout/retries = %d/%d", config.TimeoutMS, config.MaxRetries)
	}
	if client.FallbackToMongoEnabled(context.Background()) {
		t.Error("FallbackToMongoEnabled must read the stored override")
	}
}

func TestResolveConfigKeepsEnvDefaultsForWrongTypes(t *testing.T) {
	stored := &storedSearchSettings{
		Enabled:         rawMessage(t, `"true"`),
		FallbackToMongo: rawMessage(t, `1`),
		BaseURL:         rawMessage(t, `123`),
		Token:           rawMessage(t, `false`),
		TimeoutMS:       rawMessage(t, `"abc"`),
		MaxRetries:      rawMessage(t, `"3"`),
	}
	client := NewSearcher(SearcherOptions{Env: SearcherEnv{
		Enabled:         true,
		FallbackToMongo: true,
		BaseURL:         "http://env.internal",
		Token:           "env-token",
		TimeoutMS:       5000,
		MaxRetries:      2,
	}})
	client.settingsLoader = func(context.Context) (*storedSearchSettings, bool) { return stored, true }

	config := client.resolveConfig(context.Background())
	if !config.Enabled || !config.FallbackToMongo {
		t.Errorf("non-boolean stored flags must keep the env defaults: %+v", config)
	}
	if config.BaseURL != "http://env.internal" || config.Token != "env-token" {
		t.Errorf("non-string singletons must keep the env defaults: %+v", config)
	}
	if config.TimeoutMS != 5000 {
		t.Errorf("timeout = %d, want 5000", config.TimeoutMS)
	}
	// Number("3") is 3, so a numeric string is coerced like the NestJS helper.
	if config.MaxRetries != 3 {
		t.Errorf("retries = %d, want 3", config.MaxRetries)
	}
}

func TestDecodeCachedSearchSettings(t *testing.T) {
	stored, present, ok := searchDecodeCachedSettings([]byte(`{"exists":false}`))
	if !ok || present || stored != nil {
		t.Errorf("exists=false => stored=%v present=%v ok=%v", stored, present, ok)
	}
	stored, present, ok = searchDecodeCachedSettings([]byte(`{"exists":true,"value":{"enabled":true}}`))
	if !ok || !present || stored == nil {
		t.Fatalf("exists=true => stored=%v present=%v ok=%v", stored, present, ok)
	}
	if enabled, valid := searchJSONBoolean(stored.Enabled); !valid || !enabled {
		t.Errorf("decoded enabled = %v, %v", enabled, valid)
	}
	if _, _, ok := searchDecodeCachedSettings([]byte(`not-json`)); ok {
		t.Error("a malformed envelope must report ok=false")
	}
}

func TestDecodeStoredSearchRow(t *testing.T) {
	if stored := searchDecodeStoredRow([]byte(`{"timeoutMs":9000}`)); stored == nil {
		t.Fatal("valid object must decode")
	}
	for _, raw := range []string{``, `null`, `"text"`, `[]`, `not-json`} {
		if stored := searchDecodeStoredRow([]byte(raw)); stored != nil {
			t.Errorf("searchDecodeStoredRow(%q) = %+v, want nil", raw, stored)
		}
	}
}

func TestSearchBackoffJitter(t *testing.T) {
	client := NewSearcher(SearcherOptions{Env: SearcherEnv{Enabled: true, BaseURL: "http://x", Token: "t", TimeoutMS: 1000}, Random: func() float64 { return 0 }})
	if got := client.backoff(1); got != 100*time.Millisecond {
		t.Errorf("backoff(1) with random=0 = %s, want 100ms", got)
	}
	client.random = func() float64 { return 0.5 }
	if got := client.backoff(1); got != 200*time.Millisecond {
		t.Errorf("backoff(1) with random=0.5 = %s, want 200ms", got)
	}
	if got := client.backoff(3); got != 800*time.Millisecond {
		t.Errorf("backoff(3) with random=0.5 = %s, want 800ms", got)
	}
}

func TestSearchProcessLocalBackoff(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"collection":"c","matches":[]}`))
	}))
	defer server.Close()

	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	client := newSearchClient(t, server, func(options *SearcherOptions) {
		options.Now = func() time.Time { return now }
	})
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
		t.Fatal("want an unavailable error")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
	// A 401/403 keeps the service disabled for at least five minutes.
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
		t.Fatal("want a short-circuited error")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want the second call short-circuited", calls.Load())
	}
	now = now.Add(5*time.Minute + time.Second)
	fail.Store(false)
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err != nil {
		t.Fatalf("SearchBestEffort after the backoff window error = %v", err)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2", calls.Load())
	}
}

func TestSearchBadPayloadKeepsOneMinuteBackoff(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"collection":""}`))
	}))
	defer server.Close()

	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	client := newSearchClient(t, server, func(options *SearcherOptions) {
		options.Now = func() time.Time { return now }
	})
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
		t.Fatal("want an error")
	}
	now = now.Add(59 * time.Second)
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
		t.Fatal("want a short-circuited error")
	}
	if calls.Load() != 1 {
		t.Errorf("calls = %d, want 1", calls.Load())
	}
}

func TestSearchReenabledWhenFingerprintChanges(t *testing.T) {
	var calls atomic.Int64
	var fail atomic.Bool
	fail.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"collection":"c","matches":[]}`))
	}))
	defer server.Close()

	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	client := newSearchClient(t, server, func(options *SearcherOptions) {
		options.Now = func() time.Time { return now }
	})
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err == nil {
		t.Fatal("want an error")
	}
	// A new stored token changes the fingerprint and resets the disable window,
	// exactly like the client rebuild in VectorClientService.resolveClient.
	client.settingsLoader = func(context.Context) (*storedSearchSettings, bool) {
		return &storedSearchSettings{Token: rawMessage(t, `"rotated-secret"`)}, true
	}
	fail.Store(false)
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{OrgID: "org", EmbeddingModel: "m", Vector: []float64{1}, Limit: 1}); err != nil {
		t.Fatalf("SearchBestEffort after token rotation error = %v", err)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2", calls.Load())
	}
}

func TestSearchNilClient(t *testing.T) {
	var client *SearchClient
	if _, err := client.SearchBestEffort(context.Background(), SearchRequest{}); err == nil {
		t.Fatal("nil client must report unavailable")
	}
	if client.FallbackToMongoEnabled(context.Background()) {
		t.Fatal("nil client fallback must be false")
	}
}

func TestDecodeNonNegativeInteger(t *testing.T) {
	if value, err := searchDecodeNonNegativeInteger(json.RawMessage(`1700000000000`)); err != nil || value != 1_700_000_000_000 {
		t.Errorf("value = %d, err = %v", value, err)
	}
	for _, raw := range []string{``, `null`, `1.5`, `-1`, `"1"`, `1e400`} {
		if _, err := searchDecodeNonNegativeInteger(json.RawMessage(raw)); err == nil {
			t.Errorf("searchDecodeNonNegativeInteger(%q) must fail", raw)
		}
	}
}

// assertRawJSON compares one request-body member against its expected encoding.
func assertRawJSON(t *testing.T, body map[string]json.RawMessage, key, want string) {
	t.Helper()
	raw, ok := body[key]
	if !ok {
		t.Errorf("missing body member %q", key)
		return
	}
	if got := strings.TrimSpace(string(raw)); got != want {
		t.Errorf("body[%q] = %s, want %s", key, got, want)
	}
}
