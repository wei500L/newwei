package rbacapi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// rbacSlidingWindowLua 是 Nest RateLimiterService 的滑动窗口脚本。键是
// rbac:write:<orgId>:<actorId> 与 :seq，与 NestJS 共享同一桶。
const rbacSlidingWindowLua = `
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
	rbacMinLimit         = 1
	rbacMaxLimit         = 1000
	rbacMinWindowSeconds = 5
	rbacMaxWindowSeconds = 86400
)

// EnforceRbacWrite 对齐 action-rate-limit.service.ts 的 enforceRbacWrite
// （68 行）：键 rbac:write:<orgId>:<actorId>，限额与窗口来自现有 rbacWrite
// 桶（Redis rate_limit:settings 优先，否则环境默认）。Redis 失败 fail-closed
// （与 NestJS failOpen=false 一致）→ 429。
func (s *Service) EnforceRbacWrite(ctx context.Context, orgID, actorID string) error {
	if s.redis == nil {
		return nil
	}
	limit, windowSeconds := s.rbacWriteBucket(ctx)
	if limit <= 0 || windowSeconds <= 0 {
		return nil
	}
	key := "rbac:write:" + orgID + ":" + actorID
	allowed, err := s.consumeRbac(ctx, key, limit, windowSeconds)
	if err != nil {
		return newStatus(429, "Too many RBAC changes were attempted. Please try again later.")
	}
	if !allowed {
		return newStatus(429, "Too many RBAC changes were attempted. Please try again later.")
	}
	return nil
}

func (s *Service) consumeRbac(ctx context.Context, key string, limit, windowSeconds int) (bool, error) {
	now := time.Now().UnixMilli()
	windowMs := int64(windowSeconds) * 1000
	ttl := windowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	value, err := s.redis.Eval(ctx, rbacSlidingWindowLua, []string{key, key + ":seq"},
		now, windowMs, limit, ttl, 100, 1000).Result()
	if err != nil {
		return false, err
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false, errors.New("unexpected rbac rate limit result")
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, nil
	case int:
		return allowed == 1, nil
	default:
		return false, errors.New("unexpected rbac rate limit result")
	}
}

// rbacWriteBucket 读取 rbacWrite 桶（Redis rate_limit:settings 优先，否则
// RATE_LIMIT_RBAC_WRITE / RATE_LIMIT_RBAC_WRITE_WINDOW 默认 20 / 600）。
func (s *Service) rbacWriteBucket(ctx context.Context) (int, int) {
	if s.redis != nil {
		if raw, err := s.redis.Get(ctx, "rate_limit:settings").Bytes(); err == nil {
			if limit, window, ok := parseRbacBucket(raw); ok {
				return clampLimit(limit), clampWindow(window)
			}
		}
	}
	return clampLimit(envInt("RATE_LIMIT_RBAC_WRITE", 20)),
		clampWindow(envInt("RATE_LIMIT_RBAC_WRITE_WINDOW", 600))
}

func parseRbacBucket(raw []byte) (int, int, bool) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return 0, 0, false
	}
	bucket, _ := body["rbacWrite"].(map[string]any)
	if bucket == nil {
		return 0, 0, false
	}
	limit, okLimit := jsonInt(bucket["limit"])
	window, okWindow := jsonInt(bucket["windowSeconds"])
	if !okLimit || !okWindow {
		return 0, 0, false
	}
	return limit, window, true
}

func jsonInt(value any) (int, bool) {
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

func envInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func clampLimit(value int) int {
	if value < rbacMinLimit {
		return rbacMinLimit
	}
	if value > rbacMaxLimit {
		return rbacMaxLimit
	}
	return value
}

func clampWindow(value int) int {
	if value < rbacMinWindowSeconds {
		return rbacMinWindowSeconds
	}
	if value > rbacMaxWindowSeconds {
		return rbacMaxWindowSeconds
	}
	return value
}
