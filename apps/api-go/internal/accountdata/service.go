package accountdata

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// Config carries the environment-derived switches the two routes need. The
// rate limit failure policy is shared with the other Go limiters
// (RATE_LIMIT_REDIS_FAIL_OPEN); TrustProxy is the same value Express uses for
// req.ip so the audit row records the same address NestJS would.
type Config struct {
	TrustProxy        string
	RateLimitFailOpen bool
}

// AssistantRunSource streams the caller's assistant runs in the order the
// NestJS query uses (createdAt desc, _id desc). It is an interface so the unit
// tests and the integration job can run without a Mongo service, while
// production wires the real collection.
type AssistantRunSource interface {
	ForEachAssistantRun(ctx context.Context, orgID, userID string, yield func(AssistantRun) error) error
}

// Service owns the shared MySQL pool, Redis client, storage configuration
// reader and assistant-run source. All methods are safe for concurrent use.
type Service struct {
	db            *sql.DB
	redis         *redis.Client
	storage       objectstorage.ConfigReader
	behavior      *newsbehavior.Service
	assistantRuns AssistantRunSource
	cfg           Config

	// now and the id generators are injectable so tests can pin timestamps and
	// object keys without touching the wall clock.
	now     func() time.Time
	newID   func() (string, error)
	newUUID func() (string, error)
}

// Options wires the service. Only the dependencies of a taken-over route need
// to be non-nil; the handler checks the relevant ones before serving.
type Options struct {
	DB            *sql.DB
	Redis         *redis.Client
	Storage       objectstorage.ConfigReader
	Behavior      *newsbehavior.Service
	AssistantRuns AssistantRunSource
	Config        Config
	Now           func() time.Time
	NewID         func() (string, error)
	NewUUID       func() (string, error)
}

// NewService builds the account-data service.
func NewService(options Options) *Service {
	service := &Service{
		db:            options.DB,
		redis:         options.Redis,
		storage:       options.Storage,
		behavior:      options.Behavior,
		assistantRuns: options.AssistantRuns,
		cfg:           options.Config,
		now:           options.Now,
		newID:         options.NewID,
		newUUID:       options.NewUUID,
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }
	}
	if service.newID == nil {
		service.newID = newRowID
	}
	if service.newUUID == nil {
		service.newUUID = newUUID
	}
	return service
}

// RequestIP reproduces the NestJS resolveRequestIp value: the Express
// trust-proxy resolved client address. With TRUST_PROXY unset the socket
// address wins and X-Forwarded-For is ignored (a client cannot spoof the audit
// address); a numeric hop count indexes the forwarded chain from the right, any
// other configured value trusts the leftmost entry.
func (s *Service) RequestIP(r *http.Request) *string {
	if r == nil {
		return nil
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsed
	}
	host = strings.TrimPrefix(host, "::ffff:")
	trust := strings.TrimSpace(s.cfg.TrustProxy)
	if trust == "" {
		return nonEmptyString(host)
	}
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded == "" {
		return nonEmptyString(host)
	}
	parts := strings.Split(forwarded, ",")
	// A numeric TRUST_PROXY is the Express hop count and indexes the chain from
	// the right; every other configured value (true, loopback, an IP/subnet
	// list) trusts the chain and yields the leftmost entry, which is what
	// Express req.ip returns in that configuration.
	index := 0
	if parsed, err := strconv.Atoi(trust); err == nil && parsed > 0 {
		index = len(parts) - parsed
		if index < 0 {
			index = 0
		}
	}
	ip := strings.TrimPrefix(strings.TrimSpace(parts[index]), "::ffff:")
	if ip == "" {
		return nonEmptyString(host)
	}
	return &ip
}

func nonEmptyString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID generates a client-side identifier in the shape Prisma's cuid()
// produces ('c' plus 24 hex characters), because the columns have no database
// default.
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// newUUID returns a random RFC 4122 version 4 UUID, the same shape
// node:crypto randomUUID produced for the avatar object key.
func newUUID() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return hex.EncodeToString(buffer[0:4]) + "-" +
		hex.EncodeToString(buffer[4:6]) + "-" +
		hex.EncodeToString(buffer[6:8]) + "-" +
		hex.EncodeToString(buffer[8:10]) + "-" +
		hex.EncodeToString(buffer[10:16]), nil
}
