package httpx

import (
	"bufio"
	"net"
	"net/http"
)

// Response is the outcome of wrapping one ResponseWriter: the writer to pass down,
// and the two facts the outer middleware needs after the handler returns.
//
// Header hook and lifecycle are deliberately separate concerns:
//
//   - Hook commits the response head exactly once. headersOwned tells the caller
//     whether this stack still owns the header map at that moment.
//   - Done must be called after the handler returns. It runs Hook for a handler that
//     wrote nothing, so an implicit 200 still gets its headers and its sample.
//   - Hijacked reports whether the connection was taken over by a protocol upgrade.
//     A hijacked response has no "finish" in net/http and none in Express either, so
//     per-request latency recording must skip it.
type Response struct {
	// Writer is the value to hand to the next handler. It keeps exactly the optional
	// capabilities the underlying writer has, and implements Unwrap so
	// http.ResponseController reaches SetWriteDeadline, Flush and Hijack.
	Writer http.ResponseWriter

	base *hookWriter
}

// Wrap builds a Response for w.
//
// hook receives the committed status and whether the header map is still owned by
// this response stack. headersOwned is false only for a protocol upgrade the reverse
// proxy hijacks before copying the upstream head; the security middleware uses it to
// skip a response whose headers the upstream owns.
//
// The writer type is chosen from the underlying writer's real capabilities instead of
// being one type with every method, because a handler that type-asserts http.Flusher
// (the dashboard SSE stream) or a library that asserts http.Hijacker
// (coder/websocket) must get the same answer it would get without the wrapper.
// Advertising a capability the writer cannot provide would turn a real failure into a
// silent no-op and could corrupt a hijacked connection, so a writer with neither
// capability gets the plain wrapper and a non-flushable sink keeps failing loudly.
func Wrap(w http.ResponseWriter, hook func(status int, headersOwned bool)) Response {
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
	return Response{Writer: wrapped, base: base}
}

// Done runs the hook when the handler returned without committing a response, so the
// implicit 200 carries whatever the hook installs. It is a no-op once the hook ran.
func (r Response) Done() { r.base.ensure() }

// Hijacked reports whether the connection was taken over by a protocol upgrade.
func (r Response) Hijacked() bool { return r.base.hijacked }

// hookWriter is the base writer: it runs the hook once and delegates. Flush and
// Hijack live on the capability variants so this type never claims them.
type hookWriter struct {
	dst      http.ResponseWriter
	hook     func(status int, headersOwned bool)
	applied  bool
	hijacked bool
}

// Header passes the real header map through, so a handler that sets an explicit value
// (for example the media CSP) is what the hook observes.
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

// markHijacked records that the connection was taken over.
func (h *hookWriter) markHijacked() { h.hijacked = true }

// flushOnlyWriter is the variant for a writer that can flush but not hijack.
type flushOnlyWriter struct{ *hookWriter }

// Flush runs the hook (a flush commits the response head) and then flushes.
func (f *flushOnlyWriter) Flush() {
	f.fire(http.StatusOK, true)
	f.dst.(http.Flusher).Flush()
}

// hijackOnlyWriter is the variant for a writer that can hijack but not flush.
type hijackOnlyWriter struct{ *hookWriter }

// Hijack takes the connection, reporting the upgrade status without letting the hook
// touch the header map.
//
// The header exclusion matters because two callers reach this method and only one of
// them committed the head through the wrapper:
//
//   - coder/websocket's Accept writes 101 with w.WriteHeader before hijacking, so the
//     hook already ran with headersOwned=true and the Go-owned upgrade carries the
//     security headers.
//   - httputil.ReverseProxy hijacks *before* it copies the upstream response head
//     (net/http/httputil/reverseproxy.go handleUpgradeResponse). Letting the hook
//     install defaults here would put them into the header map the proxy then fills
//     from the upstream, emitting every header twice on a proxied upgrade. The
//     upstream (NestJS) already sent its own, so nothing is missing.
func (h *hijackOnlyWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.markHijacked()
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
	h.markHijacked()
	h.fire(http.StatusSwitchingProtocols, false)
	return h.dst.(http.Hijacker).Hijack()
}
