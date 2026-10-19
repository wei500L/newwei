package crawltaskwrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file ports ActionRateLimitService.enforceCrawlTaskCreate and the two
// settings readers it depends on (RateLimitPolicyService.getPolicy and
// RateLimitConfigService.getBucketConfig). The sliding window script is the
// same Lua the auth login limiter uses; the bucket key is prefixed with "rate:"
// exactly like RateLimiterService.

const (
	crawlTaskFeature           = "crawl_task"
	rateLimitPolicyCachePrefix = "rate_limit_policy:"
	rateLimitSettingsCacheKey  = "rate_limit:settings"
	rateLimitCrawlCreateKey    = "rate_limit_crawl_create"
	rateLimitMinLimit          = 1
	rateLimitMaxLimit          = 1000
	rateLimitMinWindowSeconds  = 5
	rateLimitMaxWindowSeconds  = 86_400
	rateLimitEvalTimeoutMs     = 100
	rateLimitCleanupLimit      = 100
	rateLimitCleanupThreshold  = 1_000
	createRateLimitUserMessage = "Too many crawl tasks created. Please wait before creating new tasks."
	createRateLimitIPMessage   = "Too many crawl tasks created from this IP. Please wait before creating new tasks."
)

// slidingWindowLua is byte-identical to the authlogin/auth rate limiter script.
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

// rateLimitPolicy is one RateLimitPolicy row.
type rateLimitPolicy struct {
	UserLimit     int  `json:"userLimit"`
	IPLimit       int  `json:"ipLimit"`
	WindowSeconds int  `json:"windowSeconds"`
	Enabled       bool `json:"enabled"`
}

// rateLimitPolicyCacheEntry is the cached {policy: ...|null} document.
type rateLimitPolicyCacheEntry struct {
	Policy *rateLimitPolicy `json:"policy"`
}

// rateLimitBucket is one rate_limit settings bucket.
type rateLimitBucket struct {
	Limit         json.RawMessage `json:"limit"`
	WindowSeconds json.RawMessage `json:"windowSeconds"`
}

// rateLimitPolicyReason reports why the policy resolved the way it did.
type crawlRateLimitPolicy struct {
	userLimit     int
	ipLimit       int
	windowSeconds int
}

// enforceCrawlTaskCreate is enforceCrawlTaskCreate.
func (s *Service) enforceCrawlTaskCreate(ctx context.Context, orgID, userID string, ip *string) error {
	policy := s.resolveCrawlTaskPolicy(ctx)
	if err := s.consumeOrThrow(ctx, crawlCreateUserKey(orgID, userID),
		policy.userLimit, policy.windowSeconds, createRateLimitUserMessage); err != nil {
		return err
	}
	if ip != nil {
		normalized := trimSpacePtr(ip)
		if normalized != "" {
			return s.consumeOrThrow(ctx, crawlCreateIPKey(orgID, normalized),
				policy.ipLimit, policy.windowSeconds, createRateLimitIPMessage)
		}
	}
	return nil
}

// crawlCreateUserKey is `crawl:create:{orgId}:{userId}` before the rate limiter
// prepends its own "rate:" namespace.
func crawlCreateUserKey(orgID, userID string) string {
	return "crawl:create:" + orgID + ":" + userID
}

// crawlCreateIPKey is `crawl:create:{orgId}:ip:{ip}`.
func crawlCreateIPKey(orgID, ip string) string {
	return "crawl:create:" + orgID + ":ip:" + ip
}

// consumeOrThrow consumes one slot and answers the shared 429 when exhausted.
// A Redis failure follows RATE_LIMIT_REDIS_FAIL_OPEN.
func (s *Service) consumeOrThrow(ctx context.Context, key string, limit, windowSeconds int, message string) error {
	if limit <= 0 || windowSeconds <= 0 {
		return nil
	}
	allowed, err := s.consumeSlidingWindow(ctx, "rate:"+key, limit, windowSeconds)
	if err != nil {
		if s.cfg.RateLimitFailOpen {
			return nil
		}
		return newStatus(429, message)
	}
	if !allowed {
		return newStatus(429, message)
	}
	return nil
}

// consumeSlidingWindow runs the shared script once. The key already carries the
// "rate:" prefix.
func (s *Service) consumeSlidingWindow(ctx context.Context, bucketKey string, limit, windowSeconds int) (bool, error) {
	if s.redis == nil {
		return false, errors.New("crawltaskwrite: redis is not configured")
	}
	now := time.Now().UnixMilli()
	windowMs := int64(windowSeconds) * 1000
	ttl := windowSeconds * 2
	if ttl < 1 {
		ttl = 1
	}
	evalCtx, cancel := context.WithTimeout(ctx, rateLimitEvalTimeoutMs*time.Millisecond)
	defer cancel()
	value, err := s.redis.Eval(evalCtx, slidingWindowLua,
		[]string{bucketKey, bucketKey + ":seq"},
		now, windowMs, limit, ttl, rateLimitCleanupLimit, rateLimitCleanupThreshold).Result()
	if err != nil {
		return false, err
	}
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return false, errors.New("crawltaskwrite: unexpected rate limit reply")
	}
	switch allowed := items[0].(type) {
	case int64:
		return allowed == 1, nil
	case int:
		return allowed == 1, nil
	default:
		return false, errors.New("crawltaskwrite: unexpected rate limit reply")
	}
}

// resolveCrawlTaskPolicy mirrors resolveCrawlTaskPolicy: the crawl_task policy
// first (a cached null means "not configured"), then the crawlCreate bucket.
func (s *Service) resolveCrawlTaskPolicy(ctx context.Context) crawlRateLimitPolicy {
	if policy := s.loadCrawlTaskPolicy(ctx); policy != nil {
		if !policy.Enabled {
			return crawlRateLimitPolicy{windowSeconds: policy.WindowSeconds}
		}
		return crawlRateLimitPolicy{
			userLimit:     policy.UserLimit,
			ipLimit:       policy.IPLimit,
			windowSeconds: policy.WindowSeconds,
		}
	}
	fallbackLimit, fallbackWindow := s.crawlCreateFallback()
	limit, window := s.loadCrawlCreateBucket(ctx, fallbackLimit, fallbackWindow)
	return crawlRateLimitPolicy{userLimit: limit, ipLimit: limit, windowSeconds: window}
}

// loadCrawlTaskPolicy reads the shared policy cache, then the RateLimitPolicy
// row. A cached null entry is the NestJS "no policy configured" answer.
func (s *Service) loadCrawlTaskPolicy(ctx context.Context) *rateLimitPolicy {
	cacheKey := rateLimitPolicyCachePrefix + crawlTaskFeature
	if s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil && len(raw) > 0 {
			var entry rateLimitPolicyCacheEntry
			if json.Unmarshal(raw, &entry) == nil {
				return entry.Policy
			}
		} else if err != nil && err != redis.Nil {
			log.Printf("crawltaskwrite: failed to read rate limit policy cache: %v", err)
		}
	}
	if s.db == nil {
		return nil
	}
	var policy rateLimitPolicy
	err := s.db.QueryRowContext(ctx,
		"SELECT `userLimit`, `ipLimit`, `windowSeconds`, `enabled` FROM `RateLimitPolicy` WHERE `feature` = ? LIMIT 1",
		crawlTaskFeature).Scan(&policy.UserLimit, &policy.IPLimit, &policy.WindowSeconds, &policy.Enabled)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("crawltaskwrite: failed to read rate limit policy row: %v", err)
		}
		return nil
	}
	return &policy
}

// crawlCreateFallback is getFallbackSettings for the crawlCreate bucket: raw
// environment values.
func (s *Service) crawlCreateFallback() (int, int) {
	return s.cfg.RateLimitCrawlTaskCreate, s.cfg.RateLimitCrawlTaskCreateWindow
}

// loadCrawlCreateBucket reads the shared rate_limit:settings document, then the
// rate_limit_crawl_create row, then the raw environment fallback.
func (s *Service) loadCrawlCreateBucket(ctx context.Context, fallbackLimit, fallbackWindow int) (int, int) {
	if s.redis != nil {
		if raw, err := s.redis.Get(ctx, rateLimitSettingsCacheKey).Bytes(); err == nil && len(raw) > 0 {
			var settings struct {
				CrawlCreate *rateLimitBucket `json:"crawlCreate"`
			}
			if json.Unmarshal(raw, &settings) == nil && settings.CrawlCreate != nil {
				return normalizeRateLimitBucket(*settings.CrawlCreate, fallbackLimit, fallbackWindow)
			}
		} else if err != nil && err != redis.Nil {
			log.Printf("crawltaskwrite: failed to read rate limit settings cache: %v", err)
		}
	}
	if s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", rateLimitCrawlCreateKey).Scan(&raw)
		if err == nil && len(raw) > 0 {
			var bucket rateLimitBucket
			if json.Unmarshal(raw, &bucket) == nil {
				return normalizeRateLimitBucket(bucket, fallbackLimit, fallbackWindow)
			}
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			log.Printf("crawltaskwrite: failed to read crawl create rate limit row: %v", err)
		}
	}
	return clampRateLimit(fallbackLimit, rateLimitMinLimit, rateLimitMaxLimit),
		clampRateLimit(fallbackWindow, rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds)
}

// normalizeRateLimitBucket is normalizeBucket: Number() coercion, floor and
// clamp; an absent field keeps the fallback.
func normalizeRateLimitBucket(bucket rateLimitBucket, fallbackLimit, fallbackWindow int) (int, int) {
	limit := fallbackLimit
	if value, ok := jsNumber(bucket.Limit); ok {
		limit = int(math.Floor(value))
	}
	window := fallbackWindow
	if value, ok := jsNumber(bucket.WindowSeconds); ok {
		window = int(math.Floor(value))
	}
	return clampRateLimit(limit, rateLimitMinLimit, rateLimitMaxLimit),
		clampRateLimit(window, rateLimitMinWindowSeconds, rateLimitMaxWindowSeconds)
}

func clampRateLimit(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// jsNumber mirrors Number(value) for a raw JSON leaf.
func jsNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return math.NaN(), false
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return math.NaN(), false
	}
	return number, true
}

func trimSpacePtr(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
