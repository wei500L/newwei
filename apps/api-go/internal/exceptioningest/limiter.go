package exceptioningest

import (
	"context"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// slidingWindowLua is the Nest RateLimiterService sliding window script. The
// Go takeover passes bucket = "rate:" + logical key and sequence key
// bucket + ":seq", so both implementations share the exact same quota bucket
// (Nest's consume() prefixes the same "rate:").
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
	// rateLimitCleanupLimit / rateLimitCleanupThreshold mirror the defaults of
	// RateLimiterService (RATE_LIMIT_REDIS_CLEANUP_LIMIT=100,
	// RATE_LIMIT_REDIS_CLEANUP_THRESHOLD=1000).
	rateLimitCleanupLimit     = 100
	rateLimitCleanupThreshold = 1000
)

// consumeRateLimit spends one slot of the shared sliding window. It returns
// false when the quota is exhausted AND when Redis fails: the Nest limiter runs
// with failOpen=false, so a Redis failure is answered 429 as well.
func (s *Service) consumeRateLimit(ctx context.Context, key string, limit, windowSeconds int) bool {
	if limit <= 0 || windowSeconds <= 0 {
		return true
	}
	if s == nil || s.redis == nil {
		log.Printf("exceptioningest: redis is not configured")
		return false
	}
	bucket := "rate:" + key
	now := time.Now().UnixMilli()
	windowMs := int64(windowSeconds) * 1000
	ttl := windowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	value, err := s.redis.Eval(ctx, slidingWindowLua, []string{bucket, bucket + ":seq"},
		now, windowMs, limit, ttl, rateLimitCleanupLimit, rateLimitCleanupThreshold).Result()
	if err != nil {
		log.Printf("exceptioningest: rate limit eval failed: %v", err)
		return false
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1
	case int:
		return allowed == 1
	default:
		return false
	}
}

// clientIP resolves the request IP with the existing proxy trust configuration,
// mirroring the GraphQL read takeover: with TRUST_PROXY unset the socket
// address is used and X-Forwarded-For is ignored; with a hop count the indexed
// X-Forwarded-For entry is used.
func (s *Service) clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsed
	}
	host = strings.TrimPrefix(host, "::ffff:")
	trust := strings.TrimSpace(s.trustProxy)
	if trust == "" {
		return host
	}
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded == "" {
		return host
	}
	parts := strings.Split(forwarded, ",")
	hops := 1
	if parsed, err := strconv.Atoi(trust); err == nil && parsed > 0 {
		hops = parsed
	}
	index := len(parts) - hops
	if index < 0 {
		index = 0
	}
	ip := strings.TrimPrefix(strings.TrimSpace(parts[index]), "::ffff:")
	if ip == "" {
		return host
	}
	return ip
}
