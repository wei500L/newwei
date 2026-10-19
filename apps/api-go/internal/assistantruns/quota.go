package assistantruns

import (
	"context"
	"errors"
	"math"
	"time"
)

// assistantQuotaSubmitWindowSeconds is SUBMIT_WINDOW_SECONDS.
const assistantQuotaSubmitWindowSeconds = 3600

const (
	submitLimitMessage   = "Assistant hourly submit limit reached for this organization."
	inFlightLimitMessage = "This organization already has the maximum number of assistant jobs in progress."
	tokenBudgetMessage   = "This organization has exceeded its monthly assistant token budget."
)

// slidingWindowLua is the Nest RateLimiterService script, byte-identical. The
// bucket key is rate:assistant:submit:<orgId> and the sequence key is its
// ":seq" sibling, so both implementations count the same ZSET.
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

-- Opportunistic pruning:
-- - Avoid unbounded O(N) deletes on every request.
-- - Keep correctness by counting via ZCOUNT, then prune expired entries in bounded batches.
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

// quotaEvalTimeoutMs mirrors RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS. A slow Redis
// call is a failure, and the default fail-closed policy answers 429.
const quotaEvalTimeoutMs = 100

// errQuotaRedis marks a limiter outage. assertCanSubmit maps it to the submit
// limit message like the default RATE_LIMIT_REDIS_FAIL_OPEN=false.
var errQuotaRedis = errors.New("assistant quota redis unavailable")

// consumeSubmitSlot runs the shared sliding-window script once.
func (s *Service) consumeSubmitSlot(ctx context.Context, orgID string, limit int64) (bool, error) {
	if s.redis == nil {
		return false, errQuotaRedis
	}
	now := time.Now().UnixMilli()
	windowMs := int64(assistantQuotaSubmitWindowSeconds) * 1000
	ttl := int(math.Ceil(float64(assistantQuotaSubmitWindowSeconds) * 2))
	if ttl < 1 {
		ttl = 1
	}
	evalCtx, cancel := context.WithTimeout(ctx, quotaEvalTimeoutMs*time.Millisecond)
	defer cancel()
	key := "rate:assistant:submit:" + orgID
	result, err := s.redis.Eval(evalCtx, slidingWindowLua, []string{key, key + ":seq"},
		now, windowMs, limit, ttl, 100, 1000).Result()
	if err != nil {
		return false, errQuotaRedis
	}
	values, ok := result.([]any)
	if !ok || len(values) == 0 {
		return false, errQuotaRedis
	}
	allowed, ok := values[0].(int64)
	if !ok {
		return false, errQuotaRedis
	}
	return allowed == 1, nil
}

// assertCanSubmit ports AssistantQuotaSettingsService.assertCanSubmit:
// disabled passes, the hourly limiter runs when configured, the pending+running
// count must stay below maxInFlightPerOrg, and the month's assistant token
// usage must stay below monthlyTokenBudget. The org filter is already part of
// the governance snapshot.
func (s *Service) assertCanSubmit(ctx context.Context, orgID string) error {
	snapshot, err := s.governance.AssistantQuotaSnapshot(ctx, orgID)
	if err != nil {
		return err
	}
	if !snapshot.Enabled {
		return nil
	}
	if snapshot.SubmitLimitPerHour > 0 {
		allowed, err := s.consumeSubmitSlot(ctx, orgID, snapshot.SubmitLimitPerHour)
		if err != nil || !allowed {
			return &Failure{Status: 429, Message: submitLimitMessage}
		}
	}
	if snapshot.MaxInFlightPerOrg > 0 && snapshot.InFlight >= snapshot.MaxInFlightPerOrg {
		return &Failure{Status: 429, Message: inFlightLimitMessage}
	}
	if snapshot.MonthlyTokenBudget > 0 && snapshot.TotalTokens >= snapshot.MonthlyTokenBudget {
		return &Failure{Status: 429, Message: tokenBudgetMessage}
	}
	return nil
}
