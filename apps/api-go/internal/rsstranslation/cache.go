package rsstranslation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// rssCache is the Redis side of the two caches. Values are JSON strings, the
// same encoding CacheService uses, so Go and NestJS read each other's entries.
type rssCache struct {
	client *redis.Client
}

func newRssCache(client *redis.Client) *rssCache {
	return &rssCache{client: client}
}

// getManyStrings reads the outer cache in one MGET, preserving key order. A
// missing key, a JSON null, a non-string value or a blank string is a miss,
// matching `normalizeNonEmptyString(await cache.getMany(...))`.
func (c *rssCache) getManyStrings(ctx context.Context, keys []string) ([]*string, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("cache is not configured")
	}
	if len(keys) == 0 {
		return nil, nil
	}
	values, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]*string, len(values))
	for index, raw := range values {
		text, ok := raw.(string)
		if !ok {
			continue
		}
		var decoded string
		if err := json.Unmarshal([]byte(text), &decoded); err != nil {
			continue
		}
		trimmed := strings.TrimSpace(decoded)
		if trimmed == "" {
			continue
		}
		value := trimmed
		out[index] = &value
	}
	return out, nil
}

// getString reads one JSON string (the DeepLX inner cache).
func (c *rssCache) getString(ctx context.Context, key string) (string, bool) {
	if c == nil || c.client == nil {
		return "", false
	}
	raw, err := c.client.Get(ctx, key).Bytes()
	if err != nil || len(raw) == 0 || string(raw) == "null" {
		return "", false
	}
	var decoded string
	if json.Unmarshal(raw, &decoded) != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(decoded)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// setString writes one JSON string with a TTL.
func (c *rssCache) setString(ctx context.Context, key, value string, ttlSeconds int) error {
	if c == nil || c.client == nil {
		return errors.New("cache is not configured")
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.client.Set(ctx, key, body, time.Duration(ttlSeconds)*time.Second).Err()
}

// buildRSSKey ports buildCacheKey. The LLM provider key uses the primary model
// the source service read from the active profile, never the fallback model
// that actually answered.
func buildRSSKey(provider Provider, targetLanguage, text string, llmModel *string) string {
	language := strings.ToLower(strings.TrimSpace(targetLanguage))
	providerKey := "deeplx"
	if provider == ProviderLLM {
		model := "default"
		if llmModel != nil && strings.TrimSpace(*llmModel) != "" {
			model = strings.ToLower(strings.TrimSpace(*llmModel))
		}
		providerKey = "llm:" + model
	}
	return rssCachePrefix + ":" + providerKey + ":" + language + ":" + sha256Hex(text)
}

// deepLxInnerKey ports translationCacheKey: the situation monitor inner cache
// keyed by the hash of the trimmed text.
func deepLxInnerKey(text string) string {
	return deepLxInnerCachePrefix + sha256Hex(text)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
