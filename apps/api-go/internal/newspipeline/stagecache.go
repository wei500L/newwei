package newspipeline

// This file holds the short-lived Redis cache for successful LLM stage products
// (clean, entities, sentiment, kg). A BullMQ retry re-runs the whole pipeline
// from the top; without this cache every retried job pays for the same model
// calls again. The cache is keyed by org, stage, provider, the clean stage's
// contentHash, the prompt version and the settings-resolved completion model, so
// a prompt, provider or model change naturally misses the old entry.
//
// Only successful products are written; a failure is never cached. Any read or
// write error is treated as a miss and only logged: the cache is an optimization
// and must never change the pipeline outcome.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// stageCache is the cache surface the clean stage and the enrichment stages use.
// A nil value (or one backed by an unconfigured Redis client) is a no-op.
type stageCache interface {
	key(orgID, stage, provider, contentHash, promptVersion, model string) string
	get(ctx context.Context, key string, dst any) bool
	set(ctx context.Context, key string, value any)
}

// redisStageCache is the Redis-backed stageCache.
type redisStageCache struct {
	client *redis.Client
	ttl    time.Duration
	logf   func(format string, args ...any)
}

// newRedisStageCache builds the stage cache. A non-positive ttl disables it.
func newRedisStageCache(client *redis.Client, ttlSeconds int, logf func(format string, args ...any)) *redisStageCache {
	if logf == nil {
		logf = log.Printf
	}
	return &redisStageCache{
		client: client,
		ttl:    time.Duration(ttlSeconds) * time.Second,
		logf:   logf,
	}
}

// key builds
// pipeline:stage:{orgId}:{stage}:{provider}:{contentHash}:{promptVersion}:{model}.
// The provider and the settings-resolved completion model are part of the key so
// switching either misses the old entry instead of reusing a product a different
// provider/model produced.
func (c *redisStageCache) key(orgID, stage, provider, contentHash, promptVersion, model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		model = "default"
	}
	if provider == "" {
		provider = "default"
	}
	return fmt.Sprintf("pipeline:stage:%s:%s:%s:%s:%s:%s", orgID, stage, provider, contentHash, promptVersion, model)
}

// get returns true and fills dst when the key holds a decodable value. Any error
// (including redis.Nil) is a miss; non-nil errors are logged.
func (c *redisStageCache) get(ctx context.Context, key string, dst any) bool {
	if c == nil || c.client == nil || c.ttl <= 0 {
		return false
	}
	raw, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			c.logf("newspipeline: stage cache read failed key=%s: %v", key, err)
		}
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		c.logf("newspipeline: stage cache decode failed key=%s: %v", key, err)
		return false
	}
	return true
}

// set writes value under key for the configured TTL. A marshal or Redis error is
// logged and dropped.
func (c *redisStageCache) set(ctx context.Context, key string, value any) {
	if c == nil || c.client == nil || c.ttl <= 0 {
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		c.logf("newspipeline: stage cache encode failed key=%s: %v", key, err)
		return
	}
	if err := c.client.Set(ctx, key, raw, c.ttl).Err(); err != nil {
		c.logf("newspipeline: stage cache write failed key=%s: %v", key, err)
	}
}

// stageCacheKey returns the stage cache key, or "" when no cache is wired.
func (s *Service) stageCacheKey(orgID, stage, provider, contentHash, promptVersion, model string) string {
	if s.stageCache == nil {
		return ""
	}
	return s.stageCache.key(orgID, stage, provider, contentHash, promptVersion, model)
}

// stageCacheModel resolves the completion model the org settings select for a
// model call, so the cache key tracks the actual model instead of the global
// environment override. ok is false when the settings read failed; the caller
// then skips the cache for this run (a miss must never reuse another model's
// product).
func (s *Service) stageCacheModel(ctx context.Context) (string, bool) {
	if s.models == nil {
		return "", true
	}
	resolved, err := s.models.RuntimeCompletionModel(ctx)
	if err != nil {
		if s.logf != nil {
			s.logf("newspipeline: resolving completion model for the stage cache failed: %v", err)
		}
		return "", false
	}
	return strings.TrimSpace(resolved.Model), true
}

// loadStageCache reports whether the key held a decodable value into dst.
func (s *Service) loadStageCache(ctx context.Context, key string, dst any) bool {
	if s.stageCache == nil || key == "" {
		return false
	}
	return s.stageCache.get(ctx, key, dst)
}

// storeStageCache writes a successful stage product for later retries.
func (s *Service) storeStageCache(ctx context.Context, key string, value any) {
	if s.stageCache == nil || key == "" {
		return
	}
	s.stageCache.set(ctx, key, value)
}

// cleanStageCacheEntry is the cached clean stage product. The article metadata
// patch is carried verbatim so the persisted document matches a fresh run.
type cleanStageCacheEntry struct {
	Cleaned              CleanedNews     `json:"cleaned"`
	LLM                  LLMMetadata     `json:"llm"`
	ArticleMetadataPatch json.RawMessage `json:"articleMetadataPatch"`
}

// entitiesStageCacheEntry is the cached entity-extraction product.
type entitiesStageCacheEntry struct {
	Entities []Entity     `json:"entities"`
	LLM      *LLMMetadata `json:"llm"`
}

// sentimentStageCacheEntry is the cached sentiment product.
type sentimentStageCacheEntry struct {
	Label string       `json:"label"`
	LLM   *LLMMetadata `json:"llm"`
}

// kgStageCacheEntry is the cached knowledge-graph product.
type kgStageCacheEntry struct {
	Relations []KGRelation `json:"relations"`
	LLM       *LLMMetadata `json:"llm"`
}
