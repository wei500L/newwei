package notificationssocket

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
)

const (
	// Path is the dedicated Engine.IO path for the Go transport. Keeping it
	// separate from /socket.io means the other Socket.IO namespaces keep their
	// existing NestJS transport and default Web entrypoint.
	Path = "/socket.io-notifications"

	defaultPingInterval = 25 * time.Second
	defaultPingTimeout  = 20 * time.Second
	defaultConnectWait  = 10 * time.Second

	maxMessageBytes = 1 << 20
)

// Options wires the notifications transport. Source is only set by tests;
// production builds it from Redis.
type Options struct {
	DB *sql.DB

	Verifier  *authn.Verifier
	Blacklist authn.Blacklist
	Authz     authz.Repository

	Redis *redis.Client

	CORS       cors.Policy
	TrustProxy bool

	MaxConnectionsPerUser int
	MaxConnectionsPerIP   int
	ConnectLimitPerIP     int
	ConnectLimitPerUser   int
	ConnectWindowSeconds  int

	PingInterval time.Duration
	PingTimeout  time.Duration
	ConnectWait  time.Duration

	source feedSource
}

// Runtime owns the notification namespace, its local room index and the
// Redis relay reader. It is safe to Close more than once.
type Runtime struct {
	db *sql.DB

	auth    *authenticator
	limiter *connectionLimiter
	cors    cors.Policy

	pingInterval time.Duration
	pingTimeout  time.Duration
	connectWait  time.Duration
	trustProxy   bool
	maxPerUser   int
	maxPerIP     int

	feed feedSource

	mu      sync.RWMutex
	conns   map[string]*connection
	byUser  map[string]map[*connection]struct{}
	byOrg   map[string]map[*connection]struct{}
	byIP    map[string]int
	closing atomic.Bool
	wg      sync.WaitGroup

	closeOnce sync.Once
}

// New builds the runtime. It opens no resources of its own; the shared MySQL
// and Redis handles remain owned by main.
func New(options Options) (*Runtime, error) {
	if options.DB == nil {
		return nil, errors.New("notificationssocket: MySQL is required")
	}
	if options.Redis == nil && options.source == nil {
		return nil, errors.New("notificationssocket: Redis is required")
	}
	if options.Verifier == nil || options.Blacklist == nil || options.Authz == nil {
		return nil, errors.New("notificationssocket: JWT verifier, blacklist and authorization repository are required")
	}
	if options.PingInterval <= 0 {
		options.PingInterval = defaultPingInterval
	}
	if options.PingTimeout <= 0 {
		options.PingTimeout = defaultPingTimeout
	}
	if options.ConnectWait <= 0 {
		options.ConnectWait = defaultConnectWait
	}
	runtime := &Runtime{
		db: options.DB,
		auth: &authenticator{
			verifier:  options.Verifier,
			blacklist: options.Blacklist,
			authz:     options.Authz,
		},
		limiter: newConnectionLimiter(
			options.Redis,
			options.ConnectLimitPerIP,
			options.ConnectLimitPerUser,
			options.ConnectWindowSeconds,
		),
		cors:         options.CORS,
		pingInterval: options.PingInterval,
		pingTimeout:  options.PingTimeout,
		connectWait:  options.ConnectWait,
		trustProxy:   options.TrustProxy,
		maxPerUser:   options.MaxConnectionsPerUser,
		maxPerIP:     options.MaxConnectionsPerIP,
		conns:        map[string]*connection{},
		byUser:       map[string]map[*connection]struct{}{},
		byOrg:        map[string]map[*connection]struct{}{},
		byIP:         map[string]int{},
	}
	if options.source != nil {
		runtime.feed = options.source
	} else {
		runtime.feed = newRedisFeed(options.Redis, runtime.handleRelay)
	}
	return runtime, nil
}

// Start subscribes to the relay channels. It does not start an HTTP server;
// main mounts Handles/ServeHTTP on the shared gateway.
func (r *Runtime) Start(ctx context.Context) error {
	if r == nil || r.closing.Load() {
		return nil
	}
	if r.feed != nil {
		return r.feed.Start(ctx)
	}
	return nil
}

// Handles reports whether this exact request is the Go notifications upgrade.
// The path is dedicated, so other Socket.IO namespaces continue to proxy to
// NestJS unchanged.
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

// ServeHTTP upgrades one exact notifications request and serves the socket.
func (r *Runtime) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if !r.Handles(request) {
		http.Error(w, "not a notifications websocket upgrade", http.StatusBadRequest)
		return
	}
	if r.closing.Load() {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}
	ws, err := websocket.Accept(w, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	r.wg.Add(1)
	defer r.wg.Done()
	conn := &connection{
		runtime: r,
		ws:      ws,
		request: request,
		id:      newSocketID(),
		ctx:     ctx,
		cancel:  cancel,
		ip:      resolveClientIP(request, r.trustProxy),
	}
	defer cancel()
	conn.serve()
}

// Close disconnects every live socket, then stops the Redis relay. The shared
// Redis and MySQL handles are closed by main afterwards.
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var closeErr error
	r.closeOnce.Do(func() {
		r.closing.Store(true)
		r.mu.RLock()
		connections := make([]*connection, 0, len(r.conns))
		for _, conn := range r.conns {
			connections = append(connections, conn)
		}
		r.mu.RUnlock()
		for _, conn := range connections {
			conn.shutdown(true)
		}
		if r.feed != nil {
			if err := r.feed.Close(); err != nil {
				closeErr = err
			}
		}
		done := make(chan struct{})
		go func() {
			r.wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-ctx.Done():
		}
	})
	return closeErr
}

func (r *Runtime) handleRelay(ctx context.Context, kind relayKind, raw string) {
	message, err := parseRelayMessage(raw)
	if err != nil {
		return
	}
	event, found, err := r.loadNotification(ctx, message)
	if err != nil {
		log.Printf("notificationssocket: load relayed notification failed: %v", err)
		return
	}
	if !found || !validateRelayedRow(kind, event) {
		return
	}
	r.emit(event)
}

// loadNotification re-reads the committed row. The relay carries identifiers
// only; the row is the source of truth for the display payload (B2 re-check).
func (r *Runtime) loadNotification(ctx context.Context, message relayMessage) (NotificationEvent, bool, error) {
	query := "SELECT id, orgId, userId, type, title, body, data, readAt, createdAt FROM Notification WHERE id = ? AND orgId = ?"
	args := []any{message.NotificationID, message.OrgID}
	if message.UserID != "" {
		query += " AND userId = ?"
		args = append(args, message.UserID)
	}
	var (
		event     NotificationEvent
		userID    sql.NullString
		body      sql.NullString
		readAt    sql.NullTime
		data      []byte
		createdAt time.Time
	)
	err := r.db.QueryRowContext(ctx, query, args...).Scan(
		&event.ID,
		&event.OrgID,
		&userID,
		&event.Type,
		&event.Title,
		&body,
		&data,
		&readAt,
		&createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return NotificationEvent{}, false, nil
	}
	if err != nil {
		return NotificationEvent{}, false, err
	}
	if userID.Valid {
		event.UserID = &userID.String
	}
	if body.Valid {
		event.Body = &body.String
	}
	if len(data) == 0 {
		data = []byte("null")
	}
	event.Data = json.RawMessage(data)
	if readAt.Valid {
		value := formatISOMillis(readAt.Time)
		event.ReadAt = &value
	}
	event.CreatedAt = formatISOMillis(createdAt)
	if event.ID == "" {
		event.ID = message.NotificationID
	}
	return event, true, nil
}

// emit is the B1 local push: it only walks sockets owned by this process. The
// Socket.IO Redis adapter is intentionally not involved, so a relay received
// by every API instance is still emitted exactly once per browser.
func (r *Runtime) emit(event NotificationEvent) {
	r.mu.RLock()
	var targets []*connection
	if event.UserID != nil {
		for conn := range r.byUser[*event.UserID] {
			if conn.orgID == event.OrgID {
				targets = append(targets, conn)
			}
		}
	} else {
		for conn := range r.byOrg[event.OrgID] {
			targets = append(targets, conn)
		}
	}
	r.mu.RUnlock()

	for _, conn := range targets {
		if err := conn.writeEvent("notification", event); err != nil {
			conn.shutdown(false)
		}
	}
}

func (r *Runtime) register(conn *connection) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closing.Load() {
		return errors.New("server shutting down")
	}
	if r.maxPerUser > 0 && len(r.byUser[conn.userID]) >= r.maxPerUser {
		return errors.New("Too many connections")
	}
	if conn.ip != "" && r.maxPerIP > 0 && r.byIP[conn.ip] >= r.maxPerIP {
		return errors.New("Too many connections")
	}
	r.conns[conn.id] = conn
	if r.byUser[conn.userID] == nil {
		r.byUser[conn.userID] = map[*connection]struct{}{}
	}
	r.byUser[conn.userID][conn] = struct{}{}
	if r.byOrg[conn.orgID] == nil {
		r.byOrg[conn.orgID] = map[*connection]struct{}{}
	}
	r.byOrg[conn.orgID][conn] = struct{}{}
	if conn.ip != "" {
		r.byIP[conn.ip]++
	}
	return nil
}

func (r *Runtime) unregister(conn *connection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.conns[conn.id]; !exists {
		return
	}
	delete(r.conns, conn.id)
	if userConns := r.byUser[conn.userID]; userConns != nil {
		delete(userConns, conn)
		if len(userConns) == 0 {
			delete(r.byUser, conn.userID)
		}
	}
	if orgConns := r.byOrg[conn.orgID]; orgConns != nil {
		delete(orgConns, conn)
		if len(orgConns) == 0 {
			delete(r.byOrg, conn.orgID)
		}
	}
	if conn.ip != "" {
		if r.byIP[conn.ip] <= 1 {
			delete(r.byIP, conn.ip)
		} else {
			r.byIP[conn.ip]--
		}
	}
}

func (r *Runtime) isClosing() bool {
	return r.closing.Load()
}

func (r *Runtime) connectionCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.conns)
}
