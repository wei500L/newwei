package kgingestion

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// Settings is the normalized knowledge-graph settings document. It mirrors
// KnowledgeGraphSettingsService and the GraphQL model field for field; the
// normalization itself is not copied, it is delegated to settingscrawl.
type Settings struct {
	Enabled                                    bool
	IngestionEnabled                           bool
	MaxBatchSize                               int
	MaxRelationsPerArticle                     int
	MinEdgeConfidence                          float64
	DynamicEdgeConfidenceEnabled               bool
	DynamicEdgeConfidenceQuantile              float64
	MultiModelValidationEnabled                bool
	MultiModelValidationModels                 []string
	MultiModelValidationModelCount             int
	MultiModelValidationMaxRelationsPerArticle int
	EntityDisambiguationEnabled                bool
	EntityDisambiguationMaxCandidates          int
	CacheTTLSeconds                            int
}

// settingsCacheKeyPrefix and settingsCacheTTLSeconds mirror
// KnowledgeGraphSettingsService.CACHE_KEY_PREFIX and
// SETTINGS_CACHE_TTL_SECONDS. The value shape is the camelCase persisted
// document, so the NestJS and Go caches are interchangeable.
const (
	settingsCacheKeyPrefix  = "knowledgeGraph:settings:"
	settingsCacheTTLSeconds = 60
)

// SettingsProvider reads one organization's settings.
type SettingsProvider interface {
	Read(ctx context.Context, orgID string) Settings
}

// settingsReader is the production SettingsProvider: Redis first, then MySQL
// with the shared bootstrap, then a best-effort cache write. A cache read or
// write failure never fails the read; a MySQL failure degrades to the disabled
// fallback, exactly like KnowledgeGraphSettingsService.getSettings.
type settingsReader struct {
	store  *settingscrawl.KnowledgeGraphSettingsReader
	redis  *redis.Client
	logger *log.Logger
}

func newSettingsReader(store *settingscrawl.KnowledgeGraphSettingsReader, redisClient *redis.Client, logger *log.Logger) *settingsReader {
	return &settingsReader{store: store, redis: redisClient, logger: logger}
}

// NewSettingsProvider builds the production settings provider: the shared
// MySQL pool, the shared Redis client and the same 60 second cache NestJS uses.
func NewSettingsProvider(db *sql.DB, redisClient *redis.Client, logger *log.Logger) SettingsProvider {
	return newSettingsReader(settingscrawl.NewKnowledgeGraphSettingsReader(db), redisClient, logger)
}

// Read returns the normalized settings document for one organization.
func (r *settingsReader) Read(ctx context.Context, orgID string) Settings {
	if r == nil {
		return settingsFromModel(settingscrawl.DefaultKnowledgeGraphSettings())
	}
	cacheKey := settingsCacheKeyPrefix + orgID
	if r.redis != nil {
		raw, err := r.redis.Get(ctx, cacheKey).Bytes()
		switch {
		case err == nil && len(raw) > 0 && json.Valid(raw):
			return settingsFromModel(settingscrawl.NormalizeKnowledgeGraphSettings(
				raw, settingscrawl.DefaultKnowledgeGraphSettings(),
			))
		case err == nil && len(raw) > 0:
			r.warn("knowledge graph settings cache holds invalid JSON; falling back to database", orgID, errInvalidSettingsCache)
		case err != nil && err != redis.Nil:
			r.warn("failed to read knowledge graph settings from cache", orgID, err)
		}
	}

	loaded := settingscrawl.DefaultKnowledgeGraphSettings()
	if r.store != nil {
		value, err := r.store.Read(ctx, orgID)
		if err != nil {
			r.warn("failed to load knowledge graph settings from database; using defaults", orgID, err)
		} else {
			loaded = value
		}
	}
	if r.redis != nil {
		if encoded, marshalErr := json.Marshal(loaded); marshalErr == nil {
			if err := r.redis.Set(ctx, cacheKey, encoded, settingsCacheTTLSeconds*time.Second).Err(); err != nil {
				r.warn("failed to write knowledge graph settings to cache", orgID, err)
			}
		}
	}
	return settingsFromModel(loaded)
}

func (r *settingsReader) warn(message, orgID string, err error) {
	if r.logger == nil {
		return
	}
	r.logger.Printf("kgingestion: %s orgId=%s err=%v", message, orgID, err)
}

func settingsFromModel(model settingscrawl.KnowledgeGraphSettingsModel) Settings {
	return Settings{
		Enabled:                                    model.Enabled,
		IngestionEnabled:                           model.IngestionEnabled,
		MaxBatchSize:                               model.MaxBatchSize,
		MaxRelationsPerArticle:                     model.MaxRelationsPerArticle,
		MinEdgeConfidence:                          model.MinEdgeConfidence,
		DynamicEdgeConfidenceEnabled:               model.DynamicEdgeConfidenceEnabled,
		DynamicEdgeConfidenceQuantile:              model.DynamicEdgeConfidenceQuantile,
		MultiModelValidationEnabled:                model.MultiModelValidationEnabled,
		MultiModelValidationModels:                 append([]string(nil), model.MultiModelValidationModels...),
		MultiModelValidationModelCount:             model.MultiModelValidationModelCount,
		MultiModelValidationMaxRelationsPerArticle: model.MultiModelValidationMaxRelationsPerArticle,
		EntityDisambiguationEnabled:                model.EntityDisambiguationEnabled,
		EntityDisambiguationMaxCandidates:          model.EntityDisambiguationMaxCandidates,
		CacheTTLSeconds:                            model.CacheTTLSeconds,
	}
}
