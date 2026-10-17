package modelaccesssettings

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Config carries every environment-derived value the handlers need. Each field
// mirrors the NestJS EnvService getter (or the raw env read the encryption policy
// depends on) with the same default, so both implementations agree when no
// SystemSetting row exists.
type Config struct {
	// DatabaseURL is the same MySQL DSN the shared pool uses. It is consumed only
	// by the dedicated lock session (lock.go); every other statement uses the
	// shared pool.
	DatabaseURL string

	// ModelServiceEnabled is MODEL_SERVICE_ENABLED (envBoolean, default false).
	ModelServiceEnabled bool
	// ModelServiceBaseURL is MODEL_SERVICE_BASE_URL, RAW. A blank value means
	// unset; a non-blank value is JS-trimmed when it is read.
	ModelServiceBaseURL string
	// ModelServiceInternalToken is MODEL_SERVICE_INTERNAL_TOKEN, RAW (untrimmed):
	// the NestJS env schema only rejects an all-whitespace value, it never trims
	// the accepted one. A blank value means unset.
	ModelServiceInternalToken string
	// ModelServiceTimeoutMs is MODEL_SERVICE_TIMEOUT_MS (default 15000).
	ModelServiceTimeoutMs int
	// ModelServiceMaxRetries is MODEL_SERVICE_MAX_RETRIES (default 2).
	ModelServiceMaxRetries int

	// LiteLLMConfigInternalToken is LITELLM_CONFIG_INTERNAL_TOKEN, RAW. A blank
	// value means "not configured", which is an endpoint contract (403), never a
	// startup failure.
	LiteLLMConfigInternalToken string

	// SettingsEncryptionKeyRaw is the ORIGINAL SYSTEM_SETTINGS_ENCRYPTION_KEY
	// value (untrimmed). It is kept separate from config.SettingsEncryptionKey
	// because that public field is TrimSpace'd and therefore cannot distinguish
	// "missing" from "present but blank".
	SettingsEncryptionKeyRaw string

	// IsProduction is NODE_ENV === "production", compared exactly.
	IsProduction bool
}

// Service owns the model access settings domain over five narrow ports.
type Service struct {
	settings settingsRepo
	cache    cacheStore
	audit    auditor
	locks    lockManager
	identity identityStore
	cfg      Config
}

// NewService wires the production ports: the shared MySQL pool, the shared Redis
// client and the same DSN for the dedicated lock session. A nil db or a nil Redis
// client produces the corresponding fail-closed error on the affected path.
func NewService(db *sql.DB, redisClient *redis.Client, cfg Config) *Service {
	return &Service{
		settings: &mysqlSettings{db: db},
		cache:    &redisCache{client: redisClient},
		audit:    &mysqlAuditor{db: db},
		locks:    &mysqlLock{dsn: cfg.DatabaseURL},
		identity: &mysqlIdentity{db: db},
		cfg:      cfg,
	}
}

// Config exposes the resolved defaults (used by tests and diagnostics).
func (s *Service) Config() Config {
	if s == nil {
		return Config{}
	}
	return s.cfg
}

// machineActorPrefix is the user-id prefix the machine-token authenticator
// produces ("machine:<tokenId>"). The value is part of the identity contract.
const machineActorPrefix = "machine:"

// actorIsMachine reports whether the actor id belongs to a machine token rather
// than a human user.
func actorIsMachine(actorID string) bool {
	return actorID == "" || strings.HasPrefix(actorID, machineActorPrefix)
}

// nullableActorID converts an actor id into the value that may be written to the
// nullable User foreign keys. A machine identity or an empty id must become SQL
// NULL: writing the machine id would violate the foreign key and surface as an
// HTTP 500. The platform gate (MA1) already rejects machine tokens before any
// write; this remains as a second line of defence.
func nullableActorID(actorID string) *string {
	if actorIsMachine(actorID) {
		return nil
	}
	return &actorID
}

// nowMillis returns the current UTC time truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID generates a client-side identifier in the same shape Prisma's cuid()
// produces ('c' plus 24 hex characters); MySQL has no column default because
// Prisma fills it in before the INSERT.
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// logCacheFailure records a Redis failure on a path where NestJS only logs a
// warning and continues (cache reads, best-effort eviction). The payload itself is
// never logged: no secret ever reaches the application log.
func logCacheFailure(kind, key string, err error) {
	log.Printf("modelaccesssettings: %s failed for %q: %v", kind, key, err)
}

// ---- MySQL: SystemSetting rows ----

// mysqlSettings is the settingsRepo implementation over the shared pool.
type mysqlSettings struct {
	db *sql.DB
}

// upsertSettingSQL inserts or updates one global SystemSetting row.
//
// Two behaviours are load-bearing for NestJS parity: the description is written
// only on the INSERT branch (a Prisma upsert whose `update` block omits it keeps
// the existing description), and updatedById is written on both branches with NULL
// for machine identities.
const upsertSettingSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById"

// Load reads one SystemSetting.value.
func (m *mysqlSettings) Load(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if m == nil || m.db == nil {
		return nil, false, errNoDatabase
	}
	var raw []byte
	err := m.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// Upsert writes one SystemSetting row.
func (m *mysqlSettings) Upsert(ctx context.Context, key string, value json.RawMessage, description string, updatedByID *string) error {
	if m == nil || m.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := m.db.ExecContext(ctx, upsertSettingSQL,
		key, []byte(value), description, now, now, updatedByID)
	return err
}

// Delete removes one SystemSetting row.
func (m *mysqlSettings) Delete(ctx context.Context, key string) error {
	if m == nil || m.db == nil {
		return errNoDatabase
	}
	_, err := m.db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", key)
	return err
}

// ---- Redis: cache envelopes ----

// redisCache is the cacheStore implementation over the shared Redis client.
type redisCache struct {
	client *redis.Client
}

// Get reads one JSON cache entry. A missing key is found=false; malformed JSON is
// an error so the caller can decide whether to fall back (NestJS JSON.parse throws
// in the same situation).
func (c *redisCache) Get(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if c == nil || c.client == nil {
		return nil, false, errNoRedis
	}
	raw, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || !json.Valid(raw) {
		return nil, false, errors.New("modelaccesssettings: cache entry is not valid json")
	}
	return json.RawMessage(raw), true, nil
}

// Set writes one JSON cache entry with an expiry, mirroring CacheService.set.
func (c *redisCache) Set(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if c == nil || c.client == nil {
		return errNoRedis
	}
	return c.client.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err()
}

// Del removes one cache entry, mirroring CacheService.del.
func (c *redisCache) Del(ctx context.Context, key string) error {
	if c == nil || c.client == nil {
		return errNoRedis
	}
	return c.client.Del(ctx, key).Err()
}

// ---- MySQL: identity ----

// mysqlIdentity is the identityStore implementation over the shared pool.
type mysqlIdentity struct {
	db *sql.DB
}

// IsPlatformAdmin mirrors PlatformAccessService.isPlatformAdmin: a
// GlobalRoleAssignment row with role=platform_admin for this exact user id.
func (i *mysqlIdentity) IsPlatformAdmin(ctx context.Context, userID string) (bool, error) {
	if i == nil || i.db == nil {
		return false, errNoDatabase
	}
	var id string
	err := i.db.QueryRowContext(ctx,
		"SELECT id FROM GlobalRoleAssignment WHERE userId = ? AND role = 'platform_admin' LIMIT 1",
		userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// MachineToken resolves one machine token by its SHA-256 hash, joined to
// Org.isActive.
func (i *mysqlIdentity) MachineToken(ctx context.Context, tokenHash string) (machineTokenRecord, error) {
	if i == nil || i.db == nil {
		return machineTokenRecord{}, errNoDatabase
	}
	var id, orgID string
	var rawPermissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := i.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, tokenHash,
	).Scan(&id, &orgID, &rawPermissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return machineTokenRecord{}, errMachineTokenNotFound
	}
	if err != nil {
		return machineTokenRecord{}, err
	}
	var permissions machineTokenPermissions
	if len(rawPermissions) > 0 {
		if err := json.Unmarshal(rawPermissions, &permissions); err != nil {
			// A non-array permissions document grants nothing; it never becomes a
			// wildcard.
			permissions = nil
		}
	}
	return machineTokenRecord{
		ID:          id,
		OrgID:       orgID,
		Permissions: permissions,
		Revoked:     revoked.Valid,
		Expired:     expires.Valid && !expires.Time.After(time.Now()),
		OrgActive:   active != 0,
	}, nil
}

// TouchMachineToken refreshes lastUsedAt, best-effort like the NestJS
// `.catch(() => undefined)`.
func (i *mysqlIdentity) TouchMachineToken(ctx context.Context, id string) error {
	if i == nil || i.db == nil {
		return errNoDatabase
	}
	_, err := i.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowMillis(), id)
	return err
}
