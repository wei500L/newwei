package socketio

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// defaultPingInterval, defaultPingTimeout and defaultMaxMessageBytes mirror
	// the engine.io 6.6.4 defaults used by the NestJS deployment
	// (node_modules/engine.io/build/server.js). Nest does not override any of
	// them, so the pollable browser timings are identical.
	defaultPingInterval = 25 * time.Second
	defaultPingTimeout  = 20 * time.Second
	// defaultMaxMessageBytes is engine.io's maxHttpBufferSize default of 1e6
	// bytes (1,000,000, not 1<<20). The value is both the handshake maxPayload
	// and the WebSocket read limit.
	defaultMaxMessageBytes int64 = 1_000_000
	// defaultConnectWait bounds how long a fresh Engine.IO connection may stay
	// open without a namespace CONNECT.
	defaultConnectWait = 10 * time.Second
)

// Handler is implemented by the business transports. One process owns one
// Server; the transport routes every namespace through the same Handler.
//
// Callbacks (Connect, Disconnect, ClientEvent) are invoked synchronously from
// the connection goroutine, so they never run concurrently with each other and
// the packet order observed by the browser is deterministic. A callback must
// not block indefinitely: the connection's reader is stopped while it runs.
type Handler interface {
	// Supports reports whether this process serves the namespace (for example
	// "/newsnow"). An unsupported namespace receives
	// CONNECT_ERROR {"message":"Invalid namespace"} and the connection stays
	// open, matching socket.io 4.8.1.
	Supports(namespace string) bool
	// Connect runs after the namespace CONNECT acknowledgement has been written
	// to the browser (the same ordering as NestJS handleConnection). Returning a
	// non-nil error makes the protocol layer write DISCONNECT for every live
	// namespace and close the whole Engine.IO connection (disconnect(true)); the
	// business handler is expected to have written its own <namespace>:error
	// event first.
	Connect(session *Session, authPayload []byte) error
	// Disconnect is called exactly once for every namespace socket that
	// requested Handler.Connect, after its Session context is cancelled and its
	// namespace socket has been removed. It fires for a client namespace
	// DISCONNECT, a transport close, a Connect failure and a server shutdown.
	Disconnect(session *Session)
	// ClientEvent delivers a browser EVENT packet. gateway handlers have no
	// @SubscribeMessage equivalents, so transports usually ignore it; it exists
	// to keep the protocol complete. args is a JSON array holding the event
	// arguments (without the event name).
	ClientEvent(session *Session, event string, args []byte)
}

// Options configures a Server. Zero values fall back to the socket.io 4.8.1 /
// engine.io 6.6.4 defaults.
type Options struct {
	PingInterval    time.Duration // default 25s
	PingTimeout     time.Duration // default 20s
	ConnectWait     time.Duration // default 10s, time before the first namespace CONNECT
	MaxMessageBytes int64         // default 1,000,000 (engine.io maxHttpBufferSize)
}

// Server terminates Engine.IO v4 WebSocket connections and multiplexes Socket.IO
// v5 namespaces over them. It is safe to serve concurrent connections and to
// call Close more than once.
type Server struct {
	handler Handler

	pingInterval    time.Duration
	pingTimeout     time.Duration
	connectWait     time.Duration
	maxMessageBytes int64

	mu      sync.Mutex
	conns   map[*engineConn]struct{}
	closing bool
	wg      sync.WaitGroup

	closeOnce sync.Once
}

// NewServer builds a server. A nil Handler is tolerated: every namespace then
// answers CONNECT_ERROR and no callback is invoked.
func NewServer(handler Handler, options Options) *Server {
	server := &Server{
		handler:         handler,
		pingInterval:    options.PingInterval,
		pingTimeout:     options.PingTimeout,
		connectWait:     options.ConnectWait,
		maxMessageBytes: options.MaxMessageBytes,
		conns:           map[*engineConn]struct{}{},
	}
	if server.pingInterval <= 0 {
		server.pingInterval = defaultPingInterval
	}
	if server.pingTimeout <= 0 {
		server.pingTimeout = defaultPingTimeout
	}
	if server.connectWait <= 0 {
		server.connectWait = defaultConnectWait
	}
	if server.maxMessageBytes <= 0 {
		server.maxMessageBytes = defaultMaxMessageBytes
	}
	return server
}

// ServeHTTP accepts one WebSocket upgrade and serves the Engine.IO connection
// until it closes. The caller is responsible for the path, method, upgrade
// header, EIO=4/transport=websocket and CORS/origin gating; this method performs
// no request filtering beyond the WebSocket handshake itself.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s == nil {
		http.Error(w, "socket.io server is nil", http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is enforced by the caller (the NestJS gateways own the CORS
		// allow-list), so the protocol layer must not reject the upgrade.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	conn := newEngineConn(s, ws, r)
	if !s.register(conn) {
		conn.cancel()
		_ = ws.Close(websocket.StatusTryAgainLater, "server shutting down")
		return
	}
	conn.serve()
}

// Close gracefully shuts the server down by closing every Engine.IO transport.
//
// It deliberately does not write Socket.IO DISCONNECT packets. socket.io 4.8.1
// Server#close only runs Socket#_onclose("server shutting down") locally and then
// closes the adapters and the Engine.IO server (socket.io/dist/index.js:483-494),
// so the browser observes "transport close" and the Manager reconnects according
// to its reconnection settings. A rolling API restart therefore recovers
// automatically, which is the NestJS shutdown behaviour. That differs from the
// server-side disconnect(true) of Session.Disconnect, which writes 41/<ns>, and
// leaves the browser with "io server disconnect" (no automatic reconnection).
//
// Session contexts are cancelled and every connected namespace receives exactly
// one Handler.Disconnect callback before the connection goroutines finish. Close
// waits for the connection goroutines until ctx expires and is idempotent.
func (s *Server) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closing = true
		conns := make([]*engineConn, 0, len(s.conns))
		for conn := range s.conns {
			conns = append(conns, conn)
		}
		s.mu.Unlock()

		for _, conn := range conns {
			conn.shutdownTransport()
		}

		done := make(chan struct{})
		go func() {
			s.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-ctx.Done():
		}
	})
	return nil
}

func (s *Server) register(conn *engineConn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return false
	}
	s.conns[conn] = struct{}{}
	return true
}

func (s *Server) unregister(conn *engineConn) {
	s.mu.Lock()
	delete(s.conns, conn)
	s.mu.Unlock()
}
