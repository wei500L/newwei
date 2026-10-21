package socketio

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// slidingWindowLua is the same script as Nest RateLimiterService. The caller
// keys are ws:connect:ip:<ip> / ws:connect:user:<userId>; the script arguments
// add the shared "rate:" prefix, so Go and NestJS cannot create parallel
// buckets for the same client.
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

const (
	wsBackoffPrefix = "ws:backoff:"
	baseBackoff     = time.Second
	maxBackoff      = time.Minute
	// limiterRedisTimeout bounds a single Redis call on the handshake path.
	limiterRedisTimeout = 500 * time.Millisecond
)

// Limiter applies the shared WebSocket connection rate limits and the
// failed-authentication backoff. It uses the same Redis keys and Lua script as
// the NestJS WsConnectionRateLimiterService, so both runtimes spend from one
// quota. All Redis failures fail open: an outage must not lock every browser out
// of the console.
type Limiter struct {
	redis         *redis.Client
	limitPerIP    int
	limitPerUser  int
	windowSeconds int
	timeout       time.Duration
}

// NewLimiter builds a limiter. Non-positive limits and window fall back to the
// NestJS defaults (60 connections per IP, 30 per user, 60 second window).
func NewLimiter(client *redis.Client, limitPerIP, limitPerUser, windowSeconds int) *Limiter {
	if limitPerIP <= 0 {
		limitPerIP = 60
	}
	if limitPerUser <= 0 {
		limitPerUser = 30
	}
	if windowSeconds <= 0 {
		windowSeconds = 60
	}
	return &Limiter{
		redis:         client,
		limitPerIP:    limitPerIP,
		limitPerUser:  limitPerUser,
		windowSeconds: windowSeconds,
		timeout:       limiterRedisTimeout,
	}
}

// CheckIP spends one slot in the per-IP connection window. It returns
// allowed=false and the retry-after in milliseconds when the limit is exceeded.
func (l *Limiter) CheckIP(ctx context.Context, ip string) (bool, int64) {
	if ip == "" {
		return true, 0
	}
	return l.consume(ctx, "ws:connect:ip:"+ip, l.limitPerIP)
}

// CheckUser spends one slot in the per-user connection window.
func (l *Limiter) CheckUser(ctx context.Context, userID string) (bool, int64) {
	if userID == "" {
		return true, 0
	}
	return l.consume(ctx, "ws:connect:user:"+userID, l.limitPerUser)
}

func (l *Limiter) consume(ctx context.Context, key string, limit int) (bool, int64) {
	if limit <= 0 {
		return true, 0
	}
	evalCtx, cancel := context.WithTimeout(ctx, l.timeout)
	defer cancel()

	now := time.Now().UnixMilli()
	windowMS := l.windowSeconds * 1000
	ttl := int(math.Ceil(float64(l.windowSeconds) * 2))
	if ttl < 1 {
		ttl = 1
	}
	value, err := l.redis.Eval(evalCtx, slidingWindowLua,
		rateLimitKeys(key),
		now, windowMS, limit, ttl, 100, 1000,
	).Result()
	if err != nil {
		// Fail-open mirrors WsConnectionRateLimiterService.checkRateLimit: the
		// shared limiter's failure is caught at the call site.
		return true, 0
	}
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return true, 0
	}
	if toInt64(values[0]) == 1 {
		return true, 0
	}
	return false, int64(l.windowSeconds) * 1000
}

// RecordFailure increments the per-IP failed-authentication counter used for
// the exponential backoff. Redis errors are ignored (fail-open).
func (l *Limiter) RecordFailure(ctx context.Context, ip string) {
	if ip == "" {
		return
	}
	key := backoffKey(ip)
	pipe := l.redis.TxPipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, time.Duration(l.windowSeconds*2)*time.Second)
	_, _ = pipe.Exec(ctx)
}

// BackoffDelay returns the current exponential backoff delay for the IP: 1s,
// 2s, 4s, ... capped at 60s. Zero means no backoff is active.
func (l *Limiter) BackoffDelay(ctx context.Context, ip string) time.Duration {
	if ip == "" {
		return 0
	}
	raw, err := l.redis.Get(ctx, backoffKey(ip)).Result()
	if err != nil {
		return 0
	}
	failures, err := strconv.Atoi(raw)
	if err != nil || failures <= 0 {
		return 0
	}
	delay := time.Duration(float64(baseBackoff) * math.Pow(2, float64(failures-1)))
	if delay > maxBackoff {
		delay = maxBackoff
	}
	return delay
}

// ClearBackoff clears the per-IP failure counter after a successful handshake.
func (l *Limiter) ClearBackoff(ctx context.Context, ip string) {
	if ip == "" {
		return
	}
	_ = l.redis.Del(ctx, backoffKey(ip)).Err()
}

// rateLimitKeys returns the bucket and sequence keys passed to the Lua script.
// The "rate:" prefix is shared with the NestJS limiter.
func rateLimitKeys(key string) []string {
	base := "rate:" + key
	return []string{base, base + ":seq"}
}

// backoffKey returns the per-IP failure counter key.
func backoffKey(ip string) string {
	return wsBackoffPrefix + ip
}

func toInt64(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(typed, 10, 64)
		return parsed
	default:
		return 0
	}
}
