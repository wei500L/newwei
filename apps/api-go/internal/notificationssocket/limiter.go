package notificationssocket

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// slidingWindowLua is the same script as Nest RateLimiterService. Keys are
// ws:connect:ip:<ip> / ws:connect:user:<userId>; the script adds the shared
// "rate:" prefix, so Go and NestJS cannot create parallel buckets.
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
)

type connectionLimiter struct {
	redis         *redis.Client
	limitPerIP    int
	limitPerUser  int
	windowSeconds int
	timeout       time.Duration
}

func newConnectionLimiter(client *redis.Client, limitPerIP, limitPerUser, windowSeconds int) *connectionLimiter {
	if limitPerIP <= 0 {
		limitPerIP = 60
	}
	if limitPerUser <= 0 {
		limitPerUser = 30
	}
	if windowSeconds <= 0 {
		windowSeconds = 60
	}
	return &connectionLimiter{
		redis:         client,
		limitPerIP:    limitPerIP,
		limitPerUser:  limitPerUser,
		windowSeconds: windowSeconds,
		timeout:       500 * time.Millisecond,
	}
}

// checkIP and checkUser fail open, matching WsConnectionRateLimiterService:
// the service catches Redis errors and allows the connection. Each call spends
// one slot in the shared window.
func (l *connectionLimiter) checkIP(ctx context.Context, ip string) (bool, int64) {
	if ip == "" {
		return true, 0
	}
	return l.consume(ctx, "ws:connect:ip:"+ip, l.limitPerIP)
}

func (l *connectionLimiter) checkUser(ctx context.Context, userID string) (bool, int64) {
	if userID == "" {
		return true, 0
	}
	return l.consume(ctx, "ws:connect:user:"+userID, l.limitPerUser)
}

func (l *connectionLimiter) consume(ctx context.Context, key string, limit int) (bool, int64) {
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
		[]string{"rate:" + key, "rate:" + key + ":seq"},
		now, windowMS, limit, ttl, 100, 1000,
	).Result()
	if err != nil {
		// Fail-open is the NestJS WS behaviour (the shared limiter's failure is
		// caught at the call site). A Redis outage must not lock every browser
		// out of notifications.
		return true, 0
	}
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return true, 0
	}
	allowed := toInt64(values[0]) == 1
	if allowed {
		return true, 0
	}
	return false, int64(l.windowSeconds) * 1000
}

func (l *connectionLimiter) recordFailure(ctx context.Context, ip string) {
	if ip == "" {
		return
	}
	key := wsBackoffPrefix + ip
	pipe := l.redis.TxPipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, time.Duration(l.windowSeconds*2)*time.Second)
	_, _ = pipe.Exec(ctx)
}

func (l *connectionLimiter) backoffDelay(ctx context.Context, ip string) time.Duration {
	if ip == "" {
		return 0
	}
	raw, err := l.redis.Get(ctx, wsBackoffPrefix+ip).Result()
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

func (l *connectionLimiter) clearBackoff(ctx context.Context, ip string) {
	if ip == "" {
		return
	}
	_ = l.redis.Del(ctx, wsBackoffPrefix+ip).Err()
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

func rateLimitPayload(message string, retryAfterMS int64) socketErrorPayload {
	payload := socketErrorPayload{Code: codeUnauthorized, Message: "Unauthorized"}
	switch message {
	case "Rate limit exceeded":
		payload = socketErrorPayload{Code: codeRateLimitExceeded, Message: message}
	case "Too many failed attempts":
		payload = socketErrorPayload{Code: codeTooManyFailedAttempts, Message: message}
	case "Too many connections":
		payload = socketErrorPayload{Code: codeTooManyConnections, Message: message}
	case "Too many connection attempts":
		payload = socketErrorPayload{Code: codeTooManyConnectionAttempt, Message: message}
	}
	if retryAfterMS > 0 {
		payload.RetryAfterMS = &retryAfterMS
	}
	return payload
}
