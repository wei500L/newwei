package aisrelay

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// HTTP surface contract, from the createServer handler in apps/ais-relay/src/index.ts and
// from health.ts: routes, methods, status codes, headers, auth behaviour and the exact
// serialised bodies.

func relayTestHTTPRelay(t *testing.T, configure func(*Config)) (*Relay, *relayTestClock) {
	t.Helper()

	clock := &relayTestClock{millis: relayTestBaseMillis}
	config := relayTestConfig()
	if configure != nil {
		configure(&config)
	}
	return newRelayWithClock(config, clock.now), clock
}

func relayTestRequest(t *testing.T, handler http.Handler, method string, target string, authorization string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(method, target, nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestHTTPSnapshotAuthentication(t *testing.T) {
	cases := []struct {
		name          string
		secret        string
		authorization string
		wantStatus    int
	}{
		// No configured secret disables auth entirely, which is the Node behaviour.
		{"no secret configured", "", "", http.StatusOK},
		{"no secret ignores a supplied token", "", "Bearer anything", http.StatusOK},
		{"secret requires a token", "secret", "", http.StatusUnauthorized},
		{"wrong token", "secret", "Bearer wrong-secret", http.StatusUnauthorized},
		// A token of a different length is rejected by the length check before the
		// constant-time comparison.
		{"shorter token", "secret", "Bearer secret1", http.StatusUnauthorized},
		{"longer token", "secret", "Bearer secre", http.StatusUnauthorized},
		{"correct token", "secret", "Bearer secret", http.StatusOK},
		// The scheme comparison is case insensitive.
		{"lowercase scheme", "secret", "bearer secret", http.StatusOK},
		// The token is trimmed after the seven character prefix.
		{"padded token", "secret", "Bearer   secret   ", http.StatusOK},
		{"wrong scheme", "secret", "Token secret", http.StatusUnauthorized},
		{"scheme only", "secret", "Bearer", http.StatusUnauthorized},
		{"empty token", "secret", "Bearer ", http.StatusUnauthorized},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			relay, _ := relayTestHTTPRelay(t, func(config *Config) {
				config.SharedSecret = testCase.secret
			})
			recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, "/ais/snapshot", testCase.authorization)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
			if testCase.wantStatus == http.StatusUnauthorized {
				const want = `{"error":"Unauthorized"}`
				if got := recorder.Body.String(); got != want {
					t.Fatalf("body = %s, want %s", got, want)
				}
			}
		})
	}
}

// relayTestSeedCandidate loads a single military candidate into the relay state.
//
// With one vessel the snapshot has no density zone (a cell needs two vessels) and no
// chokepoint congestion (five vessels are required), so the body stays small enough to pin
// byte for byte.
func relayTestSeedCandidate(t *testing.T, relay *Relay, clock *relayTestClock) {
	t.Helper()

	clock.set(relayTestBaseMillis)
	relay.engine.markUpstreamOpen()
	relay.engine.processRawMessageLocked([]byte(relayTestPositionReport(111, "USS One", 35, 1, 1, "")))
}

func TestHTTPSnapshotSerialisesBothCandidateVariants(t *testing.T) {
	relay, clock := relayTestHTTPRelay(t, nil)
	relayTestSeedCandidate(t, relay, clock)

	const wantHeader = `{"sequence":1,"timestamp":"2023-11-14T22:13:20.000Z",` +
		`"status":{"connected":true,"vessels":1,"messages":1,"clients":0,"droppedMessages":0},` +
		`"diagnostics":{"healthState":"ok","positionReportsSeen":1,"positionReportsProcessed":1,` +
		`"ignoredPositionReports":0,"parseErrors":0,` +
		`"lastHealthyAt":"2023-11-14T22:13:20.000Z","lastConnectedAt":"2023-11-14T22:13:20.000Z",` +
		`"lastMessageAt":"2023-11-14T22:13:20.000Z"},` +
		`"disruptions":[],"density":[],`
	const vessel = `{"mmsi":"111","name":"USS One","lat":1,"lon":1,"shipType":35,` +
		`"timestamp":1700000000000}`

	// candidates=true carries the candidate reports.
	withCandidates := relayTestRequest(t, relay.Handler(), http.MethodGet, "/ais/snapshot?candidates=true", "")
	if withCandidates.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", withCandidates.Code)
	}
	wantWith := wantHeader + `"candidateReports":[` + vessel + `],"vessels":[` + vessel + `]}`
	if got := withCandidates.Body.String(); got != wantWith {
		t.Fatalf("body mismatch\n got: %s\nwant: %s", got, wantWith)
	}

	// Any other value, including no parameter at all, serves the empty candidate array.
	for _, target := range []string{"/ais/snapshot", "/ais/snapshot?candidates=false", "/ais/snapshot?candidates=1"} {
		recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, target, "")
		wantWithout := wantHeader + `"candidateReports":[],"vessels":[` + vessel + `]}`
		if got := recorder.Body.String(); got != wantWithout {
			t.Fatalf("%s body mismatch\n got: %s\nwant: %s", target, got, wantWithout)
		}
	}
}

func TestHTTPSnapshotHeaders(t *testing.T) {
	relay, clock := relayTestHTTPRelay(t, func(config *Config) {
		config.SnapshotCacheTTL = 5 * time.Second
	})
	relayTestSeedCandidate(t, relay, clock)

	recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, "/ais/snapshot", "")
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	// max-age mirrors the snapshot cadence: floor(5000/1000) = 5.
	if got := recorder.Header().Get("Cache-Control"); got != "private, max-age=5" {
		t.Fatalf("Cache-Control = %q, want private, max-age=5", got)
	}
}

func TestHTTPHealthReportsVerdictInBodyWithStatus200(t *testing.T) {
	// With no upstream connection the relay is degraded, but /health still answers 200 so a
	// container probe does not restart a reachable process.
	relay, _ := relayTestHTTPRelay(t, nil)

	for _, target := range []string{"/", "/health"} {
		recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, target, "")
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", target, recorder.Code)
		}
		body := recorder.Body.String()
		for _, want := range []string{
			`"status":"degraded"`,
			`"connected":false`,
			`"vessels":0`,
			`"messages":0`,
			`"droppedMessages":0`,
			`"densityZones":0`,
			`"sharedSecretEnabled":false`,
			`"diagnostics":{"healthState":"degraded","statusReasonCode":"ais_upstream_disconnected"`,
		} {
			if !strings.Contains(body, want) {
				t.Fatalf("%s body = %s, want it to contain %s", target, body, want)
			}
		}
	}
}

func TestHTTPLivenessBody(t *testing.T) {
	relay, _ := relayTestHTTPRelay(t, nil)

	recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, "/healthz/live", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	const want = `{"status":"ok","service":"ais-relay","now":"2023-11-14T22:13:20.000Z"}`
	if got := recorder.Body.String(); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
}

func TestHTTPMethodHandling(t *testing.T) {
	relay, _ := relayTestHTTPRelay(t, nil)
	handler := relay.Handler()

	// OPTIONS answers 204 with only the CORS method and header allow-lists. The Node relay
	// deliberately sends no Access-Control-Allow-Origin.
	options := relayTestRequest(t, handler, http.MethodOptions, "/ais/snapshot", "")
	if options.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS status = %d, want 204", options.Code)
	}
	if got := options.Header().Get("Access-Control-Allow-Methods"); got != "GET, OPTIONS" {
		t.Fatalf("Access-Control-Allow-Methods = %q", got)
	}
	if got := options.Header().Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type" {
		t.Fatalf("Access-Control-Allow-Headers = %q", got)
	}
	if got := options.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want it absent", got)
	}
	if options.Body.Len() != 0 {
		t.Fatalf("OPTIONS body = %q, want empty", options.Body.String())
	}

	// Any other method is rejected with 405 and an Allow header.
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
		recorder := relayTestRequest(t, handler, method, "/ais/snapshot", "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d, want 405", method, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != "GET, OPTIONS" {
			t.Fatalf("%s Allow = %q", method, got)
		}
		const want = `{"error":"Method Not Allowed"}`
		if got := recorder.Body.String(); got != want {
			t.Fatalf("%s body = %s, want %s", method, got, want)
		}
	}
}

func TestHTTPUnknownPath(t *testing.T) {
	relay, _ := relayTestHTTPRelay(t, nil)

	for _, target := range []string{"/does-not-exist", "/ais/snapshot/extra", "/healthz", "/health/live"} {
		recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, target, "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", target, recorder.Code)
		}
		const want = `{"error":"Not Found"}`
		if got := recorder.Body.String(); got != want {
			t.Fatalf("%s body = %s, want %s", target, got, want)
		}
	}
}

func TestHTTPPathMatchingKeepsPercentEncoding(t *testing.T) {
	// The Node relay compares the raw pathname from new URL(req.url), which does not decode
	// percent escapes, so "%61is" is not "/ais" and the request is a 404.
	relay, _ := relayTestHTTPRelay(t, nil)

	recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, "/%61is/snapshot", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func TestHTTPErrorResponsesUseJSONContentType(t *testing.T) {
	relay, _ := relayTestHTTPRelay(t, func(config *Config) {
		config.SharedSecret = "secret"
	})

	recorder := relayTestRequest(t, relay.Handler(), http.MethodGet, "/ais/snapshot", "Bearer wrong")
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
}
