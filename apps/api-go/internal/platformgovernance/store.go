package platformgovernance

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Env carries the environment-derived defaults the sixteen routes serve when no
// SystemSetting row exists. Every field mirrors a NestJS EnvService getter (or a
// zod default) with the same value, so the two implementations agree.
type Env struct {
	// AssistantGuardrailsEnabled is ASSISTANT_GUARDRAILS_ENABLED (default true).
	AssistantGuardrailsEnabled bool
	// AssistantGuardrails is the raw ASSISTANT_GUARDRAILS string; it is split on
	// commas, trimmed and emptied exactly like EnvService.assistantConfig.
	AssistantGuardrails string
	// AssistantOrgSubmitLimitPerHour is ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR.
	AssistantOrgSubmitLimitPerHour int
	// AssistantOrgMaxInFlight is ASSISTANT_ORG_MAX_IN_FLIGHT.
	AssistantOrgMaxInFlight int
	// AssistantOrgMonthlyTokenBudget is ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET.
	AssistantOrgMonthlyTokenBudget int64
	// TaskLogRetentionDays is TASK_LOG_RETENTION_DAYS before the 1..3650 clamp.
	TaskLogRetentionDays int
	// EncryptionKeyRaw is SYSTEM_SETTINGS_ENCRYPTION_KEY exactly as configured,
	// never trimmed: "" means "unset or empty" (present=false) while whitespace
	// means "present but empty" (a decoder error).
	EncryptionKeyRaw string
}

// Service owns the MySQL pool, the Redis client and the Mongo database shared
// with the rest of the gateway. All methods are safe for concurrent use.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	mongo *mongo.Database
	env   Env
	// sleep is the retry delay seam used by the TTL reconciliation; production
	// always uses time.Sleep.
	sleep func(time.Duration)
}

// NewService wires the platform governance settings data access. db, redisClient
// and mongoDB are the same connections the other Go domains use; a nil
// dependency produces the corresponding fail-closed error on the affected code
// path.
func NewService(db *sql.DB, redisClient *redis.Client, mongoDB *mongo.Database, env Env) *Service {
	return &Service{db: db, redis: redisClient, mongo: mongoDB, env: env, sleep: time.Sleep}
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

// upsertSettingForceDescriptionSQL inserts or updates one global SystemSetting
// row, refreshing description and isPublic on the duplicate-key branch.
//
// All five services of this batch set description and isPublic in BOTH branches
// of their Prisma upsert, so unlike the runtime settings domains the update
// branch must overwrite them.
//
// The alias form (VALUES ... AS new_row) requires MySQL 8.0.19+; the project's
// CI and production images are MySQL 8.x. `key` is a reserved word and is always
// backquoted.
const upsertSettingForceDescriptionSQL = "INSERT INTO SystemSetting " +
	"(`key`, value, isPublic, description, createdAt, updatedAt, updatedById) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, isPublic = new_row.isPublic, " +
	"description = new_row.description, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById"

// upsertSetting writes one global SystemSetting row, mirroring the Prisma
// upserts of this batch exactly: value, isPublic, description and updatedById
// are refreshed on UPDATE as well.
//
// isPublic is always 0 for these five settings; it is a parameter only so the
// INSERT branch stays explicit.
func (s *Service) upsertSetting(ctx context.Context, key string, value json.RawMessage, isPublic int, description string, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, upsertSettingForceDescriptionSQL,
		key, []byte(value), isPublic, description, now, now, updatedByID)
	return err
}

// deleteSetting removes the global SystemSetting row for key, mirroring
// PrismaService.systemSetting.deleteMany({ where: { key } }).
func (s *Service) deleteSetting(ctx context.Context, key string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", key)
	return err
}

// ---- AuditLog ----

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload exactly so
// the existing retry worker can replay it.
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
// metadata must already be a marshalled named struct; it is passed through as
// raw bytes so no schema-less Go container is involved.
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
		log.Printf("platformgovernance: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("platformgovernance: failed to write audit log and enqueue outbox for %s: %v", action, err)
	}
}

// ---- Redis cache ----

// cacheGet reads a raw JSON cache entry. A missing key is reported as
// found=false rather than as an error; malformed JSON is an error so the caller
// can fall back to MySQL (NestJS JSON.parse throws in the same situation).
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
		return nil, false, errors.New("platformgovernance: cache entry is not valid json")
	}
	return json.RawMessage(raw), true, nil
}

// cacheSet writes a raw JSON cache entry with an expiry, mirroring
// CacheService.set (SET key value EX ttl).
func (s *Service) cacheSet(ctx context.Context, key string, payload []byte, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Set(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Err()
}

// cacheDel removes a cache entry, mirroring CacheService.del.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return s.redis.Del(ctx, key).Err()
}

// logCacheFailure records a Redis failure on a path where NestJS only logs a
// warning and continues (read tolerance, best-effort eviction).
func logCacheFailure(kind, key string, err error) {
	log.Printf("platformgovernance: %s cache operation failed for %q: %v", kind, key, err)
}

// ---- Mongo ----

// mongoCollection resolves one collection name against the shared database. A
// nil database (only possible when the mode dependency check was bypassed)
// returns nil and the caller reports errNoMongo.
func (s *Service) mongoCollection(name string) *mongo.Collection {
	if s == nil || s.mongo == nil {
		return nil
	}
	return s.mongo.Collection(name)
}
