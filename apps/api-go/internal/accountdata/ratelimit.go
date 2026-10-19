package accountdata

import (
	"context"
	"errors"
	"time"
)

// dataExportRateLimit and its window mirror EXPORT_RATE_LIMIT /
// EXPORT_RATE_LIMIT_WINDOW_SECONDS (3 per hour).
const (
	dataExportRateLimit        = 3
	dataExportRateLimitWindow  = 60 * 60
	dataExportRateLimitMaxWait = 100 * time.Millisecond
	dataExportCleanupLimit     = 100
	dataExportCleanupThreshold = 1000
)

// dataExportRateLimitMessage is the exact TooManyRequestsException text.
const dataExportRateLimitMessage = "Too many data export requests. Please try again later."

// slidingWindowLua is the Nest RateLimiterService script, byte-identical. The
// key pair is the bucket and its sequence counter, so Go and NestJS count
// against the same ZSET and share one quota.
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

// enforceDataExportRateLimit consumes one slot on
// `rate:data-export:user:{orgId}:{userId}`. The tenant and the user are part of
// one key, so one organization can never exhaust another's quota. A Redis
// failure follows RATE_LIMIT_REDIS_FAIL_OPEN: the Nest default is fail-closed,
// which answers the same 429 as an exhausted quota.
func (s *Service) enforceDataExportRateLimit(ctx context.Context, orgID, userID string) error {
	if s == nil || s.redis == nil {
		return errors.New("accountdata: redis is not configured")
	}
	allowed, err := s.consumeSlidingWindow(ctx, "rate:data-export:user:"+orgID+":"+userID,
		dataExportRateLimit, dataExportRateLimitWindow)
	if err != nil {
		if s.cfg.RateLimitFailOpen {
			return nil
		}
		return tooManyRequests(dataExportRateLimitMessage)
	}
	if !allowed {
		return tooManyRequests(dataExportRateLimitMessage)
	}
	return nil
}

// consumeSlidingWindow runs the shared script once.
func (s *Service) consumeSlidingWindow(ctx context.Context, bucketKey string, limit, windowSeconds int) (bool, error) {
	now := time.Now().UnixMilli()
	windowMs := int64(windowSeconds) * 1000
	ttl := windowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	evalCtx, cancel := context.WithTimeout(ctx, dataExportRateLimitMaxWait)
	defer cancel()

	value, err := s.redis.Eval(evalCtx, slidingWindowLua, []string{bucketKey, bucketKey + ":seq"},
		now, windowMs, limit, ttl, dataExportCleanupLimit, dataExportCleanupThreshold).Result()
	if err != nil {
		return false, redisWrap(err)
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false, errors.New("accountdata: unexpected rate limit reply")
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, nil
	case int:
		return allowed == 1, nil
	default:
		return false, errors.New("accountdata: unexpected rate limit reply")
	}
}
