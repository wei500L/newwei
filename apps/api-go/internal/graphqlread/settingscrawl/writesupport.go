package settingscrawl

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// This file is the reuse surface the settings write package
// (internal/graphqlread/settingswrite) calls. The write path and the read path
// must agree byte-for-byte on every default, clamp and cross-field rule, so the
// write package never re-implements the NestJS normalizeSettings functions: it
// marshals the candidate document and runs it through the same normalizer the
// read roots use.
//
// Only models, defaults, normalizers and the administrator gate are exported
// here. No resolver and no cache state is added.

// AssertSystemAdmin re-derives the fixed SettingsResolver.assertAdmin gate for
// a caller that is not the read Store: the actor must hold a role that belongs
// to the caller's own organization, is the built-in system role and is named
// "admin" (case-insensitively). An empty role set reports 403
// "Unauthenticated"; a missing admin role reports 403 "Admin access required".
func AssertSystemAdmin(ctx context.Context, db *sql.DB, identity contract.Identity) error {
	return (&store{db: db}).assertSystemAdmin(ctx, identity)
}

// DefaultRateLimitSettings is RateLimitConfigService.getFallbackSettings: the
// raw environment buckets, returned unclamped when a row is absent.
func DefaultRateLimitSettings() RateLimitSettingsModel {
	return defaultRateLimitSettings()
}

// NormalizeRateLimitBucket mirrors normalizeBucket(value, fallback) for one
// stored or submitted bucket document.
func NormalizeRateLimitBucket(raw []byte, fallback RateLimitBucketModel) RateLimitBucketModel {
	return normalizeRateLimitBucket(raw, fallback)
}

// DefaultEntityImpactGraphSettings is EntityImpactGraphSettingsService's
// getFallbackSettings.
func DefaultEntityImpactGraphSettings() EntityImpactGraphSettingsModel {
	return defaultEntityImpactGraphSettings()
}

// NormalizeEntityImpactGraphSettings mirrors the entity impact graph
// normalizeSettings(value, defaults).
func NormalizeEntityImpactGraphSettings(raw []byte, fallback EntityImpactGraphSettingsModel) EntityImpactGraphSettingsModel {
	return normalizeEntityImpactGraphSettings(raw, fallback)
}

// DefaultKnowledgeGraphSettings is KnowledgeGraphSettingsService's
// getFallbackSettings.
func DefaultKnowledgeGraphSettings() KnowledgeGraphSettingsModel {
	return defaultKnowledgeGraphSettings()
}

// NormalizeKnowledgeGraphSettings mirrors the knowledge graph
// normalizeSettings(value, defaults).
func NormalizeKnowledgeGraphSettings(raw []byte, fallback KnowledgeGraphSettingsModel) KnowledgeGraphSettingsModel {
	return normalizeKnowledgeGraphSettings(raw, fallback)
}

// DefaultNewsEventSettings is NewsEventsSettingsService's getFallbackSettings.
func DefaultNewsEventSettings() NewsEventSettingsModel {
	return defaultNewsEventSettings()
}

// NormalizeNewsEventSettings mirrors the news event normalizeSettings(value,
// defaults), including the timeline low/high swap and the bertopic minimum.
func NormalizeNewsEventSettings(raw []byte, fallback NewsEventSettingsModel) NewsEventSettingsModel {
	return normalizeNewsEventSettings(raw, fallback)
}

// DefaultNewsClassificationSettings is NewsClassificationSettingsService's
// getFallbackSettings.
func DefaultNewsClassificationSettings() NewsClassificationSettingsModel {
	return defaultNewsClassificationSettings()
}

// NormalizeNewsClassificationSettings mirrors the news classification
// normalizeSettings(value, defaults).
func NormalizeNewsClassificationSettings(raw []byte, fallback NewsClassificationSettingsModel) NewsClassificationSettingsModel {
	return normalizeNewsClassificationSettings(raw, fallback)
}

// DefaultClassificationQualitySettings is
// NewsClassificationQualitySettingsService's getFallbackSettings.
func DefaultClassificationQualitySettings() ClassificationQualitySettingsModel {
	return defaultClassificationQualitySettings()
}

// NormalizeClassificationQualitySettings mirrors the classification quality
// normalizeSettings(value, defaults).
func NormalizeClassificationQualitySettings(raw []byte, fallback ClassificationQualitySettingsModel) ClassificationQualitySettingsModel {
	return normalizeClassificationQualitySettings(raw, fallback)
}

// DefaultNewsDedupeSettings is NewsDedupeSettingsService's getFallbackSettings.
func DefaultNewsDedupeSettings() NewsDedupeSettingsModel {
	return defaultNewsDedupeSettings()
}

// NormalizeNewsDedupeSettings mirrors the news dedupe normalizeSettings(value,
// defaults), including the scopedThresholds / categoryThresholds merge.
func NormalizeNewsDedupeSettings(raw []byte, fallback NewsDedupeSettingsModel) NewsDedupeSettingsModel {
	return normalizeNewsDedupeSettings(raw, fallback)
}

// DefaultNewsIndicatorSettings is NewsIndicatorSettingsService's
// getFallbackSettings.
func DefaultNewsIndicatorSettings() NewsIndicatorSettingsModel {
	return defaultNewsIndicatorSettings()
}

// NormalizeNewsIndicatorSettings mirrors the news indicator
// normalizeSettings(value, defaults).
func NormalizeNewsIndicatorSettings(raw []byte, fallback NewsIndicatorSettingsModel) NewsIndicatorSettingsModel {
	return normalizeNewsIndicatorSettings(raw, fallback)
}

// DefaultAuthCacheSettings is AuthCacheSettingsService's getFallbackSettings:
// the raw environment values, returned unclamped when the row is absent.
func DefaultAuthCacheSettings() AuthCacheSettingsModel {
	return defaultAuthCacheSettings()
}

// NormalizeAuthCacheSettings mirrors the auth cache
// normalize({ ...fallback, ...value }).
func NormalizeAuthCacheSettings(raw []byte, fallback AuthCacheSettingsModel) AuthCacheSettingsModel {
	return normalizeAuthCacheSettings(raw, fallback)
}

// CrawlClientNormalized is the fully normalized crawl client setting: the
// nineteen GraphQL fields plus maxConcurrency, which NestJS persists and caches
// but does not expose in the schema.
type CrawlClientNormalized = crawlClientNormalized

// DefaultCrawlClientNormalized is CrawlSettingsService.getFallbackSettings,
// derived from the environment values rather than from pure literals.
func DefaultCrawlClientNormalized() CrawlClientNormalized {
	return defaultCrawlClientNormalized()
}

// NormalizeCrawlClientSettingsDocument mirrors CrawlSettingsService's
// normalize(value, fallback) for a stored or submitted document.
func NormalizeCrawlClientSettingsDocument(raw []byte, fallback CrawlClientNormalized) CrawlClientNormalized {
	return normalizeCrawlClientSettings(raw, fallback)
}

// DefaultAuditLogRetentionDays is AuditLogSettingsService.getFallbackSettings
// after normalize(): the environment default clamped to [1, 3650].
func DefaultAuditLogRetentionDays() int {
	return normalizeAuditLogRetentionDays(float64(defaultAuditLogRetentionDays))
}

// NormalizeAuditLogRetentionDays mirrors the audit retention normalize.
func NormalizeAuditLogRetentionDays(value float64) int {
	return normalizeAuditLogRetentionDays(value)
}

// DefaultNewsExtractionSettings is NewsExtractionSettingsService's
// getFallbackSettings.
func DefaultNewsExtractionSettings() NewsExtractionSettingsModel {
	return defaultNewsExtractionSettings()
}

// NormalizeNewsExtractionSettings mirrors the news extraction
// normalizeSettings(value), whose defaults are the environment-independent
// literals above.
func NormalizeNewsExtractionSettings(raw []byte, fallback NewsExtractionSettingsModel) NewsExtractionSettingsModel {
	return normalizeNewsExtractionSettings(raw, fallback)
}

// NormalizeTaxonomyPath mirrors NewsClassificationSettingsService.normalizePath
// for a plain string: trimmed and lowercased, backslashes become slashes,
// whitespace runs become hyphens, repeated slashes collapse, edge slashes are
// stripped, and an empty or over-long result is rejected.
func NormalizeTaxonomyPath(value string) (string, bool) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", false
	}
	path := normalizeNewsClassificationPath(raw)
	if path == nil {
		return "", false
	}
	return *path, true
}

// NormalizeTaxonomyStringList mirrors normalizeStringList: entries are trimmed,
// non-strings and empties dropped, the survivors capped at 80 characters,
// duplicates collapsed in first-occurrence order and the list capped at 50.
func NormalizeTaxonomyStringList(values []string) []string {
	raw, err := json.Marshal(values)
	if err != nil {
		return []string{}
	}
	return normalizeNewsClassificationList(raw)
}

// AllowedLegacyCategories exposes the legacy category whitelist the service
// validation enforces.
func AllowedLegacyCategories() []string {
	return append([]string(nil), allowedLegacyCategories...)
}

// DefaultNewsPromptConfig is DEFAULT_NEWS_PROMPT_CONFIG.
func DefaultNewsPromptConfig() NewsPromptConfigModel {
	return defaultNewsPromptConfig()
}

// DefaultNewsPromptDenoiseTemplate is DEFAULT_DENOISE_PROMPT_TEMPLATE. The
// GraphQL model does not expose it, but the persisted document keeps it.
func DefaultNewsPromptDenoiseTemplate() string {
	return defaultNewsPromptDenoiseTemplate()
}

// NormalizeNewsPromptConfigDocument mirrors NewsPromptConfigService.normalize
// for a stored or submitted document.
func NormalizeNewsPromptConfigDocument(raw []byte, defaults NewsPromptConfigModel) NewsPromptConfigModel {
	var document newsPromptConfigDocument
	if settingIsObject(raw) {
		if err := json.Unmarshal(raw, &document); err != nil {
			document = newsPromptConfigDocument{}
		}
	}
	return normalizeNewsPromptConfig(document, defaults)
}
