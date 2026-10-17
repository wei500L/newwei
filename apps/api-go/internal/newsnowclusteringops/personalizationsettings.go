package newsnowclusteringops

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrInvalidStoredSettings reports that a SystemSetting row for
// newsnow_personalization_settings exists but does not hold a valid runtime
// policy. It is the 1:1 Go port of the ConflictException the NestJS
// NewsnowPersonalizationSettingsService throws; the HTTP handler is expected to
// answer 409 with code NEWSNOW_PERSONALIZATION_SETTINGS_INVALID and the message
// "Stored NewsNow personalization settings are invalid.".
//
// A missing row is not an error: it yields the documented defaults with
// PersonalizationPolicySourceDefault.
var ErrInvalidStoredSettings = errors.New("Stored NewsNow personalization settings are invalid.")

// errPersonalizationDatabaseNotConfigured reports that the policy store was
// built without a *sql.DB. The NestJS service always has a Prisma client, so
// this can only happen on a misconfigured Go process and maps to HTTP 500.
var errPersonalizationDatabaseNotConfigured = errors.New("newsnow-clustering-ops: personalization settings database is not configured")

// errPersonalizationRedisNotConfigured reports that the metrics recorder was
// built without a Redis client. Metrics recording is best effort, so callers
// log this instead of failing the request.
var errPersonalizationRedisNotConfigured = errors.New("newsnow-clustering-ops: personalization metrics redis is not configured")

// PersonalizationPolicySource tells the console whether the runtime policy came
// from the database or from the built-in defaults. It mirrors
// NewsnowPersonalizationSettingsSource in
// newsnow-personalization-settings.service.ts.
type PersonalizationPolicySource string

const (
	// PersonalizationPolicySourceDefault means no SystemSetting row existed and
	// the built-in defaults are in force.
	PersonalizationPolicySourceDefault PersonalizationPolicySource = "default"
	// PersonalizationPolicySourceDatabase means a valid stored row was used.
	PersonalizationPolicySourceDatabase PersonalizationPolicySource = "db"
)

// Bounds of every accepted runtime policy field. Values outside these ranges
// are rejected (never clamped), exactly like toStrictInt/toStrictFloat in
// newsnow-personalization-settings.service.ts.
const (
	cacheTTLMsMin = 0
	cacheTTLMsMax = 300_000

	maxCacheEntriesMin = 100
	maxCacheEntriesMax = 20_000

	throttleWindowMsMin = 1_000
	throttleWindowMsMax = 600_000

	maxRequestsPerWindowPerUserMin = 1
	maxRequestsPerWindowPerUserMax = 500

	affinitySourceWeightMin = 0.0
	affinitySourceWeightMax = 5.0

	behaviorSourceWeightMin = 0.0
	behaviorSourceWeightMax = 5.0

	focusSourceBonusMin = 0.0
	focusSourceBonusMax = 20.0

	staleTTLMultiplierMin = 1
	staleTTLMultiplierMax = 20

	staleTTLFixedMsMin = 1_000
	staleTTLFixedMsMax = 3_600_000

	// minimumStaleTTLMs is the floor applied by resolveStaleTtlMs.
	minimumStaleTTLMs = 1_000
)

// Built-in defaults of NewsnowPersonalizationSettingsService.DEFAULT_SETTINGS.
const (
	defaultCacheTTLMs                  = 20_000
	defaultMaxCacheEntries             = 2_000
	defaultThrottleWindowMs            = 10_000
	defaultMaxRequestsPerWindowPerUser = 40
	defaultAffinitySourceWeight        = 0.42
	defaultBehaviorSourceWeight        = 0.58
	defaultFocusSourceBonus            = 0.35
	defaultStaleTTLMultiplier          = 3
	defaultStaleTTLFixedMs             = 60_000
)

const (
	// personalizationSettingsKey is SETTINGS_KEY. The row is global: NestJS
	// queries SystemSetting by key only, without an orgId.
	personalizationSettingsKey = "newsnow_personalization_settings"

	// personalizationSettingsQuery is the exact Prisma equivalent. `key` is a
	// MySQL reserved word, hence the mandatory backticks.
	personalizationSettingsQuery = "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1"

	// personalizationRuntimeCacheTTL is RUNTIME_CACHE_TTL_MS: how long
	// GetRuntimeSettings may serve an in-process copy.
	personalizationRuntimeCacheTTL = 30 * time.Second
)

// Metrics bucket constants. The retention TTL is derived from
// METRICS_RETENTION_DAYS so all three ranges stay in sync with NestJS.
// metricsDefaultWindow and metricsMaxWindow are the window bounds of the
// metrics snapshot reader (normalizeMetricsWindowDays); they are kept here so
// the whole metrics range contract lives beside the recorder.
const (
	metricsKeyPrefix     = "newsnow:personalization:metrics:v1"
	metricsDefaultWindow = 7
	metricsMaxWindow     = 90
	metricsRetentionDays = 45
)

// personalizationMetricsRetentionTTL is METRICS_RETENTION_TTL_SECONDS
// (45 * 24 * 60 * 60 = 3888000) as a duration.
const personalizationMetricsRetentionTTL = metricsRetentionDays * 24 * time.Hour

// PersonalizationPolicy is the fully normalized NewsNow runtime policy: the
// cache, throttle and ranking knobs the personalized ordering endpoint reads.
// Field order matches NewsnowPersonalizationSettingsPublic so the JSON shape is
// the one the console expects.
type PersonalizationPolicy struct {
	Source                      PersonalizationPolicySource `json:"source"`
	CacheTTLMs                  int                         `json:"cacheTtlMs"`
	MaxCacheEntries             int                         `json:"maxCacheEntries"`
	ThrottleWindowMs            int                         `json:"throttleWindowMs"`
	MaxRequestsPerWindowPerUser int                         `json:"maxRequestsPerWindowPerUser"`
	AffinitySourceWeight        float64                     `json:"affinitySourceWeight"`
	BehaviorSourceWeight        float64                     `json:"behaviorSourceWeight"`
	FocusSourceBonus            float64                     `json:"focusSourceBonus"`
	StaleTTLStrategy            StaleTTLStrategy            `json:"staleTtlStrategy"`
	StaleTTLMultiplier          int                         `json:"staleTtlMultiplier"`
	StaleTTLFixedMs             int                         `json:"staleTtlFixedMs"`
}

// ResolveStaleTTLMs returns the stale-cache lifetime for this policy. It is the
// method form of resolveStaleTtlMs so callers holding a policy do not have to
// repeat its fields.
func (p PersonalizationPolicy) ResolveStaleTTLMs() int {
	return resolveStaleTTLMs(p.CacheTTLMs, p.ThrottleWindowMs, p.StaleTTLStrategy, p.StaleTTLMultiplier, p.StaleTTLFixedMs)
}

// defaultPersonalizationPolicy returns the DEFAULT_SETTINGS object with
// Source=default.
func defaultPersonalizationPolicy() PersonalizationPolicy {
	return PersonalizationPolicy{
		Source:                      PersonalizationPolicySourceDefault,
		CacheTTLMs:                  defaultCacheTTLMs,
		MaxCacheEntries:             defaultMaxCacheEntries,
		ThrottleWindowMs:            defaultThrottleWindowMs,
		MaxRequestsPerWindowPerUser: defaultMaxRequestsPerWindowPerUser,
		AffinitySourceWeight:        defaultAffinitySourceWeight,
		BehaviorSourceWeight:        defaultBehaviorSourceWeight,
		FocusSourceBonus:            defaultFocusSourceBonus,
		StaleTTLStrategy:            StaleTTLStrategyMultiplier,
		StaleTTLMultiplier:          defaultStaleTTLMultiplier,
		StaleTTLFixedMs:             defaultStaleTTLFixedMs,
	}
}

// resolveStaleTTLMs ports resolveStaleTtlMs:
//
//	max(1000, floor(max(strategyValue, throttleWindowMs*2)))
//
// where strategyValue is staleTtlFixedMs for the fixed strategy and
// cacheTtlMs*staleTtlMultiplier otherwise. All inputs are integers, so the
// JavaScript Math.floor is a no-op and is kept only for documentation.
func resolveStaleTTLMs(cacheTTLMs, throttleWindowMs int, strategy StaleTTLStrategy, staleTTLMultiplier, staleTTLFixedMs int) int {
	fromStrategy := cacheTTLMs * staleTTLMultiplier
	if strategy == StaleTTLStrategyFixed {
		fromStrategy = staleTTLFixedMs
	}
	return max(minimumStaleTTLMs, max(fromStrategy, throttleWindowMs*2))
}

// storedPersonalizationPolicy is the raw JSON shape of SystemSetting.value.
// Every field is a json.RawMessage because toNumber accepts both JSON numbers
// and numeric strings, and because absent/null/array/object must stay
// distinguishable: absent optional fields fall back to defaults, while a
// present-but-invalid field invalidates the whole record.
type storedPersonalizationPolicy struct {
	CacheTTLMs                  json.RawMessage `json:"cacheTtlMs"`
	MaxCacheEntries             json.RawMessage `json:"maxCacheEntries"`
	ThrottleWindowMs            json.RawMessage `json:"throttleWindowMs"`
	MaxRequestsPerWindowPerUser json.RawMessage `json:"maxRequestsPerWindowPerUser"`
	AffinitySourceWeight        json.RawMessage `json:"affinitySourceWeight"`
	BehaviorSourceWeight        json.RawMessage `json:"behaviorSourceWeight"`
	FocusSourceBonus            json.RawMessage `json:"focusSourceBonus"`
	StaleTTLStrategy            json.RawMessage `json:"staleTtlStrategy"`
	StaleTTLMultiplier          json.RawMessage `json:"staleTtlMultiplier"`
	StaleTTLFixedMs             json.RawMessage `json:"staleTtlFixedMs"`
}

// storedPersonalizationValue is one row of the settings lookup.
type storedPersonalizationValue struct {
	Found bool
	Value json.RawMessage
}

// rawIsAbsent reports whether a stored JSON field was missing. JSON null is
// present (and always invalid), matching the NestJS `!== undefined` checks.
func rawIsAbsent(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) == 0
}

// toNumber ports the private toNumber helper: finite numbers pass through,
// non-empty numeric strings are parsed, everything else (including null,
// booleans, arrays and objects) is rejected.
func toNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}

	var number float64
	if err := json.Unmarshal(trimmed, &number); err == nil {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	}

	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return 0, false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// toStrictInt ports toStrictInt: the value must be an integer inside
// [min, max]. Absent and invalid fields both report ok=false; callers use
// rawIsAbsent to tell the two apart.
func toStrictInt(raw json.RawMessage, minValue, maxValue int) (int, bool) {
	parsed, ok := toNumber(raw)
	if !ok || parsed != math.Trunc(parsed) {
		return 0, false
	}
	if parsed < float64(minValue) || parsed > float64(maxValue) {
		return 0, false
	}
	return int(parsed), true
}

// toStrictFloat ports toStrictFloat: the value must fall inside [min, max] and
// is rounded to 4 decimals with the same Number(value.toFixed(4)) semantics.
func toStrictFloat(raw json.RawMessage, minValue, maxValue float64) (float64, bool) {
	parsed, ok := toNumber(raw)
	if !ok {
		return 0, false
	}
	if parsed < minValue || parsed > maxValue {
		return 0, false
	}
	return round4(parsed), true
}

// toStaleTTLStrategy ports toStaleTtlStrategy: only the two documented
// strategies (after trimming) are accepted.
func toStaleTTLStrategy(raw json.RawMessage) (StaleTTLStrategy, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	switch StaleTTLStrategy(strings.TrimSpace(text)) {
	case StaleTTLStrategyMultiplier:
		return StaleTTLStrategyMultiplier, true
	case StaleTTLStrategyFixed:
		return StaleTTLStrategyFixed, true
	default:
		return "", false
	}
}

// normalizeStoredSettings ports normalizeStoredSettings. It returns ok=false
// for anything that is not a valid stored policy: a non-object value, a
// missing/invalid required integer, a present-but-invalid optional field, or
// affinity+behavior <= 0.
func normalizeStoredSettings(raw json.RawMessage) (PersonalizationPolicy, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return PersonalizationPolicy{}, false
	}
	var stored storedPersonalizationPolicy
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return PersonalizationPolicy{}, false
	}

	cacheTTLMs, ok := toStrictInt(stored.CacheTTLMs, cacheTTLMsMin, cacheTTLMsMax)
	if !ok {
		return PersonalizationPolicy{}, false
	}
	maxCacheEntries, ok := toStrictInt(stored.MaxCacheEntries, maxCacheEntriesMin, maxCacheEntriesMax)
	if !ok {
		return PersonalizationPolicy{}, false
	}
	throttleWindowMs, ok := toStrictInt(stored.ThrottleWindowMs, throttleWindowMsMin, throttleWindowMsMax)
	if !ok {
		return PersonalizationPolicy{}, false
	}
	maxRequestsPerWindowPerUser, ok := toStrictInt(stored.MaxRequestsPerWindowPerUser, maxRequestsPerWindowPerUserMin, maxRequestsPerWindowPerUserMax)
	if !ok {
		return PersonalizationPolicy{}, false
	}

	affinitySourceWeight, ok := toStrictFloat(stored.AffinitySourceWeight, affinitySourceWeightMin, affinitySourceWeightMax)
	if !rawIsAbsent(stored.AffinitySourceWeight) && !ok {
		return PersonalizationPolicy{}, false
	}
	behaviorSourceWeight, ok := toStrictFloat(stored.BehaviorSourceWeight, behaviorSourceWeightMin, behaviorSourceWeightMax)
	if !rawIsAbsent(stored.BehaviorSourceWeight) && !ok {
		return PersonalizationPolicy{}, false
	}
	focusSourceBonus, ok := toStrictFloat(stored.FocusSourceBonus, focusSourceBonusMin, focusSourceBonusMax)
	if !rawIsAbsent(stored.FocusSourceBonus) && !ok {
		return PersonalizationPolicy{}, false
	}
	staleTTLStrategy, ok := toStaleTTLStrategy(stored.StaleTTLStrategy)
	if !rawIsAbsent(stored.StaleTTLStrategy) && !ok {
		return PersonalizationPolicy{}, false
	}
	staleTTLMultiplier, ok := toStrictInt(stored.StaleTTLMultiplier, staleTTLMultiplierMin, staleTTLMultiplierMax)
	if !rawIsAbsent(stored.StaleTTLMultiplier) && !ok {
		return PersonalizationPolicy{}, false
	}
	staleTTLFixedMs, ok := toStrictInt(stored.StaleTTLFixedMs, staleTTLFixedMsMin, staleTTLFixedMsMax)
	if !rawIsAbsent(stored.StaleTTLFixedMs) && !ok {
		return PersonalizationPolicy{}, false
	}

	defaults := defaultPersonalizationPolicy()
	policy := PersonalizationPolicy{
		Source:                      PersonalizationPolicySourceDatabase,
		CacheTTLMs:                  cacheTTLMs,
		MaxCacheEntries:             maxCacheEntries,
		ThrottleWindowMs:            throttleWindowMs,
		MaxRequestsPerWindowPerUser: maxRequestsPerWindowPerUser,
		AffinitySourceWeight:        defaults.AffinitySourceWeight,
		BehaviorSourceWeight:        defaults.BehaviorSourceWeight,
		FocusSourceBonus:            defaults.FocusSourceBonus,
		StaleTTLStrategy:            defaults.StaleTTLStrategy,
		StaleTTLMultiplier:          defaults.StaleTTLMultiplier,
		StaleTTLFixedMs:             defaults.StaleTTLFixedMs,
	}
	if !rawIsAbsent(stored.AffinitySourceWeight) {
		policy.AffinitySourceWeight = affinitySourceWeight
	}
	if !rawIsAbsent(stored.BehaviorSourceWeight) {
		policy.BehaviorSourceWeight = behaviorSourceWeight
	}
	if !rawIsAbsent(stored.FocusSourceBonus) {
		policy.FocusSourceBonus = focusSourceBonus
	}
	if !rawIsAbsent(stored.StaleTTLStrategy) {
		policy.StaleTTLStrategy = staleTTLStrategy
	}
	if !rawIsAbsent(stored.StaleTTLMultiplier) {
		policy.StaleTTLMultiplier = staleTTLMultiplier
	}
	if !rawIsAbsent(stored.StaleTTLFixedMs) {
		policy.StaleTTLFixedMs = staleTTLFixedMs
	}

	if policy.AffinitySourceWeight+policy.BehaviorSourceWeight <= 0 {
		return PersonalizationPolicy{}, false
	}
	return policy, true
}

// PersonalizationMetricIncrements is one metrics flush: each positive field is
// added to the matching Redis HASH field of the current UTC day bucket.
// Non-positive fields are ignored, matching normalizeMetricIncrements.
type PersonalizationMetricIncrements struct {
	RequestCount          int `json:"requestCount"`
	CacheHitFreshCount    int `json:"cacheHitFreshCount"`
	CacheHitStaleCount    int `json:"cacheHitStaleCount"`
	ThrottleLimitedCount  int `json:"throttleLimitedCount"`
	ThrottleRejectedCount int `json:"throttleRejectedCount"`
	TrimCount             int `json:"trimCount"`
	TrimEvictedCount      int `json:"trimEvictedCount"`
}

// personalizationMetricIncrement is one normalized HASH field increment.
type personalizationMetricIncrement struct {
	Field  string
	Amount int64
}

// normalizeMetricIncrements ports normalizeMetricIncrements: floor each field
// and keep only the positive ones. The field order is fixed (the struct
// declaration order) instead of JavaScript object insertion order; HINCRBY is
// commutative so the stored counters are identical.
func normalizeMetricIncrements(increments PersonalizationMetricIncrements) []personalizationMetricIncrement {
	candidates := [...]personalizationMetricIncrement{
		{Field: "requestCount", Amount: int64(increments.RequestCount)},
		{Field: "cacheHitFreshCount", Amount: int64(increments.CacheHitFreshCount)},
		{Field: "cacheHitStaleCount", Amount: int64(increments.CacheHitStaleCount)},
		{Field: "throttleLimitedCount", Amount: int64(increments.ThrottleLimitedCount)},
		{Field: "throttleRejectedCount", Amount: int64(increments.ThrottleRejectedCount)},
		{Field: "trimCount", Amount: int64(increments.TrimCount)},
		{Field: "trimEvictedCount", Amount: int64(increments.TrimEvictedCount)},
	}
	normalized := make([]personalizationMetricIncrement, 0, len(candidates))
	for _, candidate := range candidates {
		// toPositiveInt floors and drops anything <= 0.
		amount := candidate.Amount
		if amount <= 0 {
			continue
		}
		normalized = append(normalized, personalizationMetricIncrement{Field: candidate.Field, Amount: amount})
	}
	return normalized
}

// startOfUTCDay ports startOfUtcDay.
func startOfUTCDay(date time.Time) time.Time {
	utc := date.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}

// formatUTCDate ports formatUtcDate (toISOString().slice(0, 10)).
func formatUTCDate(date time.Time) string {
	return date.UTC().Format("2006-01-02")
}

// buildMetricsKey ports buildMetricsKey:
// newsnow:personalization:metrics:v1:<YYYY-MM-DD> in UTC.
func buildMetricsKey(date time.Time) string {
	return fmt.Sprintf("%s:%s", metricsKeyPrefix, formatUTCDate(startOfUTCDay(date)))
}

// PersonalizationPolicyStore reads the NewsNow personalization runtime policy
// from MySQL and records its Redis runtime metrics. It is the Go counterpart of
// NewsnowPersonalizationSettingsService.
//
// The 30 second runtime cache is in-process only and safe for concurrent use.
// Redis may be nil: metrics recording is then disabled (the whole Redis layer
// is optional in this port) instead of failing a request.
type PersonalizationPolicyStore struct {
	db    *sql.DB
	redis *redis.Client

	mu              sync.Mutex
	cachedRuntime   *PersonalizationPolicy
	cachedRuntimeAt time.Time
}

// NewPersonalizationPolicyStore builds a policy store. Both dependencies may be
// nil; the store reports a configuration error when the missing dependency is
// actually needed.
func NewPersonalizationPolicyStore(db *sql.DB, redisClient *redis.Client) *PersonalizationPolicyStore {
	return &PersonalizationPolicyStore{db: db, redis: redisClient}
}

// GetSettings ports getSettings: a missing SystemSetting row yields the
// defaults with Source=default, a present-but-invalid row yields
// ErrInvalidStoredSettings, and a database failure is returned as a generic
// error.
func (s *PersonalizationPolicyStore) GetSettings(ctx context.Context) (PersonalizationPolicy, error) {
	record, err := s.findStoredPolicy(ctx)
	if err != nil {
		return PersonalizationPolicy{}, err
	}
	if !record.Found {
		return defaultPersonalizationPolicy(), nil
	}

	policy, ok := normalizeStoredSettings(record.Value)
	if !ok {
		log.Printf("newsnow-clustering-ops: invalid persisted NewsNow personalization settings for key %q", personalizationSettingsKey)
		return PersonalizationPolicy{}, ErrInvalidStoredSettings
	}
	return policy, nil
}

// GetRuntimeSettings ports getRuntimeSettings: GetSettings behind a 30 second
// in-process cache. Errors are never cached.
func (s *PersonalizationPolicyStore) GetRuntimeSettings(ctx context.Context) (PersonalizationPolicy, error) {
	if cached, ok := s.runtimeCache(); ok {
		return cached, nil
	}

	policy, err := s.GetSettings(ctx)
	if err != nil {
		return PersonalizationPolicy{}, err
	}
	s.storeRuntimeCache(policy)
	return policy, nil
}

// ResolveStaleTTLMs is the method form of resolveStaleTtlMs and keeps the
// NestJS call shape (an explicit field set) for callers that do not hold a
// PersonalizationPolicy value.
func (s *PersonalizationPolicyStore) ResolveStaleTTLMs(cacheTTLMs, throttleWindowMs int, strategy StaleTTLStrategy, staleTTLMultiplier, staleTTLFixedMs int) int {
	return resolveStaleTTLMs(cacheTTLMs, throttleWindowMs, strategy, staleTTLMultiplier, staleTTLFixedMs)
}

// RecordPersonalizationMetrics ports recordRuntimeMetricsBestEffort: it
// increments the current UTC day bucket and swallows (logs) every failure.
// Only positive fields are written.
//
// A nil Redis client disables metrics collection silently: the whole Redis
// layer is optional in this port, so a missing client means "metrics off"
// rather than one warning per request.
func (s *PersonalizationPolicyStore) RecordPersonalizationMetrics(ctx context.Context, increments PersonalizationMetricIncrements) {
	if s == nil || s.redis == nil {
		return
	}
	if err := s.recordPersonalizationMetrics(ctx, increments); err != nil {
		log.Printf("newsnow-clustering-ops: failed to record NewsNow personalization runtime metrics: %v", err)
	}
}

// recordPersonalizationMetrics ports recordRuntimeMetrics: one HINCRBY per
// positive field followed by a single EXPIRE (3888000 seconds).
func (s *PersonalizationPolicyStore) recordPersonalizationMetrics(ctx context.Context, increments PersonalizationMetricIncrements) error {
	normalized := normalizeMetricIncrements(increments)
	if len(normalized) == 0 {
		return nil
	}
	if s == nil || s.redis == nil {
		return errPersonalizationRedisNotConfigured
	}

	key := buildMetricsKey(time.Now())
	for _, increment := range normalized {
		if err := s.redis.HIncrBy(ctx, key, increment.Field, increment.Amount).Err(); err != nil {
			return fmt.Errorf("newsnow-clustering-ops: metrics hincrby %q: %w", increment.Field, err)
		}
	}
	if err := s.redis.Expire(ctx, key, personalizationMetricsRetentionTTL).Err(); err != nil {
		return fmt.Errorf("newsnow-clustering-ops: metrics expire: %w", err)
	}
	return nil
}

// findStoredPolicy runs the global SystemSetting lookup. sql.ErrNoRows is not
// an error: it is the documented "row absent" result.
func (s *PersonalizationPolicyStore) findStoredPolicy(ctx context.Context) (storedPersonalizationValue, error) {
	if s == nil || s.db == nil {
		return storedPersonalizationValue{}, errPersonalizationDatabaseNotConfigured
	}

	var value []byte
	err := s.db.QueryRowContext(ctx, personalizationSettingsQuery, personalizationSettingsKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return storedPersonalizationValue{Found: false}, nil
	}
	if err != nil {
		return storedPersonalizationValue{}, fmt.Errorf("newsnow-clustering-ops: load personalization settings: %w", err)
	}
	return storedPersonalizationValue{Found: true, Value: json.RawMessage(value)}, nil
}

// runtimeCache returns the cached policy when it is still inside
// RUNTIME_CACHE_TTL_MS.
func (s *PersonalizationPolicyStore) runtimeCache() (PersonalizationPolicy, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cachedRuntime == nil || time.Since(s.cachedRuntimeAt) > personalizationRuntimeCacheTTL {
		return PersonalizationPolicy{}, false
	}
	return *s.cachedRuntime, true
}

// storeRuntimeCache replaces the cached policy.
func (s *PersonalizationPolicyStore) storeRuntimeCache(policy PersonalizationPolicy) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cached := policy
	s.cachedRuntime = &cached
	s.cachedRuntimeAt = time.Now()
}
