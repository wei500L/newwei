package socketio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testTimeout = 5 * time.Second

type recordedEvent struct {
	namespace string
	event     string
	args      []byte
}

// recordingHandler is the in-process Handler used by the multiplex tests.
type recordingHandler struct {
	mu            sync.Mutex
	namespaces    map[string]bool
	connectErrors map[string]error
	connects      []string
	connectAuth   map[string][]byte
	disconnects   []string
	events        []recordedEvent
	sessions      map[string]*Session
}

func newRecordingHandler(namespaces ...string) *recordingHandler {
	handler := &recordingHandler{
		namespaces:    map[string]bool{},
		connectErrors: map[string]error{},
		connectAuth:   map[string][]byte{},
		sessions:      map[string]*Session{},
	}
	for _, namespace := range namespaces {
		handler.namespaces[namespace] = true
	}
	return handler
}

func (h *recordingHandler) Supports(namespace string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.namespaces[namespace]
}

func (h *recordingHandler) Connect(session *Session, authPayload []byte) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.connects = append(h.connects, session.Namespace)
	h.connectAuth[session.Namespace] = append([]byte(nil), authPayload...)
	h.sessions[session.Namespace] = session
	return h.connectErrors[session.Namespace]
}

func (h *recordingHandler) Disconnect(session *Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.disconnects = append(h.disconnects, session.Namespace)
}

func (h *recordingHandler) ClientEvent(session *Session, event string, args []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, recordedEvent{
		namespace: session.Namespace,
		event:     event,
		args:      append([]byte(nil), args...),
	})
}

func (h *recordingHandler) connectCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.connects)
}

func (h *recordingHandler) sessionFor(namespace string) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessions[namespace]
}

func (h *recordingHandler) authFor(namespace string) []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]byte(nil), h.connectAuth[namespace]...)
}

func (h *recordingHandler) disconnectNames() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.disconnects...)
}

func (h *recordingHandler) disconnectCount(namespace string) int {
	count := 0
	for _, name := range h.disconnectNames() {
		if name == namespace {
			count++
		}
	}
	return count
}

func (h *recordingHandler) eventCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.events)
}

func (h *recordingHandler) eventAt(index int) recordedEvent {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.events[index]
}

// newTestServer starts an in-process HTTP server backed by a socketio.Server.
func newTestServer(t *testing.T, handler Handler, options Options) (*Server, *httptest.Server) {
	t.Helper()
	server := NewServer(handler, options)
	httpServer := httptest.NewServer(server)
	t.Cleanup(func() {
		httpServer.Close()
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
	return server, httpServer
}

func dialWS(t *testing.T, httpServer *httptest.Server) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	target := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	conn, response, err := websocket.Dial(ctx, target, nil)
	if err != nil {
		t.Fatalf("websocket.Dial() error = %v", err)
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

func readFrame(conn *websocket.Conn) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	messageType, data, err := conn.Read(ctx)
	if err != nil {
		return "", err
	}
	if messageType != websocket.MessageText {
		return "", fmt.Errorf("unexpected WebSocket message type %d", messageType)
	}
	return string(data), nil
}

func mustReadFrame(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	frame, err := readFrame(conn)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return frame
}

func mustWriteFrame(t *testing.T, conn *websocket.Conn, frame string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
		t.Fatalf("write frame %q: %v", frame, err)
	}
}

type engineHandshake struct {
	SID          string   `json:"sid"`
	Upgrades     []string `json:"upgrades"`
	PingInterval int      `json:"pingInterval"`
	PingTimeout  int      `json:"pingTimeout"`
	MaxPayload   int64    `json:"maxPayload"`
}

func readOpen(t *testing.T, conn *websocket.Conn) engineHandshake {
	t.Helper()
	frame := mustReadFrame(t, conn)
	if !strings.HasPrefix(frame, "0") {
		t.Fatalf("first frame = %q, want an engine.io open packet", frame)
	}
	var handshake engineHandshake
	if err := json.Unmarshal([]byte(frame[1:]), &handshake); err != nil {
		t.Fatalf("open packet is not JSON: %v (%s)", err, frame)
	}
	if handshake.SID == "" {
		t.Fatalf("open packet is missing sid: %s", frame)
	}
	return handshake
}

// connectNamespace sends a namespace CONNECT and returns the sid from the ack.
// Engine.IO pings that arrive while waiting are answered with pongs.
func connectNamespace(t *testing.T, conn *websocket.Conn, namespace, authPayload string) string {
	t.Helper()
	frame := "40" + namespace + ","
	if authPayload != "" {
		frame += authPayload
	}
	mustWriteFrame(t, conn, frame)
	prefix := "40" + namespace + ","
	for attempt := 0; attempt < 100; attempt++ {
		reply := mustReadFrame(t, conn)
		if reply == "2" {
			mustWriteFrame(t, conn, "3")
			continue
		}
		if !strings.HasPrefix(reply, prefix) {
			t.Fatalf("expected CONNECT ack for %s, got %q", namespace, reply)
		}
		var body struct {
			SID string `json:"sid"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(reply, prefix)), &body); err != nil {
			t.Fatalf("CONNECT ack for %s is not JSON: %v (%s)", namespace, err, reply)
		}
		if body.SID == "" {
			t.Fatalf("CONNECT ack for %s is missing sid: %s", namespace, reply)
		}
		return body.SID
	}
	t.Fatalf("no CONNECT ack for namespace %s", namespace)
	return ""
}

func waitFor(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func TestDefaultHandshakeOptions(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	handshake := readOpen(t, conn)
	if handshake.PingInterval != 25000 || handshake.PingTimeout != 20000 {
		t.Fatalf("handshake timing = %d/%d, want 25000/20000", handshake.PingInterval, handshake.PingTimeout)
	}
	if handshake.MaxPayload != 1_000_000 {
		t.Fatalf("handshake maxPayload = %d, want 1000000", handshake.MaxPayload)
	}
	if len(handshake.Upgrades) != 0 {
		t.Fatalf("handshake upgrades = %v, want []", handshake.Upgrades)
	}
}

func TestMultiplexIndependentSessions(t *testing.T) {
	handler := newRecordingHandler("/alpha", "/beta")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	alphaSID := connectNamespace(t, conn, "/alpha", `{"token":"alpha-token"}`)
	betaSID := connectNamespace(t, conn, "/beta", "")
	if alphaSID == betaSID {
		t.Fatalf("namespace sockets must have distinct sids: %q", alphaSID)
	}
	waitFor(t, "both Connect callbacks", func() bool { return handler.connectCount() == 2 })
	if got := handler.connectCount(); got != 2 {
		t.Fatalf("Connect calls = %d, want 2", got)
	}
	if got := string(handler.authFor("/alpha")); got != `{"token":"alpha-token"}` {
		t.Fatalf("alpha auth payload = %q", got)
	}
	if got := string(handler.authFor("/beta")); got != "" {
		t.Fatalf("beta auth payload = %q, want empty", got)
	}

	waitFor(t, "both sessions", func() bool {
		return handler.sessionFor("/alpha") != nil && handler.sessionFor("/beta") != nil
	})
	alpha := handler.sessionFor("/alpha")
	beta := handler.sessionFor("/beta")

	if err := alpha.Send("alpha:update", []byte(`{"z":1,"a":2}`)); err != nil {
		t.Fatalf("alpha.Send() error = %v", err)
	}
	if frame := mustReadFrame(t, conn); frame != `42/alpha,["alpha:update",{"z":1,"a":2}]` {
		t.Fatalf("alpha event frame = %q", frame)
	}

	// A client namespace DISCONNECT closes only that namespace socket. The next
	// frame the browser sees must be the beta event, not a DISCONNECT echo.
	mustWriteFrame(t, conn, "41/alpha,")
	waitFor(t, "alpha disconnect callback", func() bool { return handler.disconnectCount("/alpha") == 1 })
	if got := handler.disconnectCount("/beta"); got != 0 {
		t.Fatalf("beta disconnect callbacks = %d, want 0", got)
	}
	if alpha.Context().Err() == nil {
		t.Fatal("alpha session context must be cancelled")
	}
	if beta.Context().Err() != nil {
		t.Fatal("beta session context must stay alive")
	}

	if err := beta.Send("beta:update", []byte(`{"id":"b1"}`)); err != nil {
		t.Fatalf("beta.Send() error = %v", err)
	}
	if frame := mustReadFrame(t, conn); frame != `42/beta,["beta:update",{"id":"b1"}]` {
		t.Fatalf("beta event frame = %q", frame)
	}
	if got := handler.connectCount(); got != 2 {
		t.Fatalf("Connect calls after namespace disconnect = %d, want 2", got)
	}
}

func TestUnknownNamespaceConnectErrorKeepsConnection(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	mustWriteFrame(t, conn, `40/unknown,{"token":"x"}`)
	frame := mustReadFrame(t, conn)
	if frame != `44/unknown,{"message":"Invalid namespace"}` {
		t.Fatalf("CONNECT_ERROR frame = %q", frame)
	}

	// The connection stays open and can still connect a supported namespace.
	connectNamespace(t, conn, "/alpha", "")
	waitFor(t, "Connect callback", func() bool { return handler.connectCount() == 1 })
	if got := handler.connectCount(); got != 1 {
		t.Fatalf("Connect calls = %d, want 1", got)
	}
}

func TestDuplicateNamespaceConnectIsIdempotent(t *testing.T) {
	// Intentional deviation from socket.io 4.8.1 (see handleConnect): a
	// duplicate CONNECT for a live namespace re-sends the existing CONNECT ack
	// with the same sid instead of creating a second Session or closing the
	// multiplexed connection.
	handler := newRecordingHandler("/alpha", "/beta")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	firstSID := connectNamespace(t, conn, "/alpha", `{"token":"first"}`)
	waitFor(t, "first Connect callback", func() bool { return handler.connectCount() == 1 })
	secondSID := connectNamespace(t, conn, "/alpha", `{"token":"second"}`)
	if firstSID != secondSID {
		t.Fatalf("duplicate CONNECT ack sid = %q, want the original %q", secondSID, firstSID)
	}
	if got := handler.connectCount(); got != 1 {
		t.Fatalf("Connect calls = %d, want 1", got)
	}
	if got := string(handler.authFor("/alpha")); got != `{"token":"first"}` {
		t.Fatalf("duplicate CONNECT must not re-run auth with new payload, got %q", got)
	}

	// The multiplexed connection is still usable for other namespaces.
	betaSID := connectNamespace(t, conn, "/beta", "")
	if betaSID == "" || betaSID == firstSID {
		t.Fatalf("beta sid = %q", betaSID)
	}
	waitFor(t, "beta Connect callback", func() bool { return handler.connectCount() == 2 })
	if got := handler.connectCount(); got != 2 {
		t.Fatalf("Connect calls = %d, want 2", got)
	}
}

func TestClientNamespaceDisconnectLeavesOtherNamespaces(t *testing.T) {
	handler := newRecordingHandler("/alpha", "/beta")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)
	connectNamespace(t, conn, "/alpha", "")
	connectNamespace(t, conn, "/beta", "")
	waitFor(t, "both sessions", func() bool {
		return handler.sessionFor("/alpha") != nil && handler.sessionFor("/beta") != nil
	})
	alpha := handler.sessionFor("/alpha")

	mustWriteFrame(t, conn, "41/beta,")
	waitFor(t, "beta disconnect callback", func() bool { return handler.disconnectCount("/beta") == 1 })
	if alpha.Context().Err() != nil {
		t.Fatal("alpha session context must stay alive after a beta DISCONNECT")
	}
	if err := alpha.Send("alpha:update", []byte(`{"id":"a1"}`)); err != nil {
		t.Fatalf("alpha.Send() error = %v", err)
	}
	if frame := mustReadFrame(t, conn); frame != `42/alpha,["alpha:update",{"id":"a1"}]` {
		t.Fatalf("alpha event frame = %q", frame)
	}
	if got := handler.disconnectCount("/alpha"); got != 0 {
		t.Fatalf("alpha disconnect callbacks = %d, want 0", got)
	}
}

func TestSessionDisconnectWritesEveryNamespaceInConnectOrder(t *testing.T) {
	// socket.io 4.8.1 socket.disconnect(true) -> Client#_disconnect writes one
	// DISCONNECT packet per namespace socket in CONNECT order, then closes the
	// transport. Session.Disconnect mirrors that.
	handler := newRecordingHandler("/alpha", "/beta")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)
	connectNamespace(t, conn, "/alpha", "")
	connectNamespace(t, conn, "/beta", "")
	waitFor(t, "both sessions", func() bool {
		return handler.sessionFor("/alpha") != nil && handler.sessionFor("/beta") != nil
	})
	alpha := handler.sessionFor("/alpha")
	beta := handler.sessionFor("/beta")

	go alpha.Disconnect()

	if frame := mustReadFrame(t, conn); frame != "41/alpha," {
		t.Fatalf("first DISCONNECT frame = %q, want 41/alpha,", frame)
	}
	if frame := mustReadFrame(t, conn); frame != "41/beta," {
		t.Fatalf("second DISCONNECT frame = %q, want 41/beta,", frame)
	}
	if frame, err := readFrame(conn); err == nil {
		t.Fatalf("connection should be closed after disconnect(true), got frame %q", frame)
	}

	waitFor(t, "disconnect callbacks", func() bool { return len(handler.disconnectNames()) == 2 })
	names := handler.disconnectNames()
	if names[0] != "/alpha" || names[1] != "/beta" {
		t.Fatalf("Disconnect callback order = %v, want [/alpha /beta]", names)
	}
	if alpha.Context().Err() == nil || beta.Context().Err() == nil {
		t.Fatal("disconnect(true) must cancel every session context")
	}
}

func TestServerCloseClosesTransportWithoutDisconnectFrames(t *testing.T) {
	// socket.io 4.8.1 Server#close only runs Socket#_onclose("server shutting
	// down") locally, then closes the adapters and the engine transports
	// (socket.io/dist/index.js:483-494): it never writes Socket.IO DISCONNECT
	// packets. The browser therefore sees "transport close" and the Manager
	// reconnects according to its settings. Server.Close must mirror that:
	// close the transport silently, unlike Session.Disconnect (disconnect(true))
	// which writes 41/<ns>, for every connected namespace.
	handler := newRecordingHandler("/alpha", "/beta")
	server, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)
	connectNamespace(t, conn, "/alpha", "")
	connectNamespace(t, conn, "/beta", "")
	waitFor(t, "both sessions", func() bool {
		return handler.sessionFor("/alpha") != nil && handler.sessionFor("/beta") != nil
	})
	alpha := handler.sessionFor("/alpha")
	beta := handler.sessionFor("/beta")

	closeDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		closeDone <- server.Close(ctx)
	}()

	// The first frame the client observes must be the WebSocket close frame (a
	// text DISCONNECT packet would mean Server.Close used disconnect(true)
	// semantics and would stop the browser from reconnecting).
	frame, err := readFrame(conn)
	if err == nil {
		t.Fatalf("Server.Close must not write a Socket.IO DISCONNECT packet, got frame %q", frame)
	}
	if status := websocket.CloseStatus(err); status != websocket.StatusNormalClosure {
		t.Fatalf("transport close status = %v, want %v", status, websocket.StatusNormalClosure)
	}

	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Server.Close() error = %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Server.Close() did not return")
	}
	waitFor(t, "disconnect callbacks", func() bool { return len(handler.disconnectNames()) == 2 })
	if alpha.Context().Err() == nil || beta.Context().Err() == nil {
		t.Fatal("Server.Close must cancel every session context")
	}

	// Idempotent close.
	if err := server.Close(context.Background()); err != nil {
		t.Fatalf("second Server.Close() error = %v", err)
	}
	// New upgrades are rejected after shutdown.
	dialCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	target := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	if conn, _, err := websocket.Dial(dialCtx, target, nil); err == nil {
		_ = conn.CloseNow()
		t.Fatal("ServeHTTP accepted a connection after Close")
	}
}

func TestConnectErrorClosesWholeConnection(t *testing.T) {
	handler := newRecordingHandler("/alpha", "/beta")
	handler.connectErrors["/beta"] = errors.New("business connect failed")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)
	connectNamespace(t, conn, "/alpha", "")
	waitFor(t, "alpha session", func() bool { return handler.sessionFor("/alpha") != nil })
	alpha := handler.sessionFor("/alpha")

	// The beta ack is written before Handler.Connect runs, so the client sees
	// the ack and then disconnect(true) for every live namespace.
	mustWriteFrame(t, conn, "40/beta,")
	ack := mustReadFrame(t, conn)
	if !strings.HasPrefix(ack, "40/beta,") {
		t.Fatalf("expected beta CONNECT ack, got %q", ack)
	}
	if frame := mustReadFrame(t, conn); frame != "41/alpha," {
		t.Fatalf("first DISCONNECT frame = %q, want 41/alpha,", frame)
	}
	if frame := mustReadFrame(t, conn); frame != "41/beta," {
		t.Fatalf("second DISCONNECT frame = %q, want 41/beta,", frame)
	}
	if frame, err := readFrame(conn); err == nil {
		t.Fatalf("connection should be closed after a Connect error, got frame %q", frame)
	}

	waitFor(t, "disconnect callbacks", func() bool { return len(handler.disconnectNames()) == 2 })
	if got := handler.disconnectCount("/alpha"); got != 1 {
		t.Fatalf("alpha disconnect callbacks = %d, want 1", got)
	}
	if got := handler.disconnectCount("/beta"); got != 1 {
		t.Fatalf("beta disconnect callbacks = %d, want 1", got)
	}
	if alpha.Context().Err() == nil {
		t.Fatal("Connect failure must cancel every session context")
	}
}

func TestClientEventDispatched(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)
	connectNamespace(t, conn, "/alpha", "")

	mustWriteFrame(t, conn, `42/alpha,["client:event",{"z":1,"a":2}]`)
	waitFor(t, "client event", func() bool { return handler.eventCount() == 1 })
	event := handler.eventAt(0)
	if event.namespace != "/alpha" || event.event != "client:event" {
		t.Fatalf("event = %#v", event)
	}
	if string(event.args) != `[{"z":1,"a":2}]` {
		t.Fatalf("event args = %s", event.args)
	}
}

func TestConnectWaitTimeout(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{ConnectWait: 50 * time.Millisecond})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	started := time.Now()
	if frame, err := readFrame(conn); err == nil {
		t.Fatalf("connection without CONNECT should have been closed, got frame %q", frame)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("ConnectWait close took %v, want roughly 50ms", elapsed)
	}
}

func TestHeartbeatSendsPingAndAcceptsPong(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{
		PingInterval: 25 * time.Millisecond,
		PingTimeout:  10 * time.Second,
	})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	pings := 0
	for attempt := 0; attempt < 100; attempt++ {
		frame := mustReadFrame(t, conn)
		if frame != "2" {
			t.Fatalf("unexpected frame before ping: %q", frame)
		}
		pings++
		mustWriteFrame(t, conn, "3")
		if pings >= 2 {
			break
		}
	}
	if pings < 2 {
		t.Fatalf("pings = %d, want at least 2", pings)
	}

	// The connection stays usable after the heartbeat round-trips.
	connectNamespace(t, conn, "/alpha", "")
	waitFor(t, "Connect callback", func() bool { return handler.connectCount() == 1 })
	if got := handler.connectCount(); got != 1 {
		t.Fatalf("Connect calls = %d, want 1", got)
	}
}

func TestHeartbeatTimeoutClosesConnection(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{
		PingInterval: 20 * time.Millisecond,
		PingTimeout:  20 * time.Millisecond,
	})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	pings := 0
	for attempt := 0; attempt < 200; attempt++ {
		frame, err := readFrame(conn)
		if err != nil {
			if pings == 0 {
				t.Fatalf("connection closed before the first ping: %v", err)
			}
			return
		}
		if frame != "2" {
			t.Fatalf("unexpected frame while waiting for heartbeat timeout: %q", frame)
		}
		pings++
	}
	t.Fatal("connection without pong was not closed")
}

func TestReadLimitRejectsOversizedFrame(t *testing.T) {
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{MaxMessageBytes: 128})
	conn := dialWS(t, httpServer)
	handshake := readOpen(t, conn)
	if handshake.MaxPayload != 128 {
		t.Fatalf("handshake maxPayload = %d, want 128", handshake.MaxPayload)
	}
	connectNamespace(t, conn, "/alpha", "")

	mustWriteFrame(t, conn, strings.Repeat("x", 512))
	if frame, err := readFrame(conn); err == nil {
		t.Fatalf("oversized frame must close the connection, got frame %q", frame)
	}
}

func TestConnectPacketForUnconnectedNamespaceClosesConnection(t *testing.T) {
	// socket.io Client#ondecoded routes any non-CONNECT packet for a namespace
	// without a socket into the "invalid state" branch and closes the transport.
	handler := newRecordingHandler("/alpha")
	_, httpServer := newTestServer(t, handler, Options{})
	conn := dialWS(t, httpServer)
	readOpen(t, conn)

	mustWriteFrame(t, conn, `42/alpha,["client:event",1]`)
	if frame, err := readFrame(conn); err == nil {
		t.Fatalf("EVENT before CONNECT must close the connection, got frame %q", frame)
	}
	if got := handler.connectCount(); got != 0 {
		t.Fatalf("Connect calls = %d, want 0", got)
	}
}
