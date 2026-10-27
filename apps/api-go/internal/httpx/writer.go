package httpx

import (
	"bufio"
	"net"
	"net/http"
)

// Wrap returns a writer that runs hook exactly once, when the response is
// committed, plus an ensure function the caller must invoke after the wrapped
// handler returns.
//
// hook receives the status the response is committed with and whether the header
// map is still owned by this response stack. headersOwned is false only for one
// case: a protocol upgrade the reverse proxy hijacks before copying the upstream
// head. The security middleware uses it to skip a response whose headers the
// upstream owns; the metrics middleware ignores it and records the status either
// way.
//
// ensure covers the handler that writes nothing: net/http then sends an implicit
// 200 at return, so the hook still has to run while the header map is mutable. It
// is a no-op once the hook has run.
//
// The returned writer keeps exactly the optional capabilities the underlying
// writer has. It is not one type with every method, because a handler that
// type-asserts http.Flusher (the dashboard SSE stream) or a WebSocket library that
// asserts http.Hijacker (coder/websocket) must get the same answer it would get
// without the wrapper. Advertising Flush or Hijack on a writer that cannot provide
// it would turn a real failure into a silent no-op and could corrupt a hijacked
// connection. A writer with neither capability gets the plain wrapper, so a
// non-flushable sink keeps failing loudly.
//
// Every variant implements Unwrap, which is what lets http.ResponseController reach
// SetWriteDeadline, Flush and Hijack through the wrapper.
func Wrap(w http.ResponseWriter, hook func(status int, headersOwned bool)) (http.ResponseWriter, func()) {
	base := &hookWriter{dst: w, hook: hook}
	_, canFlush := w.(http.Flusher)
	_, canHijack := w.(http.Hijacker)
	var wrapped http.ResponseWriter
	switch {
	case canFlush && canHijack:
		wrapped = &flushHijackWriter{hookWriter: base}
	case canFlush:
		wrapped = &flushOnlyWriter{hookWriter: base}
	case canHijack:
		wrapped = &hijackOnlyWriter{hookWriter: base}
	default:
		wrapped = base
	}
	return wrapped, base.ensure
}

// hookWriter is the base writer: it runs the hook once and delegates. Flush and
// Hijack live on the capability variants so this type never claims them.
type hookWriter struct {
	dst     http.ResponseWriter
	hook    func(status int, headersOwned bool)
	applied bool
}

// Header passes the real header map through, so a handler that sets an explicit
// value (for example the media CSP) is what the hook observes.
func (h *hookWriter) Header() http.Header { return h.dst.Header() }

// WriteHeader runs the hook for the first status and then delegates.
func (h *hookWriter) WriteHeader(status int) {
	h.fire(status, true)
	h.dst.WriteHeader(status)
}

// Write runs the hook with the implicit 200 of a bare body write, then delegates.
func (h *hookWriter) Write(p []byte) (int, error) {
	h.fire(http.StatusOK, true)
	return h.dst.Write(p)
}

// Unwrap exposes the real writer to http.ResponseController.
func (h *hookWriter) Unwrap() http.ResponseWriter { return h.dst }

// ensure runs the hook when the handler returned without writing anything.
func (h *hookWriter) ensure() { h.fire(http.StatusOK, true) }

// fire runs the hook at most once.
func (h *hookWriter) fire(status int, headersOwned bool) {
	if h.applied {
		return
	}
	h.applied = true
	if h.hook != nil {
		h.hook(status, headersOwned)
	}
}

// flushOnlyWriter is the variant for a writer that can flush but not hijack.
type flushOnlyWriter struct{ *hookWriter }

// Flush runs the hook (a flush commits the response head) and then flushes.
func (f *flushOnlyWriter) Flush() {
	f.fire(http.StatusOK, true)
	f.dst.(http.Flusher).Flush()
}

// hijackOnlyWriter is the variant for a writer that can hijack but not flush.
type hijackOnlyWriter struct{ *hookWriter }

// Hijack takes the connection, reporting the upgrade status without letting the
// hook touch the header map.
//
// The header-exclusion matters because two callers reach this method and only one
// of them has committed the head through the wrapper:
//
//   - coder/websocket's Accept writes 101 with w.WriteHeader before hijacking, so
//     the hook has already run with headersOwned=true and the Go-owned upgrade
//     carries the security headers.
//   - httputil.ReverseProxy hijacks *before* it copies the upstream response head
//     (net/http/httputil/reverseproxy.go handleUpgradeResponse). Letting the hook
//     install defaults here would put them into the header map that the proxy then
//     fills from the upstream, emitting every header twice on a proxied upgrade.
//     The upstream (NestJS) already sent its own, so nothing is missing.
func (h *hijackOnlyWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.fire(http.StatusSwitchingProtocols, false)
	return h.dst.(http.Hijacker).Hijack()
}

// flushHijackWriter is the variant for a writer that can both flush and hijack.
type flushHijackWriter struct{ *hookWriter }

// Flush mirrors flushOnlyWriter.Flush.
func (f *flushHijackWriter) Flush() {
	f.fire(http.StatusOK, true)
	f.dst.(http.Flusher).Flush()
}

// Hijack mirrors hijackOnlyWriter.Hijack, including why headers are excluded.
func (h *flushHijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.fire(http.StatusSwitchingProtocols, false)
	return h.dst.(http.Hijacker).Hijack()
}
