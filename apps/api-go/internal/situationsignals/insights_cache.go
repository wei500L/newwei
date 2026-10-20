package situationsignals

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	insightsCacheKeyPrefix          = "situation-monitor:insights:v2"
	insightsCacheTTLSecondsCore     = 45
	insightsCacheTTLSecondsExternal = 300
	insightsDefaultWindowHours      = 72
	insightsDefaultMaxItems         = 400
	insightsMaxHeadlinesPerCategory = 12
	insightsMomentumWindowMinutes   = 10
	insightsCorrelationCountsPrefix = "situation-monitor:correlation:counts"
)

// insightsOptions is the validated subset of the insights query string.
type insightsOptions struct {
	WindowHours int
	MaxItems    int
	Sections    []string
	Gdelt       *bool
	Scope       string
	Debug       bool
	Translate   bool
}

// parseInsightsQuery reproduces the controller's DTO conversion and helper
// parsers. Invalid windowHours/maxItems are a 400 (class-validator); gdelt,
// scope, debug and translate fall back to their defaults when unparseable.
func parseInsightsQuery(values url.Values) (insightsOptions, error) {
	options := insightsOptions{
		WindowHours: insightsDefaultWindowHours,
		MaxItems:    insightsDefaultMaxItems,
		Scope:       "all",
	}
	if raw, ok, err := singleInsightsQuery(values, "windowHours"); err != nil {
		return options, err
	} else if ok {
		parsed, valid := insightsInt(raw)
		if !valid || parsed < 1 || parsed > 168 {
			return options, newStatus(400, "windowHours must be an integer number between 1 and 168")
		}
		options.WindowHours = parsed
	}
	if raw, ok, err := singleInsightsQuery(values, "maxItems"); err != nil {
		return options, err
	} else if ok {
		parsed, valid := insightsInt(raw)
		if !valid || parsed < 50 || parsed > 1000 {
			return options, newStatus(400, "maxItems must be an integer number between 50 and 1000")
		}
		options.MaxItems = parsed
	}
	if raw, ok, err := singleInsightsQuery(values, "sections"); err != nil {
		return options, err
	} else if ok {
		options.Sections = parseInsightsSections(raw)
	}
	if raw, ok, err := singleInsightsQuery(values, "gdelt"); err != nil {
		return options, err
	} else if ok {
		options.Gdelt = parseInsightsBoolean(raw)
	}
	if raw, ok, err := singleInsightsQuery(values, "scope"); err != nil {
		return options, err
	} else if ok {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "tagged":
			options.Scope = "tagged"
		case "all":
			options.Scope = "all"
		}
	}
	if raw, ok, err := singleInsightsQuery(values, "debug"); err != nil {
		return options, err
	} else if ok {
		if parsed := parseInsightsBoolean(raw); parsed != nil {
			options.Debug = *parsed
		}
	}
	if raw, ok, err := singleInsightsQuery(values, "translate"); err != nil {
		return options, err
	} else if ok {
		options.Translate = parseInsightsTranslateTarget(raw)
	}
	return options, nil
}

func singleInsightsQuery(values url.Values, key string) (string, bool, error) {
	list := values[key]
	if len(list) == 0 {
		return "", false, nil
	}
	if len(list) > 1 {
		return "", false, newStatus(400, key+" must be a string")
	}
	return list[0], true, nil
}

// insightsInt reproduces Number(trimmed) followed by Number.isInteger. Number
// accepts hexadecimal integers, which strconv.ParseFloat does not, so that one
// shape is handled explicitly.
func insightsInt(raw string) (int, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil && (strings.HasPrefix(trimmed, "0x") || strings.HasPrefix(trimmed, "0X")) {
		if parsed, hexErr := strconv.ParseInt(trimmed[2:], 16, 64); hexErr == nil {
			value, err = float64(parsed), nil
		}
	}
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value {
		return 0, false
	}
	if value < math.MinInt64 || value > math.MaxInt64 {
		return 0, false
	}
	return int(value), true
}

func parseInsightsBoolean(raw string) *bool {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "true", "1", "yes", "y", "on":
		value := true
		return &value
	case "false", "0", "no", "n", "off":
		value := false
		return &value
	default:
		return nil
	}
}

func parseInsightsSections(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	out := make([]string, 0)
	seen := map[string]bool{}
	for _, entry := range strings.Split(trimmed, ",") {
		value := strings.ToLower(strings.TrimSpace(entry))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseInsightsTranslateTarget(raw string) bool {
	if parsed := parseInsightsBoolean(raw); parsed != nil && *parsed {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "zh", "zh-cn", "zh-hans", "zh-hans-cn", "cn", "chs":
		return true
	default:
		return false
	}
}

// normalizeInsightsSections mirrors SituationMonitorService.normalizeSections:
// only core/external survive and an empty result means both sections.
func normalizeInsightsSections(sections []string) map[string]bool {
	out := map[string]bool{}
	for _, entry := range sections {
		value := strings.ToLower(strings.TrimSpace(entry))
		if value == "core" || value == "external" {
			out[value] = true
		}
	}
	return out
}

// insightsCacheKey builds the exact NestJS key. The learning revision is
// truncated with Math.trunc and clamped at zero.
func insightsCacheKey(orgID, section string, windowHours, maxItems int, scope string, allowGdelt, debug bool, learningRevision int64) string {
	if section == "external" {
		return insightsCacheKeyPrefix + ":external:" + orgID
	}
	revision := learningRevision
	if revision < 0 {
		revision = 0
	}
	flags := []string{
		orgID,
		"wh" + strconv.Itoa(windowHours),
		"mi" + strconv.Itoa(maxItems),
		"sc" + scope,
		"gd" + boolFlag(allowGdelt),
		"dbg" + boolFlag(debug),
		"lr" + strconv.FormatInt(revision, 10),
	}
	return insightsCacheKeyPrefix + ":core:" + strings.Join(flags, ":")
}

func boolFlag(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

// insightsCache is the small Redis surface the insights path needs. It is
// separate from cacheOps because wrap also needs SET NX and the compare-and-
// delete/renew Lua scripts.
type insightsCache struct {
	client *redis.Client
}

func newInsightsCache(client *redis.Client) insightsCache {
	return insightsCache{client: client}
}

func (c insightsCache) get(ctx context.Context, key string) (string, bool, error) {
	if c.client == nil {
		return "", false, nil
	}
	value, err := c.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (c insightsCache) set(ctx context.Context, key string, payload []byte, ttl time.Duration) error {
	if c.client == nil {
		return nil
	}
	return c.client.Set(ctx, key, payload, ttl).Err()
}

// insightsWrap mirrors CacheService.wrap, including the lock key, the 5 second
// lock TTL, the 50 ms retry loop, the 5 second wait and the 2.5 second renew.
func insightsWrap[T any](ctx context.Context, cache insightsCache, key string, ttl time.Duration, loader func(context.Context) (T, error)) (T, error) {
	var zero T
	cached, hit, err := insightsCacheGetJSON[T](ctx, cache, key)
	if err != nil {
		return zero, err
	}
	if hit {
		return cached, nil
	}

	lockKey := "lock:" + key
	lockTTL := 5 * time.Second
	retryDelay := 50 * time.Millisecond
	maxWait := lockTTL
	token, acquired, err := insightsAcquireLock(ctx, cache, lockKey, lockTTL)
	if err != nil {
		return zero, err
	}
	if !acquired {
		start := time.Now()
		for time.Since(start) < maxWait {
			if err := insightsSleep(ctx, retryDelay); err != nil {
				return zero, err
			}
			if retry, ok, err := insightsCacheGetJSON[T](ctx, cache, key); err != nil {
				return zero, err
			} else if ok {
				return retry, nil
			}
			token, acquired, err = insightsAcquireLock(ctx, cache, lockKey, lockTTL)
			if err != nil {
				return zero, err
			}
			if acquired {
				break
			}
		}
	}

	if acquired {
		stop := make(chan struct{})
		go insightsRenewLockLoop(ctx, cache, lockKey, token, lockTTL, stop)
		value, loadErr := loader(ctx)
		close(stop)
		if loadErr != nil {
			_ = insightsReleaseLock(ctx, cache, lockKey, token)
			return zero, loadErr
		}
		if err := insightsCacheSetJSON(ctx, cache, key, value, ttl); err != nil {
			_ = insightsReleaseLock(ctx, cache, lockKey, token)
			return zero, err
		}
		if err := insightsReleaseLock(ctx, cache, lockKey, token); err != nil {
			return zero, err
		}
		return value, nil
	}

	final, hit, err := insightsCacheGetJSON[T](ctx, cache, key)
	if err != nil {
		return zero, err
	}
	if hit {
		return final, nil
	}
	value, err := loader(ctx)
	if err != nil {
		return zero, err
	}
	if err := insightsCacheSetJSON(ctx, cache, key, value, ttl); err != nil {
		return zero, err
	}
	return value, nil
}

func insightsCacheGetJSON[T any](ctx context.Context, cache insightsCache, key string) (T, bool, error) {
	var zero T
	raw, found, err := cache.get(ctx, key)
	if err != nil || !found {
		return zero, false, err
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return zero, false, nil
	}
	var value T
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return zero, false, err
	}
	return value, true, nil
}

func insightsCacheSetJSON[T any](ctx context.Context, cache insightsCache, key string, value T, ttl time.Duration) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return cache.set(ctx, key, payload, ttl)
}

func insightsAcquireLock(ctx context.Context, cache insightsCache, lockKey string, ttl time.Duration) (string, bool, error) {
	if cache.client == nil {
		return "", true, nil
	}
	token, err := insightsLockToken()
	if err != nil {
		return "", false, err
	}
	acquired, err := cache.client.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return "", false, err
	}
	return token, acquired, nil
}

func insightsReleaseLock(ctx context.Context, cache insightsCache, lockKey, token string) error {
	if cache.client == nil {
		return nil
	}
	const script = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`
	return cache.client.Eval(ctx, script, []string{lockKey}, token).Err()
}

func insightsExtendLock(ctx context.Context, cache insightsCache, lockKey, token string, ttl time.Duration) error {
	if cache.client == nil {
		return nil
	}
	normalized := ttl
	if normalized < time.Second {
		normalized = time.Second
	}
	const script = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`
	return cache.client.Eval(ctx, script, []string{lockKey}, token, strconv.FormatInt(normalized.Milliseconds(), 10)).Err()
}

func insightsRenewLockLoop(ctx context.Context, cache insightsCache, lockKey, token string, ttl time.Duration, stop <-chan struct{}) {
	interval := ttl / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = insightsExtendLock(ctx, cache, lockKey, token, ttl)
		}
	}
}

func insightsLockToken() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func insightsSleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// insightsLearningRevision mirrors the cache.get<number> + finite check.
func insightsLearningRevision(ctx context.Context, cache insightsCache, orgID string) (int64, error) {
	raw, found, err := cache.get(ctx, insightsRevPrefix+":"+orgID)
	if err != nil || !found {
		return 0, err
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, nil
	}
	return int64(math.Trunc(value)), nil
}

func insightsFormatError(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}
