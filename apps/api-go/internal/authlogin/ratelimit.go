package authlogin

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// slidingWindowLua is the Nest RateLimiterService script, byte-identical. The key
// pair is the bucket and its sequence counter; both implementations therefore
// count against the same ZSET and share one quota.
const slidingWindowLua = `
local bucket_key = KEYS[1]
local sequence_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])
local cleanup_limit = tonumber(ARGV[5])
local cleanup_threshold = tonumber(ARGV[6])

local window_start = now - window_ms
local window_min = '(' .. tostring(window_start)
local active = redis.call('ZCOUNT', bucket_key, window_min, now)

if cleanup_limit > 0 and cleanup_threshold > 0 then
  local total = redis.call('ZCARD', bucket_key)
  if (total - active) >= cleanup_threshold then
    local expired = redis.call('ZRANGEBYSCORE', bucket_key, 0, window_start, 'LIMIT', 0, cleanup_limit)
    if #expired > 0 then
      redis.call('ZREM', bucket_key, unpack(expired))
    end
  end
end

if active >= limit then
  redis.call('EXPIRE', bucket_key, ttl_seconds)
  redis.call('EXPIRE', sequence_key, ttl_seconds)
  return {0, active}
end

local sequence = redis.call('INCR', sequence_key)
redis.call('ZADD', bucket_key, now, tostring(now) .. '-' .. sequence)
redis.call('EXPIRE', bucket_key, ttl_seconds)
redis.call('EXPIRE', sequence_key, ttl_seconds)

return {1, active + 1}
`

// rateLimitEvalTimeoutMs mirrors RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS: a Redis call
// that exceeds it counts as a failure, and the failure result is the configured
// fail-open/fail-closed answer rather than an unbounded wait.
const rateLimitEvalTimeoutMs = 100

// loginRateLimitScene is the bucket prefix. Password login and email-code login
// deliberately use separate scenes so one cannot exhaust the other, while both
// read the same `login` configuration bucket.
type loginRateLimitScene string

const (
	sceneLoginPassword loginRateLimitScene = "login"
	sceneLoginCode     loginRateLimitScene = "login-code"
)

// buildLoginRateLimitKey mirrors AuthService.buildLoginRateLimitKey: the account
// and the caller IP are ONE combined key, not two independent buckets. A missing
// IP becomes the literal "unknown-ip" so an unproxied deployment still throttles.
func buildLoginRateLimitKey(scene loginRateLimitScene, normalizedEmail string, ipAddress *string) string {
	ip := ""
	if ipAddress != nil {
		ip = trimSpace(*ipAddress)
	}
	if ip == "" {
		ip = "unknown-ip"
	}
	return string(scene) + ":" + normalizedEmail + ":" + ip
}

// enforceLoginRateLimit consumes one slot and answers the shared 429 when the
// quota is exhausted. A Redis failure is fail-closed by default, matching
// RATE_LIMIT_REDIS_FAIL_OPEN=false: a limiter outage must not become an open
// brute-force window.
func (s *Service) enforceLoginRateLimit(ctx context.Context, scene loginRateLimitScene, normalizedEmail string, ipAddress *string) error {
	limit, windowSeconds := s.loginRateLimitBucket(ctx)
	if limit <= 0 || windowSeconds <= 0 {
		return nil
	}
	key := "rate:" + buildLoginRateLimitKey(scene, normalizedEmail, ipAddress)
	allowed, err := s.consumeSlidingWindow(ctx, key, limit, windowSeconds)
	if err != nil {
		if s.cfg.RateLimitFailOpen {
			return nil
		}
		return tooManyRequests(tooManyLoginAttemptsMessage)
	}
	if !allowed {
		return tooManyRequests(tooManyLoginAttemptsMessage)
	}
	return nil
}

// loginRateLimitBucket resolves the `login` bucket: the shared
// rate_limit:settings document first (written by the runtime-settings batch and
// by NestJS), then the rate_limit_login SystemSetting row, then the environment
// defaults.
//
// This read path deliberately does NOT write the settings document: a partial
// document would make the other buckets fall back to environment defaults for
// whoever reads it next, silently loosening NestJS limits.
func (s *Service) loginRateLimitBucket(ctx context.Context) (int, int) {
	if raw, found, err := s.cacheGetJSON(ctx, rateLimitSettingsCacheKey); err == nil && found {
		var settings loginRateLimitSettings
		if json.Unmarshal(raw, &settings) == nil && settings.Login.Limit > 0 {
			return clampInt(settings.Login.Limit, rateLimitMinLimit, rateLimitMaxLimit),
				clampInt(settings.Login.WindowSeconds, rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds)
		}
	}
	if s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", "rate_limit_login").Scan(&raw)
		if err == nil && len(raw) > 0 {
			var bucket rateLimitBucket
			if json.Unmarshal(raw, &bucket) == nil && bucket.Limit > 0 {
				return clampInt(bucket.Limit, rateLimitMinLimit, rateLimitMaxLimit),
					clampInt(bucket.WindowSeconds, rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds)
			}
		} else if err != nil && !isNoRows(err) {
			dbWrapped := dbWrap(err)
			logBackgroundFailure("login rate limit settings", dbWrapped)
		}
	}
	return clampInt(s.cfg.RateLimitLogin, rateLimitMinLimit, rateLimitMaxLimit),
		clampInt(s.cfg.RateLimitLoginWindow, rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds)
}

// consumeSlidingWindow runs the shared script once. A timeout or Redis error is
// reported as an error so the caller applies the fail-open/fail-closed policy.
func (s *Service) consumeSlidingWindow(ctx context.Context, bucketKey string, limit, windowSeconds int) (bool, error) {
	if s.redis == nil {
		return false, errNoRedis
	}
	now := time.Now().UnixMilli()
	windowMs := int64(windowSeconds) * 1000
	ttl := windowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	evalCtx, cancel := context.WithTimeout(ctx, rateLimitEvalTimeoutMs*time.Millisecond)
	defer cancel()

	value, err := s.redis.Eval(evalCtx, slidingWindowLua, []string{bucketKey, bucketKey + ":seq"},
		now, windowMs, limit, ttl, 100, 1000).Result()
	if err != nil {
		return false, redisWrap(err)
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false, errors.New("authlogin: unexpected rate limit reply")
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, nil
	case int:
		return allowed == 1, nil
	default:
		return false, errors.New("authlogin: unexpected rate limit reply")
	}
}

// enforcePasswordResetRateLimit mirrors
// ActionRateLimitService.enforcePasswordResetRequest using the independent
// auth.password_reset policy: an IP bucket and a hashed-email bucket, counted on
// separate keys from the login quota. Like the login limiter it is fail-closed:
// a Redis failure answers the throttle instead of letting the request through.
func (s *Service) enforcePasswordResetRateLimit(ctx context.Context, normalizedEmail string, ipAddress *string) error {
	policy := s.passwordResetPolicy(ctx)
	if policy.IPLimit > 0 && policy.WindowSeconds > 0 && ipAddress != nil && trimSpace(*ipAddress) != "" {
		allowed, err := s.consumeSlidingWindow(ctx, "rate:auth:password-reset:ip:"+trimSpace(*ipAddress), policy.IPLimit, policy.WindowSeconds)
		if err != nil && !s.cfg.RateLimitFailOpen {
			return tooManyRequests(passwordResetRateLimitMessage)
		}
		if err == nil && !allowed {
			return tooManyRequests(passwordResetRateLimitMessage)
		}
	}
	if policy.UserLimit > 0 && policy.WindowSeconds > 0 {
		key := "rate:auth:password-reset:email:" + hashSHA256Hex(normalizedEmail)
		allowed, err := s.consumeSlidingWindow(ctx, key, policy.UserLimit, policy.WindowSeconds)
		if err != nil && !s.cfg.RateLimitFailOpen {
			return tooManyRequests(passwordResetRateLimitMessage)
		}
		if err == nil && !allowed {
			return tooManyRequests(passwordResetRateLimitMessage)
		}
	}
	return nil
}

// passwordResetPolicy resolves auth.password_reset from the shared policy cache,
// then the RateLimitPolicy row, then the documented defaults. A cached null
// entry is the NestJS "no policy configured" answer and must not fall through to
// the database.
func (s *Service) passwordResetPolicy(ctx context.Context) passwordResetPolicy {
	fallback := passwordResetPolicy{
		UserLimit:     passwordResetDefaultEmailLimit,
		IPLimit:       passwordResetDefaultIPLimit,
		WindowSeconds: passwordResetDefaultWindow,
	}
	cacheKey := rateLimitPolicyCachePrefix + passwordResetPolicyFeature
	if raw, found, err := s.cacheGetJSON(ctx, cacheKey); err == nil && found {
		var entry rateLimitPolicyCacheEntry
		if json.Unmarshal(raw, &entry) == nil {
			if entry.Policy == nil {
				return fallback
			}
			return passwordResetPolicyFromRecord(*entry.Policy)
		}
	}
	if s.db == nil {
		return fallback
	}
	var record rateLimitPolicyRecord
	err := s.db.QueryRowContext(ctx,
		"SELECT `userLimit`, `ipLimit`, `windowSeconds`, `enabled` FROM `RateLimitPolicy` "+
			"WHERE `feature` = ? LIMIT 1", passwordResetPolicyFeature).
		Scan(&record.UserLimit, &record.IPLimit, &record.WindowSeconds, &record.Enabled)
	if isNoRows(err) {
		return fallback
	}
	if err != nil {
		logBackgroundFailure("password reset policy", dbWrap(err))
		return fallback
	}
	return passwordResetPolicyFromRecord(record)
}

// passwordResetPolicyFromRecord reproduces resolvePasswordResetPolicy: a policy
// with enabled=false disables both limits while keeping its window, and an
// enabled policy is used exactly as stored (NestJS normalizes on write, not on
// read).
func passwordResetPolicyFromRecord(record rateLimitPolicyRecord) passwordResetPolicy {
	if !record.Enabled {
		return passwordResetPolicy{UserLimit: 0, IPLimit: 0, WindowSeconds: record.WindowSeconds}
	}
	return passwordResetPolicy{UserLimit: record.UserLimit, IPLimit: record.IPLimit, WindowSeconds: record.WindowSeconds}
}
