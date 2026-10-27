package httpx

import (
	"bufio"
	"net"
	"net/http"
	"testing"
	"time"
)

// hijackProbe is a ResponseWriter that records whether a hijack happened and what
// the handler had written before it. It implements both http.Flusher and
// http.Hijacker, which is what net/http's real writer offers.
type hijackProbe struct {
	header   http.Header
	status   int
	hijacked bool
	written  string
}

func newHijackProbe() *hijackProbe { return &hijackProbe{header: http.Header{}} }

func (h *hijackProbe) Header() http.Header { return h.header }

func (h *hijackProbe) WriteHeader(status int) {
	if h.status == 0 {
		h.status = status
	}
}

func (h *hijackProbe) Write(p []byte) (int, error) {
	if h.status == 0 {
		h.status = http.StatusOK
	}
	h.written += string(p)
	return len(p), nil
}

func (h *hijackProbe) Flush() {}

func (h *hijackProbe) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	client, server := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

// TestWrapPreservesHijackForUpgrade proves the wrapper does not break the WebSocket
// 101 path: coder/websocket's http.Hijacker lookup must still succeed through the
// wrapper, and a Go-owned upgrade (which writes 101 through the wrapper first) must
// still have its headers installed.
func TestWrapPreservesHijackForUpgrade(t *testing.T) {
	probe := newHijackProbe()
	var hookStatus int
	headersOwned := true
	wrapped, ensure := Wrap(probe, func(status int, owned bool) {
		hookStatus = status
		headersOwned = owned
	})
	if _, ok := wrapped.(http.Flusher); !ok {
		t.Fatal("wrapped writer lost http.Flusher")
	}
	hijacker, ok := wrapped.(http.Hijacker)
	if !ok {
		t.Fatal("wrapped writer lost http.Hijacker")
	}
	// The coder/websocket Accept sequence: headers, 101, then hijack.
	wrapped.Header().Set("Connection", "Upgrade")
	wrapped.WriteHeader(http.StatusSwitchingProtocols)
	conn, _, err := hijacker.Hijack()
	if err != nil {
		t.Fatalf("hijack: %v", err)
	}
	_ = conn.Close()
	ensure()
	if !probe.hijacked {
		t.Fatal("the underlying writer was not hijacked")
	}
	if hookStatus != http.StatusSwitchingProtocols {
		t.Fatalf("hook status = %d, want 101", hookStatus)
	}
	if !headersOwned {
		t.Fatal("a Go-owned upgrade must report headers as owned so the security headers apply")
	}
}

// TestWrapHijackWithoutWriteHeaderReportsUnownedHeaders covers the reverse proxy's
// upgrade path, where Hijack happens before the upstream head is copied. The status is
// still reported (so the request is measured), but the header map must not be touched,
// or every helmet header would be emitted twice on a proxied WebSocket.
func TestWrapHijackWithoutWriteHeaderReportsUnownedHeaders(t *testing.T) {
	probe := newHijackProbe()
	var hookStatus int
	headersOwned := true
	wrapped, ensure := Wrap(probe, func(status int, owned bool) {
		hookStatus = status
		headersOwned = owned
	})
	hijacker, ok := wrapped.(http.Hijacker)
	if !ok {
		t.Fatal("wrapped writer lost http.Hijacker")
	}
	// httputil.ReverseProxy hijacks first and copies the upstream head afterwards.
	conn, _, err := hijacker.Hijack()
	if err != nil {
		t.Fatalf("hijack: %v", err)
	}
	_ = conn.Close()
	ensure()
	if hookStatus != http.StatusSwitchingProtocols {
		t.Fatalf("hook status = %d, want 101", hookStatus)
	}
	if headersOwned {
		t.Fatal("a proxy-hijacked upgrade must report headers as not owned")
	}
}

// TestWrapDoesNotInventCapabilities proves the opposite: a writer without Flush or
// Hijack keeps neither, so a handler that needs them still fails loudly instead of
// silently no-oping.
func TestWrapDoesNotInventCapabilities(t *testing.T) {
	// httptest.ResponseRecorder implements neither Flush-through-assertion nor
	// Hijack in a way this test wants to rely on, so use a bare writer.
	bare := &bareWriter{header: http.Header{}}
	wrapped, _ := Wrap(bare, func(int, bool) {})
	if _, ok := wrapped.(http.Flusher); ok {
		t.Error("Wrap advertised http.Flusher on a non-flushing writer")
	}
	if _, ok := wrapped.(http.Hijacker); ok {
		t.Error("Wrap advertised http.Hijacker on a non-hijacking writer")
	}
	if _, _, err := http.NewResponseController(wrapped).Hijack(); err == nil {
		t.Error("ResponseController.Hijack succeeded through a writer that cannot hijack")
	}
}

// bareWriter is a ResponseWriter with no optional capabilities.
type bareWriter struct {
	header http.Header
	status int
}

func (b *bareWriter) Header() http.Header { return b.header }
func (b *bareWriter) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}
func (b *bareWriter) Write(p []byte) (int, error) { return len(p), nil }

// TestWrapRunsTheHookOnceAtTheFirstCommit pins the three ways a response commits
// (WriteHeader, bare Write, Flush) and the ensure fallback for a handler that
// writes nothing.
func TestWrapRunsTheHookOnceAtTheFirstCommit(t *testing.T) {
	t.Run("WriteHeader then Write", func(t *testing.T) {
		probe := newHijackProbe()
		calls := 0
		wrapped, ensure := Wrap(probe, func(int, bool) { calls++ })
		wrapped.WriteHeader(http.StatusCreated)
		_, _ = wrapped.Write([]byte("x"))
		wrapped.(http.Flusher).Flush()
		ensure()
		if calls != 1 {
			t.Fatalf("hook ran %d times, want 1", calls)
		}
	})
	t.Run("bare Write", func(t *testing.T) {
		probe := newHijackProbe()
		var status int
		wrapped, ensure := Wrap(probe, func(code int, _ bool) { status = code })
		_, _ = wrapped.Write([]byte("x"))
		ensure()
		if status != http.StatusOK {
			t.Fatalf("hook status = %d, want 200", status)
		}
	})
	t.Run("Flush before headers", func(t *testing.T) {
		probe := newHijackProbe()
		var status int
		wrapped, ensure := Wrap(probe, func(code int, _ bool) { status = code })
		wrapped.(http.Flusher).Flush()
		ensure()
		if status != http.StatusOK {
			t.Fatalf("hook status = %d, want 200", status)
		}
	})
	t.Run("nothing written", func(t *testing.T) {
		probe := newHijackProbe()
		var status int
		_, ensure := Wrap(probe, func(code int, _ bool) { status = code })
		ensure()
		if status != http.StatusOK {
			t.Fatalf("hook status = %d, want 200", status)
		}
	})
}

// TestWrapUnwrapReachesTheRealWriter proves http.ResponseController can set a
// write deadline through the wrapper, which is what the dashboard stream does
// after every frame.
func TestWrapUnwrapReachesTheRealWriter(t *testing.T) {
	probe := &deadlineProbe{hijackProbe: newHijackProbe()}
	wrapped, _ := Wrap(probe, func(int, bool) {})
	controller := http.NewResponseController(wrapped)
	if err := controller.SetWriteDeadline(time.Now().Add(time.Minute)); err != nil {
		t.Fatalf("SetWriteDeadline through the wrapper: %v", err)
	}
	if !probe.deadlineSet {
		t.Fatal("the deadline did not reach the real writer")
	}
}

// deadlineProbe is a writer whose SetWriteDeadline is reachable only through
// Unwrap, the way net/http's own *response implements it.
type deadlineProbe struct {
	*hijackProbe
	deadlineSet bool
}

func (d *deadlineProbe) SetWriteDeadline(time.Time) error {
	d.deadlineSet = true
	return nil
}
