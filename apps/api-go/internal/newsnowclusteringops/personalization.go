package newsnowclusteringops

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// ErrRateLimited is returned when the per-user personalization throttle is
// exhausted and no stale payload can be served. The HTTP handler maps it to
// 429; the message is byte-identical to the NestJS HttpException text.
var ErrRateLimited = errors.New("NewsNow personalized ordering is rate limited. Please retry shortly.")

// errColumnRequired and errInvalidColumnFormat are the two controller
// validation failures. They are unexported on purpose: ValidateColumnKey's
// contract is its exact message, and same-package handlers can still match them
// with errors.Is.
var (
	errColumnRequired      = errors.New("column is required")
	errInvalidColumnFormat = errors.New("invalid column format")
)

// PersonalizationSourceOrdering budget constants, ported from
// news-aggregator.service.ts and news-aggregator.constants.ts.
const (
	// cachePrefix is CACHE_PREFIX.
	cachePrefix = "news-aggregator"
	// newsnowSmartScoreMaxAgeDays is NEWSNOW_SMART_SCORE_MAX_AGE_DAYS.
	newsnowSmartScoreMaxAgeDays = 14
	// newsnowMaxSourceIDs is NEWSNOW_MAX_SOURCE_IDS.
	newsnowMaxSourceIDs = 240
	// columnIDMaxLength is the {1,64} bound of COLUMN_ID_PATTERN.
	columnIDMaxLength = 64

	personalizationCacheKeyPrefix       = cachePrefix + ":personalization:order:v1"
	personalizationCacheIndexKey        = personalizationCacheKeyPrefix + ":index"
	personalizationRateLimitPrefix      = cachePrefix + ":personalization:throttle"
	personalizationCacheIndexTTLSeconds = 60 * 30
	personalizationMaxCacheTrimBatch    = 200

	// negativeBehaviorPenalty is the 1.15 multiplier applied to the negative
	// behavior signal.
	negativeBehaviorPenalty = 1.15
	// recencyHalfLifeDivisor is the 1.25 factor of the decay denominator
	// (14 * 1.25 = 17.5 days).
	recencyHalfLifeDivisor = 1.25
	// recencyFactorFloor is the 0.2 lower bound of the decay multiplier.
	recencyFactorFloor = 0.2
	// personalizationScoreTieTolerance is the 0.0001 absolute-score window
	// inside which the original source order is preserved.
	personalizationScoreTieTolerance = 0.0001
	// behaviorTermMaxLength is the 96 character slice applied to behavior
	// aliases.
	behaviorTermMaxLength = 96
	// jsMaxSafeInteger is Number.MAX_SAFE_INTEGER, the upper clamp bound of
	// normalizeRankingSourceWeights.
	jsMaxSafeInteger = 9007199254740991.0
)

// personalizationCacheIndexTTL is personalizationCacheIndexTTLSeconds as a
// duration.
const personalizationCacheIndexTTL = personalizationCacheIndexTTLSeconds * time.Second

// Sliding-window throttle tap constants. They match the
// RATE_LIMIT_REDIS_CLEANUP_* environment defaults of rate-limiter.service.ts.
const (
	throttleCleanupLimit     = 100
	throttleCleanupThreshold = 1_000
)

// throttleLuaScript is a byte-for-byte port of SLIDING_WINDOW_LUA_SCRIPT in
// rate-limiter.service.ts. KEYS[1] is the bucket ZSET, KEYS[2] its sequence
// counter; ARGV is now, window_ms, limit, ttl_seconds, cleanup_limit,
// cleanup_threshold.
const throttleLuaScript = `
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
-- - Avoid unbounded O(N) deletes (ZREMRANGEBYSCORE) on every request.
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

// throttleScript wraps throttleLuaScript so go-redis can use EVALSHA with an
// automatic EVAL fallback.
var throttleScript = redis.NewScript(throttleLuaScript)

// PersonalizationRequest is the validated POST /api/news-aggregator/sources/order
// body. SettingsOverride is the raw JSON of the optional `settings` property
// (nil when it was absent); the handler is responsible for rejecting a
// non-object `settings` with 400 before building the request.
type PersonalizationRequest struct {
	// ColumnKey is the requested metadata column id.
	ColumnKey string
	// SourceIDs are the requested source ids, in request order.
	SourceIDs []string
	// SettingsOverride is the raw JSON of the optional `settings` object, nil
	// when the property was absent.
	SettingsOverride []byte
}

// SourceOrderingService computes and caches personalized source ordering. It is
// the Go port of NewsAggregatorService.getPersonalizedSourceOrderForUser.
//
// redis may be nil, in which case the service still computes an order but reads
// and writes no cache and fails the throttle open.
type SourceOrderingService struct {
	db       *sql.DB
	redis    *redis.Client
	policy   *PersonalizationPolicyStore
	behavior personalnews.BehaviorAPI
	users    *usersettings.MySQLRepository

	// now is the clock seam. It defaults to time.Now and is only replaced by
	// tests.
	now func() time.Time
}

// NewSourceOrderingService builds the ordering service. db, redisClient and
// behavior may each be nil; the matching code path then reports or degrades
// exactly as documented on the individual methods.
func NewSourceOrderingService(db *sql.DB, redisClient *redis.Client, behavior personalnews.BehaviorAPI) *SourceOrderingService {
	return &SourceOrderingService{
		db:       db,
		redis:    redisClient,
		policy:   NewPersonalizationPolicyStore(db, redisClient),
		behavior: behavior,
		users:    usersettings.NewMySQLRepository(db),
		now:      time.Now,
	}
}

// PolicyStore exposes the runtime-policy reader the service uses, so a handler
// can serve the settings endpoints from the same instance.
func (s *SourceOrderingService) PolicyStore() *PersonalizationPolicyStore {
	if s == nil {
		return nil
	}
	return s.policy
}

// RecordPersonalizationMetrics forwards to the policy store's best-effort
// metrics recorder.
func (s *SourceOrderingService) RecordPersonalizationMetrics(ctx context.Context, increments PersonalizationMetricIncrements) {
	if s == nil || s.policy == nil {
		return
	}
	s.policy.RecordPersonalizationMetrics(ctx, increments)
}

// personalizationSourceMetaIndex maps a source id to its metadata entry. It is
// built once at package init from the generated registry.
//
// The index is deliberately separate from metadata.go's newsnowAvailableSourceIDs:
// that map carries only name and home (the metadata endpoint does not expose
// titles), while behavior-alias resolution also needs sourceMeta.title.
var personalizationSourceMetaIndex = func() map[string]*newsnowMetadataSource {
	index := make(map[string]*newsnowMetadataSource, len(newsnowSourceRegistry))
	for i := range newsnowSourceRegistry {
		entry := &newsnowSourceRegistry[i]
		index[entry.ID] = &entry.Source
	}
	return index
}()

// ValidateColumnKey implements the controller's validateColumnKey: the value
// must be a non-empty string whose trimmed, lower-cased form matches
// COLUMN_ID_PATTERN (/^[a-z0-9_-]{1,64}$/i). It returns the normalized key.
func ValidateColumnKey(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errColumnRequired
	}
	normalized := strings.ToLower(trimmed)
	if !matchesColumnIDPattern(normalized) {
		return "", errInvalidColumnFormat
	}
	return normalized, nil
}

// NormalizeSourceIDs applies the controller's normalizeSourceIds rules and then
// the service's availability filter. The combined result is the ordered, stable
// de-duplicated intersection of the request ids with the metadata registry,
// capped at NEWSNOW_MAX_SOURCE_IDS.
//
// A nil available map behaves like an empty set (Set.has on an empty set),
// which drops every id.
func NormalizeSourceIDs(raw []string, available map[string]struct{}) []string {
	filtered := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, entry := range raw {
		sourceID := strings.TrimSpace(entry)
		// The controller skips non-strings, empty strings and pattern misses.
		if sourceID == "" || !matchesSourceIDPattern(sourceID) {
			continue
		}
		if _, duplicate := seen[sourceID]; duplicate {
			continue
		}
		seen[sourceID] = struct{}{}
		filtered = append(filtered, sourceID)
		if len(filtered) >= newsnowMaxSourceIDs {
			break
		}
	}
	return normalizePersonalizationSourceIDs(filtered, available)
}

// normalizePersonalizationSourceIDs ports normalizePersonalizationSourceIds:
// trim, drop empties, drop ids missing from the metadata registry, drop
// duplicates preserving first occurrence, and cap at NEWSNOW_MAX_SOURCE_IDS.
func normalizePersonalizationSourceIDs(sourceIDs []string, available map[string]struct{}) []string {
	out := make([]string, 0, len(sourceIDs))
	seen := make(map[string]struct{}, len(sourceIDs))
	for _, rawSourceID := range sourceIDs {
		sourceID := strings.TrimSpace(rawSourceID)
		if sourceID == "" {
			continue
		}
		if _, duplicate := seen[sourceID]; duplicate {
			continue
		}
		if _, ok := available[sourceID]; !ok {
			continue
		}
		seen[sourceID] = struct{}{}
		out = append(out, sourceID)
		if len(out) >= newsnowMaxSourceIDs {
			break
		}
	}
	return out
}

// matchesSourceIDPattern mirrors SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i.
func matchesSourceIDPattern(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if !isSourceIDPatternByte(value[i]) {
			return false
		}
	}
	return true
}

// matchesColumnIDPattern mirrors COLUMN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i.
func matchesColumnIDPattern(value string) bool {
	if len(value) < 1 || len(value) > columnIDMaxLength {
		return false
	}
	return matchesSourceIDPattern(value)
}

// isSourceIDPatternByte reports whether c belongs to [a-zA-Z0-9_-].
func isSourceIDPatternByte(c byte) bool {
	return (c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= '0' && c <= '9') ||
		c == '_' ||
		c == '-'
}

// OrderSources mirrors NewsAggregatorService.getPersonalizedSourceOrderForUser.
// It returns the payload plus a classified error: ErrRateLimited (HTTP 429),
// ErrInvalidStoredSettings (HTTP 409) or a generic error.
//
// Column-key and source-id validation belongs to the handler
// (ValidateColumnKey/NormalizeSourceIDs). To stay safe when it is called with a
// raw body, OrderSources trims and lower-cases the column key and re-applies
// the availability filter to the requested ids; it never returns a validation
// error, so the caller's error classification stays 429/409/generic.
//
// A nil behavior API degrades a personalized request to the manual payload
// instead of failing, matching the Service contract.
func (s *SourceOrderingService) OrderSources(ctx context.Context, orgID, userID string, req PersonalizationRequest) (PersonalizedOrderPayload, error) {
	if s == nil || s.policy == nil {
		return PersonalizedOrderPayload{}, errPersonalizationDatabaseNotConfigured
	}
	policy, err := s.policy.GetRuntimeSettings(ctx)
	if err != nil {
		return PersonalizedOrderPayload{}, err
	}
	s.policy.RecordPersonalizationMetrics(ctx, PersonalizationMetricIncrements{RequestCount: 1})

	columnKey := strings.ToLower(strings.TrimSpace(req.ColumnKey))
	fallbackSourceIDs := normalizePersonalizationSourceIDs(newsnowColumnSourcesByID[columnKey], newsnowAvailableSourceIDs)
	requestedSourceIDs := NormalizeSourceIDs(req.SourceIDs, newsnowAvailableSourceIDs)
	baseSourceIDs := requestedSourceIDs
	if len(baseSourceIDs) == 0 {
		baseSourceIDs = fallbackSourceIDs
	}

	// The override, when present, replaces the persisted settings entirely.
	// usersettings.NormalizeNewsnow maps smart -> personalized and repairs
	// invalid input with defaults, exactly like normalizeNewsnowUiSettings.
	var overrideSettings *usersettings.NewsnowSettings
	if len(req.SettingsOverride) > 0 {
		normalized := usersettings.NormalizeNewsnow(req.SettingsOverride)
		overrideSettings = &normalized
	}

	var settings usersettings.NewsnowSettings
	settingsSignature := "default"
	if overrideSettings != nil {
		settings = *overrideSettings
		settingsSignature = settingsCacheSignature(settings)
	} else {
		if s.users == nil || s.db == nil {
			return PersonalizedOrderPayload{}, errPersonalizationDatabaseNotConfigured
		}
		record, err := s.users.FindNewsnow(ctx, orgID, userID)
		if err != nil {
			return PersonalizedOrderPayload{}, err
		}
		settings = usersettings.NormalizeNewsnow(record.Value)
		if record.Found {
			// persistedSettingsResponse.updatedAt.settings ?? "default".
			settingsSignature = usersettings.BuildNewsnowResponse(record).UpdatedAt.Settings
			if settingsSignature == "" {
				settingsSignature = "default"
			}
		}
	}

	cacheKey := buildPersonalizationCacheKey(orgID, userID, columnKey, baseSourceIDs, settingsSignature, runtimePolicyCacheSignature(policy))
	cacheToken := hashPersonalizationCacheKey(cacheKey)
	freshCacheKey := buildPersonalizationRedisFreshCacheKey(cacheToken)
	staleCacheKey := buildPersonalizationRedisStaleCacheKey(cacheToken)

	if policy.CacheTTLMs > 0 {
		if freshCached := s.getPersonalizationCachePayload(ctx, freshCacheKey); freshCached != nil {
			s.policy.RecordPersonalizationMetrics(ctx, PersonalizationMetricIncrements{CacheHitFreshCount: 1})
			return *freshCached, nil
		}
	}

	if !s.consumePersonalizationThrottle(ctx, orgID+":"+userID, policy.ThrottleWindowMs, policy.MaxRequestsPerWindowPerUser) {
		if staleCached := s.getPersonalizationCachePayload(ctx, staleCacheKey); staleCached != nil {
			s.policy.RecordPersonalizationMetrics(ctx, PersonalizationMetricIncrements{
				ThrottleLimitedCount: 1,
				CacheHitStaleCount:   1,
			})
			return *staleCached, nil
		}
		s.policy.RecordPersonalizationMetrics(ctx, PersonalizationMetricIncrements{
			ThrottleLimitedCount:  1,
			ThrottleRejectedCount: 1,
		})
		return PersonalizedOrderPayload{}, ErrRateLimited
	}

	manuallyOrdered := applyManualOrder(baseSourceIDs, columnOrderValues(settings, columnKey))
	normalizedWeights := normalizeRankingSourceWeights(policy.AffinitySourceWeight, policy.BehaviorSourceWeight)
	scoreWeights := ScoreWeights{
		Affinity:   round4(normalizedWeights.Affinity),
		Behavior:   round4(normalizedWeights.Behavior),
		FocusBonus: round4(policy.FocusSourceBonus),
	}

	// NormalizeNewsnow maps "smart" to "personalized"; the extra "smart" check
	// keeps the comparison identical to the NestJS expression.
	personalizedEnabled := settings.SortMode == string(SortModePersonalized) || settings.SortMode == "smart"
	// A nil BehaviorAPI means the deployment has no behavior profile at all.
	// Service documents that personalized ordering then degrades to manual
	// ordering instead of failing the request.
	if s.behavior == nil {
		personalizedEnabled = false
	}

	if !personalizedEnabled {
		payload := PersonalizedOrderPayload{
			ColumnKey:          columnKey,
			SortMode:           SortModeManual,
			SourceIDs:          manuallyOrdered,
			SourceScores:       map[string]float64{},
			SourceScoreDetails: map[string]SourceScoreDetail{},
			ScoreWeights:       scoreWeights,
			ComputedAt:         s.computedAt(),
		}
		s.cachePersonalizationResponseIfEnabled(ctx, cacheToken, payload, policy)
		return payload, nil
	}

	behaviorProfile, err := s.behavior.GetPersonalizationProfile(ctx, orgID, userID)
	if err != nil {
		return PersonalizedOrderPayload{}, err
	}
	positiveBehaviorSourceScores := behaviorProfile.Positive.Sources
	negativeBehaviorSourceScores := behaviorProfile.Negative.Sources
	maxPositiveBehaviorSourceScore := maxScoreValue(positiveBehaviorSourceScores)
	maxNegativeBehaviorSourceScore := maxScoreValue(negativeBehaviorSourceScores)
	positiveBehaviorScoreNormalizer := 0.0
	if maxPositiveBehaviorSourceScore > 0 {
		positiveBehaviorScoreNormalizer = math.Log1p(maxPositiveBehaviorSourceScore)
	}
	negativeBehaviorScoreNormalizer := 0.0
	if maxNegativeBehaviorSourceScore > 0 {
		negativeBehaviorScoreNormalizer = math.Log1p(maxNegativeBehaviorSourceScore)
	}

	focusSet := make(map[string]struct{}, len(settings.FocusSources))
	for _, sourceID := range settings.FocusSources {
		focusSet[sourceID] = struct{}{}
	}
	affinityBySource := make(map[string]usersettings.NewsnowSourceAffinity, len(settings.SourceAffinity))
	for _, pair := range settings.SourceAffinity {
		affinityBySource[pair.Key] = pair.Affinity
	}

	scoringNow := s.nowMillis()
	scored := make([]scoredSource, 0, len(manuallyOrdered))
	for index, sourceID := range manuallyOrdered {
		affinity, hasAffinity := affinityBySource[sourceID]
		_, isFocus := focusSet[sourceID]
		scored = append(scored, scoreSource(sourceScoringInput{
			SourceID:            sourceID,
			Index:               index,
			HasAffinity:         hasAffinity,
			Affinity:            affinity,
			IsFocus:             isFocus,
			FocusSourceBonus:    policy.FocusSourceBonus,
			PositiveBehaviorRaw: resolveBehaviorSourceScore(sourceID, personalizationSourceMetaIndex[sourceID], positiveBehaviorSourceScores),
			NegativeBehaviorRaw: resolveBehaviorSourceScore(sourceID, personalizationSourceMetaIndex[sourceID], negativeBehaviorSourceScores),
			PositiveNormalizer:  positiveBehaviorScoreNormalizer,
			NegativeNormalizer:  negativeBehaviorScoreNormalizer,
			AffinityWeight:      normalizedWeights.Affinity,
			BehaviorWeight:      normalizedWeights.Behavior,
			NowMillis:           scoringNow,
		}))
	}

	// Descending score with the original index as tie-break. Scores within
	// 0.0001 of each other keep their manual order. sort.SliceStable matches
	// the stability of the JavaScript Array.sort used by the NestJS original.
	sort.SliceStable(scored, func(i, j int) bool {
		left, right := scored[i], scored[j]
		if math.Abs(right.Score-left.Score) > personalizationScoreTieTolerance {
			return right.Score > left.Score
		}
		return left.Index < right.Index
	})

	sourceIDs := make([]string, 0, len(scored))
	sourceScores := make(map[string]float64, len(scored))
	sourceScoreDetails := make(map[string]SourceScoreDetail, len(scored))
	for _, entry := range scored {
		sourceIDs = append(sourceIDs, entry.SourceID)
		sourceScores[entry.SourceID] = round4(entry.DisplayScore)
		sourceScoreDetails[entry.SourceID] = entry.Detail
	}

	payload := PersonalizedOrderPayload{
		ColumnKey:          columnKey,
		SortMode:           SortModePersonalized,
		SourceIDs:          sourceIDs,
		SourceScores:       sourceScores,
		SourceScoreDetails: sourceScoreDetails,
		ScoreWeights:       scoreWeights,
		ComputedAt:         s.computedAt(),
	}
	s.cachePersonalizationResponseIfEnabled(ctx, cacheToken, payload, policy)
	return payload, nil
}

// scoredSource is one scored source together with its explainability detail.
type scoredSource struct {
	SourceID     string
	Index        int
	Score        float64
	DisplayScore float64
	Detail       SourceScoreDetail
}

// sourceScoringInput is the fully resolved per-source scoring input. Every
// value, including the behavior normalizers, is computed once per request so
// scoreSource stays a pure function that unit tests can drive directly.
type sourceScoringInput struct {
	SourceID            string
	Index               int
	HasAffinity         bool
	Affinity            usersettings.NewsnowSourceAffinity
	IsFocus             bool
	FocusSourceBonus    float64
	PositiveBehaviorRaw float64
	NegativeBehaviorRaw float64
	PositiveNormalizer  float64
	NegativeNormalizer  float64
	AffinityWeight      float64
	BehaviorWeight      float64
	NowMillis           int64
}

// scoreSource ports one iteration of the NestJS scoring map.
func scoreSource(input sourceScoringInput) scoredSource {
	baseScore := 0.0
	elapsedDays := float64(newsnowSmartScoreMaxAgeDays)
	if input.HasAffinity {
		// Number.isFinite(affinity.score): the normalized settings always carry
		// a finite score, but the guard is kept for parity.
		if !math.IsNaN(input.Affinity.Score) && !math.IsInf(input.Affinity.Score, 0) {
			baseScore = clampPersonalizationFloat(input.Affinity.Score, 0, 100)
		}
		elapsedDays = affinityElapsedDays(input.Affinity.LastInteractedAt, input.NowMillis)
	}

	// Recency decay: recencyFactor = 1 - elapsedDays / (14 * 1.25), with the
	// factor clamped to [0.2, 1] so a stale source still keeps a fifth of its
	// affinity score.
	recencyFactor := affinityRecencyFactor(elapsedDays)
	recencyWeighted := baseScore * recencyFactor

	focusBonus := 0.0
	if input.IsFocus {
		focusBonus = input.FocusSourceBonus
	}

	positiveBehaviorNormalized := normalizeBehaviorScore(input.PositiveBehaviorRaw, input.PositiveNormalizer)
	negativeBehaviorNormalized := normalizeBehaviorScore(input.NegativeBehaviorRaw, input.NegativeNormalizer)
	behaviorWeighted := (positiveBehaviorNormalized - negativeBehaviorNormalized*negativeBehaviorPenalty) * 100

	affinityContribution := recencyWeighted * input.AffinityWeight
	behaviorContribution := behaviorWeighted * input.BehaviorWeight
	negativeContribution := round4(negativeBehaviorNormalized * 100 * input.BehaviorWeight)
	combinedScore := affinityContribution + behaviorContribution + focusBonus
	displayScore := clampPersonalizationFloat(combinedScore, 0, 100)

	return scoredSource{
		SourceID:     input.SourceID,
		Index:        input.Index,
		Score:        combinedScore,
		DisplayScore: displayScore,
		Detail: SourceScoreDetail{
			CombinedScore:        round4(combinedScore),
			AffinityScore:        round4(recencyWeighted),
			BehaviorScore:        round4(behaviorWeighted),
			AffinityWeight:       round4(input.AffinityWeight),
			BehaviorWeight:       round4(input.BehaviorWeight),
			AffinityContribution: round4(affinityContribution),
			BehaviorContribution: round4(behaviorContribution),
			NegativeContribution: negativeContribution,
			FocusBonus:           round4(focusBonus),
		},
	}
}

// affinityElapsedDays ports the elapsedDays expression: the age of the last
// interaction in days, clamped to [0, 14]. The normalized settings always carry
// a numeric lastInteractedAt (the usersettings port maps a missing field to 0),
// so the JavaScript `typeof === "number"` guard is always satisfied here; a
// missing affinity entry is handled by the caller using the 14 day default.
func affinityElapsedDays(lastInteractedAt int, nowMillis int64) float64 {
	elapsedMs := float64(nowMillis - int64(lastInteractedAt))
	return clampPersonalizationFloat(elapsedMs/(24*60*60*1000), 0, float64(newsnowSmartScoreMaxAgeDays))
}

// affinityRecencyFactor ports the decay multiplier:
//
//	recencyFactor = 1 - elapsedDays / (NEWSNOW_SMART_SCORE_MAX_AGE_DAYS * 1.25)
//
// and clamps it to [0.2, 1]. At elapsedDays 0 the factor is 1; at 14 days it is
// 0.2, which is also the floor for anything older.
func affinityRecencyFactor(elapsedDays float64) float64 {
	return clampPersonalizationFloat(1-elapsedDays/(float64(newsnowSmartScoreMaxAgeDays)*recencyHalfLifeDivisor), recencyFactorFloor, 1)
}

// normalizeBehaviorScore ports the log1p normalization: a positive raw score
// against a positive normalizer is scaled into [0, 1]; zero, negative and
// missing signals score 0.
func normalizeBehaviorScore(rawScore, normalizer float64) float64 {
	if rawScore > 0 && normalizer > 0 {
		return clampPersonalizationFloat(math.Log1p(rawScore)/normalizer, 0, 1)
	}
	return 0
}

// maxScoreValue ports Math.max(0, ...Object.values(scores)): the largest finite
// value, never below 0. Non-finite values are ignored (JSON cannot carry them
// anyway).
func maxScoreValue(scores map[string]float64) float64 {
	largest := 0.0
	for _, value := range scores {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		if value > largest {
			largest = value
		}
	}
	return largest
}

// resolveBehaviorSourceScore ports resolveBehaviorSourceScore: the maximum
// finite score found under any of the source's behavior aliases. A missing or
// negative-only signal yields 0.
func resolveBehaviorSourceScore(sourceID string, sourceMeta *newsnowMetadataSource, behaviorSourceScores map[string]float64) float64 {
	score := 0.0
	for _, alias := range buildSourceBehaviorAliases(sourceID, sourceMeta) {
		value, ok := behaviorSourceScores[alias]
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		if value > score {
			score = value
		}
	}
	return score
}

// buildSourceBehaviorAliases ports buildSourceBehaviorAliases: the normalized
// source id, its first dash-separated segment (only when different), the source
// name, its title and the domain of its home page, de-duplicated in that order.
func buildSourceBehaviorAliases(sourceID string, sourceMeta *newsnowMetadataSource) []string {
	aliases := make([]string, 0, 5)
	seen := make(map[string]struct{}, 5)
	push := func(value string) {
		normalized := normalizeBehaviorTerm(value)
		if normalized == "" {
			return
		}
		if _, duplicate := seen[normalized]; duplicate {
			return
		}
		seen[normalized] = struct{}{}
		aliases = append(aliases, normalized)
	}

	push(sourceID)
	baseSourceID := sourceID
	if separator := strings.Index(sourceID, "-"); separator >= 0 {
		baseSourceID = sourceID[:separator]
	}
	if baseSourceID != sourceID {
		push(baseSourceID)
	}
	if sourceMeta != nil {
		push(sourceMeta.Name)
		push(sourceMeta.Title)
		push(extractDomainFromURL(sourceMeta.Home))
	}
	return aliases
}

// normalizeBehaviorTerm ports normalizeBehaviorTerm: trim, lower-case, collapse
// whitespace runs to a single space and cut to 96 units. It returns "" instead
// of the JavaScript null.
//
// The JavaScript slice counts UTF-16 code units while this port counts runes,
// so terms longer than 96 units that contain astral-plane characters (for
// example emoji) are cut at a different point. Behavior aliases are source ids,
// names, titles and domains, so the difference is not observable in practice.
func normalizeBehaviorTerm(value string) string {
	normalized := trimJSWhitespace(value)
	normalized = strings.ToLower(normalized)
	normalized = collapseJSWhitespace(normalized)
	normalized = truncateRunes(normalized, behaviorTermMaxLength)
	if normalized == "" {
		return ""
	}
	return normalized
}

// extractDomainFromURL ports extractDomainFromUrl: parse the raw value as an
// absolute URL, and when that fails retry with an https:// prefix (which is how
// a bare "example.com" is accepted). The hostname is lower-cased and stripped
// of a leading "www.". It returns "" instead of the JavaScript null.
func extractDomainFromURL(value string) string {
	raw := trimJSWhitespace(value)
	if raw == "" {
		return ""
	}
	if domain := domainFromAbsoluteURL(raw); domain != "" {
		return domain
	}
	return domainFromAbsoluteURL("https://" + raw)
}

// domainFromAbsoluteURL mirrors new URL(candidate).hostname for one candidate.
// Unlike url.Parse, the JavaScript URL constructor rejects a relative
// reference, so a scheme and a host are both required here.
func domainFromAbsoluteURL(candidate string) string {
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	hostname := strings.ToLower(parsed.Hostname())
	return normalizeBehaviorTerm(strings.TrimPrefix(hostname, "www."))
}

// isJSWhitespace reports whether r is matched by the JavaScript /\s/ class.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00a0, // no-break space
		0x1680, // ogham space mark
		0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
		0x2028, // line separator
		0x2029, // paragraph separator
		0x202f, // narrow no-break space
		0x205f, // medium mathematical space
		0x3000, // ideographic space
		0xfeff: // zero width no-break space / BOM
		return true
	default:
		return false
	}
}

// trimJSWhitespace ports String.prototype.trim for the JavaScript whitespace
// class.
func trimJSWhitespace(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

// collapseJSWhitespace ports replace(/\s+/g, " ").
func collapseJSWhitespace(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	inWhitespaceRun := false
	for _, r := range value {
		if isJSWhitespace(r) {
			inWhitespaceRun = true
			continue
		}
		if inWhitespaceRun {
			builder.WriteByte(' ')
			inWhitespaceRun = false
		}
		builder.WriteRune(r)
	}
	if inWhitespaceRun {
		builder.WriteByte(' ')
	}
	return builder.String()
}

// truncateRunes keeps at most limit runes of value.
func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	count := 0
	for index := range value {
		if count == limit {
			return value[:index]
		}
		count++
	}
	return value
}

// rankingWeights is the normalized affinity/behavior pair.
type rankingWeights struct {
	Affinity float64
	Behavior float64
}

// normalizeRankingSourceWeights ports normalizeRankingSourceWeights: clamp both
// weights into [0, Number.MAX_SAFE_INTEGER] (non-finite inputs become 0), then
// return the normalized ratio, or a 50/50 split when the total is not positive.
func normalizeRankingSourceWeights(affinitySourceWeight, behaviorSourceWeight float64) rankingWeights {
	affinity := normalizeWeightInput(affinitySourceWeight)
	behavior := normalizeWeightInput(behaviorSourceWeight)
	total := affinity + behavior
	if total <= 0 {
		return rankingWeights{Affinity: 0.5, Behavior: 0.5}
	}
	return rankingWeights{Affinity: affinity / total, Behavior: behavior / total}
}

// normalizeWeightInput is the Number.isFinite + clamp step of
// normalizeRankingSourceWeights.
func normalizeWeightInput(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return clampPersonalizationFloat(value, 0, jsMaxSafeInteger)
}

// applyManualOrder ports applyManualOrder: the manual list first (only ids that
// exist in the base set, de-duplicated), then the remaining base ids in their
// original order.
func applyManualOrder(sourceIDs, manualOrder []string) []string {
	if len(manualOrder) == 0 {
		return sourceIDs
	}
	sourceSet := make(map[string]struct{}, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		sourceSet[sourceID] = struct{}{}
	}
	ordered := make([]string, 0, len(sourceIDs))
	seen := make(map[string]struct{}, len(sourceIDs))
	for _, sourceID := range manualOrder {
		if _, ok := sourceSet[sourceID]; !ok {
			continue
		}
		if _, duplicate := seen[sourceID]; duplicate {
			continue
		}
		seen[sourceID] = struct{}{}
		ordered = append(ordered, sourceID)
	}
	for _, sourceID := range sourceIDs {
		if _, duplicate := seen[sourceID]; duplicate {
			continue
		}
		ordered = append(ordered, sourceID)
	}
	return ordered
}

// columnOrderValues returns settings.columnOrders[columnKey] (nil when absent).
func columnOrderValues(settings usersettings.NewsnowSettings, columnKey string) []string {
	for _, pair := range settings.ColumnOrders {
		if pair.Key == columnKey {
			return pair.Values
		}
	}
	return nil
}

// clampPersonalizationFloat ports the private clamp helper. Like the JavaScript
// original it returns NaN unchanged, because both comparisons are false for
// NaN.
func clampPersonalizationFloat(value, minValue, maxValue float64) float64 {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

// round4 ports Number(value.toFixed(4)). A rounded negative zero is normalized
// to positive zero because JSON.stringify(-0) is "0" while encoding/json would
// emit "-0".
func round4(value float64) float64 {
	rounded := math.Round(value*10000) / 10000
	if rounded == 0 {
		return 0
	}
	return rounded
}

// ---------------------------------------------------------------------------
// Stable cache-signature serialization
// ---------------------------------------------------------------------------

// cacheValueKind discriminates the nodes of the typed JSON-like tree used by
// stableSerializeForCache.
type cacheValueKind int

const (
	cacheValueNull cacheValueKind = iota
	cacheValueScalar
	cacheValueArray
	cacheValueObject
)

// cacheValue is a typed JSON-like tree. It exists so the stable serializer
// never needs an untyped map or slice.
type cacheValue struct {
	Kind   cacheValueKind
	Scalar []byte
	Array  []cacheValue
	Object []cacheField
}

// cacheField is one key/value pair of a cacheValueObject node.
type cacheField struct {
	Key   string
	Value cacheValue
}

// newCacheNull returns the JSON null node.
func newCacheNull() cacheValue {
	return cacheValue{Kind: cacheValueNull}
}

// newCacheInt returns an integer scalar node.
func newCacheInt(value int) cacheValue {
	return cacheValue{Kind: cacheValueScalar, Scalar: []byte(strconv.FormatInt(int64(value), 10))}
}

// newCacheFloat returns a float scalar node. NaN and infinities serialize to
// null and negative zero to "0", exactly like JSON.stringify.
func newCacheFloat(value float64) cacheValue {
	if value == 0 {
		return cacheValue{Kind: cacheValueScalar, Scalar: []byte("0")}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		raw = []byte("null")
	}
	return cacheValue{Kind: cacheValueScalar, Scalar: raw}
}

// newCacheString returns a string scalar node.
func newCacheString(value string) cacheValue {
	raw, err := json.Marshal(value)
	if err != nil {
		raw = []byte(`""`)
	}
	return cacheValue{Kind: cacheValueScalar, Scalar: raw}
}

// newCacheBool returns a boolean scalar node.
func newCacheBool(value bool) cacheValue {
	if value {
		return cacheValue{Kind: cacheValueScalar, Scalar: []byte("true")}
	}
	return cacheValue{Kind: cacheValueScalar, Scalar: []byte("false")}
}

// newCacheArray returns an array node.
func newCacheArray(items ...cacheValue) cacheValue {
	return cacheValue{Kind: cacheValueArray, Array: items}
}

// newCacheObject returns an object node.
func newCacheObject(fields ...cacheField) cacheValue {
	return cacheValue{Kind: cacheValueObject, Object: fields}
}

// stableSerializeForCache ports stableSerializeForCache. Scalars are serialized
// with encoding/json, arrays keep their order and object keys are sorted.
//
// The NestJS original sorts with localeCompare while this port sorts byte-wise.
// For the ASCII keys this cache ever sees (policy field names, column ids,
// source ids) the two orders are identical. The signature is only required to
// be stable within one Go process pair: NestJS and Go never share this cache key
// space in practice, so byte-identical reproduction of the JavaScript string is
// explicitly not a goal.
func stableSerializeForCache(value cacheValue) string {
	var builder strings.Builder
	writeStableCacheValue(&builder, value)
	return builder.String()
}

// writeStableCacheValue renders one node of the stable serialization.
func writeStableCacheValue(builder *strings.Builder, value cacheValue) {
	switch value.Kind {
	case cacheValueNull:
		builder.WriteString("null")
	case cacheValueScalar:
		builder.Write(value.Scalar)
	case cacheValueArray:
		builder.WriteByte('[')
		for index, item := range value.Array {
			if index > 0 {
				builder.WriteByte(',')
			}
			writeStableCacheValue(builder, item)
		}
		builder.WriteByte(']')
	case cacheValueObject:
		fields := make([]cacheField, len(value.Object))
		copy(fields, value.Object)
		sort.Slice(fields, func(i, j int) bool { return fields[i].Key < fields[j].Key })
		builder.WriteByte('{')
		for index, field := range fields {
			if index > 0 {
				builder.WriteByte(',')
			}
			// json.Marshal cannot fail for a string key; fall back to a JSON
			// null key only to keep the writer total.
			encodedKey, err := json.Marshal(field.Key)
			if err != nil {
				encodedKey = []byte(`""`)
			}
			builder.Write(encodedKey)
			builder.WriteByte(':')
			writeStableCacheValue(builder, field.Value)
		}
		builder.WriteByte('}')
	}
}

// runtimePolicyCacheSignature is the stable serialization of the 10 runtime
// policy fields, listed in the same order as the NestJS object literal (the
// serializer sorts them anyway).
func runtimePolicyCacheSignature(policy PersonalizationPolicy) string {
	return stableSerializeForCache(newCacheObject(
		cacheField{Key: "cacheTtlMs", Value: newCacheInt(policy.CacheTTLMs)},
		cacheField{Key: "maxCacheEntries", Value: newCacheInt(policy.MaxCacheEntries)},
		cacheField{Key: "throttleWindowMs", Value: newCacheInt(policy.ThrottleWindowMs)},
		cacheField{Key: "maxRequestsPerWindowPerUser", Value: newCacheInt(policy.MaxRequestsPerWindowPerUser)},
		cacheField{Key: "affinitySourceWeight", Value: newCacheFloat(policy.AffinitySourceWeight)},
		cacheField{Key: "behaviorSourceWeight", Value: newCacheFloat(policy.BehaviorSourceWeight)},
		cacheField{Key: "focusSourceBonus", Value: newCacheFloat(policy.FocusSourceBonus)},
		cacheField{Key: "staleTtlStrategy", Value: newCacheString(string(policy.StaleTTLStrategy))},
		cacheField{Key: "staleTtlMultiplier", Value: newCacheInt(policy.StaleTTLMultiplier)},
		cacheField{Key: "staleTtlFixedMs", Value: newCacheInt(policy.StaleTTLFixedMs)},
	))
}

// settingsCacheSignature serializes the normalized NewsNow UI settings with the
// six keys the NestJS object produces: focusSources, columnOrders,
// hideCrossSourceDuplicates, sortMode, densityMode and sourceAffinity. The
// nested columnOrders and sourceAffinity objects carry exactly the fields of
// the usersettings port, and the serializer sorts every object key.
func settingsCacheSignature(settings usersettings.NewsnowSettings) string {
	columnOrders := make([]cacheField, 0, len(settings.ColumnOrders))
	for _, pair := range settings.ColumnOrders {
		values := make([]cacheValue, 0, len(pair.Values))
		for _, value := range pair.Values {
			values = append(values, newCacheString(value))
		}
		columnOrders = append(columnOrders, cacheField{Key: pair.Key, Value: newCacheArray(values...)})
	}

	affinities := make([]cacheField, 0, len(settings.SourceAffinity))
	for _, pair := range settings.SourceAffinity {
		affinity := pair.Affinity
		affinities = append(affinities, cacheField{Key: pair.Key, Value: newCacheObject(
			cacheField{Key: "score", Value: newCacheFloat(affinity.Score)},
			cacheField{Key: "openOriginalCount", Value: newCacheInt(affinity.OpenOriginalCount)},
			cacheField{Key: "openEventCount", Value: newCacheInt(affinity.OpenEventCount)},
			cacheField{Key: "openItemCount", Value: newCacheInt(affinity.OpenItemCount)},
			cacheField{Key: "refreshCount", Value: newCacheInt(affinity.RefreshCount)},
			cacheField{Key: "focusCount", Value: newCacheInt(affinity.FocusCount)},
			cacheField{Key: "accumulatedDwellMs", Value: newCacheInt(affinity.AccumulatedDwellMs)},
			cacheField{Key: "lastInteractedAt", Value: newCacheInt(affinity.LastInteractedAt)},
		)})
	}

	focusSources := make([]cacheValue, 0, len(settings.FocusSources))
	for _, sourceID := range settings.FocusSources {
		focusSources = append(focusSources, newCacheString(sourceID))
	}

	return stableSerializeForCache(newCacheObject(
		cacheField{Key: "focusSources", Value: newCacheArray(focusSources...)},
		cacheField{Key: "columnOrders", Value: newCacheObject(columnOrders...)},
		cacheField{Key: "hideCrossSourceDuplicates", Value: newCacheBool(settings.HideCrossSourceDuplicates)},
		cacheField{Key: "sortMode", Value: newCacheString(settings.SortMode)},
		cacheField{Key: "densityMode", Value: newCacheString(settings.DensityMode)},
		cacheField{Key: "sourceAffinity", Value: newCacheObject(affinities...)},
	))
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

// buildPersonalizationCacheKey ports buildPersonalizationCacheKey.
func buildPersonalizationCacheKey(orgID, userID, columnKey string, sourceIDs []string, settingsSignature, runtimePolicySignature string) string {
	return strings.Join([]string{
		orgID,
		userID,
		columnKey,
		strings.Join(sourceIDs, ","),
		settingsSignature,
		runtimePolicySignature,
	}, "|")
}

// hashPersonalizationCacheKey ports hashPersonalizationCacheKey (sha1 hex).
func hashPersonalizationCacheKey(cacheKey string) string {
	sum := sha1.Sum([]byte(cacheKey))
	return hex.EncodeToString(sum[:])
}

// buildPersonalizationRedisFreshCacheKey ports
// buildPersonalizationRedisFreshCacheKey.
func buildPersonalizationRedisFreshCacheKey(cacheToken string) string {
	return fmt.Sprintf("%s:fresh:%s", personalizationCacheKeyPrefix, cacheToken)
}

// buildPersonalizationRedisStaleCacheKey ports
// buildPersonalizationRedisStaleCacheKey.
func buildPersonalizationRedisStaleCacheKey(cacheToken string) string {
	return fmt.Sprintf("%s:stale:%s", personalizationCacheKeyPrefix, cacheToken)
}

// msToTTLSeconds ports msToTtlSeconds: max(1, ceil(ms / 1000)).
func msToTTLSeconds(ms int) int {
	return int(math.Max(1, math.Ceil(float64(ms)/1000)))
}

// ---------------------------------------------------------------------------
// Redis cache
// ---------------------------------------------------------------------------

// getPersonalizationCachePayload ports getPersonalizationCachePayload: a cache
// miss (redis.Nil) is not an error, and any transport or decode failure is
// logged and treated as a miss.
func (s *SourceOrderingService) getPersonalizationCachePayload(ctx context.Context, key string) *PersonalizedOrderPayload {
	if s == nil || s.redis == nil {
		return nil
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil
	}
	if err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache read failed for %q: %v", key, err)
		return nil
	}
	var payload PersonalizedOrderPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache decode failed for %q: %v", key, err)
		return nil
	}
	return &payload
}

// cachePersonalizationResponseIfEnabled ports
// cachePersonalizationResponseIfEnabled: write the fresh and stale entries plus
// the index entry, then trim the index. Every failure is logged and swallowed.
func (s *SourceOrderingService) cachePersonalizationResponseIfEnabled(ctx context.Context, cacheToken string, payload PersonalizedOrderPayload, policy PersonalizationPolicy) {
	if policy.CacheTTLMs <= 0 {
		return
	}
	if s == nil || s.redis == nil {
		return
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache encode failed for token %q: %v", cacheToken, err)
		return
	}

	freshKey := buildPersonalizationRedisFreshCacheKey(cacheToken)
	staleKey := buildPersonalizationRedisStaleCacheKey(cacheToken)
	freshTTL := time.Duration(msToTTLSeconds(policy.CacheTTLMs)) * time.Second
	staleTTL := time.Duration(msToTTLSeconds(policy.ResolveStaleTTLMs())) * time.Second

	// A pipeline mirrors the NestJS Promise.all: all four commands run and the
	// first failure aborts the trim.
	pipeline := s.redis.Pipeline()
	pipeline.Set(ctx, freshKey, encoded, freshTTL)
	pipeline.Set(ctx, staleKey, encoded, staleTTL)
	pipeline.ZAdd(ctx, personalizationCacheIndexKey, redis.Z{Score: float64(s.nowMillis()), Member: cacheToken})
	pipeline.Expire(ctx, personalizationCacheIndexKey, personalizationCacheIndexTTL)
	if _, err := pipeline.Exec(ctx); err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache write failed for token %q: %v", cacheToken, err)
		return
	}

	s.trimPersonalizationCache(ctx, policy.MaxCacheEntries)
}

// trimPersonalizationCache ports trimPersonalizationCache: when the index holds
// more than maxCacheEntries tokens, drop the oldest
// min(max(1, overflow), 200) tokens and delete their fresh and stale keys.
func (s *SourceOrderingService) trimPersonalizationCache(ctx context.Context, maxCacheEntries int) {
	maxEntries := max(1, maxCacheEntries)
	size, err := s.redis.ZCard(ctx, personalizationCacheIndexKey).Result()
	if err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache index size read failed: %v", err)
		return
	}
	if size <= int64(maxEntries) {
		return
	}

	overflow := int(size) - maxEntries
	trimCount := min(max(1, overflow), personalizationMaxCacheTrimBatch)

	evictTokens, err := s.redis.ZRange(ctx, personalizationCacheIndexKey, 0, int64(trimCount-1)).Result()
	if err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache index scan failed: %v", err)
		return
	}
	if len(evictTokens) == 0 {
		return
	}

	pipeline := s.redis.Pipeline()
	for _, cacheToken := range evictTokens {
		pipeline.ZRem(ctx, personalizationCacheIndexKey, cacheToken)
		pipeline.Del(ctx,
			buildPersonalizationRedisFreshCacheKey(cacheToken),
			buildPersonalizationRedisStaleCacheKey(cacheToken),
		)
	}
	if _, err := pipeline.Exec(ctx); err != nil {
		log.Printf("newsnow-clustering-ops: personalization cache trim failed: %v", err)
		return
	}

	s.policy.RecordPersonalizationMetrics(ctx, PersonalizationMetricIncrements{
		TrimCount:        1,
		TrimEvictedCount: len(evictTokens),
	})
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

// consumePersonalizationThrottle ports consumePersonalizationThrottle:
// windowSeconds = max(1, ceil(windowMs / 1000)) and the rate key
// news-aggregator:personalization:throttle:<orgId>:<userId>.
//
// Redis failures fail open (return true). The NestJS RateLimiterService defaults
// RATE_LIMIT_REDIS_FAIL_OPEN to false; this port always fails open, as required
// by the task contract, and does not port the Redis circuit breaker or the
// RATE_LIMIT_REDIS_* tuning knobs.
func (s *SourceOrderingService) consumePersonalizationThrottle(ctx context.Context, key string, windowMs, limit int) bool {
	if limit <= 0 || windowMs <= 0 {
		return true
	}
	if s == nil || s.redis == nil {
		return true
	}

	windowSeconds := max(1, int(math.Ceil(float64(windowMs)/1000)))
	rateKey := fmt.Sprintf("%s:%s", personalizationRateLimitPrefix, key)
	allowed, err := s.consumeSlidingWindow(ctx, "rate:"+rateKey, windowSeconds, limit)
	if err != nil {
		log.Printf("newsnow-clustering-ops: personalization throttle failed for %q: %v", rateKey, err)
		return true
	}
	return allowed
}

// consumeSlidingWindow runs the ported Lua script with the NestJS argument
// order.
func (s *SourceOrderingService) consumeSlidingWindow(ctx context.Context, bucketKey string, windowSeconds, limit int) (bool, error) {
	now := s.nowMillis()
	ttlSeconds := max(int(math.Ceil(float64(windowSeconds)*2)), 1)
	result, err := throttleScript.Run(
		ctx,
		s.redis,
		[]string{bucketKey, bucketKey + ":seq"},
		now,
		int64(windowSeconds)*1000,
		limit,
		ttlSeconds,
		throttleCleanupLimit,
		throttleCleanupThreshold,
	).Slice()
	if err != nil {
		return false, err
	}
	if len(result) == 0 {
		return false, errors.New("newsnow-clustering-ops: personalization throttle returned an empty reply")
	}
	allowed, ok := result[0].(int64)
	if !ok {
		return false, fmt.Errorf("newsnow-clustering-ops: personalization throttle returned %T", result[0])
	}
	return allowed == 1, nil
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

// currentTime returns the injected clock value, falling back to time.Now for a
// zero-value service.
func (s *SourceOrderingService) currentTime() time.Time {
	if s == nil || s.now == nil {
		return time.Now()
	}
	return s.now()
}

// nowMillis is Date.now().
func (s *SourceOrderingService) nowMillis() int64 {
	return s.currentTime().UnixMilli()
}

// computedAt is the Date.toISOString() equivalent: RFC3339 with exactly three
// fractional digits in UTC.
func (s *SourceOrderingService) computedAt() string {
	return s.currentTime().UTC().Format("2006-01-02T15:04:05.000Z")
}
