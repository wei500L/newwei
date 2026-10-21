package realtimesocket

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
)

// Defaults mirror the NestJS WS_* defaults (config.service.ts + env.schema.ts).
// Options zero values fall back to them so a partially configured deployment
// behaves exactly like the baseline.
const (
	defaultMaxConnectionsPerUser = 5
	defaultMaxConnectionsPerIP   = 50
	defaultRevalidateInterval    = 30 * time.Second
)

// ClientIdentity is the locally derived identity of one namespace socket.
// SocketID is the Socket.IO socket id of that namespace (Session.SID), which is
// what the browser sees in the CONNECT acknowledgement and what local
// registries (for example the newsnow active-source registry) key on.
type ClientIdentity struct {
	SocketID string
	OrgID    string
	UserID   string
}

// ClientEvents receives browser EVENT frames for namespaces with a client
// handler (only newsnow:set-active-sources today) and socket-close callbacks.
//
// HandleClientEvent runs synchronously on the Engine.IO connection goroutine
// with the raw JSON argument array produced by the browser (for example
// `[{"sourceIds":["a"]}]`); implementations must not block and must treat the
// bytes as read-only.
//
// HandleClientDisconnect runs exactly once after the socket has been removed
// from the local room index, so a registry keyed by ClientIdentity.SocketID is
// always empty by then.
type ClientEvents interface {
	HandleClientEvent(namespace string, identity ClientIdentity, event string, args json.RawMessage)
	HandleClientDisconnect(namespace string, identity ClientIdentity)
}

// Options wires the realtime transport. MySQL and Redis handles remain owned by
// main; this package never closes them. A nil ClientEvents disables browser
// event delivery (connections still work).
type Options struct {
	// DB is part of the shared realtime wiring contract. This transport issues
	// no SQL itself: identity/permission derivation and re-derivation go
	// through Authz, whose implementation queries MySQL.
	DB *sql.DB

	Verifier  *authn.Verifier
	Blacklist authn.Blacklist
	Authz     authz.Repository

	Redis *redis.Client
	CORS  cors.Policy

	TrustProxy bool

	MaxConnectionsPerUser int
	MaxConnectionsPerIP   int

	ConnectLimitPerIP    int
	ConnectLimitPerUser  int
	ConnectWindowSeconds int

	// RevalidateInterval is the B2 identity revalidation period of every
	// namespace socket. Zero selects the NestJS 30s default; tests run it much
	// faster to observe a disconnect in bounded time.
	RevalidateInterval time.Duration

	ClientEvents ClientEvents

	// limiter is a test seam: when set, New does not build the Redis limiter.
	// Production always leaves it nil.
	limiter webSocketLimiter
}

// webSocketLimiter is the subset of socketio.Limiter used by the handshake and
// exposes a fake replacement in unit tests (no Redis required).
type webSocketLimiter interface {
	CheckIP(ctx context.Context, ip string) (bool, int64)
	CheckUser(ctx context.Context, userID string) (bool, int64)
	BackoffDelay(ctx context.Context, ip string) time.Duration
	RecordFailure(ctx context.Context, ip string)
	ClearBackoff(ctx context.Context, ip string)
}
