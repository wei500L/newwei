package httpx

import (
	"net/http"
	"time"
)

// HTTPObservation is one finished request, as the metrics middleware measures it.
type HTTPObservation struct {
	// Method is the request method, verbatim.
	Method string
	// Route is the bounded route label the gateway resolved for this request, or
	// UnmatchedRouteLabel. It is never the raw URL.
	Route string
	// StatusCode is the status the response actually wrote.
	StatusCode int
	// Duration is the wall time from entering the middleware to the status line
	// being committed.
	Duration time.Duration
}

// MetricsMiddleware measures every request and hands the observation to record.
//
// The recording function is injected rather than called directly: internal/metrics
// imports internal/authhttp, which imports this package, so a direct call would
// close an import cycle.
//
// # Semantics copied from recordHttpRequestMetric
//
// apps/api/src/main.ts:78-105 observes one http_request_duration_seconds sample
// per finished response, labelled with:
//
//   - method: req.method unchanged;
//   - route: req.route?.path, else the literal "unmatched". The literal is
//     deliberate: a raw path carries IDs, tokens and query strings, and each
//     distinct value would become its own Prometheus series;
//   - statusCode: the status the response ended with.
//
// durationMs is Date.now() minus the observer's start. This middleware measures
// to the status line, where the metrics package converts milliseconds to the
// histogram's seconds.
//
// # How the route label is resolved
//
// The label is not derived here: the gateway records it while matching its own
// route table, through the sink installed below (SetRouteLabel). A request no
// rule claims keeps UnmatchedRouteLabel. Using the gateway's own bounded family
// keeps one series per route while it moves from the NestJS proxy to a Go
// handler.
//
// # Streaming and hijacked connections
//
// The wrapper fires on the first WriteHeader/Write/Flush, so an SSE response is
// observed when its head is committed and a WebSocket at its 101. Both keep the
// real writer's capabilities; see Wrap.
func MetricsMiddleware(next http.Handler, record func(HTTPObservation)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		ctx, sink := WithRouteLabelSink(r.Context())
		status := 0
		// The metrics observation does not depend on header ownership: a hijacked upgrade
		// is still one request with one status.
		wrapped, ensure := Wrap(w, func(code int, _ bool) { status = code })
		next.ServeHTTP(wrapped, r.WithContext(ctx))
		ensure()
		if status == 0 {
			// Nothing was written, so net/http answers an implicit 200.
			status = http.StatusOK
		}
		if record == nil {
			return
		}
		record(HTTPObservation{
			Method:     r.Method,
			Route:      sink.Label(),
			StatusCode: status,
			Duration:   time.Since(started),
		})
	})
}
