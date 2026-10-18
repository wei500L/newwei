package accountsecurity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Config carries the environment-derived defaults and cache TTLs the service
// needs. The S3_* and encryption fields mirror the NestJS EnvService getters
// used by the storage read path; the AUTH_PROFILE_CACHE_* fields mirror the
// auth-cache defaults.
type Config struct {
	AuthProfileCacheTTLSeconds   int
	AuthProfileCacheLockTTLMs    int
	AuthProfileCacheMaxWaitMs    int
	AuthProfileCacheRetryDelayMs int

	S3AccessKeyID            string
	S3SecretAccessKey        string
	S3Region                 string
	S3Bucket                 string
	S3Endpoint               string
	S3PublicBaseURL          string
	S3ForcePathStyle         bool
	S3PresignedURLTTLSeconds int

	EncryptionKeyRaw     string
	EncryptionKeyPresent bool
}

// Service owns the shared MySQL pool and the shared Redis client. All methods
// are safe for concurrent use.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	cfg   Config
}

// NewService wires the account security data access. db and redisClient are the
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

// ---- value helpers ----

// nowMillis returns the current UTC time truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes.
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

// randomTokenHex generates an owner token for the profile cache lock.
func randomTokenHex() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// nullableActorID mirrors normalizeAuditActorId for the columns that are
// nullable foreign keys into User: a machine actor ("machine:<id>") and an empty
// actor are stored as SQL NULL, a human user id is kept unchanged.
func nullableActorID(actorID string) *string {
	if actorID == "" || strings.HasPrefix(actorID, machineActorPrefix) {
		return nil
	}
	value := actorID
	return &value
}

// machineActorPrefix is the user-id prefix the machine authentication path
// produces.
const machineActorPrefix = "machine:"

// isNoRows reports whether err is sql.ErrNoRows.
func isNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}

// nullableString converts a sql.NullString to a *string.
func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

// nullableTime converts a sql.NullTime to a *time.Time (UTC, milliseconds).
func nullableTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	utc := value.Time.UTC().Truncate(time.Millisecond)
	return &utc
}

// ---- MySQL ----

// loadSetting reads SystemSetting.value as raw JSON bytes. found is false when
// the row does not exist. The bytes are decoded into named structs by callers
// and never interpreted as a loose map.
func (s *Service) loadSetting(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errNoDatabase
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, dbWrap(err)
	}
	return json.RawMessage(raw), true, nil
}

// membershipOrgIDs lists every organization the user belongs to. It is used to
// invalidate every cached profile of that user after a global profile update.
func (s *Service) membershipOrgIDs(ctx context.Context, userID string) ([]string, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `orgId` FROM `Membership` WHERE `userId` = ?", userID)
	if err != nil {
		return nil, dbWrap(err)
	}
	defer rows.Close()
	orgIDs := make([]string, 0, 4)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, dbWrap(err)
		}
		orgIDs = append(orgIDs, orgID)
	}
	if err := rows.Err(); err != nil {
		return nil, dbWrap(err)
	}
	return orgIDs, nil
}

// ---- Redis ----

// cacheGetJSON reads a JSON cache entry. A missing key is reported as
// found=false; malformed JSON is an error because NestJS JSON.parse throws in
// the same situation.
func (s *Service) cacheGetJSON(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if s == nil || s.redis == nil {
		return nil, false, errNoRedis
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, redisWrap(err)
	}
	if len(raw) == 0 || !json.Valid(raw) {
		return nil, false, redisWrap(fmt.Errorf("accountsecurity: cache entry %q is not valid json", key))
	}
	return json.RawMessage(raw), true, nil
}

// cacheSet writes a JSON cache entry with an expiry, mirroring CacheService.set
// (SET key value EX ttl).
func (s *Service) cacheSet(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return redisWrap(s.redis.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err())
}

// cacheDel removes a cache entry, mirroring CacheService.del.
func (s *Service) cacheDel(ctx context.Context, key string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return redisWrap(s.redis.Del(ctx, key).Err())
}

// blacklistSet writes a boolean blacklist entry exactly like NestJS
// CacheService.set(key, true, ttl): the stored value is the JSON literal "true".
func (s *Service) blacklistSet(ctx context.Context, key string, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	if ttlSeconds <= 0 {
		return nil
	}
	return redisWrap(s.redis.Set(ctx, key, "true", time.Duration(ttlSeconds)*time.Second).Err())
}

// acquireLock mirrors CacheService.acquireLock: SET lockKey <randomToken> PX
// ttlMs NX. It returns the owner token, or "" when another holder owns the lock.
func (s *Service) acquireLock(ctx context.Context, lockKey string, ttlMs int) (string, error) {
	if s == nil || s.redis == nil {
		return "", errNoRedis
	}
	token, err := randomTokenHex()
	if err != nil {
		return "", err
	}
	acquired, err := s.redis.SetNX(ctx, lockKey, token, time.Duration(ttlMs)*time.Millisecond).Result()
	if err != nil {
		return "", redisWrap(err)
	}
	if !acquired {
		return "", nil
	}
	return token, nil
}

// lockScripts compare the stored owner token before mutating, so a lock that was
// already re-acquired by another request is never released or extended.
const releaseLockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const extendLockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

// releaseLock deletes the lock only when it is still owned by token.
func (s *Service) releaseLock(ctx context.Context, lockKey, token string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	if err := s.redis.Eval(ctx, releaseLockScript, []string{lockKey}, token).Err(); err != nil {
		return redisWrap(err)
	}
	return nil
}

// extendLock refreshes the lock TTL only when it is still owned by token.
func (s *Service) extendLock(ctx context.Context, lockKey, token string, ttlMs int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	if err := s.redis.Eval(ctx, extendLockScript, []string{lockKey}, token, ttlMs).Err(); err != nil {
		return redisWrap(err)
	}
	return nil
}

// logRedisFailure records a best-effort Redis failure (NestJS logs a warning on
// the paths where it does not propagate the error).
func logRedisFailure(operation, key string, err error) {
	if err == nil {
		return
	}
	log.Printf("accountsecurity: redis %s failed for %q: %v", operation, key, err)
}
