package dashboardwarmap

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

type blobCache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Del(ctx context.Context, key string) error
}

type redisBlobs struct {
	client *redis.Client
}

func (r redisBlobs) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if r.client == nil {
		return nil, false, errors.New("redis is not configured")
	}
	raw, err := r.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func (r redisBlobs) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if r.client == nil {
		return errors.New("redis is not configured")
	}
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r redisBlobs) Del(ctx context.Context, key string) error {
	if r.client == nil {
		return errors.New("redis is not configured")
	}
	return r.client.Del(ctx, key).Err()
}

type memoryBlobs struct {
	values map[string][]byte
}

func newMemoryBlobs() *memoryBlobs {
	return &memoryBlobs{values: map[string][]byte{}}
}

func (m *memoryBlobs) Get(_ context.Context, key string) ([]byte, bool, error) {
	value, ok := m.values[key]
	if !ok {
		return nil, false, nil
	}
	return append([]byte(nil), value...), true, nil
}

func (m *memoryBlobs) Set(_ context.Context, key string, value []byte, _ time.Duration) error {
	m.values[key] = append([]byte(nil), value...)
	return nil
}

func (m *memoryBlobs) Del(_ context.Context, key string) error {
	delete(m.values, key)
	return nil
}

func dashboardCacheKey(scope, orgID string, start, end time.Time) string {
	payload := struct {
		OrgID string `json:"orgId"`
		Range struct {
			Start string `json:"start"`
			End   string `json:"end"`
		} `json:"range"`
	}{OrgID: orgID}
	payload.Range.Start = iso(start)
	payload.Range.End = iso(end)
	raw, _ := json.Marshal(payload)
	sum := sha1.Sum(raw)
	return "dashboard:query:" + scope + ":" + hex.EncodeToString(sum[:])
}

type cachedEventRow struct {
	Location    *string `json:"location"`
	ProcessedAt *string `json:"processedAt"`
	EventAt     *string `json:"eventAt"`
}

type cachedMarkerArticle struct {
	URL        *string `json:"url"`
	CrawlAt    *string `json:"crawlAt"`
	TitleGuess *string `json:"titleGuess"`
}

type cachedMarkerRow struct {
	ID          string              `json:"id"`
	Title       *string             `json:"title"`
	Location    *string             `json:"location"`
	PublishedAt *string             `json:"publishedAt"`
	EventAt     *string             `json:"eventAt"`
	ProcessedAt *string             `json:"processedAt"`
	Entities    json.RawMessage     `json:"entities"`
	Article     cachedMarkerArticle `json:"article"`
}

func loadCached[T any](ctx context.Context, cache blobCache, key string, load func() (T, []byte, error)) (T, error) {
	var zero T
	if cache == nil {
		value, _, err := load()
		return value, err
	}
	raw, hit, err := cache.Get(ctx, key)
	if err != nil {
		return zero, err
	}
	if hit && len(raw) > 0 && raw[0] == '[' {
		var value T
		if err := json.Unmarshal(raw, &value); err != nil {
			return zero, err
		}
		return value, nil
	}
	value, body, err := load()
	if err != nil {
		return zero, err
	}
	if err := cache.Set(ctx, key, body, 10*time.Second); err != nil {
		return zero, err
	}
	return value, nil
}
