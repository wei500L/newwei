package settingscrawl

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// settingsReader serves the settings-center Query roots that read their
// configuration from the SystemSetting table.
//
// Every stored document is decoded into a named struct whose fields are
// json.RawMessage and then coerced with the JavaScript-compatible helpers in
// settingvalue.go. The reader carries no cache state: the package store exposes
// Redis reads only for the source-policy sync-status comparison, and the value
// these roots return is fully determined by the normalized stored document,
// which is exactly the NestJS cache-miss result.
type settingsReader struct {
	s *store
}

// ---------------------------------------------------------------------------
// Root 1 - rateLimitSettings
// ---------------------------------------------------------------------------

// Global rate limit bucket bounds, copied from rate-limit-config.service.ts.
const (
	rateLimitMinLimit         = 1
	rateLimitMaxLimit         = 1000
	rateLimitMinWindowSeconds = 5
	rateLimitMaxWindowSeconds = 86400
)

// The three global SystemSetting primary keys of the rate limit buckets.
const (
	rateLimitLoginKey       = "rate_limit_login"
	rateLimitCrawlCreateKey = "rate_limit_crawl_create"
	rateLimitRbacWriteKey   = "rate_limit_rbac_write"
)

// rateLimitBucketDocument is the stored value of one rate_limit_* row:
// { limit, windowSeconds }.
type rateLimitBucketDocument struct {
	Limit         json.RawMessage `json:"limit"`
	WindowSeconds json.RawMessage `json:"windowSeconds"`
}

// defaultRateLimitSettings is getFallbackSettings: the raw environment buckets,
// which the whole-bucket-missing path returns without clamping.
func defaultRateLimitSettings() RateLimitSettingsModel {
	return RateLimitSettingsModel{
		Login: RateLimitBucketModel{
			Limit:         defaultRateLimitLoginLimit,
			WindowSeconds: defaultRateLimitLoginWindow,
		},
		CrawlCreate: RateLimitBucketModel{
			Limit:         defaultRateLimitCrawlLimit,
			WindowSeconds: defaultRateLimitCrawlWindow,
		},
		RbacWrite: RateLimitBucketModel{
			Limit:         defaultRateLimitRbacLimit,
			WindowSeconds: defaultRateLimitRbacWindow,
		},
	}
}

// rateLimitSettings implements the rateLimitSettings Query root.
//
// The caller must be a system administrator. The three global rows are read
// individually; a MySQL failure on any of them degrades the whole result to the
// raw environment fallback, because RateLimitConfigService never throws from its
// read path.
func (r *settingsReader) rateLimitSettings(ctx context.Context, identity contract.Identity) (RateLimitSettingsModel, error) {
	if err := r.s.assertSystemAdmin(ctx, identity); err != nil {
		return RateLimitSettingsModel{}, err
	}
	fallback := defaultRateLimitSettings()
	// The three global rows are read one by one. A MySQL failure degrades to the
	// raw environment fallback because RateLimitConfigService never throws from
	// its read path.
	rows := make(map[string][]byte, 3)
	for _, key := range []string{rateLimitLoginKey, rateLimitCrawlCreateKey, rateLimitRbacWriteKey} {
		value, found, err := r.s.selectSetting(ctx, key)
		if err != nil {
			return fallback, nil
		}
		if found {
			rows[key] = value
		}
	}
	return RateLimitSettingsModel{
		Login:       normalizeRateLimitBucket(rows[rateLimitLoginKey], fallback.Login),
		CrawlCreate: normalizeRateLimitBucket(rows[rateLimitCrawlCreateKey], fallback.CrawlCreate),
		RbacWrite:   normalizeRateLimitBucket(rows[rateLimitRbacWriteKey], fallback.RbacWrite),
	}, nil
}

// normalizeRateLimitBucket mirrors normalizeBucket(value, fallback).
//
// A missing, non-object or unparsable value keeps the raw environment fallback
// untouched. A JavaScript array is an object without these properties, so it
// normalizes to the clamped minimum instead. A present bucket object is coerced
// with Number() (an absent key yields NaN), floored with Math.floor (NOT
// rounded) and clamped to the bucket bounds, so a NaN limit becomes the minimum
// rather than the environment default.
func normalizeRateLimitBucket(raw []byte, fallback RateLimitBucketModel) RateLimitBucketModel {
	value := json.RawMessage(raw)
	if !settingIsObject(value) {
		if settingIsArray(value) {
			return RateLimitBucketModel{
				Limit:         rateLimitMinLimit,
				WindowSeconds: rateLimitMinWindowSeconds,
			}
		}
		return fallback
	}
	var document rateLimitBucketDocument
	if err := json.Unmarshal(value, &document); err != nil {
		return fallback
	}
	return RateLimitBucketModel{
		Limit: int(clampFloatBounds(
			jsFloor(settingNumberOrNaN(document.Limit)),
			rateLimitMinLimit,
			rateLimitMaxLimit,
		)),
		WindowSeconds: int(clampFloatBounds(
			jsFloor(settingNumberOrNaN(document.WindowSeconds)),
			rateLimitMinWindowSeconds,
			rateLimitMaxWindowSeconds,
		)),
	}
}

// ---------------------------------------------------------------------------
// Root 2 - entityImpactGraphSettings
// ---------------------------------------------------------------------------

// entityImpactGraphSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const entityImpactGraphSettingsKeyPrefix = "entity_impact_graph_settings:"

// entityImpactAllowedCategories is ALLOWED_CATEGORIES, the only category slugs
// a stored taxonomy may keep.
var entityImpactAllowedCategories = []string{"person", "organization", "stock", "commodity"}

// entityImpactGraphSettingsDocument is the stored
// entity_impact_graph_settings:<orgId> payload.
type entityImpactGraphSettingsDocument struct {
	Enabled             json.RawMessage `json:"enabled"`
	MinEntityConfidence json.RawMessage `json:"minEntityConfidence"`
	MinCorrelation      json.RawMessage `json:"minCorrelation"`
	MinCoOccurrence     json.RawMessage `json:"minCoOccurrence"`
	MaxNodes            json.RawMessage `json:"maxNodes"`
	Categories          json.RawMessage `json:"categories"`
	CacheTTLSeconds     json.RawMessage `json:"cacheTtlSeconds"`
}

// defaultEntityImpactGraphSettings is getFallbackSettings.
func defaultEntityImpactGraphSettings() EntityImpactGraphSettingsModel {
	return EntityImpactGraphSettingsModel{
		Enabled:             true,
		MinEntityConfidence: 0.5,
		MinCorrelation:      0.3,
		MinCoOccurrence:     2,
		MaxNodes:            100,
		Categories:          append([]string(nil), entityImpactAllowedCategories...),
		CacheTTLSeconds:     60,
	}
}

// entityImpactGraphSettings implements the entityImpactGraphSettings Query root.
//
// It has no administrator gate: the registry enforces the dashboards.read
// permission. A MySQL failure or a missing row degrades to the defaults.
func (r *settingsReader) entityImpactGraphSettings(ctx context.Context, orgID string) (EntityImpactGraphSettingsModel, error) {
	fallback := defaultEntityImpactGraphSettings()
	raw, found, err := r.s.selectSetting(ctx, entityImpactGraphSettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeEntityImpactGraphSettings(raw, fallback), nil
}

// normalizeEntityImpactGraphSettings mirrors normalizeSettings(value, defaults).
//
// This service's toNumber has no empty-string guard: Number("") === 0, so an
// empty string parses to zero and is then clamped instead of falling back.
func normalizeEntityImpactGraphSettings(raw []byte, fallback EntityImpactGraphSettingsModel) EntityImpactGraphSettingsModel {
	value := json.RawMessage(raw)
	var document entityImpactGraphSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = entityImpactGraphSettingsDocument{}
		}
	}
	return EntityImpactGraphSettingsModel{
		Enabled: settingBool(document.Enabled, fallback.Enabled),
		MinEntityConfidence: clampFloatBounds(
			settingNumberLenient(document.MinEntityConfidence, fallback.MinEntityConfidence), 0, 1),
		MinCorrelation: clampFloatBounds(
			settingNumberLenient(document.MinCorrelation, fallback.MinCorrelation), 0, 1),
		MinCoOccurrence: clampIntRounded(
			settingNumberLenient(document.MinCoOccurrence, float64(fallback.MinCoOccurrence)), 1, 100),
		MaxNodes: clampIntRounded(
			settingNumberLenient(document.MaxNodes, float64(fallback.MaxNodes)), 10, 500),
		Categories: normalizeEntityImpactCategories(document.Categories, fallback.Categories),
		CacheTTLSeconds: clampIntRounded(
			settingNumberLenient(document.CacheTTLSeconds, float64(fallback.CacheTTLSeconds)), 0, 3600),
	}
}

// normalizeEntityImpactCategories mirrors normalizeCategories: a non-array value
// falls back; otherwise every entry is trimmed and lowercased, entries outside
// ALLOWED_CATEGORIES are dropped, duplicates collapse while preserving the first
// occurrence order, and an empty result falls back.
func normalizeEntityImpactCategories(raw json.RawMessage, fallback []string) []string {
	if !settingIsArray(raw) {
		return append([]string(nil), fallback...)
	}
	entries, ok := settingStringList(raw)
	if !ok {
		return append([]string(nil), fallback...)
	}
	out := make([]string, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		candidate := strings.ToLower(strings.TrimSpace(entry))
		if !isEntityImpactCategory(candidate) {
			continue
		}
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		out = append(out, candidate)
	}
	if len(out) == 0 {
		return append([]string(nil), fallback...)
	}
	return out
}

// isEntityImpactCategory reports whether slug is one of ALLOWED_CATEGORIES.
func isEntityImpactCategory(slug string) bool {
	for _, allowed := range entityImpactAllowedCategories {
		if slug == allowed {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Root 3 - knowledgeGraphSettings
// ---------------------------------------------------------------------------

// knowledgeGraphSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const knowledgeGraphSettingsKeyPrefix = "knowledge_graph_settings:"

// knowledgeGraphSettingsDocument is the stored
// knowledge_graph_settings:<orgId> payload.
type knowledgeGraphSettingsDocument struct {
	Enabled                                    json.RawMessage `json:"enabled"`
	IngestionEnabled                           json.RawMessage `json:"ingestionEnabled"`
	MaxBatchSize                               json.RawMessage `json:"maxBatchSize"`
	MaxRelationsPerArticle                     json.RawMessage `json:"maxRelationsPerArticle"`
	MinEdgeConfidence                          json.RawMessage `json:"minEdgeConfidence"`
	DynamicEdgeConfidenceEnabled               json.RawMessage `json:"dynamicEdgeConfidenceEnabled"`
	DynamicEdgeConfidenceQuantile              json.RawMessage `json:"dynamicEdgeConfidenceQuantile"`
	MultiModelValidationEnabled                json.RawMessage `json:"multiModelValidationEnabled"`
	MultiModelValidationModels                 json.RawMessage `json:"multiModelValidationModels"`
	MultiModelValidationModelCount             json.RawMessage `json:"multiModelValidationModelCount"`
	MultiModelValidationMaxRelationsPerArticle json.RawMessage `json:"multiModelValidationMaxRelationsPerArticle"`
	EntityDisambiguationEnabled                json.RawMessage `json:"entityDisambiguationEnabled"`
	EntityDisambiguationMaxCandidates          json.RawMessage `json:"entityDisambiguationMaxCandidates"`
	CacheTTLSeconds                            json.RawMessage `json:"cacheTtlSeconds"`
}

// knowledgeGraphBootstrapDocument is the exact JSON document the read-time
// bootstrap writes: getFallbackSettings with enabled and ingestionEnabled
// forced to true. It is a separate named struct so json.Marshal emits the same
// camelCase keys NestJS persists (the GraphQL model only carries graphql tags).
type knowledgeGraphBootstrapDocument struct {
	Enabled                                    bool     `json:"enabled"`
	IngestionEnabled                           bool     `json:"ingestionEnabled"`
	MaxBatchSize                               int      `json:"maxBatchSize"`
	MaxRelationsPerArticle                     int      `json:"maxRelationsPerArticle"`
	MinEdgeConfidence                          float64  `json:"minEdgeConfidence"`
	DynamicEdgeConfidenceEnabled               bool     `json:"dynamicEdgeConfidenceEnabled"`
	DynamicEdgeConfidenceQuantile              float64  `json:"dynamicEdgeConfidenceQuantile"`
	MultiModelValidationEnabled                bool     `json:"multiModelValidationEnabled"`
	MultiModelValidationModels                 []string `json:"multiModelValidationModels"`
	MultiModelValidationModelCount             int      `json:"multiModelValidationModelCount"`
	MultiModelValidationMaxRelationsPerArticle int      `json:"multiModelValidationMaxRelationsPerArticle"`
	EntityDisambiguationEnabled                bool     `json:"entityDisambiguationEnabled"`
	EntityDisambiguationMaxCandidates          int      `json:"entityDisambiguationMaxCandidates"`
	CacheTTLSeconds                            int      `json:"cacheTtlSeconds"`
}

// defaultKnowledgeGraphSettings is getFallbackSettings.
func defaultKnowledgeGraphSettings() KnowledgeGraphSettingsModel {
	return KnowledgeGraphSettingsModel{
		Enabled:                                    false,
		IngestionEnabled:                           false,
		MaxBatchSize:                               100,
		MaxRelationsPerArticle:                     20,
		MinEdgeConfidence:                          0.55,
		DynamicEdgeConfidenceEnabled:               true,
		DynamicEdgeConfidenceQuantile:              0.25,
		MultiModelValidationEnabled:                false,
		MultiModelValidationModels:                 []string{},
		MultiModelValidationModelCount:             3,
		MultiModelValidationMaxRelationsPerArticle: 5,
		EntityDisambiguationEnabled:                false,
		EntityDisambiguationMaxCandidates:          5,
		CacheTTLSeconds:                            60,
	}
}

// newKnowledgeGraphBootstrapDocument converts the bootstrap model into its
// persisted JSON shape.
func newKnowledgeGraphBootstrapDocument(settings KnowledgeGraphSettingsModel) knowledgeGraphBootstrapDocument {
	return knowledgeGraphBootstrapDocument{
		Enabled:                                    settings.Enabled,
		IngestionEnabled:                           settings.IngestionEnabled,
		MaxBatchSize:                               settings.MaxBatchSize,
		MaxRelationsPerArticle:                     settings.MaxRelationsPerArticle,
		MinEdgeConfidence:                          settings.MinEdgeConfidence,
		DynamicEdgeConfidenceEnabled:               settings.DynamicEdgeConfidenceEnabled,
		DynamicEdgeConfidenceQuantile:              settings.DynamicEdgeConfidenceQuantile,
		MultiModelValidationEnabled:                settings.MultiModelValidationEnabled,
		MultiModelValidationModels:                 settings.MultiModelValidationModels,
		MultiModelValidationModelCount:             settings.MultiModelValidationModelCount,
		MultiModelValidationMaxRelationsPerArticle: settings.MultiModelValidationMaxRelationsPerArticle,
		EntityDisambiguationEnabled:                settings.EntityDisambiguationEnabled,
		EntityDisambiguationMaxCandidates:          settings.EntityDisambiguationMaxCandidates,
		CacheTTLSeconds:                            settings.CacheTTLSeconds,
	}
}

// knowledgeGraphSettings implements the knowledgeGraphSettings Query root.
//
// It has no administrator gate. A MySQL failure degrades to the disabled
// fallback. A missing row is bootstrapped: the fallback with enabled and
// ingestionEnabled set to true is marshaled and inserted with an
// insert-if-absent statement, and the normalized bootstrap is returned even if
// that insert fails (the failure is only logged).
func (r *settingsReader) knowledgeGraphSettings(ctx context.Context, orgID string) (KnowledgeGraphSettingsModel, error) {
	fallback := defaultKnowledgeGraphSettings()
	key := knowledgeGraphSettingsKeyPrefix + orgID
	raw, found, err := r.s.selectSetting(ctx, key)
	if err != nil {
		return fallback, nil
	}
	if found {
		return normalizeKnowledgeGraphSettings(raw, fallback), nil
	}

	bootstrap := fallback
	bootstrap.Enabled = true
	bootstrap.IngestionEnabled = true
	payload, marshalErr := json.Marshal(newKnowledgeGraphBootstrapDocument(bootstrap))
	if marshalErr != nil {
		log.Printf("settingscrawl: marshal knowledge graph bootstrap for %q: %v", key, marshalErr)
		return bootstrap, nil
	}
	if upsertErr := r.s.upsertSettingIfAbsent(
		ctx, key, payload, "Knowledge graph settings (org="+orgID+")",
	); upsertErr != nil {
		log.Printf("settingscrawl: bootstrap knowledge graph settings %q: %v", key, upsertErr)
	}
	// The persisted payload is normalized before it is returned, mirroring
	// loadSettings normalizing the row it just upserted.
	return normalizeKnowledgeGraphSettings(payload, fallback), nil
}

// normalizeKnowledgeGraphSettings mirrors normalizeSettings(value, defaults).
//
// This service's toNumber trims a string and rejects it when it becomes empty
// (unlike entity-impact, where "" parses to zero), so settingNumber is used.
func normalizeKnowledgeGraphSettings(raw []byte, fallback KnowledgeGraphSettingsModel) KnowledgeGraphSettingsModel {
	value := json.RawMessage(raw)
	var document knowledgeGraphSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = knowledgeGraphSettingsDocument{}
		}
	}
	return KnowledgeGraphSettingsModel{
		Enabled:          settingBool(document.Enabled, fallback.Enabled),
		IngestionEnabled: settingBool(document.IngestionEnabled, fallback.IngestionEnabled),
		MaxBatchSize: clampIntRounded(
			settingNumber(document.MaxBatchSize, float64(fallback.MaxBatchSize)), 1, 500),
		MaxRelationsPerArticle: clampIntRounded(
			settingNumber(document.MaxRelationsPerArticle, float64(fallback.MaxRelationsPerArticle)), 0, 100),
		MinEdgeConfidence: clampFloatBounds(
			settingNumber(document.MinEdgeConfidence, fallback.MinEdgeConfidence), 0, 1),
		DynamicEdgeConfidenceEnabled: settingBool(
			document.DynamicEdgeConfidenceEnabled, fallback.DynamicEdgeConfidenceEnabled),
		DynamicEdgeConfidenceQuantile: clampFloatBounds(
			settingNumber(document.DynamicEdgeConfidenceQuantile, fallback.DynamicEdgeConfidenceQuantile), 0, 1),
		MultiModelValidationEnabled: settingBool(
			document.MultiModelValidationEnabled, fallback.MultiModelValidationEnabled),
		MultiModelValidationModels: normalizeKnowledgeGraphStringList(
			document.MultiModelValidationModels, fallback.MultiModelValidationModels),
		MultiModelValidationModelCount: clampIntRounded(
			settingNumber(document.MultiModelValidationModelCount, float64(fallback.MultiModelValidationModelCount)), 2, 3),
		MultiModelValidationMaxRelationsPerArticle: clampIntRounded(
			settingNumber(document.MultiModelValidationMaxRelationsPerArticle,
				float64(fallback.MultiModelValidationMaxRelationsPerArticle)), 0, 20),
		EntityDisambiguationEnabled: settingBool(
			document.EntityDisambiguationEnabled, fallback.EntityDisambiguationEnabled),
		EntityDisambiguationMaxCandidates: clampIntRounded(
			settingNumber(document.EntityDisambiguationMaxCandidates,
				float64(fallback.EntityDisambiguationMaxCandidates)), 2, 20),
		CacheTTLSeconds: clampIntRounded(
			settingNumber(document.CacheTTLSeconds, float64(fallback.CacheTTLSeconds)), 0, 3600),
	}
}

// normalizeKnowledgeGraphStringList mirrors normalizeStringList: a non-array
// value is empty; string entries are trimmed, empties dropped and duplicates
// collapsed in first-occurrence order, then capped at ten; an empty result
// falls back.
func normalizeKnowledgeGraphStringList(raw json.RawMessage, fallback []string) []string {
	out := []string{}
	if settingIsArray(raw) {
		entries, _ := settingStringList(raw)
		seen := make(map[string]bool, len(entries))
		for _, entry := range entries {
			trimmed := strings.TrimSpace(entry)
			if trimmed == "" || seen[trimmed] {
				continue
			}
			seen[trimmed] = true
			out = append(out, trimmed)
			if len(out) == 10 {
				break
			}
		}
	}
	if len(out) == 0 {
		return append([]string{}, fallback...)
	}
	return out
}

// ---------------------------------------------------------------------------
// Root 4 - newsEventSettings
// ---------------------------------------------------------------------------

// newsEventSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const newsEventSettingsKeyPrefix = "news_event_settings:"

// newsEventSettingsDocument is the stored news_event_settings:<orgId> payload.
type newsEventSettingsDocument struct {
	Enabled                               json.RawMessage `json:"enabled"`
	IngestionEnabled                      json.RawMessage `json:"ingestionEnabled"`
	TimelineEnabled                       json.RawMessage `json:"timelineEnabled"`
	ClusteringMode                        json.RawMessage `json:"clusteringMode"`
	BertopicMinItemsPerGroup              json.RawMessage `json:"bertopicMinItemsPerGroup"`
	BertopicMaxItemsPerRequest            json.RawMessage `json:"bertopicMaxItemsPerRequest"`
	BertopicMinTopicSize                  json.RawMessage `json:"bertopicMinTopicSize"`
	ForceAuthoritativeMode                json.RawMessage `json:"forceAuthoritativeMode"`
	ForceMinAuthoritativeSources          json.RawMessage `json:"forceMinAuthoritativeSources"`
	MaxBatchSize                          json.RawMessage `json:"maxBatchSize"`
	BackfillDays                          json.RawMessage `json:"backfillDays"`
	LookbackDays                          json.RawMessage `json:"lookbackDays"`
	TimelineMaxEventsPerRun               json.RawMessage `json:"timelineMaxEventsPerRun"`
	VectorMinScore                        json.RawMessage `json:"vectorMinScore"`
	CrossLanguagePenalty                  json.RawMessage `json:"crossLanguagePenalty"`
	ClassificationGateEnabled             json.RawMessage `json:"classificationGateEnabled"`
	CategoryConflictReject                json.RawMessage `json:"categoryConflictReject"`
	CategorySoftPenalty                   json.RawMessage `json:"categorySoftPenalty"`
	MinCategoryConfidenceForGate          json.RawMessage `json:"minCategoryConfidenceForGate"`
	TimelineLowConfidenceThreshold        json.RawMessage `json:"timelineLowConfidenceThreshold"`
	TimelineHighConfidenceThreshold       json.RawMessage `json:"timelineHighConfidenceThreshold"`
	TimelineDriftKlThreshold              json.RawMessage `json:"timelineDriftKlThreshold"`
	TimelineMinBucketItemsForDrift        json.RawMessage `json:"timelineMinBucketItemsForDrift"`
	TimelineCrossCategoryWarningShare     json.RawMessage `json:"timelineCrossCategoryWarningShare"`
	TimelineMaxCategoryDistributionItems  json.RawMessage `json:"timelineMaxCategoryDistributionItems"`
	TimelineMaxPhaseSummaries             json.RawMessage `json:"timelineMaxPhaseSummaries"`
	TimelinePresetCustomDistanceThreshold json.RawMessage `json:"timelinePresetCustomDistanceThreshold"`
	CacheTTLSeconds                       json.RawMessage `json:"cacheTtlSeconds"`
}

// defaultNewsEventSettings is getFallbackSettings.
func defaultNewsEventSettings() NewsEventSettingsModel {
	return NewsEventSettingsModel{
		Enabled:                               false,
		IngestionEnabled:                      false,
		TimelineEnabled:                       true,
		ClusteringMode:                        NewsEventClusteringModeVector,
		BertopicMinItemsPerGroup:              8,
		BertopicMaxItemsPerRequest:            32,
		BertopicMinTopicSize:                  4,
		ForceAuthoritativeMode:                false,
		ForceMinAuthoritativeSources:          1,
		MaxBatchSize:                          100,
		BackfillDays:                          30,
		LookbackDays:                          30,
		TimelineMaxEventsPerRun:               50,
		VectorMinScore:                        0.82,
		CrossLanguagePenalty:                  0.1,
		ClassificationGateEnabled:             true,
		CategoryConflictReject:                true,
		CategorySoftPenalty:                   0.15,
		MinCategoryConfidenceForGate:          0.4,
		TimelineLowConfidenceThreshold:        0.5,
		TimelineHighConfidenceThreshold:       0.8,
		TimelineDriftKlThreshold:              0.35,
		TimelineMinBucketItemsForDrift:        3,
		TimelineCrossCategoryWarningShare:     0.3,
		TimelineMaxCategoryDistributionItems:  16,
		TimelineMaxPhaseSummaries:             8,
		TimelinePresetCustomDistanceThreshold: 0.22,
		CacheTTLSeconds:                       60,
	}
}

// newsEventSettings implements the newsEventSettings Query root.
//
// It has no administrator gate. A MySQL failure or a missing row degrades to
// the defaults.
func (r *settingsReader) newsEventSettings(ctx context.Context, orgID string) (NewsEventSettingsModel, error) {
	fallback := defaultNewsEventSettings()
	raw, found, err := r.s.selectSetting(ctx, newsEventSettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeNewsEventSettings(raw, fallback), nil
}

// normalizeNewsEventSettings mirrors normalizeSettings(value, defaults).
//
// Two values are computed from pairs before the literal: the timeline
// confidence thresholds are swapped so low <= high (independent of which stored
// key held which value), and bertopicMaxItemsPerRequest is forced to at least
// bertopicMinItemsPerGroup.
func normalizeNewsEventSettings(raw []byte, fallback NewsEventSettingsModel) NewsEventSettingsModel {
	value := json.RawMessage(raw)
	var document newsEventSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = newsEventSettingsDocument{}
		}
	}

	bertopicMinItemsPerGroup := clampIntRounded(
		settingNumber(document.BertopicMinItemsPerGroup, float64(fallback.BertopicMinItemsPerGroup)), 2, 100)
	bertopicMaxItemsPerRequest := clampIntRounded(
		settingNumber(document.BertopicMaxItemsPerRequest, float64(fallback.BertopicMaxItemsPerRequest)), 2, 500)
	if bertopicMaxItemsPerRequest < bertopicMinItemsPerGroup {
		bertopicMaxItemsPerRequest = bertopicMinItemsPerGroup
	}

	rawLow := clampFloatBounds(
		settingNumber(document.TimelineLowConfidenceThreshold, fallback.TimelineLowConfidenceThreshold), 0, 1)
	rawHigh := clampFloatBounds(
		settingNumber(document.TimelineHighConfidenceThreshold, fallback.TimelineHighConfidenceThreshold), 0, 1)
	// The min/max confidence swap: a stored pair in either order yields the
	// same normalized low/high pair.
	timelineLow := rawLow
	timelineHigh := rawHigh
	if timelineHigh < timelineLow {
		timelineLow, timelineHigh = timelineHigh, timelineLow
	}

	return NewsEventSettingsModel{
		Enabled:                         settingBool(document.Enabled, fallback.Enabled),
		IngestionEnabled:                settingBool(document.IngestionEnabled, fallback.IngestionEnabled),
		TimelineEnabled:                 settingBool(document.TimelineEnabled, fallback.TimelineEnabled),
		ClusteringMode:                  normalizeNewsEventClusteringMode(document.ClusteringMode, fallback.ClusteringMode),
		BertopicMinItemsPerGroup:        bertopicMinItemsPerGroup,
		BertopicMaxItemsPerRequest:      bertopicMaxItemsPerRequest,
		BertopicMinTopicSize:            clampIntRounded(settingNumber(document.BertopicMinTopicSize, float64(fallback.BertopicMinTopicSize)), 2, 100),
		ForceAuthoritativeMode:          settingBool(document.ForceAuthoritativeMode, fallback.ForceAuthoritativeMode),
		ForceMinAuthoritativeSources:    clampIntRounded(settingNumber(document.ForceMinAuthoritativeSources, float64(fallback.ForceMinAuthoritativeSources)), 1, 5),
		MaxBatchSize:                    clampIntRounded(settingNumber(document.MaxBatchSize, float64(fallback.MaxBatchSize)), 1, 500),
		BackfillDays:                    clampIntRounded(settingNumber(document.BackfillDays, float64(fallback.BackfillDays)), 1, 365),
		LookbackDays:                    clampIntRounded(settingNumber(document.LookbackDays, float64(fallback.LookbackDays)), 1, 180),
		TimelineMaxEventsPerRun:         clampIntRounded(settingNumber(document.TimelineMaxEventsPerRun, float64(fallback.TimelineMaxEventsPerRun)), 1, 200),
		VectorMinScore:                  clampFloatBounds(settingNumber(document.VectorMinScore, fallback.VectorMinScore), 0, 1),
		CrossLanguagePenalty:            clampFloatBounds(settingNumber(document.CrossLanguagePenalty, fallback.CrossLanguagePenalty), 0, 1),
		ClassificationGateEnabled:       settingBool(document.ClassificationGateEnabled, fallback.ClassificationGateEnabled),
		CategoryConflictReject:          settingBool(document.CategoryConflictReject, fallback.CategoryConflictReject),
		CategorySoftPenalty:             clampFloatBounds(settingNumber(document.CategorySoftPenalty, fallback.CategorySoftPenalty), 0, 1),
		MinCategoryConfidenceForGate:    clampFloatBounds(settingNumber(document.MinCategoryConfidenceForGate, fallback.MinCategoryConfidenceForGate), 0, 1),
		TimelineLowConfidenceThreshold:  timelineLow,
		TimelineHighConfidenceThreshold: timelineHigh,
		TimelineDriftKlThreshold:        clampFloatBounds(settingNumber(document.TimelineDriftKlThreshold, fallback.TimelineDriftKlThreshold), 0, 5),
		TimelineMinBucketItemsForDrift: clampIntRounded(
			settingNumber(document.TimelineMinBucketItemsForDrift, float64(fallback.TimelineMinBucketItemsForDrift)), 1, 50),
		TimelineCrossCategoryWarningShare: clampFloatBounds(
			settingNumber(document.TimelineCrossCategoryWarningShare, fallback.TimelineCrossCategoryWarningShare), 0, 1),
		TimelineMaxCategoryDistributionItems: clampIntRounded(
			settingNumber(document.TimelineMaxCategoryDistributionItems,
				float64(fallback.TimelineMaxCategoryDistributionItems)), 4, 64),
		TimelineMaxPhaseSummaries: clampIntRounded(
			settingNumber(document.TimelineMaxPhaseSummaries, float64(fallback.TimelineMaxPhaseSummaries)), 1, 20),
		TimelinePresetCustomDistanceThreshold: clampFloatBounds(
			settingNumber(document.TimelinePresetCustomDistanceThreshold, fallback.TimelinePresetCustomDistanceThreshold), 0, 7),
		CacheTTLSeconds: clampIntRounded(
			settingNumber(document.CacheTTLSeconds, float64(fallback.CacheTTLSeconds)), 0, 3600),
	}
}

// normalizeNewsEventClusteringMode mirrors normalizeClusteringMode: only the two
// exact literals are accepted (there is no case folding) and anything else
// falls back to vector.
func normalizeNewsEventClusteringMode(raw json.RawMessage, fallback NewsEventClusteringMode) NewsEventClusteringMode {
	text, ok := settingString(raw)
	if !ok {
		return fallback
	}
	switch strings.TrimSpace(text) {
	case string(NewsEventClusteringModeVector):
		return NewsEventClusteringModeVector
	case string(NewsEventClusteringModeBertopicPrimary):
		return NewsEventClusteringModeBertopicPrimary
	default:
		return fallback
	}
}

// ---------------------------------------------------------------------------
// Root 8 - newsClassificationSettings
// ---------------------------------------------------------------------------

// newsClassificationSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const newsClassificationSettingsKeyPrefix = "news_classification_settings:"

// newsClassificationSettingsDocument is the stored
// news_classification_settings:<orgId> payload.
type newsClassificationSettingsDocument struct {
	Enabled         json.RawMessage `json:"enabled"`
	StrictFail      json.RawMessage `json:"strictFail"`
	EnableLlm       json.RawMessage `json:"enableLlm"`
	EnableEmbedding json.RawMessage `json:"enableEmbedding"`
	EnableRerank    json.RawMessage `json:"enableRerank"`
	LlmModel        json.RawMessage `json:"llmModel"`
	MinConfidence   json.RawMessage `json:"minConfidence"`
	EmbeddingTopK   json.RawMessage `json:"embeddingTopK"`
	RerankTopN      json.RawMessage `json:"rerankTopN"`
	CacheTTLSeconds json.RawMessage `json:"cacheTtlSeconds"`
	TaxonomyVersion json.RawMessage `json:"taxonomyVersion"`
	Taxonomy        json.RawMessage `json:"taxonomy"`
}

// newsClassificationTaxonomyNodeDocument is one stored taxonomy node.
type newsClassificationTaxonomyNodeDocument struct {
	Path           json.RawMessage `json:"path"`
	DisplayName    json.RawMessage `json:"displayName"`
	Description    json.RawMessage `json:"description"`
	LegacyCategory json.RawMessage `json:"legacyCategory"`
	Keywords       json.RawMessage `json:"keywords"`
	Synonyms       json.RawMessage `json:"synonyms"`
}

// defaultNewsClassificationSettings is getFallbackSettings.
func defaultNewsClassificationSettings() NewsClassificationSettingsModel {
	return NewsClassificationSettingsModel{
		Enabled:         true,
		StrictFail:      true,
		EnableLlm:       true,
		EnableEmbedding: true,
		EnableRerank:    true,
		LlmModel:        nil,
		MinConfidence:   0.35,
		EmbeddingTopK:   12,
		RerankTopN:      6,
		CacheTTLSeconds: 60,
		TaxonomyVersion: "news-taxonomy-v1",
		Taxonomy:        fallbackTaxonomySorted(),
	}
}

// fallbackTaxonomySorted returns the built-in taxonomy in the order NestJS
// reports once its settings cache is warm.
//
// NewsClassificationSettingsService.getSettings returns the declaration-order
// fallback on a cache miss and writes it to Redis; every later call re-runs
// normalizeSettings over the cached object, and normalizeTaxonomy re-sorts a
// value that IS an array. The steady state is therefore the path-sorted list,
// which is what this reader returns for a missing or unreadable row.
func fallbackTaxonomySorted() []NewsClassificationTaxonomyNodeModel {
	fallback := defaultTaxonomy()
	encoded, err := json.Marshal(fallback)
	if err != nil {
		return fallback
	}
	return normalizeNewsClassificationTaxonomy(encoded, fallback)
}

// newsClassificationSettings implements the newsClassificationSettings Query
// root. It has no administrator gate; a MySQL failure or missing row degrades
// to the defaults.
func (r *settingsReader) newsClassificationSettings(ctx context.Context, orgID string) (NewsClassificationSettingsModel, error) {
	fallback := defaultNewsClassificationSettings()
	raw, found, err := r.s.selectSetting(ctx, newsClassificationSettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeNewsClassificationSettings(raw, fallback), nil
}

// normalizeNewsClassificationSettings mirrors normalizeSettings.
func normalizeNewsClassificationSettings(raw []byte, fallback NewsClassificationSettingsModel) NewsClassificationSettingsModel {
	value := json.RawMessage(raw)
	var document newsClassificationSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = newsClassificationSettingsDocument{}
		}
	}
	return NewsClassificationSettingsModel{
		Enabled:         settingBool(document.Enabled, fallback.Enabled),
		StrictFail:      settingBool(document.StrictFail, fallback.StrictFail),
		EnableLlm:       settingBool(document.EnableLlm, fallback.EnableLlm),
		EnableEmbedding: settingBool(document.EnableEmbedding, fallback.EnableEmbedding),
		EnableRerank:    settingBool(document.EnableRerank, fallback.EnableRerank),
		// cleanNullableString(120): a JSON null stays null, a missing or
		// unusable value falls back, and a usable string is trimmed and capped.
		LlmModel: cleanStringFallback(document.LlmModel, 120, fallback.LlmModel),
		MinConfidence: clampFloatBounds(
			settingNumber(document.MinConfidence, fallback.MinConfidence), 0, 1),
		EmbeddingTopK: clampIntRounded(
			settingNumber(document.EmbeddingTopK, float64(fallback.EmbeddingTopK)), 1, 100),
		RerankTopN: clampIntRounded(
			settingNumber(document.RerankTopN, float64(fallback.RerankTopN)), 1, 30),
		CacheTTLSeconds: clampIntRounded(
			settingNumber(document.CacheTTLSeconds, float64(fallback.CacheTTLSeconds)), 0, 3600),
		TaxonomyVersion: stringOrFallback(document.TaxonomyVersion, 64, fallback.TaxonomyVersion),
		Taxonomy:        normalizeNewsClassificationTaxonomy(document.Taxonomy, fallback.Taxonomy),
	}
}

// normalizeNewsClassificationTaxonomy mirrors normalizeTaxonomy.
//
// A non-array or empty value returns the fallback in declaration order. Stored
// nodes are keyed by their normalized path (a later duplicate replaces an
// earlier one), capped at 512 nodes, and returned sorted by path. The sort uses
// byte order; the service uses localeCompare, which agrees for the lowercase
// ASCII paths this taxonomy allows.
func normalizeNewsClassificationTaxonomy(raw json.RawMessage, fallback []NewsClassificationTaxonomyNodeModel) []NewsClassificationTaxonomyNodeModel {
	entries, ok := decodeRawArray(raw)
	if !ok || len(entries) == 0 {
		return append([]NewsClassificationTaxonomyNodeModel(nil), fallback...)
	}
	byPath := make(map[string]NewsClassificationTaxonomyNodeModel, len(entries))
	for _, entry := range entries {
		if len(byPath) >= 512 {
			break
		}
		if !settingIsObject(entry) {
			continue
		}
		var document newsClassificationTaxonomyNodeDocument
		if err := json.Unmarshal(entry, &document); err != nil {
			continue
		}
		path := normalizeNewsClassificationPath(document.Path)
		if path == nil {
			continue
		}
		legacyCategory := normalizeNewsClassificationLegacyCategory(document.LegacyCategory)
		if legacyCategory == nil {
			continue
		}
		displayName := cleanStringLimited(document.DisplayName, 500)
		if displayName == nil {
			displayName = path
		}
		description := cleanStringLimited(document.Description, 500)
		descriptionValue := ""
		if description != nil {
			descriptionValue = *description
		}
		byPath[*path] = NewsClassificationTaxonomyNodeModel{
			Path:           *path,
			DisplayName:    *displayName,
			Description:    descriptionValue,
			LegacyCategory: *legacyCategory,
			Keywords:       normalizeNewsClassificationList(document.Keywords),
			Synonyms:       normalizeNewsClassificationList(document.Synonyms),
		}
	}
	if len(byPath) == 0 {
		return append([]NewsClassificationTaxonomyNodeModel(nil), fallback...)
	}
	out := make([]NewsClassificationTaxonomyNodeModel, 0, len(byPath))
	for _, node := range byPath {
		out = append(out, node)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// normalizeNewsClassificationPath mirrors normalizePath: a string is trimmed and
// lowercased, backslashes become slashes, whitespace runs become hyphens,
// repeated slashes collapse, edge slashes are stripped, and an empty or
// over-long (160) result is rejected.
func normalizeNewsClassificationPath(raw json.RawMessage) *string {
	text, ok := settingString(raw)
	if !ok {
		return nil
	}
	path := strings.ToLower(strings.TrimSpace(text))
	if path == "" {
		return nil
	}
	path = strings.ReplaceAll(path, "\\", "/")
	path = collapseSettingsWhitespace(path, "-")
	path = collapseSettingsSlashes(path)
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	if len([]rune(path)) > 160 {
		return nil
	}
	return &path
}

// normalizeNewsClassificationLegacyCategory mirrors normalizeLegacyCategory:
// the lowercase trimmed string must be one of the legacy category whitelist.
func normalizeNewsClassificationLegacyCategory(raw json.RawMessage) *string {
	text, ok := settingString(raw)
	if !ok {
		return nil
	}
	category := strings.ToLower(strings.TrimSpace(text))
	for _, allowed := range allowedLegacyCategories {
		if category == allowed {
			return &category
		}
	}
	return nil
}

// normalizeNewsClassificationList mirrors normalizeStringList: non-string
// entries are dropped, strings are trimmed, emptied entries are dropped and
// capped at 80 characters, duplicates collapse in first-occurrence order, and
// the list is capped at 50 entries.
func normalizeNewsClassificationList(raw json.RawMessage) []string {
	entries, ok := settingStringList(raw)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		cleaned := strings.TrimSpace(entry)
		if cleaned == "" {
			continue
		}
		cleaned = truncateRunes(cleaned, 80)
		if seen[cleaned] {
			continue
		}
		seen[cleaned] = true
		out = append(out, cleaned)
		if len(out) >= 50 {
			break
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Root 9 - classificationQualitySettings
// ---------------------------------------------------------------------------

// classificationQualitySettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const classificationQualitySettingsKeyPrefix = "classification_quality_settings:"

// classificationQualitySettingsDocument is the stored
// classification_quality_settings:<orgId> payload; all nine values are numbers.
type classificationQualitySettingsDocument struct {
	LowConfidenceThreshold    json.RawMessage `json:"lowConfidenceThreshold"`
	LlmP95LatencyWarnMs       json.RawMessage `json:"llmP95LatencyWarnMs"`
	EmbeddingP95LatencyWarnMs json.RawMessage `json:"embeddingP95LatencyWarnMs"`
	RerankP95LatencyWarnMs    json.RawMessage `json:"rerankP95LatencyWarnMs"`
	GateRejectRateWarn        json.RawMessage `json:"gateRejectRateWarn"`
	GatePenalizedRateWarn     json.RawMessage `json:"gatePenalizedRateWarn"`
	ReportMinPairCount        json.RawMessage `json:"reportMinPairCount"`
	ReportMinPairErrorRate    json.RawMessage `json:"reportMinPairErrorRate"`
	CacheTTLSeconds           json.RawMessage `json:"cacheTtlSeconds"`
}

// defaultClassificationQualitySettings is getFallbackSettings.
func defaultClassificationQualitySettings() ClassificationQualitySettingsModel {
	return ClassificationQualitySettingsModel{
		LowConfidenceThreshold:    0.4,
		LlmP95LatencyWarnMs:       8000,
		EmbeddingP95LatencyWarnMs: 3000,
		RerankP95LatencyWarnMs:    4000,
		GateRejectRateWarn:        0.2,
		GatePenalizedRateWarn:     0.35,
		ReportMinPairCount:        3,
		ReportMinPairErrorRate:    0.2,
		CacheTTLSeconds:           60,
	}
}

// classificationQualitySettings implements the classificationQualitySettings
// Query root. It has no administrator gate; a MySQL failure or missing row
// degrades to the defaults.
func (r *settingsReader) classificationQualitySettings(ctx context.Context, orgID string) (ClassificationQualitySettingsModel, error) {
	fallback := defaultClassificationQualitySettings()
	raw, found, err := r.s.selectSetting(ctx, classificationQualitySettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeClassificationQualitySettings(raw, fallback), nil
}

// normalizeClassificationQualitySettings mirrors normalizeSettings.
//
// This service is strictly typed: both clamps accept only a finite JSON number
// and ignore numeric strings entirely, so settingNumberStrict is used here.
func normalizeClassificationQualitySettings(raw []byte, fallback ClassificationQualitySettingsModel) ClassificationQualitySettingsModel {
	value := json.RawMessage(raw)
	var document classificationQualitySettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = classificationQualitySettingsDocument{}
		}
	}
	return ClassificationQualitySettingsModel{
		LowConfidenceThreshold: qualitySettingFloat(
			document.LowConfidenceThreshold, 0, 1, fallback.LowConfidenceThreshold),
		LlmP95LatencyWarnMs: qualitySettingInt(
			document.LlmP95LatencyWarnMs, 100, 120000, fallback.LlmP95LatencyWarnMs),
		EmbeddingP95LatencyWarnMs: qualitySettingInt(
			document.EmbeddingP95LatencyWarnMs, 100, 120000, fallback.EmbeddingP95LatencyWarnMs),
		RerankP95LatencyWarnMs: qualitySettingInt(
			document.RerankP95LatencyWarnMs, 100, 120000, fallback.RerankP95LatencyWarnMs),
		GateRejectRateWarn: qualitySettingFloat(
			document.GateRejectRateWarn, 0, 1, fallback.GateRejectRateWarn),
		GatePenalizedRateWarn: qualitySettingFloat(
			document.GatePenalizedRateWarn, 0, 1, fallback.GatePenalizedRateWarn),
		ReportMinPairCount: qualitySettingInt(
			document.ReportMinPairCount, 1, 1000, fallback.ReportMinPairCount),
		ReportMinPairErrorRate: qualitySettingFloat(
			document.ReportMinPairErrorRate, 0, 1, fallback.ReportMinPairErrorRate),
		CacheTTLSeconds: qualitySettingInt(
			document.CacheTTLSeconds, 0, 3600, fallback.CacheTTLSeconds),
	}
}

// qualitySettingFloat mirrors the quality service clampFloat: a non-number falls
// back, then the value is rounded to four decimals and clamped. The rounding
// happens before the clamp, matching Number(value.toFixed(4)) inside the clamp.
func qualitySettingFloat(raw json.RawMessage, min, max, fallback float64) float64 {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return fallback
	}
	return clampFloatBounds(roundTo(value, 4), min, max)
}

// qualitySettingInt mirrors the quality service clampInt: a non-number falls
// back, then Math.round is applied before the bounds clamp.
func qualitySettingInt(raw json.RawMessage, min, max int, fallback int) int {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return fallback
	}
	return int(clampFloatBounds(jsRound(value), float64(min), float64(max)))
}

// ---------------------------------------------------------------------------
// Root 10 - newsDedupeSettings
// ---------------------------------------------------------------------------

// newsDedupeSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const newsDedupeSettingsKeyPrefix = "news_dedupe_settings:"

// newsDedupeMaxScopedThresholds is MAX_SCOPED_THRESHOLDS.
const newsDedupeMaxScopedThresholds = 100

// newsDedupeSettingsDocument is the stored news_dedupe_settings:<orgId> payload.
// categoryThresholds is the legacy key that is still read and folded into
// scopedThresholds.
type newsDedupeSettingsDocument struct {
	DefaultThreshold             json.RawMessage `json:"defaultThreshold"`
	ScopedThresholds             json.RawMessage `json:"scopedThresholds"`
	CategoryThresholds           json.RawMessage `json:"categoryThresholds"`
	UseEmbeddings                json.RawMessage `json:"useEmbeddings"`
	LlmJudgeInstructions         json.RawMessage `json:"llmJudgeInstructions"`
	LlmJudgeModel                json.RawMessage `json:"llmJudgeModel"`
	LlmJudgeConcurrency          json.RawMessage `json:"llmJudgeConcurrency"`
	LlmJudgeMaxComparisons       json.RawMessage `json:"llmJudgeMaxComparisons"`
	LlmJudgeCandidateChars       json.RawMessage `json:"llmJudgeCandidateChars"`
	LlmJudgePromptVersion        json.RawMessage `json:"llmJudgePromptVersion"`
	LlmJudgeSystemPromptTemplate json.RawMessage `json:"llmJudgeSystemPromptTemplate"`
	LlmJudgeUserPromptTemplate   json.RawMessage `json:"llmJudgeUserPromptTemplate"`
}

// newsDedupeScopedThresholdDocument is one stored scoped threshold.
type newsDedupeScopedThresholdDocument struct {
	SourceID     json.RawMessage `json:"sourceId"`
	Language     json.RawMessage `json:"language"`
	CategoryPath json.RawMessage `json:"categoryPath"`
	Threshold    json.RawMessage `json:"threshold"`
}

// newsDedupeCategoryThresholdDocument is one legacy category threshold.
type newsDedupeCategoryThresholdDocument struct {
	Category  json.RawMessage `json:"category"`
	Threshold json.RawMessage `json:"threshold"`
}

// defaultNewsDedupeSettings is getFallbackSettings. defaultThreshold comes from
// the news pipeline configuration file (summary_dedup_threshold, default 0.9).
func defaultNewsDedupeSettings() NewsDedupeSettingsModel {
	return NewsDedupeSettingsModel{
		DefaultThreshold:             defaultSummaryDedupThreshold,
		ScopedThresholds:             []NewsDedupeScopedThresholdModel{},
		UseEmbeddings:                true,
		LlmJudgeInstructions:         nil,
		LlmJudgeModel:                nil,
		LlmJudgeConcurrency:          4,
		LlmJudgeMaxComparisons:       12,
		LlmJudgeCandidateChars:       1200,
		LlmJudgePromptVersion:        defaultDedupePromptVersion,
		LlmJudgeSystemPromptTemplate: defaultDedupeSystemPromptTemplate(),
		LlmJudgeUserPromptTemplate:   defaultDedupeUserPromptTemplate(),
	}
}

// newsDedupeSettings implements the newsDedupeSettings Query root. It has no
// administrator gate; a MySQL failure or missing row degrades to the defaults.
func (r *settingsReader) newsDedupeSettings(ctx context.Context, orgID string) (NewsDedupeSettingsModel, error) {
	fallback := defaultNewsDedupeSettings()
	raw, found, err := r.s.selectSetting(ctx, newsDedupeSettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeNewsDedupeSettings(raw, fallback), nil
}

// normalizeNewsDedupeSettings mirrors normalizeSettings.
func normalizeNewsDedupeSettings(raw []byte, fallback NewsDedupeSettingsModel) NewsDedupeSettingsModel {
	value := json.RawMessage(raw)
	var document newsDedupeSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = newsDedupeSettingsDocument{}
		}
	}
	defaultThreshold := clampFloatBounds(
		settingNumber(document.DefaultThreshold, fallback.DefaultThreshold), 0, 1)
	return NewsDedupeSettingsModel{
		DefaultThreshold: defaultThreshold,
		ScopedThresholds: normalizeNewsDedupeScopedThresholds(document, defaultThreshold),
		UseEmbeddings:    settingBool(document.UseEmbeddings, fallback.UseEmbeddings),
		// llmJudgeInstructions/llmJudgeModel have no fallback merge: a missing
		// or unusable value is null, not the (null) default.
		LlmJudgeInstructions: cleanStringLimited(document.LlmJudgeInstructions, 2000),
		LlmJudgeModel:        cleanStringLimited(document.LlmJudgeModel, 120),
		LlmJudgeConcurrency: clampIntRounded(
			settingNumber(document.LlmJudgeConcurrency, float64(fallback.LlmJudgeConcurrency)), 1, 8),
		LlmJudgeMaxComparisons: clampIntRounded(
			settingNumber(document.LlmJudgeMaxComparisons, float64(fallback.LlmJudgeMaxComparisons)), 1, 30),
		LlmJudgeCandidateChars: clampIntRounded(
			settingNumber(document.LlmJudgeCandidateChars, float64(fallback.LlmJudgeCandidateChars)), 200, 5000),
		LlmJudgePromptVersion: stringOrFallback(
			document.LlmJudgePromptVersion, 80, fallback.LlmJudgePromptVersion),
		LlmJudgeSystemPromptTemplate: stringOrFallback(
			document.LlmJudgeSystemPromptTemplate, 12000, fallback.LlmJudgeSystemPromptTemplate),
		LlmJudgeUserPromptTemplate: stringOrFallback(
			document.LlmJudgeUserPromptTemplate, 12000, fallback.LlmJudgeUserPromptTemplate),
	}
}

// normalizeNewsDedupeScopedThresholds assembles scopedThresholds from the
// current scopedThresholds array plus the legacy categoryThresholds array.
//
// Entries are keyed by the normalized (sourceId, language, categoryPath) triple
// so a later duplicate overwrites an earlier one; legacy entries are inserted
// only while the key is absent. Both loops cap the map at 100. Every scope key
// is computed once per entry, every sort key is computed once after
// deduplication, and the result is sorted by the NUL-joined triple.
func normalizeNewsDedupeScopedThresholds(document newsDedupeSettingsDocument, defaultThreshold float64) []NewsDedupeScopedThresholdModel {
	byKey := make(map[string]NewsDedupeScopedThresholdModel)

	if entries, ok := decodeRawArray(document.ScopedThresholds); ok {
		for _, entry := range entries {
			if len(byKey) >= newsDedupeMaxScopedThresholds {
				break
			}
			if !settingIsObject(entry) {
				continue
			}
			var record newsDedupeScopedThresholdDocument
			if err := json.Unmarshal(entry, &record); err != nil {
				continue
			}
			sourceID := cleanDedupeScopeToken(record.SourceID, 191, false)
			language := cleanDedupeScopeToken(record.Language, 32, true)
			categoryPath := cleanDedupeScopeToken(record.CategoryPath, 240, false)
			if sourceID == nil && language == nil && categoryPath == nil {
				continue
			}
			// The fallback here is the computed defaultThreshold, not the
			// entry-level default.
			threshold := clampFloatBounds(settingNumber(record.Threshold, defaultThreshold), 0, 1)
			byKey[dedupeScopeKey(sourceID, language, categoryPath)] = NewsDedupeScopedThresholdModel{
				SourceID:     sourceID,
				Language:     language,
				CategoryPath: categoryPath,
				Threshold:    threshold,
			}
		}
	}

	if entries, ok := decodeRawArray(document.CategoryThresholds); ok {
		for _, entry := range entries {
			if len(byKey) >= newsDedupeMaxScopedThresholds {
				break
			}
			if !settingIsObject(entry) {
				continue
			}
			var record newsDedupeCategoryThresholdDocument
			if err := json.Unmarshal(entry, &record); err != nil {
				continue
			}
			categoryPath := cleanDedupeScopeToken(record.Category, 240, false)
			if categoryPath == nil {
				continue
			}
			key := dedupeScopeKey(nil, nil, categoryPath)
			if _, exists := byKey[key]; exists {
				continue
			}
			threshold := clampFloatBounds(settingNumber(record.Threshold, defaultThreshold), 0, 1)
			byKey[key] = NewsDedupeScopedThresholdModel{
				CategoryPath: categoryPath,
				Threshold:    threshold,
			}
		}
	}

	// Each surviving entry computes its sort key exactly once; the comparator
	// only reads the precomputed keys.
	type scopedEntry struct {
		value   NewsDedupeScopedThresholdModel
		sortKey string
	}
	entries := make([]scopedEntry, 0, len(byKey))
	for _, value := range byKey {
		entries = append(entries, scopedEntry{value: value, sortKey: dedupeScopeSortKey(value)})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].sortKey < entries[j].sortKey })
	out := make([]NewsDedupeScopedThresholdModel, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.value)
	}
	return out
}

// cleanDedupeScopeToken mirrors cleanScopeToken: only a string is accepted, its
// whitespace runs collapse to single spaces, it is trimmed, empties are
// rejected, and the result is capped; language is additionally lowercased.
func cleanDedupeScopeToken(raw json.RawMessage, max int, lower bool) *string {
	text, ok := settingString(raw)
	if !ok {
		return nil
	}
	value := strings.TrimSpace(collapseSettingsWhitespace(text, " "))
	if value == "" {
		return nil
	}
	value = truncateRunes(value, max)
	if lower {
		value = strings.ToLower(value)
	}
	return &value
}

// dedupeScopeKey is buildScopeKey: the normalized triple joined with "|", where
// an absent selector is the literal "*".
func dedupeScopeKey(sourceID, language, categoryPath *string) string {
	return dedupeScopeToken(sourceID) + "|" + dedupeScopeToken(language) + "|" + dedupeScopeToken(categoryPath)
}

// dedupeScopeToken normalizes one selector for the scope key: absent or empty
// becomes "*", otherwise it is trimmed, internal whitespace runs collapse to a
// single space and it is lowercased.
func dedupeScopeToken(value *string) string {
	if value == nil {
		return "*"
	}
	trimmed := strings.TrimSpace(collapseSettingsWhitespace(*value, " "))
	if trimmed == "" {
		return "*"
	}
	return strings.ToLower(trimmed)
}

// dedupeScopeSortKey is buildScopeSortKey without the trailing threshold
// component. The map already guarantees that the (sourceId, language,
// categoryPath) triple is unique, so the threshold can never break a tie and
// omitting it cannot change the order.
func dedupeScopeSortKey(item NewsDedupeScopedThresholdModel) string {
	var builder strings.Builder
	if item.SourceID != nil {
		builder.WriteString(*item.SourceID)
	}
	builder.WriteString("\x00")
	if item.Language != nil {
		builder.WriteString(*item.Language)
	}
	builder.WriteString("\x00")
	if item.CategoryPath != nil {
		builder.WriteString(*item.CategoryPath)
	}
	return builder.String()
}

// ---------------------------------------------------------------------------
// Root 11 - newsIndicatorSettings
// ---------------------------------------------------------------------------

// newsIndicatorSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const newsIndicatorSettingsKeyPrefix = "news_indicator_association_settings:"

// newsIndicatorMaxSlugs is the indicatorSlugs cap applied before dedupe.
const newsIndicatorMaxSlugs = 50

// newsIndicatorSettingsDocument is the stored
// news_indicator_association_settings:<orgId> payload.
type newsIndicatorSettingsDocument struct {
	Enabled                     json.RawMessage `json:"enabled"`
	IngestionEnabled            json.RawMessage `json:"ingestionEnabled"`
	WindowDays                  json.RawMessage `json:"windowDays"`
	MaxLagDays                  json.RawMessage `json:"maxLagDays"`
	MinSampleSize               json.RawMessage `json:"minSampleSize"`
	MinAbsCorrelation           json.RawMessage `json:"minAbsCorrelation"`
	MaxPValue                   json.RawMessage `json:"maxPValue"`
	TopEntities                 json.RawMessage `json:"topEntities"`
	TopTopics                   json.RawMessage `json:"topTopics"`
	MaxAssociationsPerIndicator json.RawMessage `json:"maxAssociationsPerIndicator"`
	IndicatorSlugs              json.RawMessage `json:"indicatorSlugs"`
	BacktestTriggerZScore       json.RawMessage `json:"backtestTriggerZScore"`
	BacktestBaselineDays        json.RawMessage `json:"backtestBaselineDays"`
	BacktestHoldoutDays         json.RawMessage `json:"backtestHoldoutDays"`
	CacheTTLSeconds             json.RawMessage `json:"cacheTtlSeconds"`
}

// defaultNewsIndicatorSettings is getFallbackSettings.
func defaultNewsIndicatorSettings() NewsIndicatorSettingsModel {
	return NewsIndicatorSettingsModel{
		Enabled:                     false,
		IngestionEnabled:            false,
		WindowDays:                  180,
		MaxLagDays:                  7,
		MinSampleSize:               30,
		MinAbsCorrelation:           0.2,
		MaxPValue:                   0.2,
		TopEntities:                 50,
		TopTopics:                   50,
		MaxAssociationsPerIndicator: 60,
		IndicatorSlugs:              append([]string(nil), recommendedIndicatorSlugs...),
		BacktestTriggerZScore:       2,
		BacktestBaselineDays:        30,
		BacktestHoldoutDays:         30,
		CacheTTLSeconds:             120,
	}
}

// newsIndicatorSettings implements the newsIndicatorSettings Query root. It has
// no administrator gate; a MySQL failure or missing row degrades to the
// defaults.
func (r *settingsReader) newsIndicatorSettings(ctx context.Context, orgID string) (NewsIndicatorSettingsModel, error) {
	fallback := defaultNewsIndicatorSettings()
	raw, found, err := r.s.selectSetting(ctx, newsIndicatorSettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeNewsIndicatorSettings(raw, fallback), nil
}

// normalizeNewsIndicatorSettings mirrors normalizeSettings.
func normalizeNewsIndicatorSettings(raw []byte, fallback NewsIndicatorSettingsModel) NewsIndicatorSettingsModel {
	value := json.RawMessage(raw)
	var document newsIndicatorSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = newsIndicatorSettingsDocument{}
		}
	}
	return NewsIndicatorSettingsModel{
		Enabled:          settingBool(document.Enabled, fallback.Enabled),
		IngestionEnabled: settingBool(document.IngestionEnabled, fallback.IngestionEnabled),
		WindowDays: clampIntRounded(
			settingNumber(document.WindowDays, float64(fallback.WindowDays)), 7, 3650),
		MaxLagDays: clampIntRounded(
			settingNumber(document.MaxLagDays, float64(fallback.MaxLagDays)), 0, 30),
		MinSampleSize: clampIntRounded(
			settingNumber(document.MinSampleSize, float64(fallback.MinSampleSize)), 10, 2000),
		MinAbsCorrelation: clampFloatBounds(
			settingNumber(document.MinAbsCorrelation, fallback.MinAbsCorrelation), 0, 1),
		MaxPValue: clampFloatBounds(
			settingNumber(document.MaxPValue, fallback.MaxPValue), 0, 1),
		TopEntities: clampIntRounded(
			settingNumber(document.TopEntities, float64(fallback.TopEntities)), 0, 500),
		TopTopics: clampIntRounded(
			settingNumber(document.TopTopics, float64(fallback.TopTopics)), 0, 500),
		MaxAssociationsPerIndicator: clampIntRounded(
			settingNumber(document.MaxAssociationsPerIndicator, float64(fallback.MaxAssociationsPerIndicator)), 1, 1000),
		IndicatorSlugs: normalizeNewsIndicatorSlugs(document.IndicatorSlugs, fallback.IndicatorSlugs),
		BacktestTriggerZScore: clampFloatBounds(
			settingNumber(document.BacktestTriggerZScore, fallback.BacktestTriggerZScore), 0, 10),
		BacktestBaselineDays: clampIntRounded(
			settingNumber(document.BacktestBaselineDays, float64(fallback.BacktestBaselineDays)), 5, 365),
		BacktestHoldoutDays: clampIntRounded(
			settingNumber(document.BacktestHoldoutDays, float64(fallback.BacktestHoldoutDays)), 0, 365),
		CacheTTLSeconds: clampIntRounded(
			settingNumber(document.CacheTTLSeconds, float64(fallback.CacheTTLSeconds)), 0, 3600),
	}
}

// normalizeNewsIndicatorSlugs mirrors the inline indicatorSlugs normalization: a
// non-array value keeps the default list; otherwise entries are trimmed,
// non-strings and empties dropped, the survivors capped at 50, and only then
// deduplicated in first-occurrence order.
func normalizeNewsIndicatorSlugs(raw json.RawMessage, fallback []string) []string {
	entries := fallback
	if settingIsArray(raw) {
		if list, ok := settingStringList(raw); ok {
			entries = list
		}
	}
	trimmed := make([]string, 0, len(entries))
	for _, entry := range entries {
		value := strings.TrimSpace(entry)
		if value == "" {
			continue
		}
		trimmed = append(trimmed, value)
		if len(trimmed) >= newsIndicatorMaxSlugs {
			break
		}
	}
	out := make([]string, 0, len(trimmed))
	seen := make(map[string]bool, len(trimmed))
	for _, entry := range trimmed {
		if seen[entry] {
			continue
		}
		seen[entry] = true
		out = append(out, entry)
	}
	return out
}

// ---------------------------------------------------------------------------
// Root 12 - authCacheSettings
// ---------------------------------------------------------------------------

// authCacheSettingsKey is the single global SystemSetting row for the auth
// profile cache.
const authCacheSettingsKey = "auth_profile_cache_settings"

// Auth profile cache bounds, copied from auth-cache-settings.service.ts.
const (
	authCacheMinProfileTTLSeconds = 60
	authCacheMaxProfileTTLSeconds = 86400
	authCacheMinLockTTLMs         = 100
	authCacheMaxLockTTLMs         = 60000
	authCacheMinRetryDelayMs      = 10
	authCacheMaxRetryDelayMs      = 1000
	authCacheMinMaxWaitMs         = 50
	authCacheMaxMaxWaitMs         = 120000
)

// authCacheSettingsDocument is the stored auth_profile_cache_settings payload.
type authCacheSettingsDocument struct {
	ProfileTTLSeconds json.RawMessage `json:"profileTtlSeconds"`
	LockTTLMs         json.RawMessage `json:"lockTtlMs"`
	MaxWaitMs         json.RawMessage `json:"maxWaitMs"`
	RetryDelayMs      json.RawMessage `json:"retryDelayMs"`
}

// defaultAuthCacheSettings is getFallbackSettings: the raw environment values,
// returned unclamped when the row is absent.
func defaultAuthCacheSettings() AuthCacheSettingsModel {
	return AuthCacheSettingsModel{
		ProfileTTLSeconds: defaultAuthProfileTTLSeconds,
		LockTTLMs:         defaultAuthProfileLockTTLMs,
		MaxWaitMs:         defaultAuthProfileMaxWaitMs,
		RetryDelayMs:      defaultAuthProfileRetryDelayMs,
	}
}

// authCacheSettings implements the authCacheSettings Query root.
//
// The caller must be a system administrator. AuthCacheSettingsService has no
// try/catch, so a MySQL failure propagates as the field error instead of
// degrading to the defaults.
func (r *settingsReader) authCacheSettings(ctx context.Context, identity contract.Identity) (AuthCacheSettingsModel, error) {
	if err := r.s.assertSystemAdmin(ctx, identity); err != nil {
		return AuthCacheSettingsModel{}, err
	}
	fallback := defaultAuthCacheSettings()
	raw, found, err := r.s.selectSetting(ctx, authCacheSettingsKey)
	if err != nil {
		return AuthCacheSettingsModel{}, err
	}
	if !found {
		return fallback, nil
	}
	return normalizeAuthCacheSettings(raw, fallback), nil
}

// normalizeAuthCacheSettings mirrors normalize({ ...fallback, ...value }): every
// stored key is read with toInt against the environment fallback (numbers only,
// floored), then each field is clamped and maxWaitMs is forced to at least
// retryDelayMs and 50 before its own clamp.
func normalizeAuthCacheSettings(raw []byte, fallback AuthCacheSettingsModel) AuthCacheSettingsModel {
	value := json.RawMessage(raw)
	var document authCacheSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = authCacheSettingsDocument{}
		}
	}
	retryDelayMs := authCacheClamp(
		authCacheToInt(document.RetryDelayMs, fallback.RetryDelayMs),
		authCacheMinRetryDelayMs, authCacheMaxRetryDelayMs)
	maxWaitMs := authCacheToInt(document.MaxWaitMs, fallback.MaxWaitMs)
	if retryDelayMs > maxWaitMs {
		maxWaitMs = retryDelayMs
	}
	if maxWaitMs < authCacheMinMaxWaitMs {
		maxWaitMs = authCacheMinMaxWaitMs
	}
	return AuthCacheSettingsModel{
		ProfileTTLSeconds: authCacheClamp(
			authCacheToInt(document.ProfileTTLSeconds, fallback.ProfileTTLSeconds),
			authCacheMinProfileTTLSeconds, authCacheMaxProfileTTLSeconds),
		LockTTLMs: authCacheClamp(
			authCacheToInt(document.LockTTLMs, fallback.LockTTLMs),
			authCacheMinLockTTLMs, authCacheMaxLockTTLMs),
		MaxWaitMs:    authCacheClamp(maxWaitMs, authCacheMinMaxWaitMs, authCacheMaxMaxWaitMs),
		RetryDelayMs: retryDelayMs,
	}
}

// authCacheToInt mirrors the auth cache toInt: only a finite JSON number is
// accepted (numeric strings are ignored) and it is floored toward negative
// infinity; anything else yields the fallback.
func authCacheToInt(raw json.RawMessage, fallback int) int {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return fallback
	}
	return int(jsFloor(value))
}

// authCacheClamp mirrors the auth cache clamp helper for already-resolved
// integers.
func authCacheClamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// ---------------------------------------------------------------------------
// Root 13 - crawlClientSettings
// ---------------------------------------------------------------------------

// crawlClientSettingsKey is the single global SystemSetting row for the crawl
// client.
const crawlClientSettingsKey = "crawl_client_settings"

// crawlClientSettingsDocument is the stored crawl_client_settings payload. It
// has twenty keys: the nineteen GraphQL fields plus maxConcurrency, which is
// normalized for fidelity but never exposed by the schema.
type crawlClientSettingsDocument struct {
	HealthCheckTtlMs                         json.RawMessage `json:"healthCheckTtlMs"`
	RequestTimeoutMs                         json.RawMessage `json:"requestTimeoutMs"`
	RequestTimeoutHotMs                      json.RawMessage `json:"requestTimeoutHotMs"`
	RequestTimeoutNormalMs                   json.RawMessage `json:"requestTimeoutNormalMs"`
	ConditionalRequestEnabled                json.RawMessage `json:"conditionalRequestEnabled"`
	ConditionalRequestTimeoutMs              json.RawMessage `json:"conditionalRequestTimeoutMs"`
	ConditionalRequestMaxRetries             json.RawMessage `json:"conditionalRequestMaxRetries"`
	DetailPublishSignalHeadFetchTimeoutMs    json.RawMessage `json:"detailPublishSignalHeadFetchTimeoutMs"`
	DetailPublishSignalHeadFetchConcurrency  json.RawMessage `json:"detailPublishSignalHeadFetchConcurrency"`
	DetailPublishSignalHeadFetchMaxReadBytes json.RawMessage `json:"detailPublishSignalHeadFetchMaxReadBytes"`
	MaxRetries                               json.RawMessage `json:"maxRetries"`
	RetryBackoffMs                           json.RawMessage `json:"retryBackoffMs"`
	QueueOverloadCooldownMs                  json.RawMessage `json:"queueOverloadCooldownMs"`
	AdaptiveConcurrencyEnabled               json.RawMessage `json:"adaptiveConcurrencyEnabled"`
	AdaptiveWindowMinutes                    json.RawMessage `json:"adaptiveWindowMinutes"`
	AdaptiveCooldownMinutes                  json.RawMessage `json:"adaptiveCooldownMinutes"`
	AdaptiveLatencyThresholdRatio            json.RawMessage `json:"adaptiveLatencyThresholdRatio"`
	AdaptiveErrorRateThreshold               json.RawMessage `json:"adaptiveErrorRateThreshold"`
	AdaptiveMemoryHeadroomThreshold          json.RawMessage `json:"adaptiveMemoryHeadroomThreshold"`
	MaxConcurrency                           json.RawMessage `json:"maxConcurrency"`
}

// crawlClientNormalized is the fully normalized crawl client setting: the
// nineteen GraphQL fields plus maxConcurrency, which NestJS persists and caches
// but does not expose.
type crawlClientNormalized struct {
	Settings       CrawlClientSettingsModel
	MaxConcurrency int
}

// defaultCrawlClientNormalized is getFallbackSettings, derived from the
// environment values rather than from pure literals.
func defaultCrawlClientNormalized() crawlClientNormalized {
	requestTimeoutNormalMs := crawlClientClampValue(
		float64(defaultCrawlRequestTimeoutMs), 5000, 900000, float64(defaultCrawlRequestTimeoutMs))
	// The hot timeout is capped by the normal timeout before its own clamp.
	requestTimeoutHotMs := crawlClientClampValue(
		minFloat(requestTimeoutNormalMs, float64(defaultCrawlRequestTimeoutHotMs)),
		5000, 900000, requestTimeoutNormalMs)
	return crawlClientNormalized{
		Settings: CrawlClientSettingsModel{
			HealthCheckTTLMs: int(crawlClientClampValue(
				float64(defaultCrawlHealthCheckTTLMs), 5000, 900000, 5000)),
			RequestTimeoutMs:          int(requestTimeoutNormalMs),
			RequestTimeoutNormalMs:    int(requestTimeoutNormalMs),
			RequestTimeoutHotMs:       int(requestTimeoutHotMs),
			ConditionalRequestEnabled: true,
			ConditionalRequestTimeoutMs: int(crawlClientClampValue(
				float64(defaultCrawlConditionalTimeoutMs), 500, 60000, 500)),
			ConditionalRequestMaxRetries: int(crawlClientClampValue(
				float64(defaultCrawlConditionalMaxRetries), 0, 5, 0)),
			DetailPublishSignalHeadFetchTimeoutMs: int(crawlClientClampValue(
				float64(defaultCrawlHeadFetchTimeoutMs), 500, 10000, 500)),
			DetailPublishSignalHeadFetchConcurrency: int(crawlClientClampValue(
				float64(defaultCrawlHeadFetchConcurrency), 1, 8, 1)),
			DetailPublishSignalHeadFetchMaxReadBytes: int(crawlClientClampValue(
				float64(defaultCrawlHeadFetchMaxReadBytes), 1048576, 64000000, 1048576)),
			MaxRetries: int(crawlClientClampValue(
				float64(defaultCrawlMaxRetries), 1, 10, 1)),
			RetryBackoffMs: int(crawlClientClampValue(
				float64(defaultCrawlRetryBackoffMs), 500, 600000, 500)),
			QueueOverloadCooldownMs: int(crawlClientClampValue(
				float64(defaultCrawlQueueCooldownMs), 5000, 600000, 5000)),
			AdaptiveConcurrencyEnabled: false,
			AdaptiveWindowMinutes: int(crawlClientClampValue(
				float64(defaultCrawlAdaptiveWindow), 1, 180, 1)),
			AdaptiveCooldownMinutes: int(crawlClientClampValue(
				float64(defaultCrawlAdaptiveCooldown), 1, 60, 1)),
			AdaptiveLatencyThresholdRatio: crawlClientClampValue(
				defaultCrawlAdaptiveLatencyRatio, 0.01, 0.99, 0.01),
			AdaptiveErrorRateThreshold: crawlClientClampValue(
				defaultCrawlAdaptiveErrorRate, 0.01, 0.99, 0.01),
			AdaptiveMemoryHeadroomThreshold: crawlClientClampValue(
				defaultCrawlAdaptiveHeadroom, 0.01, 0.99, 0.01),
		},
		MaxConcurrency: int(crawlClientClampValue(
			float64(defaultCrawlMaxConcurrency), 1, 20, 1)),
	}
}

// crawlClientSettings implements the crawlClientSettings Query root.
//
// The caller must be a system administrator. CrawlSettingsService has no
// try/catch around its Prisma read, so a MySQL failure propagates as the field
// error.
func (r *settingsReader) crawlClientSettings(ctx context.Context, identity contract.Identity) (CrawlClientSettingsModel, error) {
	if err := r.s.assertSystemAdmin(ctx, identity); err != nil {
		return CrawlClientSettingsModel{}, err
	}
	fallback := defaultCrawlClientNormalized()
	raw, found, err := r.s.selectSetting(ctx, crawlClientSettingsKey)
	if err != nil {
		return CrawlClientSettingsModel{}, err
	}
	if !found {
		return fallback.Settings, nil
	}
	return normalizeCrawlClientSettings(raw, fallback).Settings, nil
}

// normalizeCrawlClientSettings mirrors normalize(value, fallback). Only finite
// JSON numbers are accepted (numeric strings are ignored); integers are rounded
// before clamping, while the adaptive float ratios are clamped first and only
// the in-range value is rounded to three decimals.
func normalizeCrawlClientSettings(raw []byte, fallback crawlClientNormalized) crawlClientNormalized {
	value := json.RawMessage(raw)
	var document crawlClientSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = crawlClientSettingsDocument{}
		}
	}
	defaults := fallback.Settings
	// The normal timeout is the modern key with the legacy requestTimeoutMs as
	// its nullish fallback, and requestTimeoutMs mirrors the result.
	requestTimeoutNormalMs := crawlClientClampIntRaw(
		firstNonNullRaw(document.RequestTimeoutNormalMs, document.RequestTimeoutMs),
		5000, 900000, float64(defaults.RequestTimeoutNormalMs))
	requestTimeoutHotMs := int(minFloat(
		float64(requestTimeoutNormalMs),
		float64(crawlClientClampIntRaw(
			document.RequestTimeoutHotMs, 5000, 900000, float64(defaults.RequestTimeoutHotMs))),
	))
	return crawlClientNormalized{
		Settings: CrawlClientSettingsModel{
			HealthCheckTTLMs: crawlClientClampIntRaw(
				document.HealthCheckTtlMs, 5000, 900000, float64(defaults.HealthCheckTTLMs)),
			RequestTimeoutMs:       requestTimeoutNormalMs,
			RequestTimeoutNormalMs: requestTimeoutNormalMs,
			RequestTimeoutHotMs:    requestTimeoutHotMs,
			ConditionalRequestEnabled: settingBool(
				document.ConditionalRequestEnabled, defaults.ConditionalRequestEnabled),
			ConditionalRequestTimeoutMs: crawlClientClampIntRaw(
				document.ConditionalRequestTimeoutMs, 500, 60000, float64(defaults.ConditionalRequestTimeoutMs)),
			ConditionalRequestMaxRetries: crawlClientClampIntRaw(
				document.ConditionalRequestMaxRetries, 0, 5, float64(defaults.ConditionalRequestMaxRetries)),
			DetailPublishSignalHeadFetchTimeoutMs: crawlClientClampIntRaw(
				document.DetailPublishSignalHeadFetchTimeoutMs, 500, 10000,
				float64(defaults.DetailPublishSignalHeadFetchTimeoutMs)),
			DetailPublishSignalHeadFetchConcurrency: crawlClientClampIntRaw(
				document.DetailPublishSignalHeadFetchConcurrency, 1, 8,
				float64(defaults.DetailPublishSignalHeadFetchConcurrency)),
			DetailPublishSignalHeadFetchMaxReadBytes: crawlClientClampIntRaw(
				document.DetailPublishSignalHeadFetchMaxReadBytes, 1048576, 64000000,
				float64(defaults.DetailPublishSignalHeadFetchMaxReadBytes)),
			MaxRetries: crawlClientClampIntRaw(
				document.MaxRetries, 1, 10, float64(defaults.MaxRetries)),
			RetryBackoffMs: crawlClientClampIntRaw(
				document.RetryBackoffMs, 500, 600000, float64(defaults.RetryBackoffMs)),
			QueueOverloadCooldownMs: crawlClientClampIntRaw(
				document.QueueOverloadCooldownMs, 5000, 600000, float64(defaults.QueueOverloadCooldownMs)),
			AdaptiveConcurrencyEnabled: settingBool(
				document.AdaptiveConcurrencyEnabled, defaults.AdaptiveConcurrencyEnabled),
			AdaptiveWindowMinutes: crawlClientClampIntRaw(
				document.AdaptiveWindowMinutes, 1, 180, float64(defaults.AdaptiveWindowMinutes)),
			AdaptiveCooldownMinutes: crawlClientClampIntRaw(
				document.AdaptiveCooldownMinutes, 1, 60, float64(defaults.AdaptiveCooldownMinutes)),
			AdaptiveLatencyThresholdRatio: crawlClientClampFloatRaw(
				document.AdaptiveLatencyThresholdRatio, 0.01, 0.99, defaults.AdaptiveLatencyThresholdRatio),
			AdaptiveErrorRateThreshold: crawlClientClampFloatRaw(
				document.AdaptiveErrorRateThreshold, 0.01, 0.99, defaults.AdaptiveErrorRateThreshold),
			AdaptiveMemoryHeadroomThreshold: crawlClientClampFloatRaw(
				document.AdaptiveMemoryHeadroomThreshold, 0.01, 0.99, defaults.AdaptiveMemoryHeadroomThreshold),
		},
		MaxConcurrency: crawlClientClampIntRaw(
			document.MaxConcurrency, 1, 20, float64(fallback.MaxConcurrency)),
	}
}

// crawlClientClampValue mirrors the crawl clamp helper for already-resolved
// numbers: NaN yields the fallback untouched, and only then are the bounds
// applied.
func crawlClientClampValue(value, min, max, fallback float64) float64 {
	if value != value {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// crawlClientClampIntRaw reads a finite JSON number, rounds it with Math.round
// and clamps; a missing or non-numeric value yields the fallback untouched.
func crawlClientClampIntRaw(raw json.RawMessage, min, max, fallback float64) int {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return int(fallback)
	}
	rounded := jsRound(value)
	if rounded < min {
		return int(min)
	}
	if rounded > max {
		return int(max)
	}
	return int(rounded)
}

// crawlClientClampFloatRaw mirrors the crawl clampFloat: a missing or
// non-numeric value yields the fallback, out-of-range values are clamped
// unrounded, and only the in-range value is rounded to three decimals.
func crawlClientClampFloatRaw(raw json.RawMessage, min, max, fallback float64) float64 {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return roundTo(value, 3)
}

// minFloat returns the smaller of two float64 values.
func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// firstNonNullRaw mirrors JavaScript nullish coalescing: the primary value is
// used unless it is absent or the JSON literal null.
func firstNonNullRaw(primary, secondary json.RawMessage) json.RawMessage {
	trimmed := strings.TrimSpace(string(primary))
	if trimmed == "" || trimmed == "null" {
		return secondary
	}
	return primary
}

// ---------------------------------------------------------------------------
// Root 14 - auditLogRetention
// ---------------------------------------------------------------------------

// auditLogRetentionKey is the single global SystemSetting row for the audit log
// retention.
const auditLogRetentionKey = "audit_log_retention_days"

// Audit log retention bounds, copied from audit-log-settings.service.ts.
const (
	auditLogMinRetentionDays = 1
	auditLogMaxRetentionDays = 3650
)

// auditLogRetentionDocument is the object form the stored value may use; a bare
// JSON number is also accepted.
type auditLogRetentionDocument struct {
	RetentionDays json.RawMessage `json:"retentionDays"`
}

// auditLogRetention implements the auditLogRetention Query root.
//
// The caller must be a system administrator. AuditLogSettingsService has no
// try/catch around its Prisma read, so a MySQL failure propagates as the field
// error.
func (r *settingsReader) auditLogRetention(ctx context.Context, identity contract.Identity) (AuditLogRetentionModel, error) {
	if err := r.s.assertSystemAdmin(ctx, identity); err != nil {
		return AuditLogRetentionModel{}, err
	}
	fallback := normalizeAuditLogRetentionDays(float64(defaultAuditLogRetentionDays))
	raw, found, err := r.s.selectSetting(ctx, auditLogRetentionKey)
	if err != nil {
		return AuditLogRetentionModel{}, err
	}
	if !found {
		return AuditLogRetentionModel{RetentionDays: fallback}, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return AuditLogRetentionModel{RetentionDays: fallback}, nil
	}
	if trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9') {
		if value, ok := settingFloatOnly(raw); ok {
			return AuditLogRetentionModel{RetentionDays: normalizeAuditLogRetentionDays(value)}, nil
		}
		return AuditLogRetentionModel{RetentionDays: fallback}, nil
	}
	if settingIsObject(json.RawMessage(raw)) {
		var document auditLogRetentionDocument
		if err := json.Unmarshal(raw, &document); err == nil {
			if value, ok := settingNumberStrict(document.RetentionDays); ok {
				return AuditLogRetentionModel{RetentionDays: normalizeAuditLogRetentionDays(value)}, nil
			}
		}
	}
	return AuditLogRetentionModel{RetentionDays: fallback}, nil
}

// normalizeAuditLogRetentionDays mirrors the audit retention normalize:
// Math.floor first (toward negative infinity), then NaN or below the minimum
// becomes the minimum and above the maximum becomes the maximum.
func normalizeAuditLogRetentionDays(value float64) int {
	floored := jsFloor(value)
	if floored != floored || floored < auditLogMinRetentionDays {
		return auditLogMinRetentionDays
	}
	if floored > auditLogMaxRetentionDays {
		return auditLogMaxRetentionDays
	}
	return int(floored)
}

// ---------------------------------------------------------------------------
// Root 15 - newsExtractionSettings
// ---------------------------------------------------------------------------

// newsExtractionSettingsKeyPrefix is SYSTEM_SETTING_KEY_PREFIX.
const newsExtractionSettingsKeyPrefix = "news_extraction_settings:"

// newsExtractionSettingsDocument is the stored
// news_extraction_settings:<orgId> payload.
type newsExtractionSettingsDocument struct {
	PipelineMode  json.RawMessage `json:"pipelineMode"`
	PreflightGate json.RawMessage `json:"preflightGate"`
	PostCleanGate json.RawMessage `json:"postCleanGate"`
	Capabilities  json.RawMessage `json:"capabilities"`
	Providers     json.RawMessage `json:"providers"`
}

// newsExtractionPreflightGateDocument is the stored preflightGate object.
type newsExtractionPreflightGateDocument struct {
	Enabled            json.RawMessage `json:"enabled"`
	MinWordCount       json.RawMessage `json:"minWordCount"`
	MinQualityScore    json.RawMessage `json:"minQualityScore"`
	RejectBotChallenge json.RawMessage `json:"rejectBotChallenge"`
	RejectListLike     json.RawMessage `json:"rejectListLike"`
}

// newsExtractionPostCleanGateDocument is the stored postCleanGate object.
type newsExtractionPostCleanGateDocument struct {
	Enabled         json.RawMessage `json:"enabled"`
	MinQualityScore json.RawMessage `json:"minQualityScore"`
	MinCleanedChars json.RawMessage `json:"minCleanedChars"`
	RequireSummary  json.RawMessage `json:"requireSummary"`
}

// newsExtractionCapabilitiesDocument is the stored capabilities object.
type newsExtractionCapabilitiesDocument struct {
	Entities  json.RawMessage `json:"entities"`
	Sentiment json.RawMessage `json:"sentiment"`
	Kg        json.RawMessage `json:"kg"`
}

// newsExtractionProvidersDocument is the stored providers object.
type newsExtractionProvidersDocument struct {
	Clean     json.RawMessage `json:"clean"`
	Entities  json.RawMessage `json:"entities"`
	Sentiment json.RawMessage `json:"sentiment"`
	Kg        json.RawMessage `json:"kg"`
}

// defaultNewsExtractionSettings is getFallbackSettings.
func defaultNewsExtractionSettings() NewsExtractionSettingsModel {
	return NewsExtractionSettingsModel{
		PipelineMode: NewsExtractionPipelineModeStaged,
		PreflightGate: NewsExtractionPreflightGateSettingsModel{
			Enabled:            true,
			MinWordCount:       120,
			MinQualityScore:    0.35,
			RejectBotChallenge: true,
			RejectListLike:     true,
		},
		PostCleanGate: NewsExtractionPostCleanGateSettingsModel{
			Enabled:         true,
			MinQualityScore: 0.35,
			MinCleanedChars: 400,
			RequireSummary:  true,
		},
		Capabilities: NewsExtractionCapabilitiesSettingsModel{
			Entities:  true,
			Sentiment: true,
			Kg:        true,
		},
		Providers: NewsExtractionProvidersSettingsModel{
			Clean:     NewsExtractionProviderIdLlm,
			Entities:  NewsExtractionProviderIdLlm,
			Sentiment: NewsExtractionProviderIdLlm,
			Kg:        NewsExtractionProviderIdLlm,
		},
	}
}

// newsExtractionSettings implements the newsExtractionSettings Query root. It
// has no administrator gate; a MySQL failure or missing row degrades to the
// defaults.
func (r *settingsReader) newsExtractionSettings(ctx context.Context, orgID string) (NewsExtractionSettingsModel, error) {
	fallback := defaultNewsExtractionSettings()
	raw, found, err := r.s.selectSetting(ctx, newsExtractionSettingsKeyPrefix+orgID)
	if err != nil {
		return fallback, nil
	}
	if !found {
		return fallback, nil
	}
	return normalizeNewsExtractionSettings(raw, fallback), nil
}

// normalizeNewsExtractionSettings mirrors normalizeSettings. Nested values are
// read through optional chaining in NestJS, so a missing or non-object nested
// value simply falls back to the defaults for every one of its fields.
func normalizeNewsExtractionSettings(raw []byte, fallback NewsExtractionSettingsModel) NewsExtractionSettingsModel {
	value := json.RawMessage(raw)
	var document newsExtractionSettingsDocument
	if settingIsObject(value) {
		if err := json.Unmarshal(value, &document); err != nil {
			document = newsExtractionSettingsDocument{}
		}
	}
	var preflight newsExtractionPreflightGateDocument
	if settingIsObject(document.PreflightGate) {
		if err := json.Unmarshal(document.PreflightGate, &preflight); err != nil {
			preflight = newsExtractionPreflightGateDocument{}
		}
	}
	var postClean newsExtractionPostCleanGateDocument
	if settingIsObject(document.PostCleanGate) {
		if err := json.Unmarshal(document.PostCleanGate, &postClean); err != nil {
			postClean = newsExtractionPostCleanGateDocument{}
		}
	}
	var capabilities newsExtractionCapabilitiesDocument
	if settingIsObject(document.Capabilities) {
		if err := json.Unmarshal(document.Capabilities, &capabilities); err != nil {
			capabilities = newsExtractionCapabilitiesDocument{}
		}
	}
	var providers newsExtractionProvidersDocument
	if settingIsObject(document.Providers) {
		if err := json.Unmarshal(document.Providers, &providers); err != nil {
			providers = newsExtractionProvidersDocument{}
		}
	}
	return NewsExtractionSettingsModel{
		PipelineMode: normalizeNewsExtractionPipelineMode(document.PipelineMode, fallback.PipelineMode),
		PreflightGate: NewsExtractionPreflightGateSettingsModel{
			Enabled: settingBool(preflight.Enabled, fallback.PreflightGate.Enabled),
			MinWordCount: extractionSettingInt(
				preflight.MinWordCount, 0, 10000, fallback.PreflightGate.MinWordCount),
			MinQualityScore: extractionSettingFloat(
				preflight.MinQualityScore, 0, 1, fallback.PreflightGate.MinQualityScore),
			RejectBotChallenge: settingBool(
				preflight.RejectBotChallenge, fallback.PreflightGate.RejectBotChallenge),
			RejectListLike: settingBool(
				preflight.RejectListLike, fallback.PreflightGate.RejectListLike),
		},
		PostCleanGate: NewsExtractionPostCleanGateSettingsModel{
			Enabled: settingBool(postClean.Enabled, fallback.PostCleanGate.Enabled),
			MinQualityScore: extractionSettingFloat(
				postClean.MinQualityScore, 0, 1, fallback.PostCleanGate.MinQualityScore),
			MinCleanedChars: extractionSettingInt(
				postClean.MinCleanedChars, 0, 100000, fallback.PostCleanGate.MinCleanedChars),
			RequireSummary: settingBool(postClean.RequireSummary, fallback.PostCleanGate.RequireSummary),
		},
		Capabilities: NewsExtractionCapabilitiesSettingsModel{
			Entities:  settingBool(capabilities.Entities, fallback.Capabilities.Entities),
			Sentiment: settingBool(capabilities.Sentiment, fallback.Capabilities.Sentiment),
			Kg:        settingBool(capabilities.Kg, fallback.Capabilities.Kg),
		},
		Providers: NewsExtractionProvidersSettingsModel{
			Clean:     normalizeNewsExtractionProviderId(providers.Clean, fallback.Providers.Clean),
			Entities:  normalizeNewsExtractionProviderId(providers.Entities, fallback.Providers.Entities),
			Sentiment: normalizeNewsExtractionProviderId(providers.Sentiment, fallback.Providers.Sentiment),
			Kg:        normalizeNewsExtractionProviderId(providers.Kg, fallback.Providers.Kg),
		},
	}
}

// normalizeNewsExtractionPipelineMode mirrors normalizePipelineMode: only the
// exact staged/legacy literals are accepted.
func normalizeNewsExtractionPipelineMode(raw json.RawMessage, fallback NewsExtractionPipelineMode) NewsExtractionPipelineMode {
	text, ok := settingString(raw)
	if !ok {
		return fallback
	}
	switch strings.TrimSpace(text) {
	case string(NewsExtractionPipelineModeStaged):
		return NewsExtractionPipelineModeStaged
	case string(NewsExtractionPipelineModeLegacy):
		return NewsExtractionPipelineModeLegacy
	default:
		return fallback
	}
}

// normalizeNewsExtractionProviderId mirrors normalizeProviderId: only the exact
// llm literal is accepted.
func normalizeNewsExtractionProviderId(raw json.RawMessage, fallback NewsExtractionProviderId) NewsExtractionProviderId {
	text, ok := settingString(raw)
	if !ok {
		return fallback
	}
	if strings.TrimSpace(text) == string(NewsExtractionProviderIdLlm) {
		return NewsExtractionProviderIdLlm
	}
	return fallback
}

// extractionSettingFloat mirrors the extraction clampFloat: numbers only (no
// string parsing), and the value is clamped without extra rounding.
func extractionSettingFloat(raw json.RawMessage, min, max, fallback float64) float64 {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return fallback
	}
	return clampFloatBounds(value, min, max)
}

// extractionSettingInt mirrors the extraction clampInt: numbers only, rounded
// with Math.round before the bounds clamp.
func extractionSettingInt(raw json.RawMessage, min, max, fallback int) int {
	value, ok := settingNumberStrict(raw)
	if !ok {
		return fallback
	}
	return int(clampFloatBounds(jsRound(value), float64(min), float64(max)))
}

// ---------------------------------------------------------------------------
// Root 16 - newsPromptConfig
// ---------------------------------------------------------------------------

// newsPromptConfigKey is the single global SystemSetting row for the news
// pipeline prompt configuration.
const newsPromptConfigKey = "news_pipeline_prompt_config"

// newsPromptConfigDocument is the stored news_pipeline_prompt_config payload.
// denoisePromptTemplate is persisted but not part of the GraphQL model.
type newsPromptConfigDocument struct {
	Version                       json.RawMessage `json:"version"`
	SystemPromptTemplate          json.RawMessage `json:"systemPromptTemplate"`
	DenoisePromptTemplate         json.RawMessage `json:"denoisePromptTemplate"`
	UserPromptTemplate            json.RawMessage `json:"userPromptTemplate"`
	EntitySystemPromptTemplate    json.RawMessage `json:"entitySystemPromptTemplate"`
	EntityUserPromptTemplate      json.RawMessage `json:"entityUserPromptTemplate"`
	SentimentSystemPromptTemplate json.RawMessage `json:"sentimentSystemPromptTemplate"`
	SentimentUserPromptTemplate   json.RawMessage `json:"sentimentUserPromptTemplate"`
	KgSystemPromptTemplate        json.RawMessage `json:"kgSystemPromptTemplate"`
	KgUserPromptTemplate          json.RawMessage `json:"kgUserPromptTemplate"`
}

// newsPromptConfig implements the newsPromptConfig Query root.
//
// The caller must be a system administrator. The service has no try/catch and
// no cache, so a MySQL failure propagates as the field error while a missing
// row returns the built-in defaults.
func (r *settingsReader) newsPromptConfig(ctx context.Context, identity contract.Identity) (NewsPromptConfigModel, error) {
	if err := r.s.assertSystemAdmin(ctx, identity); err != nil {
		return NewsPromptConfigModel{}, err
	}
	defaults := defaultNewsPromptConfig()
	raw, found, err := r.s.selectSetting(ctx, newsPromptConfigKey)
	if err != nil {
		return NewsPromptConfigModel{}, err
	}
	if !found {
		return defaults, nil
	}
	var document newsPromptConfigDocument
	if settingIsObject(json.RawMessage(raw)) {
		if err := json.Unmarshal(raw, &document); err != nil {
			document = newsPromptConfigDocument{}
		}
	}
	return normalizeNewsPromptConfig(document, defaults), nil
}

// normalizeNewsPromptConfig mirrors normalize: every template is trimmed with
// cleanString and falls back to the built-in template when it is absent, empty
// or not a string. There is no length cap.
func normalizeNewsPromptConfig(document newsPromptConfigDocument, defaults NewsPromptConfigModel) NewsPromptConfigModel {
	return NewsPromptConfigModel{
		Version:                       promptConfigString(document.Version, defaults.Version),
		SystemPromptTemplate:          promptConfigString(document.SystemPromptTemplate, defaults.SystemPromptTemplate),
		UserPromptTemplate:            promptConfigString(document.UserPromptTemplate, defaults.UserPromptTemplate),
		EntitySystemPromptTemplate:    promptConfigString(document.EntitySystemPromptTemplate, defaults.EntitySystemPromptTemplate),
		EntityUserPromptTemplate:      promptConfigString(document.EntityUserPromptTemplate, defaults.EntityUserPromptTemplate),
		SentimentSystemPromptTemplate: promptConfigString(document.SentimentSystemPromptTemplate, defaults.SentimentSystemPromptTemplate),
		SentimentUserPromptTemplate:   promptConfigString(document.SentimentUserPromptTemplate, defaults.SentimentUserPromptTemplate),
		KgSystemPromptTemplate:        promptConfigString(document.KgSystemPromptTemplate, defaults.KgSystemPromptTemplate),
		KgUserPromptTemplate:          promptConfigString(document.KgUserPromptTemplate, defaults.KgUserPromptTemplate),
	}
}

// promptConfigString applies cleanString and falls back when the cleaned value
// is absent, mirroring `cleanString(value) ?? fallback`.
func promptConfigString(raw json.RawMessage, fallback string) string {
	if cleaned := cleanString(raw); cleaned != nil {
		return *cleaned
	}
	return fallback
}

// ---------------------------------------------------------------------------
// Shared coercion helpers
// ---------------------------------------------------------------------------

// settingNumberStrict decodes a finite JSON number only. Unlike settingFloatOnly
// it treats the JSON literal null as absent, matching the JavaScript
// `typeof value === "number"` guards: null must fall back rather than become 0.
func settingNumberStrict(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	return settingFloatOnly(raw)
}

// decodeRawArray decodes a stored value as a JSON array of raw entries. A
// non-array value reports ok=false, mirroring the Array.isArray guards.
func decodeRawArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if !settingIsArray(raw) {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, false
	}
	return entries, true
}

// stringOrFallback applies cleanStringLimited and falls back when the cleaned
// value is absent, mirroring `cleanString(value, max) ?? fallback`.
func stringOrFallback(raw json.RawMessage, max int, fallback string) string {
	if cleaned := cleanStringLimited(raw, max); cleaned != nil {
		return *cleaned
	}
	return fallback
}

// collapseSettingsWhitespace replaces every run of JavaScript-visible ASCII
// whitespace with a single replacement string.
func collapseSettingsWhitespace(value, replacement string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	inRun := false
	for _, character := range value {
		if isSettingsWhitespace(character) {
			if !inRun {
				builder.WriteString(replacement)
				inRun = true
			}
			continue
		}
		inRun = false
		builder.WriteRune(character)
	}
	return builder.String()
}

// collapseSettingsSlashes replaces every run of forward slashes with a single
// slash, mirroring replace(/\/+/g, "/").
func collapseSettingsSlashes(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	inRun := false
	for _, character := range value {
		if character == '/' {
			if !inRun {
				builder.WriteByte('/')
				inRun = true
			}
			continue
		}
		inRun = false
		builder.WriteRune(character)
	}
	return builder.String()
}

// isSettingsWhitespace reports whether character is one of the ASCII whitespace
// code points matched by the JavaScript \s class (the Unicode-only members are
// not expected in stored taxonomy paths).
func isSettingsWhitespace(character rune) bool {
	switch character {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	default:
		return false
	}
}
