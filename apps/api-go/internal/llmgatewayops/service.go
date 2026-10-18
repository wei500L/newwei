package llmgatewayops

import (
	"context"
	"database/sql"
	"net"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// ProfilePort is the narrow typed surface this batch needs from the LLM gateway
// profile domain. It is implemented by *llmgatewayprofiles.Service, which owns
// the normalization, the encryption policy and the runtime binding rules; this
// package never reimplements them.
type ProfilePort interface {
	// RuntimeProfileConfig returns one saved profile with its apiKey resolved.
	RuntimeProfileConfig(ctx context.Context, id string) (llmgatewayprofiles.ResolvedProfileConfig, bool, error)
	// RuntimeBindings returns the profile ids currently serving each traffic
	// kind.
	RuntimeBindings(ctx context.Context) (llmgatewayprofiles.RuntimeBindings, error)
	// EncodeSecretForStorage applies the shared write-time secret policy.
	EncodeSecretForStorage(ctx context.Context, plain string) (*llmgatewayprofiles.SecretValue, error)
	// DecryptSecretEnvelope opens one v1 envelope with the settings key.
	DecryptSecretEnvelope(envelope llmgatewayprofiles.EncryptedStringValueV1) (string, bool)
}

// ProbeLogWriter persists one llmrequestlogs row per real model attempt.
type ProbeLogWriter interface {
	WriteProbe(ctx context.Context, entry llmlogs.ProbeLogEntry) error
}

// Config is the environment-derived configuration of the batch.
type Config struct {
	// MasterKey is the raw LITELLM_MASTER_KEY. It authenticates the LiteLLM
	// management calls only; a missing value is a per-request 503 on those
	// calls and never a startup error for the diagnostics routes.
	MasterKey string
}

// Service owns the shared MySQL pool, the Redis client, the profile port, the
// probe log writer and the outbound HTTP client. All methods are safe for
// concurrent use.
type Service struct {
	db       *sql.DB
	redis    *redis.Client
	profiles ProfilePort
	logs     ProbeLogWriter
	http     *http.Client
	cfg      Config
	// now is the clock used for checkedAt/lastSyncedAt. Tests replace it to
	// keep the generated alias stable.
	now func() time.Time
}

// NewService wires the shared resources. Every dependency is shared with the
// rest of api-go: this batch opens no extra MySQL pool, no second Redis client
// and no second Mongo client.
func NewService(db *sql.DB, redisClient *redis.Client, profiles ProfilePort, logs ProbeLogWriter, cfg Config) *Service {
	return &Service{
		db:       db,
		redis:    redisClient,
		profiles: profiles,
		logs:     logs,
		http:     newUpstreamHTTPClient(),
		cfg:      cfg,
		now:      time.Now,
	}
}

// nowUTC is the millisecond clock every ISO timestamp uses.
func (s *Service) nowUTC() time.Time {
	if s == nil || s.now == nil {
		return time.Now().UTC()
	}
	return s.now().UTC()
}

// newUpstreamHTTPClient builds the one transport shared by every probe and every
// management call. Reusing it matters for proxy-lb-test: up to fifty attempts
// against one host must not open fifty handshakes, so idle connections per host
// are raised well above the maximum attempt count and the overall request
// deadline is applied per request instead of on the client.
func newUpstreamHTTPClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:          128,
			MaxIdleConnsPerHost:   64,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
			ForceAttemptHTTP2:     true,
		},
	}
}

// hasAdminKey reports whether a usable LITELLM_MASTER_KEY is configured.
func (s *Service) hasAdminKey() bool {
	if s == nil {
		return false
	}
	return normalizeSecret(s.cfg.MasterKey) != ""
}
