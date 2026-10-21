package socketio

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
)

// errSessionClosed is returned by Session.Send once the namespace socket has
// been disconnected. Callers normally log and drop the event.
var errSessionClosed = errors.New("socketio: session is closed")

// Session is one Socket.IO namespace socket multiplexed on a single Engine.IO
// connection. A connection owns one Session per connected namespace; each has
// its own SID, context and disconnect lifecycle.
//
// Handler callbacks receive the Session pointer and may retain it (for example
// in a local room index) until Disconnect is called. Session methods are safe
// for concurrent use.
type Session struct {
	// Namespace is the Socket.IO namespace served by this session, including
	// the leading slash (for example "/newsnow").
	Namespace string
	// SID is the Socket.IO socket id reported to the browser in the CONNECT
	// acknowledgement. It is unique per namespace socket, not per connection.
	SID string

	conn    *engineConn
	request *http.Request
	ctx     context.Context
	cancel  context.CancelFunc

	// closed is set once the session has been removed from the connection and
	// its Disconnect callback (if any) is being delivered. It makes the
	// disconnect lifecycle exactly-once.
	closed atomic.Bool
	// connectCalled records that Handler.Connect was invoked for this session.
	// A namespace that never got that far (for example the CONNECT ack write
	// failed) must not receive a Disconnect callback.
	connectCalled atomic.Bool
	// disconnectSent records that the server has written the DISCONNECT packet
	// for this namespace.
	disconnectSent atomic.Bool
}

// Send encodes and writes one Socket.IO EVENT to this namespace socket. The
// payload must be the caller-marshalled JSON bytes; nil or empty payload bytes
// produce an event without arguments. Send is serialized with every other write
// on the underlying Engine.IO connection, so events from different namespace
// sockets never interleave inside one frame.
func (s *Session) Send(event string, payloadJSON []byte) error {
	if s == nil || s.closed.Load() {
		return errSessionClosed
	}
	packet, err := encodeEvent(s.Namespace, event, payloadJSON)
	if err != nil {
		return err
	}
	return s.conn.writePacket(packet)
}

// Context returns the session-scoped context. It is cancelled when this
// namespace socket disconnects, either because the browser sent DISCONNECT, the
// server disconnected the socket, or the Engine.IO connection closed.
func (s *Session) Context() context.Context {
	if s == nil {
		return context.Background()
	}
	return s.ctx
}

// Request returns the HTTP request that opened the Engine.IO connection. It
// carries the handshake headers (Origin, Authorization, ...) and query.
func (s *Session) Request() *http.Request {
	if s == nil {
		return nil
	}
	return s.request
}

// Disconnect implements the server-side socket.disconnect(true) semantics: it
// asks the connection to write a DISCONNECT packet for every connected
// namespace (in CONNECT order), close the underlying WebSocket, cancel all
// session contexts and deliver one Disconnect callback per connected namespace.
//
// Upstream note: socket.io 4.8.1 Socket#disconnect(true) delegates to
// Client#_disconnect, which iterates this.sockets and writes one DISCONNECT per
// namespace socket before closing the transport. This method mirrors that
// broadcast form rather than only disconnecting the receiver.
//
// Server.Close uses the other shutdown path: it only closes the Engine.IO
// transport without DISCONNECT packets (socket.io Server#close,
// dist/index.js:483-494), so the browser sees "transport close" and reconnects
// instead of the "io server disconnect" caused by disconnect(true).
//
// Disconnect is idempotent; calling it on an already disconnected session is a
// no-op and does not tear down the other namespaces.
func (s *Session) Disconnect() {
	if s == nil || s.closed.Load() {
		return
	}
	s.conn.disconnectAll()
}

// writeDisconnect writes the DISCONNECT packet for this namespace at most once.
func (s *Session) writeDisconnect() {
	if !s.disconnectSent.CompareAndSwap(false, true) {
		return
	}
	_ = s.conn.writePacket(encodeDisconnect(s.Namespace))
}
