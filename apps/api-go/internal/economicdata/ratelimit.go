package economicdata

import (
	"context"
	"errors"
	"time"
)

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

// RateLimitError is the GraphQL TOO_MANY_REQUESTS / REST 429 contract.
type RateLimitError struct{ Message string }

func (e *RateLimitError) Error() string { return e.Message }

const (
	presetRateLimitMessage  = "This economic data preset was refreshed recently. Please wait before triggering it again."
	upgradeRateLimitMessage = "Akshare upgrade can only be triggered once per hour. Please wait before trying again."
)

// EnforcePresetLimit consumes rate:economic-data:refresh:<org>:<preset>.
func (s *Service) EnforcePresetLimit(ctx context.Context, orgID, preset string) error {
	return s.consumeRateLimit(ctx, "economic-data:refresh:"+orgID+":"+preset, 1, 60, presetRateLimitMessage)
}

// EnforceAkshareUpgradeLimit consumes rate:akshare:upgrade:<org>.
func (s *Service) EnforceAkshareUpgradeLimit(ctx context.Context, orgID string) error {
	return s.consumeRateLimit(ctx, "akshare:upgrade:"+orgID, 1, 3600, upgradeRateLimitMessage)
}

func (s *Service) consumeRateLimit(ctx context.Context, key string, limit, windowSeconds int, message string) error {
	if s == nil || s.redis == nil {
		return errNoRedis
	}
	allowed, err := s.consumeSlidingWindow(ctx, key, limit, windowSeconds)
	if err != nil {
		if s.env.RateLimitFailOpen {
			return nil
		}
		return &RateLimitError{Message: message}
	}
	if !allowed {
		return &RateLimitError{Message: message}
	}
	return nil
}

func (s *Service) consumeSlidingWindow(ctx context.Context, key string, limit, windowSeconds int) (bool, error) {
	if limit <= 0 || windowSeconds <= 0 {
		return true, nil
	}
	now := time.Now().UnixMilli()
	ttl := windowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	evalCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	bucket := "rate:" + key
	value, err := s.redis.Eval(evalCtx, slidingWindowLua, []string{bucket, bucket + ":seq"},
		now, int64(windowSeconds)*1000, limit, ttl, 100, 1000).Result()
	if err != nil {
		return false, err
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false, errors.New("economicdata: unexpected rate limit reply")
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, nil
	case int:
		return allowed == 1, nil
	default:
		return false, errors.New("economicdata: unexpected rate limit reply")
	}
}
