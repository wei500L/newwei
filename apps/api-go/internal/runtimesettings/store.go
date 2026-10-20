package runtimesettings

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// errNoDatabase is returned when the MySQL pool was not injected. The handler
// maps it to the same fail-closed 503 that NestJS produces for Prisma
// connection errors.
var errNoDatabase = errors.New("runtimesettings: mysql is not configured")

// errNoRedis is returned when the Redis client was not injected.
var errNoRedis = errors.New("runtimesettings: redis is not configured")

// Config carries the environment-derived defaults and cache TTLs the handlers
// need. Every field mirrors a NestJS EnvService getter with the same default,
// so the two implementations agree when no SystemSetting row exists yet.
type Config struct {
	RateLimitLogin                   int
	RateLimitLoginWindow             int
	RateLimitCrawlTaskCreate         int
	RateLimitCrawlTaskCreateWindow   int
	RateLimitRbacWrite               int
	RateLimitRbacWriteWindow         int
	RateLimitSettingsCacheTTLSeconds int

	AuthProfileCacheTTLSeconds   int
	AuthProfileCacheLockTTLMs    int
	AuthProfileCacheMaxWaitMs    int
	AuthProfileCacheRetryDelayMs int

	AuditLogRetentionDays int
}

// Service owns the MySQL pool and the Redis client shared with the rest of the
// gateway. All methods are safe for concurrent use.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	cfg   Config
	// newsSourceCache mirrors the news-source scheduler service's process-local
	// 30 second cache.
	newsSourceCache newsSourceSchedulerCache
	// digestDeliveryCache mirrors the multi-tenant scheduler service's 30 second
	// runtime cache for the digest delivery organization concurrency.
	digestDeliveryCache digestDeliveryRuntimeCache
	// kgIngestionCache is the same runtime cache for the knowledge-graph
	// ingestion organization concurrency.
	kgIngestionCache kgIngestionRuntimeCache
	// newsEventsIngestionCache is the same runtime cache for the news-event
	// ingestion organization concurrency.
	newsEventsIngestionCache newsEventsIngestionRuntimeCache
}

// NewService wires the runtime settings data access. db and redisClient are the
// same connections the other Go domains use; a nil db or nil Redis client
// produces the corresponding fail-closed error on the affected code path.
func NewService(db *sql.DB, redisClient *redis.Client, cfg Config) *Service {
	return &Service{db: db, redis: redisClient, cfg: cfg}
}

// Config exposes the resolved defaults (used by tests and diagnostics).
func (s *Service) Config() Config {
	if s == nil {
		return Config{}
	}
	return s.cfg
}

// ---- SystemSetting storage ----

// loadSetting reads SystemSetting.value as raw JSON bytes. found is false when
// the row does not exist. The bytes are decoded into a named struct by the
// caller; they are never interpreted as a loose map.
func (s *Service) loadSetting(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errNoDatabase
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// upsertSettingSQL inserts or updates one global SystemSetting row.
//
// Two behaviours are load-bearing for NestJS parity:
//   - description and isPublic are written only on the INSERT branch, exactly
//     like a Prisma upsert whose `update` block omits them;
//   - updatedById is written on both branches, but callers pass NULL for
//     machine tokens (see nullableActorID) because the column has a foreign key
//     into User(id).
//
// The alias form (VALUES ... AS new_row) requires MySQL 8.0.19+; the project's
// CI and production images are MySQL 8.x. `key` is a reserved word and is
// always backquoted.
const upsertSettingSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById"

// upsertSetting keeps the description of an existing row (Prisma upserts whose
// update block omits description).
func (s *Service) upsertSetting(ctx context.Context, key string, value json.RawMessage, description string, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingSQL,
		key, []byte(value), description, now, now, updatedByID)
	return err
}

// upsertSettingForceDescription overwrites the description of an existing row
// as well, matching the three services that set description in both branches of
// their Prisma upsert (multi-tenant scheduler, news-source scheduler and
// NewsNow personalization).
func (s *Service) upsertSettingForceDescription(ctx context.Context, key string, value json.RawMessage, description string, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingForceDescriptionSQL,
		key, []byte(value), description, now, now, updatedByID)
	return err
}

// upsertSettingForceDescriptionSQL is the description-overwriting variant of
// upsertSettingSQL. description is refreshed on the duplicate-key branch too.
const upsertSettingForceDescriptionSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById, description = new_row.description"

// upsertSettingTx runs the same statement on a transaction handle so the three
// rate-limit buckets commit atomically. The argument list is duplicated on
// purpose: database/sql only accepts a spread []any, and this package avoids
// untyped containers entirely.
func upsertSettingTx(ctx context.Context, tx *sql.Tx, key string, value json.RawMessage, description string, updatedByID *string) error {
	now := nowMillis()
	_, err := tx.ExecContext(ctx, upsertSettingSQL,
		key, []byte(value), description, now, now, updatedByID)
	return err
}

// logCacheFailure records a Redis failure on a path where NestJS only logs a
// warning and continues (read tolerance, best-effort eviction).
func logCacheFailure(kind, key string, err error) {
	log.Printf("runtimesettings: %s cache operation failed for %q: %v", kind, key, err)
}

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID generates a client-side identifier in the same shape Prisma's cuid()
// produces ('c' plus 24 hex characters). MySQL columns have no database default
// because Prisma fills them in before the INSERT.
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// ---- AuditLog ----

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload exactly so
// the existing retry worker can replay it. Metadata is passed through as raw
// bytes because the concrete metadata type is a named struct per domain.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort in apps/api: insert
// the AuditLog row first, fall back to an AuditLogOutbox entry on failure, and
// never turn a successfully persisted settings change into an HTTP error.
//
// actorID is normalised through nullableActorID, so a machine token writes NULL
// instead of "machine:<id>" (the column is a nullable foreign key into User).
// Every call site passes a named metadata struct marshalled to JSON.
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, action string, metadata json.RawMessage) {
	if s == nil || s.db == nil {
		return
	}
	const resource = "system_settings"
	actor := nullableActorID(actorID)
	now := nowMillis()

	if id, idErr := newRowID(); idErr == nil {
		_, err := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, resource, action, []byte(metadata), now)
		if err == nil {
			return
		}
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("runtimesettings: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("runtimesettings: failed to write audit log and enqueue outbox for %s: %v", action, err)
	}
}

// ---- Redis cache ----

// cacheGet reads a JSON cache entry. A missing key is reported as found=false
// rather than as an error; malformed JSON is an error so the caller can decide
// whether to fall back (NestJS JSON.parse throws in the same situation).
func (s *Service) cacheGet(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.redis == nil {
		return nil, false, errNoRedis
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 || !json.Valid(raw) {
		return nil, false, fmt.Errorf("runtimesettings: cache entry %q is not valid json", key)
	}
	return json.RawMessage(raw), true, nil
}

// cacheSet writes a JSON cache entry with an expiry, mirroring CacheService.set
// (SET key value EX ttl).
func (s *Service) cacheSet(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err()
}

// cacheDel removes a cache entry, mirroring CacheService.del.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Del(ctx, key).Err()
}

// cacheDelByPrefix best-effort deletes every key with the given prefix using a
// non-blocking SCAN loop. It reports how many keys were removed and never
// fails the caller's write: NestJS treats cache eviction the same way.
func (s *Service) cacheDelByPrefix(ctx context.Context, prefix string) int {
	if s == nil || s.redis == nil {
		return 0
	}
	var cursor uint64
	deleted := 0
	for {
		keys, next, err := s.redis.Scan(ctx, cursor, prefix+"*", 100).Result()
		if err != nil {
			log.Printf("runtimesettings: scan cache prefix %q failed: %v", prefix, err)
			return deleted
		}
		if len(keys) > 0 {
			removed, err := s.redis.Del(ctx, keys...).Result()
			if err != nil {
				log.Printf("runtimesettings: delete cache prefix %q failed: %v", prefix, err)
				return deleted
			}
			deleted += int(removed)
		}
		cursor = next
		if cursor == 0 {
			return deleted
		}
	}
}
