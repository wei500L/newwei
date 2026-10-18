package authfactors

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Config carries the environment-derived inputs the secret-encoding policy
// needs. Every field mirrors a NestJS EnvService getter or the raw
// process.env read AuthSecurityService performs, so the two implementations
// agree byte for byte.
type Config struct {
	// EncryptionKeyRaw keeps the untrimmed SYSTEM_SETTINGS_ENCRYPTION_KEY:
	// "missing" and "present but blank" must stay distinguishable.
	EncryptionKeyRaw string
	// EncryptionKeyPresent mirrors the NestJS `if (!raw)` presence test, which
	// is evaluated on the untrimmed value.
	EncryptionKeyPresent bool
	// NodeEnv is compared against the exact string "production".
	NodeEnv string
}

// Service owns the shared MySQL pool and Redis client plus the
// environment-derived encoding policy. All methods are safe for concurrent use.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	cfg   Config
}

// NewService wires the MFA/OIDC data access. db and redisClient are the same
// connections every other Go domain uses; this package never opens a second
// pool.
func NewService(db *sql.DB, redisClient *redis.Client, cfg Config) *Service {
	return &Service{db: db, redis: redisClient, cfg: cfg}
}

// Config exposes the resolved encoding policy (used by tests).
func (s *Service) Config() Config {
	if s == nil {
		return Config{}
	}
	return s.cfg
}

// ---- response models ----

// mfaStatus is the five-field factor summary returned by GET /api/auth/mfa and
// by the disable route. Field order is the serialization order and matches the
// NestJS object literal.
type mfaStatus struct {
	Enabled                bool    `json:"enabled"`
	EnrolledAt             *string `json:"enrolledAt"`
	VerifiedAt             *string `json:"verifiedAt"`
	LastUsedAt             *string `json:"lastUsedAt"`
	RecoveryCodesRemaining int     `json:"recoveryCodesRemaining"`
}

// responseBody marks mfaStatus as a JSON response body.
func (mfaStatus) responseBody() {}

// mfaEnrollmentResponse is the POST /api/auth/mfa/enroll body. The plaintext
// secret is handed to the user exactly once and never logged.
type mfaEnrollmentResponse struct {
	Secret     string `json:"secret"`
	OtpauthURI string `json:"otpauthUri"`
}

// responseBody marks mfaEnrollmentResponse as a JSON response body.
func (mfaEnrollmentResponse) responseBody() {}

// mfaRecoveryResponse is the POST /api/auth/mfa/verify-enroll and
// POST /api/auth/mfa/recovery/rotate body: the newly committed plaintext codes
// followed by the fresh factor summary.
type mfaRecoveryResponse struct {
	RecoveryCodes          []string `json:"recoveryCodes"`
	Enabled                bool     `json:"enabled"`
	EnrolledAt             *string  `json:"enrolledAt"`
	VerifiedAt             *string  `json:"verifiedAt"`
	LastUsedAt             *string  `json:"lastUsedAt"`
	RecoveryCodesRemaining int      `json:"recoveryCodesRemaining"`
}

// responseBody marks mfaRecoveryResponse as a JSON response body.
func (mfaRecoveryResponse) responseBody() {}

// oidcConfigResponse is the eight-field organization OIDC configuration body.
// It never carries the client secret, the row id, the org id or timestamps.
type oidcConfigResponse struct {
	Enabled              bool     `json:"enabled"`
	IssuerURL            string   `json:"issuerUrl"`
	DiscoveryURL         string   `json:"discoveryUrl"`
	ClientID             string   `json:"clientId"`
	HasClientSecret      bool     `json:"hasClientSecret"`
	Scopes               []string `json:"scopes"`
	ButtonLabel          string   `json:"buttonLabel"`
	RequireEmailVerified bool     `json:"requireEmailVerified"`
}

// responseBody marks oidcConfigResponse as a JSON response body.
func (oidcConfigResponse) responseBody() {}

// ---- database row models ----

// mfaFactorRow is one UserTotpFactor row. secret and pendingSecret keep the
// raw JSON bytes of the JSON column so the named storedSecret model decides how
// they are interpreted; pendingSecret is nil for SQL NULL, which is what
// distinguishes "no replacement in progress" from an empty JSON value.
type mfaFactorRow struct {
	Secret        []byte
	PendingSecret []byte
	Label         sql.NullString
	PendingLabel  sql.NullString
	EnrolledAt    time.Time
	VerifiedAt    sql.NullTime
	DisabledAt    sql.NullTime
	LastUsedAt    sql.NullTime
}

// active reports whether the factor is a completed, enabled factor:
// verifiedAt present and disabledAt absent. This is the only definition of
// "active" used by this package.
func (f mfaFactorRow) active() bool {
	return f.VerifiedAt.Valid && !f.DisabledAt.Valid
}

// hasPending reports whether a replacement enrollment is in progress. A JSON
// literal null counts as absent, matching the JavaScript `pendingSecret ??
// secret` fallback: Prisma cannot distinguish it from SQL NULL either.
func (f mfaFactorRow) hasPending() bool {
	trimmed := bytes.TrimSpace(f.PendingSecret)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

// oidcConfigRow is one OrgOidcConfig row. ClientSecret and Scopes keep the raw
// JSON bytes; nil means SQL NULL.
type oidcConfigRow struct {
	Enabled              bool
	IssuerURL            string
	DiscoveryURL         sql.NullString
	ClientID             string
	ClientSecret         []byte
	Scopes               []byte
	ButtonLabel          sql.NullString
	RequireEmailVerified bool
}

// ---- small helpers ----

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// nestTimestamp renders a time exactly like JavaScript's
// Date.prototype.toISOString (UTC, millisecond precision, trailing Z).
func nestTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// nestTimestampPtr renders a nullable DATETIME(3) as the ISO string NestJS
// emits, or nil for SQL NULL.
func nestTimestampPtr(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	rendered := nestTimestamp(value.Time)
	return &rendered
}

// timestampValue wraps a non-null DATETIME(3) for the nullable renderer.
func timestampValue(value time.Time) sql.NullTime {
	return sql.NullTime{Time: value, Valid: true}
}

// actorIsMachine reports whether the actor id belongs to a machine token.
func actorIsMachine(actorID string) bool {
	return strings.HasPrefix(actorID, machineActorPrefix)
}

// jsonBooleanTruthy reproduces JavaScript's Boolean(value) for a decoded JSON
// value: null, false, 0 and the empty string are falsy, everything else is
// truthy. It is used for `hasClientSecret`, which NestJS computes as
// Boolean(storedValue) rather than by attempting a decryption.
func jsonBooleanTruthy(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed == "false" {
		return false
	}
	if trimmed == "0" {
		return false
	}
	if trimmed == `""` {
		return false
	}
	return true
}

// logBackground records a failure on a path where NestJS only logs a warning
// and continues (a tolerant cache read, a best-effort eviction). A nil error
// logs the message alone.
func logBackground(kind string, err error) {
	if err == nil {
		log.Printf("authfactors: %s", kind)
		return
	}
	log.Printf("authfactors: %s: %v", kind, err)
}

// errNotConfigured is a named error type so the package keeps a single shape
// for "dependency missing" without exporting a bare string.
type errNotConfigured string

// Error implements the error interface.
func (e errNotConfigured) Error() string { return "authfactors: " + string(e) }

// errNoDatabase is returned when the MySQL pool was not injected. The handler
// maps it to the same fail-closed 503 NestJS produces for Prisma errors.
var errNoDatabase = errNotConfigured("mysql is not configured")

// errNoRedis is returned when the Redis client was not injected.
var errNoRedis = errNotConfigured("redis is not configured")
