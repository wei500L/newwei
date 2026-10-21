//go:build integration

// Package realtimeintegration holds black-box integration tests for the Go
// realtime transport. It is compiled only with the integration build tag and
// never imported by production code.
//
// The package contains a minimal Engine.IO v4 / Socket.IO v5 client because the
// repository must not add a Socket.IO client dependency: the Web console uses
// socket.io-client 4.8.1 while the Go module already vendors coder/websocket.
// The client implements only the frames the Go transport emits:
//
//	0 open, 1 close, 2 ping (answered with pong), 3 pong, 4 message
//	40 connect / 40 connect ack, 41 disconnect, 42 event, 44 connect_error
//
// Every helper fails the test through t.Fatalf (t.Helper style) so a broken
// transport produces a readable message instead of a hanging CI job.
package realtimeintegration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const (
	// dialTimeout bounds the WebSocket upgrade; the CI services are local so a
	// healthy handshake completes in milliseconds.
	dialTimeout = 5 * time.Second
	// defaultFrameTimeout is the per-frame wait used by the tests. The task
	// allows at most 5s per assertion, which keeps a faulty build from hanging
	// the CI job.
	defaultFrameTimeout = 3 * time.Second
	// clientSubBuffer keeps per-namespace delivery buffered so the single
	// reader goroutine never blocks on an idle test (events are consumed in
	// order by the assertion helpers).
	clientSubBuffer = 256
)

// engineOpen mirrors the Engine.IO v4 open packet written by the server.
type engineOpen struct {
	SID          string   `json:"sid"`
	Upgrades     []string `json:"upgrades"`
	PingInterval int64    `json:"pingInterval"`
	PingTimeout  int64    `json:"pingTimeout"`
	MaxPayload   int64    `json:"maxPayload"`
}

// frame is one decoded Socket.IO frame observed on the client connection.
// Non-message Engine.IO frames are recorded with an empty SocketType so tests
// can assert protocol behaviour (for example the absence of an error event).
type frame struct {
	// EngineType is the first Engine.IO byte: "0", "2", "3", "4", ...
	EngineType string
	// SocketType is the Socket.IO type for Engine.IO message frames:
	// "connect", "disconnect", "event", "connect_error" ("" otherwise).
	SocketType string
	// Namespace is the Socket.IO namespace the frame belongs to ("/" when the
	// frame is for the default namespace or carries no namespace).
	Namespace string
	// Event is the event name for "event" frames.
	Event string
	// SID is the namespace socket id for "connect" acknowledgements.
	SID string
	// Args are the JSON arguments of an event (the event name excluded).
	Args []json.RawMessage
	// ConnectError is the decoded connect_error payload (string or object).
	ConnectError json.RawMessage
	// Raw is the complete text frame as received; used for wire-order
	// assertions where the JSON encoder order matters.
	Raw string
}

// payload returns the first event argument, failing the test when the event was
// emitted without arguments.
func (f frame) payload(t *testing.T) json.RawMessage {
	t.Helper()
	if len(f.Args) == 0 {
		t.Fatalf("event %q on namespace %q has no payload (raw=%q)", f.Event, f.Namespace, f.Raw)
	}
	return f.Args[0]
}

// decodePayload unmarshals the first event argument into dst.
func decodePayload[T any](t *testing.T, f frame) T {
	t.Helper()
	var out T
	raw := f.payload(t)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode payload of event %q on namespace %q: %v (raw=%s)", f.Event, f.Namespace, err, raw)
	}
	return out
}

// sioClient is a single Engine.IO WebSocket connection carrying any number of
// multiplexed Socket.IO namespace sockets.
type sioClient struct {
	t       *testing.T
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex

	mu      sync.Mutex
	history []frame
	subs    map[string]chan frame

	open   engineOpen
	closed chan struct{}

	closeOnce  sync.Once
	readerDone chan struct{}
	readErr    error
}

// dialSocketClient upgrades to the Engine.IO endpoint and consumes the open
// packet. wsBaseURL is an httptest.Server URL ("http://..."); path is the
// Socket.IO path served by the transport (for example
// realtimesocket.Path). The returned client keeps reading until close.
func dialSocketClient(t *testing.T, wsBaseURL, path string) *sioClient {
	t.Helper()
	if !strings.HasPrefix(path, "/") {
		t.Fatalf("socket.io path %q must start with /", path)
	}
	wsURL := "ws" + strings.TrimPrefix(wsBaseURL, "http") + strings.TrimSuffix(path, "/") + "/?EIO=4&transport=websocket"
	ctx, cancel := context.WithCancel(context.Background())
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{},
	})
	if err != nil {
		cancel()
		t.Fatalf("dial engine.io %s: %v", wsURL, err)
	}
	client := &sioClient{
		t:          t,
		conn:       conn,
		ctx:        ctx,
		cancel:     cancel,
		subs:       map[string]chan frame{},
		closed:     make(chan struct{}),
		readerDone: make(chan struct{}),
	}
	// The open packet is the first frame engine.io writes; read it
	// synchronously so tests can assert the handshake values before CONNECT.
	open, err := client.readOpen(t)
	if err != nil {
		cancel()
		_ = conn.Close(websocket.StatusNormalClosure, "close after failed handshake")
		t.Fatalf("read engine.io open packet: %v", err)
	}
	client.open = open
	go client.readLoop()
	t.Cleanup(client.close)
	return client
}

// readOpen consumes the "0{...}" frame with a bounded timeout.
func (c *sioClient) readOpen(t *testing.T) (engineOpen, error) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(c.ctx, dialTimeout)
	defer cancel()
	typ, data, err := c.conn.Read(readCtx)
	if err != nil {
		return engineOpen{}, err
	}
	if typ != websocket.MessageText {
		return engineOpen{}, fmt.Errorf("open packet type = %v, want text", typ)
	}
	text := string(data)
	if !strings.HasPrefix(text, "0") {
		return engineOpen{}, fmt.Errorf("first engine.io frame = %q, want open packet", text)
	}
	var open engineOpen
	if err := json.Unmarshal([]byte(text[1:]), &open); err != nil {
		return engineOpen{}, fmt.Errorf("decode open packet %q: %w", text, err)
	}
	if open.SID == "" {
		return engineOpen{}, fmt.Errorf("open packet %q has no sid", text)
	}
	return open, nil
}

// readLoop decodes every subsequent frame, answers engine.io pings and fans
// Socket.IO frames out to the per-namespace subscribers.
func (c *sioClient) readLoop() {
	defer close(c.readerDone)
	for {
		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			c.mu.Lock()
			c.readErr = err
			c.mu.Unlock()
			c.closeOnce.Do(func() { close(c.closed) })
			return
		}
		text := string(data)
		if text == "" {
			continue
		}
		switch text[0] {
		case '2': // server ping: engine.io expects an immediate pong
			if err := c.writeText("3"); err != nil {
				c.mu.Lock()
				c.readErr = err
				c.mu.Unlock()
				c.closeOnce.Do(func() { close(c.closed) })
				return
			}
		case '4':
			decoded, err := decodeSocketFrame(text)
			if err != nil {
				c.mu.Lock()
				c.readErr = err
				c.mu.Unlock()
				c.closeOnce.Do(func() { close(c.closed) })
				return
			}
			c.dispatch(decoded)
		default:
			// open (already consumed), pong, close, noop, upgrade: nothing to
			// dispatch. "1" (engine close) is followed by the read error above.
			c.dispatch(frame{EngineType: text[:1], Namespace: "/", Raw: text})
		}
	}
}

// decodeSocketFrame parses one Engine.IO message frame into a Socket.IO frame.
func decodeSocketFrame(text string) (frame, error) {
	decoded := frame{EngineType: "4", Namespace: "/", Raw: text}
	if len(text) < 2 {
		return decoded, fmt.Errorf("truncated socket.io frame %q", text)
	}
	decoded.SocketType = socketTypeName(text[1])
	if decoded.SocketType == "" {
		return decoded, fmt.Errorf("unsupported socket.io packet type %q in %q", text[1], text)
	}
	rest := text[2:]
	if strings.HasPrefix(rest, "/") {
		if index := strings.IndexByte(rest, ','); index >= 0 {
			decoded.Namespace = rest[:index]
			rest = rest[index+1:]
		} else {
			decoded.Namespace = rest
			rest = ""
		}
	}
	switch decoded.SocketType {
	case "connect":
		var ack struct {
			SID string `json:"sid"`
		}
		if err := json.Unmarshal([]byte(rest), &ack); err != nil {
			return decoded, fmt.Errorf("decode connect ack %q: %w", rest, err)
		}
		decoded.SID = ack.SID
	case "connect_error":
		decoded.ConnectError = json.RawMessage(rest)
	case "event":
		var args []json.RawMessage
		if err := json.Unmarshal([]byte(rest), &args); err != nil {
			return decoded, fmt.Errorf("decode event frame %q: %w", rest, err)
		}
		if len(args) == 0 {
			return decoded, fmt.Errorf("event frame %q has no event name", text)
		}
		if err := json.Unmarshal(args[0], &decoded.Event); err != nil {
			return decoded, fmt.Errorf("decode event name in %q: %w", text, err)
		}
		decoded.Args = args[1:]
	}
	return decoded, nil
}

func socketTypeName(b byte) string {
	switch b {
	case '0':
		return "connect"
	case '1':
		return "disconnect"
	case '2':
		return "event"
	case '3':
		return "ack"
	case '4':
		return "connect_error"
	case '5':
		return "binary_event"
	case '6':
		return "binary_ack"
	default:
		return ""
	}
}

// dispatch records a frame and forwards it to its namespace subscriber.
func (c *sioClient) dispatch(decoded frame) {
	c.mu.Lock()
	c.history = append(c.history, decoded)
	ch := c.subs[decoded.Namespace]
	c.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- decoded:
	default:
		c.t.Logf("client subscriber buffer full for namespace %q, dropping frame %q", decoded.Namespace, decoded.Raw)
	}
}

// subscribe returns (creating on first use) the delivery channel for a
// namespace. All frames of that namespace are delivered in wire order.
func (c *sioClient) subscribe(namespace string) chan frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := c.subs[namespace]
	if ch == nil {
		ch = make(chan frame, clientSubBuffer)
		c.subs[namespace] = ch
	}
	return ch
}

// connectNamespace sends the namespace CONNECT frame with the given auth
// payload and returns the namespace socket id from the CONNECT ack.
func (c *sioClient) connectNamespace(t *testing.T, namespace string, auth any) string {
	t.Helper()
	// Subscribe before writing the CONNECT so a fast CONNECT acknowledgement can
	// never be dropped by the reader goroutine before the wait below starts.
	c.subscribe(namespace)
	encoded, err := json.Marshal(auth)
	if err != nil {
		t.Fatalf("encode namespace auth for %q: %v", namespace, err)
	}
	if err := c.writeText("40" + namespace + "," + string(encoded)); err != nil {
		t.Fatalf("send CONNECT for namespace %q: %v", namespace, err)
	}
	ack := c.waitFrame(t, namespace, defaultFrameTimeout, "namespace CONNECT ack", func(f frame) bool {
		return f.SocketType == "connect" || f.SocketType == "connect_error"
	})
	if ack.SocketType == "connect_error" {
		t.Fatalf("namespace %q CONNECT_ERROR: %s", namespace, ack.ConnectError)
	}
	if ack.SID == "" {
		t.Fatalf("namespace %q CONNECT ack has no sid: %q", namespace, ack.Raw)
	}
	return ack.SID
}

// waitEvent blocks until the event named event arrives on namespace.
func (c *sioClient) waitEvent(t *testing.T, namespace, event string, timeout time.Duration) frame {
	t.Helper()
	return c.waitFrame(t, namespace, timeout, fmt.Sprintf("event %q", event), func(f frame) bool {
		return f.SocketType == "event" && f.Event == event
	})
}

// waitDisconnect blocks until the server writes the namespace DISCONNECT frame.
func (c *sioClient) waitDisconnect(t *testing.T, namespace string, timeout time.Duration) frame {
	t.Helper()
	return c.waitFrame(t, namespace, timeout, "namespace DISCONNECT", func(f frame) bool {
		return f.SocketType == "disconnect"
	})
}

// waitFrame blocks until pred matches a frame of namespace. A timed out wait or
// an unexpectedly closed connection fails the test and includes the observed
// frame history, which makes CI failures debuggable without rerunning locally.
func (c *sioClient) waitFrame(t *testing.T, namespace string, timeout time.Duration, what string, pred func(frame) bool) frame {
	t.Helper()
	ch := c.subscribe(namespace)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case f := <-ch:
			if pred(f) {
				return f
			}
		case <-timer.C:
			t.Fatalf("timed out after %s waiting for %s on namespace %q (frames=%s)", timeout, what, namespace, c.historySummary())
			return frame{}
		case <-c.closed:
			// Frames queued before the close must still be considered: the
			// server writes the error/disconnect frames before closing.
			for {
				select {
				case f := <-ch:
					if pred(f) {
						return f
					}
				default:
					t.Fatalf("connection closed while waiting for %s on namespace %q (frames=%s, readErr=%v)",
						what, namespace, c.historySummary(), c.readError())
					return frame{}
				}
			}
		}
	}
}

// waitClosed blocks until the underlying Engine.IO connection is closed.
func (c *sioClient) waitClosed(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-c.closed:
	case <-time.After(timeout):
		c.t.Fatalf("timed out after %s waiting for the engine.io connection to close (frames=%s)", timeout, c.historySummary())
	}
}

// assertNoEvent fails when an event with the given name was observed on the
// namespace. It is used for the silent-disconnect and cross-org assertions.
func (c *sioClient) assertNoEvent(t *testing.T, namespace, event string) {
	t.Helper()
	for _, f := range c.frames() {
		if f.Namespace == namespace && f.SocketType == "event" && f.Event == event {
			t.Fatalf("unexpected event %q on namespace %q (raw=%q)", event, namespace, f.Raw)
		}
	}
}

// assertNoEventFor fails when an event with the given name arrives on namespace
// within d. It is the cross-org "must not receive" assertion: a delivery that
// happens after the positive assertion of the other org would still be caught.
func (c *sioClient) assertNoEventFor(t *testing.T, namespace, event string, d time.Duration) {
	t.Helper()
	ch := c.subscribe(namespace)
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case f := <-ch:
			if f.SocketType == "event" && f.Event == event {
				t.Fatalf("unexpected event %q on namespace %q within %s (raw=%q)", event, namespace, d, f.Raw)
			}
		case <-timer.C:
			return
		case <-c.closed:
			return
		}
	}
}

// eventCount reports how many events named event were observed on namespace.
func (c *sioClient) eventCount(namespace, event string) int {
	count := 0
	for _, f := range c.frames() {
		if f.Namespace == namespace && f.SocketType == "event" && f.Event == event {
			count++
		}
	}
	return count
}

// frames returns a snapshot of every frame observed so far.
func (c *sioClient) frames() []frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]frame, len(c.history))
	copy(out, c.history)
	return out
}

func (c *sioClient) readError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readErr
}

// historySummary renders the observed frames for failure messages.
func (c *sioClient) historySummary() string {
	frames := c.frames()
	if len(frames) == 0 {
		return "<none>"
	}
	parts := make([]string, 0, len(frames))
	for _, f := range frames {
		switch {
		case f.SocketType == "":
			parts = append(parts, "engine:"+f.EngineType)
		case f.SocketType == "event":
			parts = append(parts, f.Namespace+"::"+f.Event)
		default:
			parts = append(parts, f.Namespace+"::"+f.SocketType)
		}
	}
	return strings.Join(parts, ", ")
}

// writeText serializes one client-to-server frame.
func (c *sioClient) writeText(text string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(c.ctx, dialTimeout)
	defer cancel()
	return c.conn.Write(writeCtx, websocket.MessageText, []byte(text))
}

// close tears the client connection down. It is safe to call more than once.
func (c *sioClient) close() {
	if c == nil {
		return
	}
	c.cancel()
	_ = c.conn.Close(websocket.StatusNormalClosure, "test finished")
	<-c.readerDone
}
