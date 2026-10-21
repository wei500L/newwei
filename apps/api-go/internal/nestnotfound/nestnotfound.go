// Package nestnotfound renders the 404 response the NestJS global exception
// filter produces for a request that no route serves.
//
// The Strangler gateway stops being a proxy in two places: the legacy fallback
// "reject" mode (C-9, every former proxy destination is refused) and the
// Go-served /docs routes when SWAGGER_ENABLED is false (C-7). Both must answer
// with the NestJS contract instead of a Go-flavoured error, so the response
// writer lives here and is shared by the gateway and the docs handler.
//
// The contract is derived from
// apps/api/src/common/filters/global-exception.filter.ts:
//
//   - setHeader("x-trace-id", traceId);
//   - status 404 with the member order statusCode, message, error from
//     normalizeResponse(), followed by traceId, path and timestamp;
//   - message is the NestJS unmatched-route NotFoundException text
//     "Cannot <METHOD> <url>", where <url> is request.url (path *and* query);
//   - timestamp is new Date().toISOString(): UTC with milliseconds and Z;
//   - an exception event is recorded on the same best-effort side channel.
//
// CORS is answered before the 404 because the NestJS cors() middleware runs
// before routing: a real preflight OPTIONS request is answered 204 by the
// middleware and never reaches the exception filter.
package nestnotfound

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// isoMillis is the layout of JavaScript Date#toISOString(): always UTC, always
// three fractional digits, always the literal Z suffix.
const isoMillis = "2006-01-02T15:04:05.000Z"

// Recorder receives one rejected request for the NestJS-compatible exception
// event side channel. traceID and message are the exact values written to the
// response. Implementations must not block the HTTP response: the production
// recorder enqueues the Mongo insert on a bounded goroutine.
type Recorder func(r *http.Request, traceID, message string)

// body mirrors the object the NestJS filter serializes. Member order is part of
// the contract, so this stays a struct (encoding/json keeps declaration order)
// rather than a map.
type body struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// Write renders the NestJS unmatched-route response. It first lets the CORS
// policy answer a real preflight request; for every other request it applies the
// actual-request CORS headers (when the origin is allowed) and writes the 404.
// A HEAD request gets the headers and Content-Length but no body, matching
// Express.
func Write(w http.ResponseWriter, r *http.Request, policy cors.Policy, record Recorder) {
	if policy.FinishOptions(w, r) {
		return
	}

	traceID := httpx.TraceIDFromContext(r.Context())
	if traceID == "" {
		// Direct handler tests bypass TraceMiddleware; derive the same value the
		// middleware would have produced.
		traceID = httpx.EnsureTraceID(r.Header.Get("x-trace-id"))
	}
	path := r.URL.RequestURI()
	message := "Cannot " + r.Method + " " + path

	payload, err := json.Marshal(body{
		StatusCode: http.StatusNotFound,
		Message:    message,
		Error:      "Not Found",
		TraceID:    traceID,
		Path:       path,
		Timestamp:  nowISO(),
	})
	if err != nil {
		// Unreachable for this fixed shape; fail closed without a half-written body.
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.Header().Set("x-trace-id", traceID)
	w.Header().Set("content-type", "application/json; charset=utf-8")

	// record before writing so an event is kept even if the client disconnects.
	if record != nil {
		record(r, traceID, message)
	}

	if r.Method == http.MethodHead {
		w.Header().Set("content-length", strconv.Itoa(len(payload)))
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(payload)
}

// nowISO renders the current instant the way new Date().toISOString() does.
func nowISO() string {
	return time.Now().UTC().Format(isoMillis)
}
