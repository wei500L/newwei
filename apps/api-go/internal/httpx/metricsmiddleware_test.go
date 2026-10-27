package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestRouteFamilyIsBounded pins the label values. A path parameter, ID, token or
// query string must never survive into the label, because every distinct value
// becomes its own Prometheus series.
func TestRouteFamilyIsBounded(t *testing.T) {
	cases := map[string]string{
		"/api/items":                               "/api/items",
		"/api/items/507f1f77bcf86cd799439011":      "/api/items",
		"/api/crawl-tasks/abc123/media-assets/x/y": "/api/crawl-tasks",
		"/api/":                               "/api",
		"/api":                                "/api",
		"/graphql":                            "/graphql",
		"/socket.io/?EIO=4&transport=polling": "/socket.io",
		"/admin/queues":                       "/admin",
		"/":                                   "/",
		"":                                    "/",
		"/docs":                               "/docs",
		"/api/healthz/live":                   "/api/healthz",
	}
	for path, want := range cases {
		if got := RouteFamily(path); got != want {
			t.Errorf("RouteFamily(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestMetricsMiddlewareRecordsOneObservationPerRequest covers the four things the
// NestJS recordHttpRequestMetric call site guarantees: one sample per request, the
// verbatim method, the bounded route label, and the status the response actually
// wrote.
func TestMetricsMiddlewareRecordsOneObservationPerRequest(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		path       string
		handler    http.HandlerFunc
		wantRoute  string
		wantStatus int
	}{
		{
			name:   "success",
			method: http.MethodGet,
			path:   "/api/items?page=2&search=climate",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			},
			wantRoute:  "/api/items",
			wantStatus: http.StatusOK,
		},
		{
			name:   "error status is the written one",
			method: http.MethodPost,
			path:   "/api/items",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadRequest)
			},
			wantRoute:  "/api/items",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "implicit 200",
			method: http.MethodGet,
			path:   "/graphql",
			handler: func(http.ResponseWriter, *http.Request) {
			},
			wantRoute:  "/graphql",
			wantStatus: http.StatusOK,
		},
		{
			name:   "path parameter does not become a label",
			method: http.MethodGet,
			path:   "/api/items/507f1f77bcf86cd799439011",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNotFound)
			},
			wantRoute:  "/api/items",
			wantStatus: http.StatusNotFound,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var observations []HTTPObservation
			handler := MetricsMiddleware(testCase.handler, func(observation HTTPObservation) {
				observations = append(observations, observation)
			})
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(testCase.method, testCase.path, nil))
			if len(observations) != 1 {
				t.Fatalf("observations = %d, want 1", len(observations))
			}
			got := observations[0]
			if got.Method != testCase.method {
				t.Errorf("method = %q, want %q", got.Method, testCase.method)
			}
			if got.Route != testCase.wantRoute {
				t.Errorf("route = %q, want %q", got.Route, testCase.wantRoute)
			}
			if got.StatusCode != testCase.wantStatus {
				t.Errorf("status = %d, want %d", got.StatusCode, testCase.wantStatus)
			}
			if got.Duration < 0 {
				t.Errorf("duration = %s, want non-negative", got.Duration)
			}
		})
	}
}

// TestMetricsMiddlewareSeesTheGatewayRouteLabel proves the label recorded for a
// request the gateway routed is the one the gateway chose, not a value derived by
// the middleware: the sink is what makes one route keep one series across its
// cutover.
func TestMetricsMiddlewareSeesTheGatewayRouteLabel(t *testing.T) {
	var got HTTPObservation
	handler := MetricsMiddleware(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// A gateway records its own bounded family, which for a migrated route may
			// differ from the path-derived default.
			SetRouteLabel(r.Context(), "/api/items")
			w.WriteHeader(http.StatusCreated)
		}),
		func(observation HTTPObservation) { got = observation },
	)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/items", nil))
	if got.Route != "/api/items" {
		t.Fatalf("route = %q, want /api/items", got.Route)
	}
	if got.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", got.StatusCode)
	}
}

// TestMetricsMiddlewareFallsBackToUnmatched proves an unrouted request records the
// NestJS literal instead of its path, so a scanned or unknown path cannot create a
// Prometheus series.
func TestMetricsMiddlewareFallsBackToUnmatched(t *testing.T) {
	var got HTTPObservation
	handler := MetricsMiddleware(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			// No route table ran, so nothing recorded a label.
			w.WriteHeader(http.StatusNotFound)
		}),
		func(observation HTTPObservation) { got = observation },
	)
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/completely/unknown", nil))
	if got.Route != UnmatchedRouteLabel {
		t.Fatalf("route = %q, want %q", got.Route, UnmatchedRouteLabel)
	}
	if got.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", got.StatusCode)
	}
	// An unset sink reports the same literal, which is what the gateway leaves
	// behind when no rule matched.
	sink := &RouteLabelSink{}
	if sink.Label() != UnmatchedRouteLabel {
		t.Fatalf("unset sink label = %q, want %q", sink.Label(), UnmatchedRouteLabel)
	}
}

// TestMetricsMiddlewareKeepsStreamingObservable proves an SSE response is observed
// when its head is committed rather than never, and that the wrapper still flushes.
func TestMetricsMiddlewareKeepsStreamingObservable(t *testing.T) {
	observations := make(chan HTTPObservation, 1)
	handler := MetricsMiddleware(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			SetRouteLabel(r.Context(), "/api/dashboard")
			flusher, ok := w.(http.Flusher)
			if !ok {
				t.Error("streaming handler lost http.Flusher")
				return
			}
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			flusher.Flush()
		}),
		func(observation HTTPObservation) { observations <- observation },
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/dashboard/stream", nil))
	select {
	case got := <-observations:
		if got.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", got.StatusCode)
		}
		if got.Route != "/api/dashboard" {
			t.Fatalf("route = %q, want /api/dashboard", got.Route)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the SSE response produced no observation")
	}
}

// TestMetricsMiddlewareSkipsHijackedConnections proves a protocol upgrade records no
// latency sample, because Express never emits res "finish" for a connection a
// Socket.IO adapter took over. Recording one would add a series NestJS never had with
// a socket-lifetime duration.
func TestMetricsMiddlewareSkipsHijackedConnections(t *testing.T) {
	probe := newHijackProbe()
	var observations int
	handler := MetricsMiddleware(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			SetRouteLabel(r.Context(), "/socket.io")
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("the upgrade handler lost http.Hijacker")
				return
			}
			// coder/websocket's Accept sequence.
			w.WriteHeader(http.StatusSwitchingProtocols)
			conn, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			_ = conn.Close()
		}),
		func(HTTPObservation) { observations++ },
	)
	handler.ServeHTTP(probe, httptest.NewRequest(http.MethodGet, "/socket.io/?EIO=4", nil))
	if observations != 0 {
		t.Fatalf("a hijacked connection produced %d observations, want 0", observations)
	}
	if !probe.hijacked {
		t.Fatal("the connection was not hijacked")
	}
}
