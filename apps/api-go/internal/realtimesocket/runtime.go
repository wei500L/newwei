// Package realtimesocket implements the five Web console realtime namespaces
// (/newsnow, /ops, /quality, /queue, /situation-monitor) of the Go console on
// the shared Engine.IO multiplexing transport of internal/socketio.
//
// Wire behaviour mirrors the NestJS gateways at the migration baseline
// (1ba22e3b): the same namespaces, per-namespace token precedence, permission
// gates, connection rate limits, failed-authentication backoff, room
// membership, error payloads and the 30s token/identity revalidation (B2).
// Browser events are only handled for /newsnow (newsnow:set-active-sources);
// the other namespaces had no @SubscribeMessage handlers in NestJS.
//
// Cross-instance delivery is out of scope: the local push API below only walks
// the sockets owned by this process (B1). The Redis adapter protocol is owned
// by internal/realtimeevents, which consumes it and calls this package.
package realtimesocket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/socketio"
)

var (
	// errTooManyConnections is the UserSessionManager.register rejection; the
	// browser maps the exact message to TOO_MANY_CONNECTIONS without a retry.
	errTooManyConnections = errors.New(socketio.MessageTooManyConnections)
	// errRuntimeClosing rejects a handshake that races with Close.
	errRuntimeClosing = errors.New("server shutting down")
)

// Runtime owns the Socket.IO server of the realtime path, the per-namespace
// local room indexes and the B2 revalidation cache. It is safe for concurrent
// use and Close may be called more than once.
type Runtime struct {
	server *socketio.Server

	auth    *authenticator
	limiter webSocketLimiter
	cors    cors.Policy

	trustProxy            bool
	maxConnectionsPerUser int
	maxConnectionsPerIP   int

	revalidateInterval time.Duration
	clientEvents       ClientEvents
	revalidation       *revalidationCache

	mu         sync.RWMutex
	namespaces map[string]*namespaceIndex

	closing   atomic.Bool
	closeOnce sync.Once
	closeErr  error

	serveWG      sync.WaitGroup
	revalidateWG sync.WaitGroup
}

// New builds the realtime transport. It opens no connections of its own: the
// MySQL and Redis handles remain owned by main and the HTTP server is mounted
// by the caller through Handles/ServeHTTP.
func New(options Options) (*Runtime, error) {
	if options.Verifier == nil {
		return nil, errors.New("realtimesocket: JWT verifier is required")
	}
	if options.Blacklist == nil {
		return nil, errors.New("realtimesocket: token blacklist is required")
	}
	if options.Authz == nil {
		return nil, errors.New("realtimesocket: authorization repository is required")
	}
	limiter := options.limiter
	if limiter == nil {
		if options.Redis == nil {
			return nil, errors.New("realtimesocket: Redis client is required for connection rate limiting")
		}
		// Zero limits/window fall back to the NestJS WS_* defaults inside the
		// shared limiter (60/IP, 30/user, 60s window).
		limiter = socketio.NewLimiter(
			options.Redis,
			options.ConnectLimitPerIP,
			options.ConnectLimitPerUser,
			options.ConnectWindowSeconds,
		)
	}
	maxConnectionsPerUser := options.MaxConnectionsPerUser
	if maxConnectionsPerUser <= 0 {
		maxConnectionsPerUser = defaultMaxConnectionsPerUser
	}
	maxConnectionsPerIP := options.MaxConnectionsPerIP
	if maxConnectionsPerIP <= 0 {
		maxConnectionsPerIP = defaultMaxConnectionsPerIP
	}
	revalidateInterval := options.RevalidateInterval
	if revalidateInterval <= 0 {
		revalidateInterval = defaultRevalidateInterval
	}
	runtime := &Runtime{
		auth:                  newAuthenticator(options.Verifier, options.Blacklist, options.Authz),
		limiter:               limiter,
		cors:                  options.CORS,
		trustProxy:            options.TrustProxy,
		maxConnectionsPerUser: maxConnectionsPerUser,
		maxConnectionsPerIP:   maxConnectionsPerIP,
		revalidateInterval:    revalidateInterval,
		clientEvents:          options.ClientEvents,
		revalidation:          newRevalidationCache(revalidateInterval),
		namespaces:            make(map[string]*namespaceIndex, len(namespaceSpecs)),
	}
	for namespace := range namespaceSpecs {
		runtime.namespaces[namespace] = newNamespaceIndex()
	}
	runtime.server = socketio.NewServer(runtime, socketio.Options{})
	return runtime, nil
}

// Start is a no-op today: the realtime transport has no background source of
// its own. Event sources (BullMQ streams, the situation bridge, the newsnow
// relay) are owned by internal/realtimeevents and injected by main.
func (r *Runtime) Start(ctx context.Context) error {
	if r == nil {
		return nil
	}
	return nil
}

// Handles reports whether this exact request is the Go realtime Engine.IO
// upgrade. The path is dedicated, so NestJS keeps the remaining namespaces on
// "/socket.io" and the reverse proxy can route by path.
//
// The trailing-slash form is required: engine.io-client normalizes its path to
// a trailing slash, so browsers request "/socket.io-realtime/?EIO=4&...".
func (r *Runtime) Handles(request *http.Request) bool {
	if r == nil || request == nil {
		return false
	}
	if request.Method != http.MethodGet {
		return false
	}
	if request.URL.Path != Path && request.URL.Path != Path+"/" {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") {
		return false
	}
	if !strings.Contains(strings.ToLower(request.Header.Get("Connection")), "upgrade") {
		return false
	}
	if request.URL.Query().Get("EIO") != "4" {
		return false
	}
	return request.URL.Query().Get("transport") == "websocket"
}

// ServeHTTP upgrades one exact realtime request and serves the Engine.IO
// connection. Close drains in-flight upgrades before waiting for the protocol
// server, so a handshake cannot slip in after shutdown started.
func (r *Runtime) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if !r.Handles(request) {
		http.Error(w, "not a realtime socket upgrade", http.StatusBadRequest)
		return
	}
	r.mu.Lock()
	if r.closing.Load() {
		r.mu.Unlock()
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	r.serveWG.Add(1)
	r.mu.Unlock()
	defer r.serveWG.Done()
	r.server.ServeHTTP(w, request)
}

// Close closes every live Engine.IO transport without writing Socket.IO
// DISCONNECT packets, matching socket.io 4.8.1 Server#close: the browser
// observes "transport close" and its Manager reconnects, so a rolling API
// restart recovers the console without a page reload. It waits for the
// connection and revalidation goroutines until ctx expires and is idempotent.
// Session contexts are cancelled and every connected namespace receives one
// Handler.Disconnect callback. The caller-owned MySQL/Redis handles are left
// untouched.
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.closeOnce.Do(func() {
		// Setting closing under the same mutex that gates register/start
		// guarantees no WaitGroup Add can race with the Wait below.
		r.mu.Lock()
		r.closing.Store(true)
		r.mu.Unlock()

		r.closeErr = r.server.Close(ctx)

		done := make(chan struct{})
		go func() {
			r.serveWG.Wait()
			r.revalidateWG.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-ctx.Done():
		}
	})
	return r.closeErr
}

// Supports reports whether this process serves the namespace. The root
// namespace and every other namespace are answered with CONNECT_ERROR
// {"message":"Invalid namespace"} and the connection stays open (socket.io
// semantics implemented by internal/socketio).
func (r *Runtime) Supports(namespace string) bool {
	_, supported := namespaceSpecs[namespace]
	return supported
}

// Connect runs the per-namespace handshake pipeline after the CONNECT
// acknowledgement has been written to the browser. A non-nil error makes the
// protocol layer perform disconnect(true) for the whole Engine.IO connection;
// every rejection path here has already emitted <ns>:error.
func (r *Runtime) Connect(session *socketio.Session, authPayload []byte) error {
	if r == nil || session == nil {
		return errors.New("realtimesocket: nil session")
	}
	spec, supported := namespaceSpecs[session.Namespace]
	if !supported {
		return fmt.Errorf("realtimesocket: unsupported namespace %q", session.Namespace)
	}
	ctx := session.Context()
	request := session.Request()
	ip := socketio.ResolveClientIP(request, r.trustProxy)

	// a. Per-IP sliding-window connect budget (the shared limiter fails open).
	if allowed, retryAfterMS := r.limiter.CheckIP(ctx, ip); !allowed {
		return r.rejectConnection(session, spec, ip, socketio.MessageRateLimitExceeded, retryAfterMS)
	}
	// b. Exponential failed-authentication backoff for this IP.
	if delay := r.limiter.BackoffDelay(ctx, ip); delay > 0 {
		return r.rejectConnection(session, spec, ip, socketio.MessageTooManyFailedAttempts, delay.Milliseconds())
	}
	// c. Application-level origin allow-list. NestJS throws "Origin not allowed",
	// which its catch-all maps to UNAUTHORIZED and records as a failed attempt.
	if origin := socketio.RequestOrigin(request); !r.cors.AllowsOrigin(origin) {
		return r.rejectConnection(session, spec, ip, messageOriginNotAllowed, 0)
	}
	// d. Token extraction with the per-namespace precedence.
	rawToken := socketio.ExtractTokenInOrder(request, authPayload, spec.tokenSources)
	// e. JWT verification.
	token, err := r.auth.verifyToken(rawToken)
	if err != nil {
		return r.rejectAuthError(session, spec, ip, err)
	}
	// f. Per-user connect budget (newsnow and situation-monitor only).
	if spec.userRateLimit {
		if allowed, retryAfterMS := r.limiter.CheckUser(ctx, token.Subject); !allowed {
			return r.rejectConnection(session, spec, ip, socketio.MessageTooManyConnectionAttempt, retryAfterMS)
		}
	}
	// e (continued). Revocation and profile re-derivation, in the gateway order:
	// user bucket first, then blacklist, then the MySQL membership lookup.
	if err := r.auth.ensureNotRevoked(ctx, token.JTI); err != nil {
		return r.rejectAuthError(session, spec, ip, err)
	}
	authorization, err := r.auth.authorize(ctx, token.Subject, token.OrgID)
	if err != nil {
		return r.rejectAuthError(session, spec, ip, err)
	}
	// g. Namespace permission gate. The browser only ever sees UNAUTHORIZED for
	// a missing permission ("Insufficient permissions" must not leak).
	if !spec.allows(authorization) {
		return r.rejectConnection(session, spec, ip, messageInsufficientPermissions, 0)
	}
	// h. Authentication succeeded: clear the per-IP backoff before registering,
	// matching the NestJS clearBackoff position (newsnow.gateway.ts:170).
	r.limiter.ClearBackoff(ctx, ip)
	// i. Register the socket, join the rooms and enforce the per-namespace
	// connection caps of this instance.
	identity := ClientIdentity{
		SocketID: session.SID,
		OrgID:    authorization.OrgID,
		UserID:   authorization.UserID,
	}
	state := newSocketState(session, spec, identity, ip, token.JTI, token.ExpiresAt)
	if err := r.register(state); err != nil {
		return r.rejectConnection(session, spec, ip, err.Error(), 0)
	}
	// j. Announce the identity derived from MySQL, not from token claims.
	if err := r.sendConnected(state); err != nil {
		return err
	}
	// k. Start the B2 revalidation ticker of this socket.
	if !r.startRevalidation(state) {
		return fmt.Errorf("realtimesocket: %s socket rejected because the runtime is shutting down", spec.namespace)
	}
	return nil
}

// Disconnect runs once per namespace socket after its session context has been
// cancelled. It removes the socket from the local index and notifies the client
// event sink (registry cleanup) after the removal, so the registry can never
// retain a socket that is already gone.
func (r *Runtime) Disconnect(session *socketio.Session) {
	if r == nil || session == nil {
		return
	}
	state := r.unregister(session)
	if state == nil || !state.spec.clientEvents || r.clientEvents == nil {
		return
	}
	r.clientEvents.HandleClientDisconnect(session.Namespace, state.identity)
}

// ClientEvent forwards browser EVENT frames to the registered ClientEvents
// sink. Only newsnow:set-active-sources reaches the sink today; every other
// event (and every other namespace) is ignored, matching the gateways that
// register no @SubscribeMessage handler.
func (r *Runtime) ClientEvent(session *socketio.Session, event string, args []byte) {
	if r == nil || session == nil || r.clientEvents == nil {
		return
	}
	spec, supported := namespaceSpecs[session.Namespace]
	if !supported || !spec.clientEvents {
		return
	}
	if event != eventNewsnowSetActiveSources {
		return
	}
	state := r.lookup(session.Namespace, session.SID)
	if state == nil {
		return
	}
	// The protocol layer owns args; copy because the sink may retain the bytes.
	arguments := json.RawMessage(append([]byte(nil), args...))
	r.clientEvents.HandleClientEvent(session.Namespace, state.identity, event, arguments)
}

// connectedPayload is the <ns>:connected body. Field order is part of the
// browser contract: orgId first, then userId.
type connectedPayload struct {
	OrgID  string `json:"orgId"`
	UserID string `json:"userId"`
}

func (r *Runtime) sendConnected(state *socketState) error {
	payload, err := json.Marshal(connectedPayload{
		OrgID:  state.identity.OrgID,
		UserID: state.identity.UserID,
	})
	if err != nil {
		return fmt.Errorf("realtimesocket: marshal %s: %w", state.spec.connectedEvent, err)
	}
	if sendErr := state.session.Send(state.spec.connectedEvent, payload); sendErr != nil {
		return fmt.Errorf("realtimesocket: send %s: %w", state.spec.connectedEvent, sendErr)
	}
	return nil
}

// rejectAuthError turns an authentication-chain error into the namespace error
// event. Business rejections carry their exact message; infrastructure failures
// carry the wrapped error text. Both collapse to UNAUTHORIZED/Unauthorized in
// the wire payload and both count towards the failed-auth backoff, exactly like
// the gateway catch-all.
func (r *Runtime) rejectAuthError(session *socketio.Session, spec *namespaceSpec, ip string, err error) error {
	message, rejected := authRejection(err)
	if !rejected {
		message = err.Error()
	}
	return r.rejectConnection(session, spec, ip, message, 0)
}

// rejectConnection emits the namespace error payload and returns the error that
// makes the protocol layer close the whole Engine.IO connection
// (disconnect(true)). It also records the per-IP failed-authentication backoff
// unless the message belongs to NON_AUTH_BACKOFF_ERROR_MESSAGES.
func (r *Runtime) rejectConnection(session *socketio.Session, spec *namespaceSpec, ip, message string, retryAfterMS int64) error {
	if shouldRecordFailedAuth(message) {
		r.limiter.RecordFailure(session.Context(), ip)
	}
	payload, err := json.Marshal(socketio.NewErrorPayload(message, retryAfterMS))
	if err == nil {
		// The protocol layer closes the connection right after Connect returns;
		// a failed write only means the browser is already gone.
		_ = session.Send(spec.errorEvent, payload)
	}
	return fmt.Errorf("realtimesocket: %s connection rejected: %s", spec.namespace, message)
}

// register inserts the socket into the namespace index after enforcing the
// per-namespace connection caps of this instance. The check happens before the
// join, mirroring UserSessionManager.register (check-then-join, not atomic
// across instances).
func (r *Runtime) register(state *socketState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closing.Load() {
		return errRuntimeClosing
	}
	index := r.namespaces[state.spec.namespace]
	if index == nil {
		return errRuntimeClosing
	}
	if r.maxConnectionsPerUser > 0 && len(index.rooms[userRoom(state.identity.UserID)]) >= r.maxConnectionsPerUser {
		return errTooManyConnections
	}
	if state.ip != "" && r.maxConnectionsPerIP > 0 && len(index.rooms[ipRoom(state.ip)]) >= r.maxConnectionsPerIP {
		return errTooManyConnections
	}
	index.add(state)
	return nil
}

// unregister removes one namespace socket and returns its state, or nil when it
// was never registered.
func (r *Runtime) unregister(session *socketio.Session) *socketState {
	r.mu.Lock()
	defer r.mu.Unlock()
	index := r.namespaces[session.Namespace]
	if index == nil {
		return nil
	}
	state := index.socket(session.SID)
	if state == nil {
		return nil
	}
	index.remove(state)
	return state
}

func (r *Runtime) lookup(namespace, sid string) *socketState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	index := r.namespaces[namespace]
	if index == nil {
		return nil
	}
	return index.socket(sid)
}

// startRevalidation launches the B2 ticker of one socket. The registration and
// the WaitGroup Add both happen under the runtime mutex so Close can never wait
// on a group that is still being incremented.
func (r *Runtime) startRevalidation(state *socketState) bool {
	r.mu.Lock()
	if r.closing.Load() {
		r.mu.Unlock()
		return false
	}
	r.revalidateWG.Add(1)
	r.mu.Unlock()
	go r.revalidateLoop(state)
	return true
}
