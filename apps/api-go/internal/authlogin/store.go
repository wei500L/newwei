package authlogin

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authfactors"
)

// Service owns the shared MySQL pool, the shared Redis client and the two reused
// port objects for the login chain. It opens no second connection pool, starts no
// background worker and keeps no request state.
type Service struct {
	db      *sql.DB
	redis   *redis.Client
	cfg     Config
	store   *accountsecurity.LoginStore
	factors *authfactors.Service
	signer  *tokenSigner
	mailer  *mailer
}

// NewService wires the login chain onto the shared connections. The MFA factor
// service is constructed here so the login chain reuses the existing TOTP,
// recovery-code and secret-encryption implementation instead of a second copy.
func NewService(db *sql.DB, redisClient *redis.Client, cfg Config) *Service {
	service := &Service{
		db:    db,
		redis: redisClient,
		cfg:   cfg,
	}
	if db != nil {
		service.store = accountsecurity.NewLoginStore(db, redisClient)
		service.factors = authfactors.NewService(db, redisClient, authfactors.Config{
			EncryptionKeyRaw:     cfg.EncryptionKeyRaw,
			EncryptionKeyPresent: cfg.EncryptionKeyPresent,
			NodeEnv:              cfg.NodeEnv,
		})
	}
	service.signer = newTokenSigner(cfg)
	service.mailer = newMailer(cfg.SMTP)
	return service
}

// Config exposes the resolved configuration (used by tests).
func (s *Service) Config() Config {
	if s == nil {
		return Config{}
	}
	return s.cfg
}

// ---- identifiers and time ----

// nowMillis returns the current UTC instant truncated to milliseconds, because
// every DATETIME(3) column Prisma writes has millisecond precision.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID generates a client-side identifier in the shape Prisma's cuid()
// produces ('c' plus 24 hex characters) for the tables whose id has no database
// default.
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// newUUIDv4 generates a version-4 UUID in the canonical hyphenated form. Refresh
// token ids and access-token jti values use it because NestJS uses
// crypto.randomUUID() for both, and the refresh token string embeds the id in a
// form both parsers must accept.
func newUUIDv4() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// randomHex returns n cryptographically random bytes as lowercase hex.
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// randomDigits returns a fixed-length decimal code drawn from crypto/rand. Every
// digit is independent, so no modulo bias is introduced.
func randomDigits(length int) (string, error) {
	out := make([]byte, length)
	var block [1]byte
	for index := range out {
		for {
			if _, err := io.ReadFull(rand.Reader, block[:]); err != nil {
				return "", err
			}
			// Reject the top of the byte range so 0..9 stays uniform.
			if block[0] >= 250 {
				continue
			}
			out[index] = byte('0' + block[0]%10)
			break
		}
	}
	return string(out), nil
}

// nestTimestamp renders an instant exactly like Date.prototype.toISOString at
// millisecond precision.
func nestTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func nestTimestampPtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	rendered := nestTimestamp(*value)
	return &rendered
}

// ttlSecondsUntil mirrors the NestJS helper: whole seconds remaining, floored at
// zero, used for the revocation TTL of a token that is still alive.
func ttlSecondsUntil(expiresAt, now time.Time) int {
	remaining := expiresAt.Sub(now)
	if remaining <= 0 {
		return 0
	}
	return int((remaining + time.Second - 1) / time.Second)
}

// osNullString renders a *string as a driver value.
func osNullString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func nullableTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	instant := value.Time.UTC()
	return &instant
}

// isNoRows reports the sql.ErrNoRows sentinel through any wrapping.
func isNoRows(err error) bool { return errors.Is(err, sql.ErrNoRows) }

// ---- Redis ----

// cacheGetJSON reads a JSON cache entry. A missing key is (nil, false, nil);
// malformed JSON is an error because NestJS JSON.parse throws in that case.
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
		return nil, false, redisWrap(fmt.Errorf("authlogin: cache entry %q is not valid json", key))
	}
	return json.RawMessage(raw), true, nil
}

// cacheSet mirrors CacheService.set: an expiry is only attached when the caller
// supplied a positive TTL.
func (s *Service) cacheSet(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	if ttlSeconds > 0 {
		return redisWrap(s.redis.Set(ctx, key, []byte(payload), time.Duration(ttlSeconds)*time.Second).Err())
	}
	return redisWrap(s.redis.Set(ctx, key, []byte(payload), 0).Err())
}

// cacheDel mirrors CacheService.del and returns the number of removed keys. The
// email-code flows depend on that count: a single-use code is only consumed when
// exactly one caller removed it.
func (s *Service) cacheDel(ctx context.Context, key string) (int64, error) {
	if s == nil || s.redis == nil {
		return 0, errNoRedis
	}
	removed, err := s.redis.Del(ctx, key).Result()
	if err != nil {
		return 0, redisWrap(err)
	}
	return removed, nil
}

// incr mirrors CacheService.incr: the counter is incremented first and the
// window expiry is attached only when the key was created by this call, so the
// attempt window never slides.
func (s *Service) incr(ctx context.Context, key string, ttlSeconds int) (int64, error) {
	if s == nil || s.redis == nil {
		return 0, errNoRedis
	}
	value, err := s.redis.Incr(ctx, key).Result()
	if err != nil {
		return 0, redisWrap(err)
	}
	if value == 1 && ttlSeconds > 0 {
		if err := s.redis.Expire(ctx, key, time.Duration(ttlSeconds)*time.Second).Err(); err != nil {
			return 0, redisWrap(err)
		}
	}
	return value, nil
}

// setIfAbsent mirrors CacheService.setIfAbsent (SET NX EX max(1, floor(ttl))).
func (s *Service) setIfAbsent(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) (bool, error) {
	if s == nil || s.redis == nil {
		return false, errNoRedis
	}
	ttl := ttlSeconds
	if ttl < 1 {
		ttl = 1
	}
	acquired, err := s.redis.SetNX(ctx, key, []byte(payload), time.Duration(ttl)*time.Second).Result()
	if err != nil {
		return false, redisWrap(err)
	}
	return acquired, nil
}

// ---- shared lock (CacheService lock protocol) ----

// The scripts compare the owner token before mutating, so a lock already
// re-acquired by somebody else is never released or extended by the previous
// holder.
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

func (s *Service) acquireLock(ctx context.Context, lockKey string, ttl time.Duration) (string, error) {
	if s == nil || s.redis == nil {
		return "", errNoRedis
	}
	token, err := randomHex(16)
	if err != nil {
		return "", err
	}
	acquired, err := s.redis.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return "", redisWrap(err)
	}
	if !acquired {
		return "", nil
	}
	return token, nil
}

func (s *Service) releaseLock(ctx context.Context, lockKey, token string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	return redisWrap(s.redis.Eval(ctx, releaseLockScript, []string{lockKey}, token).Err())
}

func (s *Service) extendLock(ctx context.Context, lockKey, token string, ttl time.Duration) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	ttlMs := ttl.Milliseconds()
	if ttlMs < 1000 {
		ttlMs = 1000
	}
	return redisWrap(s.redis.Eval(ctx, extendLockScript, []string{lockKey}, token, ttlMs).Err())
}

// wrapRefreshResult reproduces CacheService.wrap for the refresh rotation:
//
//   - a cached value short-circuits the loader entirely (the grace window);
//   - otherwise a shared lock serializes the loader, renewed while it runs;
//   - when the lock cannot be acquired within maxWait the loader still runs
//     WITHOUT a lock, exactly like NestJS, so the atomic single-use claim inside
//     the loader — not the lock — remains the real protection;
//   - loader failures are never cached.
//
// The lock key, TTL and the release/extend protocol are shared with NestJS, so
// both implementations serialize against each other.
func (s *Service) wrapRefreshResult(
	ctx context.Context,
	key string,
	ttlSeconds int,
	loader func(context.Context) (sessionResult, error),
	lockTTL time.Duration,
	retryDelay time.Duration,
	maxWait time.Duration,
) (sessionResult, error) {
	if cached, found, err := s.readCachedSession(ctx, key); err != nil {
		return sessionResult{}, err
	} else if found {
		return cached, nil
	}

	lockKey := lockKeyPrefix + key
	token, err := s.acquireLock(ctx, lockKey, lockTTL)
	if err != nil {
		return sessionResult{}, err
	}
	if token == "" {
		deadline := time.Now().Add(maxWait)
		for time.Now().Before(deadline) {
			if err := sleepContext(ctx, retryDelay); err != nil {
				return sessionResult{}, err
			}
			if cached, found, err := s.readCachedSession(ctx, key); err != nil {
				return sessionResult{}, err
			} else if found {
				return cached, nil
			}
			token, err = s.acquireLock(ctx, lockKey, lockTTL)
			if err != nil {
				return sessionResult{}, err
			}
			if token != "" {
				break
			}
		}
	}

	if token != "" {
		stopRenew := s.startLockRenewal(ctx, lockKey, token, lockTTL)
		defer stopRenew()
		defer func() {
			// Best-effort release: a failed unlock only costs the remaining TTL.
			_ = s.releaseLock(ctx, lockKey, token)
		}()
		value, err := loader(ctx)
		if err != nil {
			return sessionResult{}, err
		}
		if err := s.storeSessionCache(ctx, key, ttlSeconds, value); err != nil {
			return sessionResult{}, err
		}
		return value, nil
	}

	if cached, found, err := s.readCachedSession(ctx, key); err != nil {
		return sessionResult{}, err
	} else if found {
		return cached, nil
	}
	value, err := loader(ctx)
	if err != nil {
		return sessionResult{}, err
	}
	if err := s.storeSessionCache(ctx, key, ttlSeconds, value); err != nil {
		return sessionResult{}, err
	}
	return value, nil
}

func (s *Service) readCachedSession(ctx context.Context, key string) (sessionResult, bool, error) {
	raw, found, err := s.cacheGetJSON(ctx, key)
	if err != nil || !found {
		return sessionResult{}, false, err
	}
	var cached sessionResult
	if err := json.Unmarshal(raw, &cached); err != nil {
		return sessionResult{}, false, redisWrap(err)
	}
	return cached, true, nil
}

func (s *Service) storeSessionCache(ctx context.Context, key string, ttlSeconds int, value sessionResult) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.cacheSet(ctx, key, payload, ttlSeconds)
}

// startLockRenewal extends the lock while the loader runs, so an expensive
// rotation that outlives the TTL does not let a second request run the loader
// concurrently. The returned function stops the renewal.
func (s *Service) startLockRenewal(ctx context.Context, lockKey, token string, lockTTL time.Duration) func() {
	interval := lockTTL / 2
	if interval < time.Second {
		interval = time.Second
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				// context.WithoutCancel keeps the renewal alive when the client
				// request is cancelled mid-rotation.
				if err := s.extendLock(context.WithoutCancel(ctx), lockKey, token, lockTTL); err != nil {
					log.Printf("authlogin: refresh lock renewal failed: %v", err)
				}
			}
		}
	}()
	return func() { close(stop) }
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// trimSpace is a local alias so the hot paths never import strings twice for one
// call; it behaves exactly like strings.TrimSpace.
func trimSpace(value string) string { return strings.TrimSpace(value) }

// logBackgroundFailure records a failure that must not change the response: the
// settings fallback and the best-effort audit paths keep serving while logging.
func logBackgroundFailure(operation string, err error) {
	if err == nil {
		return
	}
	log.Printf("authlogin: %s failed: %v", operation, err)
}

// ---- settings helpers ----

// clampInt normalizes an integer into [min,max]; a non-positive value falls back
// to min, matching the NestJS clamp helpers.
func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// jsonIntValue decodes a JSON number or numeric string. Prisma stores Int
// columns as JSON numbers, but a value written through a looser path may arrive
// as a string.
func jsonIntValue(raw json.RawMessage) (int, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0, false
		}
		parsed, err := strconv.Atoi(strings.TrimSpace(text))
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, false
	}
	return int(number), true
}

// jsonStringValue decodes a JSON string member.
func jsonStringValue(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}
