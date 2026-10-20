package realtimesignals

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

func testRuntime() *dataruntimesettings.RealtimeCronRuntime {
	return &dataruntimesettings.RealtimeCronRuntime{RequestTimeoutMs: 2000, MaxRetries: 0}
}

func TestFetchJSONRequestShapeAndSuccess(t *testing.T) {
	var gotAccept, gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("accept")
		gotMethod = r.Method
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := newHTTPClient()
	payload, err := client.fetchJSON(context.Background(), testRuntime(), server.URL, fetchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodGet || gotAccept != "application/json" {
		t.Fatalf("method/accept = %s/%s", gotMethod, gotAccept)
	}
	if !bytesTrimmedEqual(payload, []byte(`{"ok":true}`)) {
		t.Fatalf("payload = %s", payload)
	}
}

func TestFetchJSONRateLimitDetails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "2")
		w.Header().Set("RateLimit", "100;w=60")
		w.Header().Set("RateLimit-Policy", "100;w=60")
		w.Header().Set("CF-Ray", "ray-1")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`too many`))
	}))
	defer server.Close()

	client := newHTTPClient()
	_, err := client.fetchJSON(context.Background(), testRuntime(), server.URL, fetchOptions{})
	if err == nil {
		t.Fatal("expected an error")
	}
	status := readHTTPStatus(err)
	if status == nil || *status != 429 {
		t.Fatalf("status = %v", status)
	}
	details := diagnosticErrorDetails(err)
	if details.Code != codeUpstreamRateLimited || details.Kind != kindRateLimited {
		t.Fatalf("details = %+v", details)
	}
	if details.Message != "HTTP 429 Too Many Requests" {
		t.Fatalf("message = %q", details.Message)
	}
	retryAfter := retryAfterMillis(err)
	if retryAfter == nil || *retryAfter != 2000 {
		t.Fatalf("retryAfterMs = %v", retryAfter)
	}
	rateLimit := rateLimitDetails(err)
	if rateLimit == nil || rateLimit.RetryAfterSec == nil || *rateLimit.RetryAfterSec != 2 ||
		rateLimit.RateLimit != "100;w=60" || rateLimit.RateLimitPolicy != "100;w=60" || rateLimit.CFRay != "ray-1" {
		t.Fatalf("rateLimit = %+v", rateLimit)
	}
}

func TestFetchJSONRetriesServerErrors(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		attempt := requests
		mu.Unlock()
		if attempt == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := newHTTPClient()
	retries := 1
	if _, err := client.fetchJSON(context.Background(), testRuntime(), server.URL, fetchOptions{MaxRetries: &retries}); err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
}

func TestFetchJSONDoesNotRetryRateLimit(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()

	client := newHTTPClient()
	retries := 3
	_, err := client.fetchJSON(context.Background(), testRuntime(), server.URL, fetchOptions{MaxRetries: &retries})
	if err == nil {
		t.Fatal("expected an error")
	}
	if requests != 1 {
		t.Fatalf("429 must not be retried, requests = %d", requests)
	}
}

func TestFetchJSONTimeoutClassification(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1200 * time.Millisecond)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	runtime := &dataruntimesettings.RealtimeCronRuntime{RequestTimeoutMs: 1000, MaxRetries: 0}
	client := newHTTPClient()
	_, err := client.fetchJSON(context.Background(), runtime, server.URL, fetchOptions{})
	if err == nil {
		t.Fatal("expected a timeout")
	}
	details := diagnosticErrorDetails(err)
	if details.Code != codeRequestTimeout || details.Kind != kindTimeout {
		t.Fatalf("details = %+v", details)
	}
	if !strings.Contains(details.Message, "Network request timed out after 1000ms") {
		t.Fatalf("message = %q", details.Message)
	}
}

func TestShouldRetryWithIPv4OnlyForConfiguredHost(t *testing.T) {
	timeout := &upstreamError{timedOut: true, code: codeRequestTimeout}
	if !shouldRetryWithIPv4("https://api.gdeltproject.org/api/v1/gkg_geojson", timeout) {
		t.Fatal("the GDELT host must allow the IPv4 retry")
	}
	if shouldRetryWithIPv4("https://example.test/api", timeout) {
		t.Fatal("an unconfigured host must not allow the IPv4 retry")
	}
	if shouldRetryWithIPv4("https://api.gdeltproject.org/api", &upstreamError{status: 500}) {
		t.Fatal("an HTTP status error must not trigger the IPv4 retry")
	}
}

func TestReadRetryAfterHTTPDate(t *testing.T) {
	future := time.Now().Add(3 * time.Second).UTC().Format(http.TimeFormat)
	parsed := parseRetryAfterMs(future)
	if parsed == nil || *parsed <= 0 {
		t.Fatalf("HTTP-date Retry-After = %v", parsed)
	}
	if parseRetryAfterMs("not-a-date") != nil {
		t.Fatal("invalid Retry-After must be nil")
	}
}

// ---- per-source request shape ----

type fakeRuntimePort struct {
	runtime        *dataruntimesettings.RealtimeCronRuntime
	refreshedToken string
	refreshCalls   int
}

func (f *fakeRuntimePort) EffectiveRealtimeCronRuntime(context.Context, bool) (*dataruntimesettings.RealtimeCronRuntime, error) {
	return f.runtime, nil
}

func (f *fakeRuntimePort) EnvRealtimeCronRuntime() *dataruntimesettings.RealtimeCronRuntime {
	return f.runtime
}

func (f *fakeRuntimePort) ForceRefreshAcledAccessToken(context.Context) (string, error) {
	f.refreshCalls++
	return f.refreshedToken, nil
}

func TestAcledUnauthorizedRefreshesTokenAndRetries(t *testing.T) {
	var mu sync.Mutex
	authorizations := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer refresh-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"event_id_cnty":"IRN1","event_date":"2026-10-20","latitude":35.7,"longitude":51.4,"iso":"IRN","fatalities":2}]}`))
	}))
	defer server.Close()

	runtime := testRuntime()
	runtime.Capabilities.AcledAPIEnabled = true
	runtime.Credentials.AcledAccessToken = "stale-token"
	port := &fakeRuntimePort{runtime: runtime, refreshedToken: "refresh-token"}
	service := &Service{http: newHTTPClient(), runtime: port, endpoints: endpointOverrides{ACLED: server.URL}}
	result := service.fetchAcledUnrestEvents(context.Background(), runtime)
	if port.refreshCalls != 1 {
		t.Fatalf("refresh calls = %d", port.refreshCalls)
	}
	if !result.Configured || result.HasError || len(result.Events) != 1 {
		t.Fatalf("result = %+v", result)
	}
	if result.Events[0].CountryCode != "IRN" || result.Events[0].Reports != 2 || result.Events[0].ID != "acled-IRN1" {
		t.Fatalf("event = %+v", result.Events[0])
	}
	if len(authorizations) != 2 || authorizations[0] != "Bearer stale-token" || authorizations[1] != "Bearer refresh-token" {
		t.Fatalf("authorizations = %v", authorizations)
	}
}

func TestOutagesRequestShape(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"result":[{"locations":[{"alpha2":"IR"}]},{"locations":[{"name":"Russia"}]}]}`))
	}))
	defer server.Close()

	runtime := testRuntime()
	runtime.Credentials.CloudflareAPIToken = "cf-token"
	service := &Service{http: newHTTPClient(), endpoints: endpointOverrides{Cloudflare: server.URL}}
	results, err := service.fetchOutagesSignal(context.Background(), runtime)
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer cf-token" {
		t.Fatalf("authorization = %q", authorization)
	}
	contextValue, ok := results[0].Context.(*outagesContext)
	if !ok || results[0].Value != 2 || len(contextValue.CountryCodes) != 2 ||
		contextValue.CountryCodes[0] != "IRN" || contextValue.CountryCodes[1] != "RUS" {
		t.Fatalf("outages = %+v", results[0])
	}
}

func TestPizzintRequestAndMetric(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"locations":[
			{"open":true,"pop":80,"activeSpike":true},
			{"is_open":true,"avg_pop":60},
			{"status":"open","traffic":70,"has_spike":true},
			{"open":false,"pop":999}
		]}`))
	}))
	defer server.Close()

	service := &Service{http: newHTTPClient(), endpoints: endpointOverrides{PizzintDashboard: server.URL}}
	results, err := service.fetchPizzintSignal(context.Background(), testRuntime())
	if err != nil {
		t.Fatal(err)
	}
	contextValue, ok := results[0].Context.(*pizzintContext)
	if !ok {
		t.Fatalf("context type = %T", results[0].Context)
	}
	if contextValue.OpenLocations != 3 || contextValue.ActiveSpikes != 2 {
		t.Fatalf("pizzint counts = %+v", contextValue)
	}
	if contextValue.AvgPop != 70 || contextValue.AdjustedScore != 90 || contextValue.Defcon != 1 {
		t.Fatalf("pizzint scores = %+v", contextValue)
	}
}

func TestGdeltUnrestRequestShapeAndFiltering(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"features":[
			{"properties":{"name":"Protest, Iran","mentionedthemes":"PROTEST","urltone":-2,"urlpubtimedate":"20261020120000"},"geometry":{"coordinates":[51.4,35.7]}},
			{"properties":{"name":"Protest, Iran","mentionedthemes":"PROTEST","urltone":-2,"urlpubtimedate":"20261020130000"},"geometry":{"coordinates":[51.4,35.7]}},
			{"properties":{"name":"Positive news, Iran","mentionedthemes":"PROTEST","urltone":5},"geometry":{"coordinates":[51.4,35.7]}}
		]}`))
	}))
	defer server.Close()

	service := &Service{http: newHTTPClient(), endpoints: endpointOverrides{GDELTUnrest: server.URL}}
	result := service.fetchGdeltUnrestEvents(context.Background(), testRuntime())
	if !result.Configured || result.HasError {
		t.Fatalf("result = %+v", result)
	}
	wantQuery := "QUERY=PROTEST&TIMESPAN=10080&MAXROWS=250&OUTPUTFIELDS=name%2Curl%2Curlpubtimedate%2Curltone%2Cmentionedthemes%2Cgeores"
	if rawQuery != wantQuery {
		t.Fatalf("query = %q, want %q", rawQuery, wantQuery)
	}
	if len(result.Events) != 1 || result.Events[0].Reports != 2 || result.Events[0].CountryCode != "IRN" {
		t.Fatalf("events = %+v", result.Events)
	}
}

func TestGdeltTensionRequestShape(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"usa_russia":[{"t":"2026-10-20","v":71.5}]}`))
	}))
	defer server.Close()

	service := &Service{http: newHTTPClient(), endpoints: endpointOverrides{PizzintTension: server.URL}}
	results, err := service.fetchGdeltTensionSignal(context.Background(), testRuntime())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rawQuery, "pairs=usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela&method=gpr&dateStart=") {
		t.Fatalf("query = %q", rawQuery)
	}
	if results[0].Value != 71.5 {
		t.Fatalf("max score = %v", results[0].Value)
	}
}

func TestAisRelayPayloadRequestShape(t *testing.T) {
	var authorization, path string
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		authorization = r.Header.Get("Authorization")
		path = r.URL.RequestURI()
		_, _ = w.Write([]byte(`{"disruptions":[],"density":[]}`))
	}))
	defer server.Close()

	runtime := testRuntime()
	runtime.AisRelay.SharedSecret = "relay-secret"
	service := &Service{http: newHTTPClient()}
	round := newRoundContext(runtime)
	payload, err := round.aisPayload(context.Background(), service, runtime, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if path != "/ais/snapshot?candidates=true" || authorization != "Bearer relay-secret" {
		t.Fatalf("request = %s / %q", path, authorization)
	}
	if len(readArray(payload)) != 0 {
		t.Fatalf("payload = %s", payload)
	}
	// A second call in the same round must not issue another request.
	if _, err := round.aisPayload(context.Background(), service, runtime, server.URL); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("AIS relay requests = %d, want 1 (O1 shares the response per round)", requests)
	}
}

func TestPolymarketEventsRequestShape(t *testing.T) {
	var path string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.RequestURI()
		_, _ = w.Write([]byte(`[{"id":"e1","title":"Event"}]`))
	}))
	defer server.Close()

	service := &Service{http: newHTTPClient()}
	round := newRoundContext(testRuntime())
	events, err := round.polymarketEvents(context.Background(), service, testRuntime(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if path != "/events?closed=false&limit=60" {
		t.Fatalf("path = %s", path)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d", len(events))
	}
}

func TestOpenSkyEndpointShape(t *testing.T) {
	got := openSkyEndpoint("https://opensky-network.org/api/", [4]float64{-130, 24, -60, 55})
	want := "https://opensky-network.org/api/states/all?lamin=24&lomin=-130&lamax=55&lomax=-60"
	if got != want {
		t.Fatalf("endpoint = %s, want %s", got, want)
	}
}
