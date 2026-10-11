package policy

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// The Lua is the Nest RateLimiterService sliding window. Keys are
// rate:graphql:<ip> and rate:graphql:<ip>:seq, shared with NestJS.
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

// Limiter shares Nest's graphql bucket. The in-memory circuit is per process,
// matching Nest's per-process breaker around the same Redis script.
type Limiter struct {
	redis            *redis.Client
	fallbackLimit    int
	fallbackWindow   int
	evalTimeout      time.Duration
	slowCall         time.Duration
	failOpen         bool
	failureThreshold int
	openFor          time.Duration
	cleanupLimit     int
	cleanupThreshold int

	mu            sync.Mutex
	state         string
	openUntil     time.Time
	failures      int
	halfOpenInUse bool
}

// NewLimiter builds the shared-bucket limiter. fallbackLimit is the login
// bucket size (Nest default 5); the GraphQL budget is max(limit*30, 120).
func NewLimiter(client *redis.Client, fallbackLimit, fallbackWindow int, failOpen bool) *Limiter {
	if fallbackLimit <= 0 {
		fallbackLimit = 5
	}
	if fallbackWindow <= 0 {
		fallbackWindow = 60
	}
	return &Limiter{
		redis:            client,
		fallbackLimit:    fallbackLimit,
		fallbackWindow:   fallbackWindow,
		evalTimeout:      100 * time.Millisecond,
		slowCall:         200 * time.Millisecond,
		failOpen:         failOpen,
		failureThreshold: 5,
		openFor:          5 * time.Second,
		cleanupLimit:     100,
		cleanupThreshold: 1000,
		state:            "closed",
	}
}

// Budget is max(login.limit*30, 120) over the login window.
type Budget struct {
	Limit         int
	WindowSeconds int
}

// BudgetFor returns the GraphQL budget from Redis rate_limit:settings, then
// the caller-supplied fallback (env defaults).
func (l *Limiter) BudgetFor(ctx context.Context) Budget {
	if l == nil {
		return Budget{Limit: 150, WindowSeconds: 60}
	}
	limit := l.fallbackLimit
	window := l.fallbackWindow
	if l != nil && l.redis != nil {
		if raw, err := l.redis.Get(ctx, "rate_limit:settings").Bytes(); err == nil {
			if parsedLimit, parsedWindow, ok := loginBucket(raw); ok {
				limit = parsedLimit
				window = parsedWindow
			}
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 1000 {
		limit = 1000
	}
	if window < 5 {
		window = 5
	}
	if window > 86400 {
		window = 86400
	}
	graphqlLimit := limit * 30
	if graphqlLimit < 120 {
		graphqlLimit = 120
	}
	return Budget{Limit: graphqlLimit, WindowSeconds: window}
}

func loginBucket(raw []byte) (int, int, bool) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return 0, 0, false
	}
	login, _ := body["login"].(map[string]any)
	if login == nil {
		return 0, 0, false
	}
	limit, okLimit := number(login["limit"])
	window, okWindow := number(login["windowSeconds"])
	if !okLimit || !okWindow {
		return 0, 0, false
	}
	return limit, window, true
}

func number(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return int(parsed), err == nil
	case string:
		parsed, err := strconv.Atoi(typed)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// Consume spends one slot of rate:graphql:<ip>. true means the request may
// continue. Redis failures follow failOpen (Nest default false = deny).
func (l *Limiter) Consume(ctx context.Context, ip string, budget Budget) bool {
	if l == nil || budget.Limit <= 0 || budget.WindowSeconds <= 0 {
		return true
	}
	if ip == "" {
		ip = "anonymous"
	}
	l.mu.Lock()
	now := time.Now()
	if l.state == "open" && now.Before(l.openUntil) {
		l.mu.Unlock()
		return l.failOpen
	}
	if l.state == "open" && !now.Before(l.openUntil) {
		l.state = "half_open"
	}
	if l.state == "half_open" {
		if l.halfOpenInUse {
			l.mu.Unlock()
			return l.failOpen
		}
		l.halfOpenInUse = true
	}
	l.mu.Unlock()

	allowed, failed := l.eval(ctx, ip, budget)
	l.mu.Lock()
	if l.state == "half_open" {
		l.halfOpenInUse = false
	}
	if failed {
		l.failures++
		if l.failures >= l.failureThreshold {
			l.state = "open"
			l.openUntil = time.Now().Add(l.openFor)
			l.failures = 0
		}
		l.mu.Unlock()
		return l.failOpen
	}
	l.failures = 0
	l.state = "closed"
	l.openUntil = time.Time{}
	l.mu.Unlock()
	return allowed
}

func (l *Limiter) eval(ctx context.Context, ip string, budget Budget) (bool, bool) {
	if l.redis == nil {
		return l.failOpen, true
	}
	evalCtx, cancel := context.WithTimeout(ctx, l.evalTimeout)
	defer cancel()
	bucket := "rate:graphql:" + ip
	now := time.Now().UnixMilli()
	windowMs := budget.WindowSeconds * 1000
	ttl := budget.WindowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	started := time.Now()
	value, err := l.redis.Eval(evalCtx, slidingWindowLua, []string{bucket, bucket + ":seq"},
		now, windowMs, budget.Limit, ttl, l.cleanupLimit, l.cleanupThreshold).Result()
	if err != nil {
		return false, true
	}
	if time.Since(started) > l.slowCall {
		// Nest records a failure but still uses the script result.
		l.noteSlow()
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false, true
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, false
	case int:
		return allowed == 1, false
	default:
		return false, true
	}
}

func (l *Limiter) noteSlow() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures++
	if l.failures >= l.failureThreshold {
		l.state = "open"
		l.openUntil = time.Now().Add(l.openFor)
		l.failures = 0
	}
}
