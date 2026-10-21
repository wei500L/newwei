package legacyproxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// fallbackTraceID is a 32-hex trace id, so httpx.EnsureTraceID keeps it
// verbatim and every assertion can predict the value written to the body.
const fallbackTraceID = "0123456789abcdef0123456789abcdef"

// fallbackUpstream stands in for NestJS and counts every request that reaches
// it. The reject-mode tests assert this count never moves.
type fallbackUpstream struct {
	mu     sync.Mutex
	hits   int
	server *httptest.Server
}

func newFallbackUpstream(t *testing.T) *fallbackUpstream {
	t.Helper()
	upstream := &fallbackUpstream{}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstream.mu.Lock()
		upstream.hits++
		upstream.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"upstream":"legacy"}`))
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (u *fallbackUpstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.hits
}

// newFallbackGateway builds a gateway and applies SetLegacyFallback exactly the
// way cmd/api does: mode first, then the CORS policy and the event recorder.
func newFallbackGateway(t *testing.T, legacyURL string, rules []Rule, mode LegacyFallbackMode, policy cors.Policy, record nestnotfound.Recorder) *Gateway {
	t.Helper()
	gateway, err := New(legacyURL, rules)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	gateway.SetLegacyFallback(string(mode), policy, record)
	return gateway
}

// serveFallback drives the gateway through httpx.TraceMiddleware so the trace
// id is present in the request context, like production.
func serveFallback(t *testing.T, gateway *Gateway, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://gateway"+target, nil)
	req.Header.Set("x-trace-id", fallbackTraceID)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	httpx.TraceMiddleware(gateway).ServeHTTP(rec, req)
	return rec
}

// serveFallbackWithShadow is serveFallback for the shadow/canary dispatch path.
func serveFallbackWithShadow(t *testing.T, gateway *Gateway, disp ShadowDispatcher, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://gateway"+target, nil)
	req.Header.Set("x-trace-id", fallbackTraceID)
	rec := httptest.NewRecorder()
	wrapped := httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gateway.ServeHTTPWithShadow(w, r, disp)
	}))
	wrapped.ServeHTTP(rec, req)
	return rec
}

// nest404 mirrors the object order the NestJS global exception filter writes:
// statusCode, message, error, traceId, path, timestamp.
type nest404 struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

func decodeNest404(t *testing.T, body []byte) nest404 {
	t.Helper()
	var payload nest404
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode 404 body %q: %v", body, err)
	}
	return payload
}

// assertNest404KeyOrder asserts the serialized member order, not just the
// decoded values: the contract is the NestJS filter's object literal order.
func assertNest404KeyOrder(t *testing.T, body []byte) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil {
		t.Fatalf("decode 404 body %q: %v", body, err)
	}
	if token != json.Delim('{') {
		t.Fatalf("404 body does not start with an object: %q", body)
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			t.Fatalf("decode 404 key from %q: %v", body, err)
		}
		key, ok := token.(string)
		if !ok {
			t.Fatalf("404 body key token = %#v, want string", token)
		}
		keys = append(keys, key)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("decode 404 value for %q: %v", key, err)
		}
	}
	want := []string{"statusCode", "message", "error", "traceId", "path", "timestamp"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("404 body key order = %v, want %v", keys, want)
	}
}

// assertNest404Timestamp asserts new Date().toISOString() shape: UTC, exactly
// three fractional digits and a literal Z.
func assertNest404Timestamp(t *testing.T, timestamp string) {
	t.Helper()
	if len(timestamp) != 24 || !strings.HasSuffix(timestamp, "Z") {
		t.Fatalf("timestamp %q is not ISO milliseconds with Z", timestamp)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", timestamp); err != nil {
		t.Fatalf("parse timestamp %q: %v", timestamp, err)
	}
}

// counterValue reads one labeled series from the process registry.
func counterValue(t *testing.T, name, labelName, labelValue string) float64 {
	t.Helper()
	needle := name + `{` + labelName + `="` + labelValue + `"}`
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if !strings.HasPrefix(line, needle) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("unexpected exposition line %q", line)
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			t.Fatalf("parse counter value from %q: %v", line, err)
		}
		return value
	}
	return 0
}

func rejectedCounterValue(t *testing.T, routePrefix string) float64 {
	t.Helper()
	return counterValue(t, "api_go_legacy_rejected_requests_total", "route_prefix", routePrefix)
}

func proxiedCounterValue(t *testing.T, routePrefix string) float64 {
	t.Helper()
	return counterValue(t, "api_go_legacy_proxy_requests_total", "route_prefix", routePrefix)
}

// TestRejectModeWritesNestNotFoundBody anchors the response contract: status,
// headers, member order, message text with the query string, trace id
// correlation and the timestamp shape.
func TestRejectModeWritesNestNotFoundBody(t *testing.T) {
	upstream := newFallbackUpstream(t)

	var recorded struct {
		calls   int
		traceID string
		message string
		uri     string
	}
	record := func(r *http.Request, traceID, message string) {
		recorded.calls++
		recorded.traceID = traceID
		recorded.message = message
		recorded.uri = r.URL.RequestURI()
	}

	gateway := newFallbackGateway(t, upstream.server.URL,
		DefaultRules(ModeShadow, ""), LegacyFallbackReject, cors.New("http://console.example"), record)

	rec := serveFallback(t, gateway, http.MethodGet, "/nope?x=1", nil)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want application/json; charset=utf-8", got)
	}
	if got := rec.Header().Get("x-trace-id"); got != fallbackTraceID {
		t.Fatalf("x-trace-id = %q, want %q", got, fallbackTraceID)
	}
	body := rec.Body.Bytes()
	assertNest404KeyOrder(t, body)
	if !strings.HasPrefix(string(body),
		`{"statusCode":404,"message":"Cannot GET /nope?x=1","error":"Not Found","traceId":"`+fallbackTraceID+`","path":"/nope?x=1","timestamp":"`) {
		t.Fatalf("404 body prefix mismatch: %s", body)
	}

	payload := decodeNest404(t, body)
	if payload.StatusCode != http.StatusNotFound {
		t.Fatalf("statusCode = %d, want 404", payload.StatusCode)
	}
	if payload.Message != "Cannot GET /nope?x=1" {
		t.Fatalf("message = %q, want %q", payload.Message, "Cannot GET /nope?x=1")
	}
	if payload.Error != "Not Found" {
		t.Fatalf("error = %q, want %q", payload.Error, "Not Found")
	}
	if payload.TraceID != fallbackTraceID {
		t.Fatalf("traceId = %q, want %q", payload.TraceID, fallbackTraceID)
	}
	if payload.Path != "/nope?x=1" {
		t.Fatalf("path = %q, want /nope?x=1", payload.Path)
	}
	assertNest404Timestamp(t, payload.Timestamp)

	if recorded.calls != 1 {
		t.Fatalf("recorder called %d times, want 1", recorded.calls)
	}
	if recorded.traceID != fallbackTraceID || recorded.message != "Cannot GET /nope?x=1" {
		t.Fatalf("recorder got traceID=%q message=%q", recorded.traceID, recorded.message)
	}
	if recorded.uri != "/nope?x=1" {
		t.Fatalf("recorder request URI = %q, want /nope?x=1", recorded.uri)
	}
	if upstream.count() != 0 {
		t.Fatalf("reject mode reached NestJS %d times, want 0", upstream.count())
	}
}

// TestRejectModeRejectsEveryLegacySource covers each route resolution that ends
// at proxyLegacy in the default rule table.
func TestRejectModeRejectsEveryLegacySource(t *testing.T) {
	upstream := newFallbackUpstream(t)
	gateway := newFallbackGateway(t, upstream.server.URL,
		DefaultRules(ModeShadow, ""), LegacyFallbackReject, cors.New(""), nil)

	cases := []struct {
		name   string
		method string
		target string
	}{
		{"unmatched path", http.MethodGet, "/nope"},
		{"unmatched root", http.MethodGet, "/"},
		{"unmatched /api", http.MethodGet, "/api"},
		{"unmatched under /api/", http.MethodGet, "/api/not-taken/items"},
		{"graphql legacy prefix", http.MethodGet, "/graphql"},
		{"socket.io legacy prefix", http.MethodGet, "/socket.io/?EIO=4&transport=polling"},
		{"docs legacy prefix", http.MethodGet, "/docs"},
		{"bull board legacy prefix", http.MethodGet, "/admin/queues"},
		{"shadow probe", http.MethodGet, healthzLivePath},
		{"probe POST falls through to /api/", http.MethodPost, healthzLivePath},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := upstream.count()
			rec := serveFallback(t, gateway, tc.method, tc.target, nil)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s status = %d, want 404", tc.method, tc.target, rec.Code)
			}
			payload := decodeNest404(t, rec.Body.Bytes())
			wantMessage := "Cannot " + tc.method + " " + tc.target
			if payload.Message != wantMessage {
				t.Fatalf("message = %q, want %q", payload.Message, wantMessage)
			}
			if payload.Path != tc.target {
				t.Fatalf("path = %q, want %q", payload.Path, tc.target)
			}
			if got := rec.Header().Get("x-trace-id"); got != fallbackTraceID {
				t.Fatalf("x-trace-id = %q, want %q", got, fallbackTraceID)
			}
			if after := upstream.count(); after != before {
				t.Fatalf("reject mode reached NestJS %d times, want 0", after-before)
			}
		})
	}
}

// TestRejectModeCanaryFallback covers the canary rule: a nil dispatcher, a
// dispatcher that keeps the request on the legacy side, and a canary hit with
// no Go implementation (fail-safe back to legacy) all end in the 404.
func TestRejectModeCanaryFallback(t *testing.T) {
	upstream := newFallbackUpstream(t)
	rules := []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/canary-probe", Mode: ModeCanary, Exact: true},
	}
	gateway := newFallbackGateway(t, upstream.server.URL, rules, LegacyFallbackReject, cors.New(""), nil)

	for _, tc := range []struct {
		name string
		disp ShadowDispatcher
	}{
		{"nil dispatcher", nil},
		{"canary disabled", &fakeDispatcher{}},
		{"canary hit without handler", &fakeDispatcher{canaryGo: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := upstream.count()
			rec := serveFallbackWithShadow(t, gateway, tc.disp, http.MethodGet, "/api/canary-probe")
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", rec.Code)
			}
			payload := decodeNest404(t, rec.Body.Bytes())
			if payload.Message != "Cannot GET /api/canary-probe" {
				t.Fatalf("message = %q, want %q", payload.Message, "Cannot GET /api/canary-probe")
			}
			if after := upstream.count(); after != before {
				t.Fatalf("reject mode reached NestJS %d times, want 0", after-before)
			}
		})
	}
}

// TestRejectModeServeLegacyFromGoHandler covers the handler handoff: a Go route
// that asks for the legacy destination gets the 404, not a proxied request.
func TestRejectModeServeLegacyFromGoHandler(t *testing.T) {
	upstream := newFallbackUpstream(t)
	rules := []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{
			Prefix:  "/api/legacy-handoff",
			Mode:    ModeGo,
			Exact:   true,
			Methods: map[string]bool{http.MethodGet: true},
		},
	}
	gateway := newFallbackGateway(t, upstream.server.URL, rules, LegacyFallbackReject, cors.New(""), nil)
	gateway.RegisterGoHandler("/api/legacy-handoff", func(w http.ResponseWriter, r *http.Request) {
		gateway.ServeLegacy(w, r)
	})

	rec := serveFallback(t, gateway, http.MethodGet, "/api/legacy-handoff", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	payload := decodeNest404(t, rec.Body.Bytes())
	if payload.Message != "Cannot GET /api/legacy-handoff" {
		t.Fatalf("message = %q, want %q", payload.Message, "Cannot GET /api/legacy-handoff")
	}
	if upstream.count() != 0 {
		t.Fatalf("reject mode reached NestJS %d times, want 0", upstream.count())
	}
}

// TestRejectModeHeadHasNoBody pins Express's HEAD behaviour: headers and
// Content-Length describe the GET body, but nothing is written.
func TestRejectModeHeadHasNoBody(t *testing.T) {
	upstream := newFallbackUpstream(t)
	gateway := newFallbackGateway(t, upstream.server.URL,
		DefaultRules(ModeShadow, ""), LegacyFallbackReject, cors.New(""), nil)

	rec := serveFallback(t, gateway, http.MethodHead, "/nope", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD body = %q, want empty", rec.Body.Bytes())
	}
	if got := rec.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want application/json; charset=utf-8", got)
	}
	if rec.Header().Get("content-length") == "" {
		t.Fatal("HEAD response must advertise the GET body length")
	}
	if upstream.count() != 0 {
		t.Fatalf("reject mode reached NestJS %d times, want 0", upstream.count())
	}
}

// TestRejectModeOptions covers the NestJS cors middleware ordering: a real
// preflight is answered 204 before routing, a header-less OPTIONS is a normal
// unmatched request and therefore a 404.
func TestRejectModeOptions(t *testing.T) {
	const origin = "http://console.example"
	upstream := newFallbackUpstream(t)
	gateway := newFallbackGateway(t, upstream.server.URL,
		DefaultRules(ModeShadow, ""), LegacyFallbackReject, cors.New(origin), nil)

	preflight := serveFallback(t, gateway, http.MethodOptions, "/nope", map[string]string{
		"Origin":                        origin,
		"Access-Control-Request-Method": http.MethodGet,
	})
	if preflight.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", preflight.Code)
	}
	if preflight.Body.Len() != 0 {
		t.Fatalf("preflight body = %q, want empty", preflight.Body.Bytes())
	}
	if got := preflight.Header().Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, origin)
	}
	if got := preflight.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials = %q, want true", got)
	}

	plain := serveFallback(t, gateway, http.MethodOptions, "/nope", nil)
	if plain.Code != http.StatusNotFound {
		t.Fatalf("non-preflight OPTIONS status = %d, want 404", plain.Code)
	}
	payload := decodeNest404(t, plain.Body.Bytes())
	if payload.Message != "Cannot OPTIONS /nope" {
		t.Fatalf("message = %q, want %q", payload.Message, "Cannot OPTIONS /nope")
	}
	if upstream.count() != 0 {
		t.Fatalf("reject mode reached NestJS %d times, want 0", upstream.count())
	}
}

// TestRejectModeMetricsCountsRejectedNotProxied pins the cutover counter: the
// rejection uses the same bounded route-family label as the proxy counter, and
// the proxy counter itself stays flat.
func TestRejectModeMetricsCountsRejectedNotProxied(t *testing.T) {
	upstream := newFallbackUpstream(t)
	gateway := newFallbackGateway(t, upstream.server.URL,
		DefaultRules(ModeShadow, ""), LegacyFallbackReject, cors.New(""), nil)

	beforeRejected := rejectedCounterValue(t, "/api")
	beforeProxied := proxiedCounterValue(t, "/api")
	if rec := serveFallback(t, gateway, http.MethodGet, "/api", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rejectedCounterValue(t, "/api"); got != beforeRejected+1 {
		t.Fatalf("api_go_legacy_rejected_requests_total{route_prefix=\"/api\"} = %v, want %v", got, beforeRejected+1)
	}
	if got := proxiedCounterValue(t, "/api"); got != beforeProxied {
		t.Fatalf("proxy counter changed from %v to %v in reject mode", beforeProxied, got)
	}

	beforeRejected = rejectedCounterValue(t, "/api/items")
	if rec := serveFallback(t, gateway, http.MethodGet, "/api/items/1", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rejectedCounterValue(t, "/api/items"); got != beforeRejected+1 {
		t.Fatalf("api_go_legacy_rejected_requests_total{route_prefix=\"/api/items\"} = %v, want %v", got, beforeRejected+1)
	}
	if upstream.count() != 0 {
		t.Fatalf("reject mode reached NestJS %d times, want 0", upstream.count())
	}
}

// TestProxyModeKeepsForwarding pins the rollback contract: the zero value, the
// explicit "proxy" value, and an unknown value (rejected by config validation
// before it can reach the gateway) all keep the original proxy behaviour,
// including the legacy proxy counter.
func TestProxyModeKeepsForwarding(t *testing.T) {
	cases := []struct {
		name string
		mode *LegacyFallbackMode
	}{
		{"zero value", nil},
		{"explicit proxy", modePtr(LegacyFallbackProxy)},
		{"unknown value", modePtr(LegacyFallbackMode("bogus"))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			upstream := newFallbackUpstream(t)
			gateway, err := New(upstream.server.URL, DefaultRules(ModeShadow, ""))
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if tc.mode != nil {
				gateway.SetLegacyFallback(string(*tc.mode), cors.New(""), nil)
			}

			before := proxiedCounterValue(t, "/api/items")
			rec := serveFallback(t, gateway, http.MethodGet, "/api/items/1?x=1", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 from NestJS", rec.Code)
			}
			if body := strings.TrimSpace(rec.Body.String()); body != `{"upstream":"legacy"}` {
				t.Fatalf("body = %q, want the upstream response", body)
			}
			if upstream.count() != 1 {
				t.Fatalf("upstream received %d requests, want 1", upstream.count())
			}
			if got := proxiedCounterValue(t, "/api/items"); got != before+1 {
				t.Fatalf("legacy proxy counter for /api/items = %v, want %v", got, before+1)
			}
		})
	}
}

// modePtr lets the proxy-mode table distinguish "never called SetLegacyFallback"
// (nil) from an explicit value.
func modePtr(mode LegacyFallbackMode) *LegacyFallbackMode { return &mode }
