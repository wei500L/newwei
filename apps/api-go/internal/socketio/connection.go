package socketio

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	// writeTimeout bounds a single WebSocket frame write. A peer that cannot
	// drain one frame must not stall the serialized writer forever.
	writeTimeout = 5 * time.Second
	// closeReason is the WebSocket close reason used for normal server-initiated
	// shutdowns.
	closeReason = "disconnected"
)

// engineConn is one Engine.IO v4 WebSocket connection carrying zero or more
// Socket.IO namespace sessions. Exactly one goroutine (the HTTP handler that
// accepted it) reads frames and runs Handler callbacks; all writes are
// serialized behind sendMu because Engine.IO frames must not interleave.
type engineConn struct {
	server  *Server
	ws      *websocket.Conn
	request *http.Request
	sid     string

	ctx    context.Context
	cancel context.CancelFunc

	sendMu   sync.Mutex
	lastPong atomic.Int64

	// mu guards the session registry. order preserves CONNECT order, which is
	// the order server-side DISCONNECT packets must follow when the whole
	// connection is torn down (socket.io Client#_disconnect iterates the
	// per-namespace sockets in insertion order).
	mu       sync.Mutex
	sessions map[string]*Session
	order    []*Session
	cleaned  bool

	pingWG sync.WaitGroup
}

func newEngineConn(server *Server, ws *websocket.Conn, request *http.Request) *engineConn {
	ctx, cancel := context.WithCancel(request.Context())
	return &engineConn{
		server:   server,
		ws:       ws,
		request:  request,
		sid:      newSocketID(),
		ctx:      ctx,
		cancel:   cancel,
		sessions: map[string]*Session{},
	}
}

// serve writes the Engine.IO open packet, starts the heartbeat, then reads
// frames until the connection ends. It always runs cleanup before returning.
func (c *engineConn) serve() {
	defer c.cleanup()
	c.ws.SetReadLimit(c.server.maxMessageBytes)
	open := encodeOpen(
		c.sid,
		int(c.server.pingInterval/time.Millisecond),
		int(c.server.pingTimeout/time.Millisecond),
		c.server.maxMessageBytes,
	)
	if err := c.writePacket(open); err != nil {
		return
	}
	// The heartbeat clock starts when the Engine.IO connection opens: a browser
	// that never answers a ping must not stay connected forever.
	c.lastPong.Store(time.Now().UnixNano())
	c.pingWG.Add(1)
	go c.pingLoop()

	// Engine.IO clients may only start using the transport after CONNECT. Before
	// the first namespace connects, cap the wait with ConnectWait; once at least
	// one namespace is live the ordinary connection lifetime applies.
	if err := c.readUntilConnected(); err != nil {
		return
	}
	_ = c.readLoop()
}

// readUntilConnected reads frames until the first namespace CONNECT succeeds.
// Unknown namespaces are answered with CONNECT_ERROR and do not end the wait;
// every other pre-CONNECT Socket.IO packet is an invalid state that closes the
// connection (socket.io/dist/client.js Client#ondecoded).
func (c *engineConn) readUntilConnected() error {
	ctx, cancel := context.WithTimeout(c.ctx, c.server.connectWait)
	defer cancel()
	for {
		packet, err := c.readPacket(ctx)
		if err != nil {
			return err
		}
		switch packet.EngineType {
		case enginePing:
			if err := c.writePacket(string(enginePong)); err != nil {
				return err
			}
		case enginePong:
			c.lastPong.Store(time.Now().UnixNano())
		case engineClose:
			return fmt.Errorf("client closed the engine.io connection")
		case engineMessage:
			if packet.SocketType != socketConnect {
				return fmt.Errorf("socket.io packet type %d before any namespace CONNECT", packet.SocketType)
			}
			connected, err := c.handleConnect(packet)
			if err != nil {
				return err
			}
			if connected {
				return nil
			}
		}
	}
}

// readLoop reads frames for the lifetime of the connection.
func (c *engineConn) readLoop() error {
	for {
		packet, err := c.readPacket(c.ctx)
		if err != nil {
			return err
		}
		switch packet.EngineType {
		case enginePing:
			// Engine.IO v4 servers own the heartbeat, but answering a legacy
			// client ping with a pong is harmless and keeps the transport usable.
			if err := c.writePacket(string(enginePong)); err != nil {
				return err
			}
		case enginePong:
			c.lastPong.Store(time.Now().UnixNano())
		case engineClose:
			return nil
		case engineMessage:
			if err := c.handlePacket(packet); err != nil {
				return err
			}
		}
	}
}

// readPacket reads one Engine.IO frame. Binary WebSocket messages belong to
// binary Socket.IO packets, whose delivery path is not implemented, so they are
// skipped here (the read limit still applies).
func (c *engineConn) readPacket(ctx context.Context) (clientPacket, error) {
	for {
		messageType, data, err := c.ws.Read(ctx)
		if err != nil {
			return clientPacket{}, err
		}
		if messageType != websocket.MessageText {
			continue
		}
		packet, err := parseClientPacket(string(data))
		if err != nil {
			return clientPacket{}, err
		}
		return packet, nil
	}
}

// handlePacket dispatches one Socket.IO packet received after CONNECT.
func (c *engineConn) handlePacket(packet clientPacket) error {
	switch packet.SocketType {
	case socketConnect:
		_, err := c.handleConnect(packet)
		return err
	case socketDisconnect:
		session := c.session(packet.Namespace)
		if session == nil {
			return fmt.Errorf("socket.io DISCONNECT for unconnected namespace %q", packet.Namespace)
		}
		// A client-initiated namespace DISCONNECT closes only this namespace
		// socket; the server does not echo a DISCONNECT packet back.
		c.removeSession(session)
		return nil
	case socketEvent:
		session := c.session(packet.Namespace)
		if session == nil {
			return fmt.Errorf("socket.io EVENT for unconnected namespace %q", packet.Namespace)
		}
		event, args, err := parseEventPayload(packet.Payload)
		if err != nil {
			return err
		}
		if handler := c.server.handler; handler != nil {
			handler.ClientEvent(session, event, args)
		}
		return nil
	case socketAck, socketBinaryEvent, socketBinaryAck:
		// Parsed for protocol completeness; acknowledgements and binary
		// attachments have no delivery path in the Go transports. Unknown
		// namespaces are still a protocol violation.
		if c.session(packet.Namespace) == nil {
			return fmt.Errorf("socket.io packet type %d for unconnected namespace %q", packet.SocketType, packet.Namespace)
		}
		return nil
	default:
		// socketConnectError can only travel from server to client. Receiving it
		// means the browser is in an invalid state; socket.io closes the client.
		return fmt.Errorf("unexpected socket.io packet type %d from client", packet.SocketType)
	}
}

// handleConnect connects one namespace. It returns connected=true when a
// namespace socket is live (including an idempotent duplicate CONNECT). A
// non-nil error closes the whole Engine.IO connection.
func (c *engineConn) handleConnect(packet clientPacket) (bool, error) {
	handler := c.server.handler
	if handler == nil || !handler.Supports(packet.Namespace) {
		// socket.io 4.8.1 answers an unregistered namespace with a
		// CONNECT_ERROR carrying data {"message":"Invalid namespace"} and keeps
		// the Engine.IO connection open (socket.io/dist/client.js Client#connect).
		if err := c.writePacket(encodeConnectError(packet.Namespace, invalidNamespaceMessage)); err != nil {
			return false, err
		}
		return false, nil
	}
	if session := c.session(packet.Namespace); session != nil {
		// Intentional deviation from socket.io 4.8.1, where Client#ondecoded
		// routes a second CONNECT for an already-connected namespace into the
		// "invalid state" branch and closes the whole transport (client.js
		// Client#ondecoded). A real socket.io-client never sends a duplicate
		// CONNECT, and tearing down every namespace because of a spurious frame
		// would be a multiplexing defect in the Go transport. We therefore treat
		// the duplicate as idempotent: no second Session, no second
		// Handler.Connect call, and the CONNECT ack is re-sent with the same sid.
		if err := c.writePacket(encodeConnectAck(packet.Namespace, session.SID)); err != nil {
			return false, err
		}
		return true, nil
	}

	// Socket.IO acknowledges the namespace before the connection handler runs.
	// Nest runs handleConnection (and therefore the auth chain and the business
	// "connected" events) after the ack, so Handler.Connect must be called only
	// once the ack is on the wire.
	session := c.newSession(packet.Namespace)
	if err := c.writePacket(encodeConnectAck(packet.Namespace, session.SID)); err != nil {
		c.removeSession(session)
		return false, err
	}
	session.connectCalled.Store(true)
	if err := handler.Connect(session, packet.Payload); err != nil {
		// The business handler has already written its <namespace>:error event.
		// A namespace Connect failure is disconnect(true) for the whole
		// connection: DISCONNECT for every live namespace in CONNECT order, then
		// close the transport.
		c.disconnectAll()
		return false, err
	}
	return true, nil
}

// newSession registers one namespace socket before its CONNECT ack is written.
func (c *engineConn) newSession(namespace string) *Session {
	ctx, cancel := context.WithCancel(c.ctx)
	session := &Session{
		Namespace: namespace,
		SID:       newSocketID(),
		conn:      c,
		request:   c.request,
		ctx:       ctx,
		cancel:    cancel,
	}
	c.mu.Lock()
	c.sessions[namespace] = session
	c.order = append(c.order, session)
	c.mu.Unlock()
	return session
}

func (c *engineConn) session(namespace string) *Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessions[namespace]
}

// removeSession ends one namespace socket: the context is cancelled and
// Handler.Disconnect is delivered exactly once.
func (c *engineConn) removeSession(session *Session) {
	c.finalizeSession(session)
	c.mu.Lock()
	if c.sessions[session.Namespace] == session {
		delete(c.sessions, session.Namespace)
	}
	c.mu.Unlock()
}

// finalizeSession runs the exactly-once disconnect tail for a session. It is
// safe to call for sessions that were never connected: connectCalled gates the
// Handler.Disconnect callback.
func (c *engineConn) finalizeSession(session *Session) {
	if !session.closed.CompareAndSwap(false, true) {
		return
	}
	session.cancel()
	if !session.connectCalled.Load() {
		return
	}
	if handler := c.server.handler; handler != nil {
		handler.Disconnect(session)
	}
}

// shutdownTransport closes the underlying WebSocket without writing any
// Socket.IO DISCONNECT packet. This is the server-shutdown path: socket.io
// 4.8.1 Server#close does not call socket.disconnect(); it only runs
// Socket#_onclose("server shutting down") locally, closes the adapters and then
// closes the Engine.IO transports (socket.io/dist/index.js:483-494). The browser
// therefore observes "transport close" and the Manager keeps its reconnection
// behaviour, so a rolling API restart recovers without a page reload. That is
// different from disconnectAll (socket.disconnect(true)), which writes
// 41/<ns>, and leaves the browser in the "io server disconnect" state where no
// automatic reconnection happens.
//
// Session contexts are cancelled and Handler.Disconnect fires exactly once per
// connected namespace once the read loop observes the closed transport; see
// cleanup.
func (c *engineConn) shutdownTransport() {
	_ = c.ws.Close(websocket.StatusNormalClosure, "server shutting down")
}

// disconnectAll implements socket.disconnect(true) for the whole connection:
// write a DISCONNECT packet for every live namespace in CONNECT order, close the
// underlying WebSocket, then cancel all session contexts and deliver one
// Disconnect callback each. cleanup performs the context/callback part once the
// read loop returns.
func (c *engineConn) disconnectAll() {
	c.mu.Lock()
	order := append([]*Session(nil), c.order...)
	c.mu.Unlock()
	for _, session := range order {
		if session.closed.Load() {
			continue
		}
		session.writeDisconnect()
	}
	_ = c.ws.Close(websocket.StatusNormalClosure, closeReason)
}

// cleanup releases the connection exactly once. It cancels the connection (and
// therefore every session context), closes the transport, joins the heartbeat
// goroutine, then delivers the remaining Disconnect callbacks.
func (c *engineConn) cleanup() {
	c.mu.Lock()
	if c.cleaned {
		c.mu.Unlock()
		return
	}
	c.cleaned = true
	order := append([]*Session(nil), c.order...)
	c.mu.Unlock()

	c.cancel()
	_ = c.ws.Close(websocket.StatusNormalClosure, closeReason)
	c.pingWG.Wait()
	for _, session := range order {
		c.finalizeSession(session)
	}
	c.server.unregister(c)
}

// pingLoop is the Engine.IO v4 heartbeat. The server sends a ping every
// PingInterval; a browser that does not pong within PingInterval+PingTimeout is
// disconnected. Engine.IO treats a heartbeat timeout as a transport failure, so
// no Socket.IO DISCONNECT packets are written.
func (c *engineConn) pingLoop() {
	defer c.pingWG.Done()
	ticker := time.NewTicker(c.server.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			last := time.Unix(0, c.lastPong.Load())
			if time.Since(last) > c.server.pingInterval+c.server.pingTimeout {
				_ = c.ws.Close(websocket.StatusNormalClosure, "ping timeout")
				return
			}
			if err := c.writePacketContext(c.ctx, string(enginePing)); err != nil {
				return
			}
		}
	}
}

// writePacket serializes one text frame on the connection.
func (c *engineConn) writePacket(packet string) error {
	return c.writePacketContext(context.Background(), packet)
}

// writePacketContext serializes one text frame. The caller context allows the
// heartbeat to abort a write once the connection is shutting down.
func (c *engineConn) writePacketContext(parent context.Context, packet string) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	ctx, cancel := context.WithTimeout(parent, writeTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, []byte(packet))
}
