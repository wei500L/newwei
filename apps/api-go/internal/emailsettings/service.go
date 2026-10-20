// Package emailsettings serves the three email settings REST routes:
//
//	GET  /api/system-settings/email              (settings.manage)
//	PUT  /api/system-settings/email/auth-code    (settings.manage + platform admin)
//	POST /api/system-settings/email/test         (settings.manage)
//
// The SMTP verify state is process-local, exactly like NestJS EmailService: it
// reports this process's most recent verify, not a shared cluster state.
package emailsettings

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/smtpmail"
)

// SystemSetting and Redis keys shared with the NestJS service. The cache key and
// TTL are byte-identical so either implementation reads the other's writes.
const (
	authCodeSettingsRowKey    = "auth_email_code_settings"
	authCodeSettingsCacheKey  = "auth_email_code:settings"
	authCodeSettingsCacheTTL  = 60
	authCodeDescription       = "Auth email code settings"
	emailAuditResource        = "system_settings"
	emailAuditAction          = "auth_email_code_settings_update"
	emailTestNotAllowedReason = "Test emails may only be sent to the configured SMTP account to prevent relay abuse"
)

// AuthCode bounds mirror AuthEmailCodeSettingsService.
const (
	minTTLSeconds      = 60
	maxTTLSeconds      = 1800
	minCooldownSeconds = 10
	maxCooldownSeconds = 3600
	minMaxAttempts     = 1
	maxMaxAttempts     = 10
)

// SMTPConfig is the 14-field status projection plus the password the transport
// needs. Pass is never serialized.
type SMTPConfig struct {
	Host                  string
	Port                  int
	Secure                bool
	User                  string
	Pass                  string
	From                  string
	Pool                  bool
	MaxConnections        int
	MaxMessages           int
	RateDeltaMs           int
	RateLimit             int
	ConnectionTimeoutMs   int
	GreetingTimeoutMs     int
	SocketTimeoutMs       int
	TLSRejectUnauthorized bool
}

// transport maps the status projection onto the shared SMTP client.
func (c SMTPConfig) transport() smtpmail.Config {
	return smtpmail.Config{
		Host:                  c.Host,
		Port:                  c.Port,
		Secure:                c.Secure,
		User:                  c.User,
		Pass:                  c.Pass,
		From:                  c.From,
		ConnectionTimeoutMs:   c.ConnectionTimeoutMs,
		GreetingTimeoutMs:     c.GreetingTimeoutMs,
		SocketTimeoutMs:       c.SocketTimeoutMs,
		TLSRejectUnauthorized: c.TLSRejectUnauthorized,
	}
}

// Config is the environment-derived configuration of the unit.
type Config struct {
	SMTP SMTPConfig
	// AuthCodeTTLSeconds / CooldownSeconds / MaxAttempts are the environment
	// fallbacks (AUTH_EMAIL_CODE_*), used when no SystemSetting row exists.
	AuthCodeTTLSeconds      int
	AuthCodeCooldownSeconds int
	AuthCodeMaxAttempts     int
}

// Service owns the shared MySQL pool, Redis client and the SMTP transport. The
// verify cache is process-local by design.
type Service struct {
	redis      *redis.Client
	cfg        Config
	verify     *verifyCache
	now        func() time.Time
	sendMail   func(context.Context, smtpmail.Message) (smtpmail.Result, error)
	settingsDB settingsDB
}

// settingsDB is the narrow MySQL surface; *DB implements it in production and a
// fake implements it in unit tests.
type settingsDB interface {
	Exec(ctx context.Context, query string, args ...any) error
	QueryValue(ctx context.Context, key string) ([]byte, bool, error)
}

// NewService wires the production dependencies.
func NewService(db settingsDB, redisClient *redis.Client, cfg Config) *Service {
	transport := cfg.SMTP.transport()
	service := &Service{
		redis:      redisClient,
		cfg:        cfg,
		verify:     newVerifyCache(time.Now, transport.Verify),
		now:        time.Now,
		sendMail:   transport.Send,
		settingsDB: db,
	}
	return service
}

// NewServiceForTest wires a service with a fake DB and explicit transport seams.
// It exists so unit tests can prove TTL/single-flight and D1 without SMTP.
func NewServiceForTest(db settingsDB, redisClient *redis.Client, cfg Config, verify func(context.Context) error, send func(context.Context, smtpmail.Message) (smtpmail.Result, error), now func() time.Time) *Service {
	return &Service{
		redis:      redisClient,
		cfg:        cfg,
		verify:     newVerifyCache(now, verify),
		now:        now,
		sendMail:   send,
		settingsDB: db,
	}
}

// ---- auth code settings ----

// authCodeSettingsDoc keeps every member raw so an absent member is
// distinguishable from an explicit zero, exactly like the NestJS toInt helper.
type authCodeSettingsDoc struct {
	TTLSeconds      json.RawMessage `json:"ttlSeconds"`
	CooldownSeconds json.RawMessage `json:"cooldownSeconds"`
	MaxAttempts     json.RawMessage `json:"maxAttempts"`
}

// environmentSettings is the normalized environment fallback.
func (s *Service) environmentSettings() AuthCodeSettings {
	return AuthCodeSettings{
		TTLSeconds:      clampInt(s.cfg.AuthCodeTTLSeconds, minTTLSeconds, maxTTLSeconds),
		CooldownSeconds: clampInt(s.cfg.AuthCodeCooldownSeconds, minCooldownSeconds, maxCooldownSeconds),
		MaxAttempts:     clampInt(s.cfg.AuthCodeMaxAttempts, minMaxAttempts, maxMaxAttempts),
	}
}

// normalize merges a stored document over the environment fallback and clamps
// every member.
func (s *Service) normalize(raw json.RawMessage) AuthCodeSettings {
	fallback := s.environmentSettings()
	var doc authCodeSettingsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fallback
	}
	return AuthCodeSettings{
		TTLSeconds:      clampInt(settingsInt(doc.TTLSeconds, fallback.TTLSeconds), minTTLSeconds, maxTTLSeconds),
		CooldownSeconds: clampInt(settingsInt(doc.CooldownSeconds, fallback.CooldownSeconds), minCooldownSeconds, maxCooldownSeconds),
		MaxAttempts:     clampInt(settingsInt(doc.MaxAttempts, fallback.MaxAttempts), minMaxAttempts, maxMaxAttempts),
	}
}

// settingsInt mirrors the NestJS toInt helper: a finite number is floored,
// anything else falls back.
func settingsInt(raw json.RawMessage, fallback int) int {
	if len(raw) == 0 {
		return fallback
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return fallback
	}
	if number != number { // NaN cannot appear in JSON, kept for parity.
		return fallback
	}
	return int(number)
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// settings resolves the policy: Redis cache first (60 second TTL), then the
// SystemSetting row, then the environment defaults. The resolved document is
// written back to the cache. This mirrors authlogin's emailCodeSettings and
// AuthEmailCodeSettingsService.getSettings; authlogin keeps its own copy because
// that reader is coupled to its Service cache helpers.
func (s *Service) settings(ctx context.Context) (AuthCodeSettings, error) {
	if s.redis != nil {
		raw, err := s.redis.Get(ctx, authCodeSettingsCacheKey).Bytes()
		if err == nil && len(raw) > 0 {
			return s.normalize(raw), nil
		}
		if err != nil && !errors.Is(err, redis.Nil) {
			return AuthCodeSettings{}, err
		}
	}
	settings := s.environmentSettings()
	if s.settingsDB != nil {
		raw, found, err := s.settingsDB.QueryValue(ctx, authCodeSettingsRowKey)
		if err != nil {
			return AuthCodeSettings{}, err
		}
		if found && len(raw) > 0 && json.Valid(raw) {
			settings = s.normalize(raw)
		}
	}
	s.cacheSettings(ctx, settings)
	return settings, nil
}

// cacheSettings writes the resolved document with the shared 60 second TTL. A
// cache failure is logged and does not fail the read, matching the authlogin
// takeover.
func (s *Service) cacheSettings(ctx context.Context, settings AuthCodeSettings) {
	if s.redis == nil {
		return
	}
	payload, err := json.Marshal(settings)
	if err != nil {
		log.Printf("emailsettings: encode auth code settings: %v", err)
		return
	}
	if err := s.redis.Set(ctx, authCodeSettingsCacheKey, payload, authCodeSettingsCacheTTL*time.Second).Err(); err != nil {
		log.Printf("emailsettings: auth code settings cache write failed: %v", err)
	}
}

// updateSettings normalizes the validated input, upserts the global row, writes
// the best-effort audit and refreshes the cache.
func (s *Service) updateSettings(ctx context.Context, orgID, actorID string, input AuthCodeSettings) (AuthCodeSettings, error) {
	normalized := s.normalizeInput(input)
	if s.settingsDB == nil {
		return AuthCodeSettings{}, errors.New("emailsettings: mysql is not configured")
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return AuthCodeSettings{}, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	if err := s.settingsDB.Exec(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt, updatedById) "+
			"VALUES (?, ?, 0, ?, ?, ?, ?) "+
			"ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt), updatedById = VALUES(updatedById)",
		authCodeSettingsRowKey, payload, authCodeDescription, now, now, platformgovernance.NullableActorID(actorID)); err != nil {
		return AuthCodeSettings{}, err
	}
	s.audit(ctx, orgID, actorID, payload)
	s.cacheSettings(ctx, normalized)
	return normalized, nil
}

// normalizeInput merges a freshly validated DTO over the environment defaults.
func (s *Service) normalizeInput(input AuthCodeSettings) AuthCodeSettings {
	return AuthCodeSettings{
		TTLSeconds:      clampInt(input.TTLSeconds, minTTLSeconds, maxTTLSeconds),
		CooldownSeconds: clampInt(input.CooldownSeconds, minCooldownSeconds, maxCooldownSeconds),
		MaxAttempts:     clampInt(input.MaxAttempts, minMaxAttempts, maxMaxAttempts),
	}
}
