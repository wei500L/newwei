package situationsignals

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

// memoryCache is an in-process cacheOps substitute. The package tests never
// connect to Redis: every cache interaction goes through this struct.
type memoryCache struct {
	values map[string][]byte
	ttls   map[string]time.Duration
	incs   map[string]int64
	// deletedPrefixes records every delByPrefix call so a test can assert which
	// prefixes the refresh cleared.
	deletedPrefixes []string
	// deleteErr, when set, makes delByPrefix fail like a Redis outage.
	deleteErr error
}

func newMemoryCache() (*memoryCache, cacheOps) {
	store := &memoryCache{
		values: map[string][]byte{},
		ttls:   map[string]time.Duration{},
		incs:   map[string]int64{},
	}
	ops := cacheOps{
		get: func(_ context.Context, key string) (string, error) {
			value, ok := store.values[key]
			if !ok {
				return "", redis.Nil
			}
			return string(value), nil
		},
		set: func(_ context.Context, key string, value []byte, ttl time.Duration) error {
			store.values[key] = append([]byte(nil), value...)
			store.ttls[key] = ttl
			return nil
		},
		incr: func(_ context.Context, key string) (int64, error) {
			store.incs[key]++
			return store.incs[key], nil
		},
		expire: func(_ context.Context, key string, ttl time.Duration) error {
			store.ttls[key] = ttl
			return nil
		},
		deleteByPrefix: func(_ context.Context, prefix string) (int, error) {
			store.deletedPrefixes = append(store.deletedPrefixes, prefix)
			if store.deleteErr != nil {
				return 0, store.deleteErr
			}
			removed := 0
			for key := range store.values {
				if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
					delete(store.values, key)
					delete(store.ttls, key)
					removed++
				}
			}
			return removed, nil
		},
	}
	return store, ops
}

// fakeEmbeddings records every model-gateway call so a test can assert that the
// lexical fallback never touched the gateway.
type fakeEmbeddings struct {
	embedCalls  int
	rerankCalls int
	vectors     [][]float64
	embedErr    error
	rerankHits  []llmembed.Hit
	rerankErr   error
	lastTexts   []string
	lastDocs    []string
}

func (f *fakeEmbeddings) Embed(_ context.Context, _ string, texts []string) ([][]float64, string, error) {
	f.embedCalls++
	f.lastTexts = append([]string(nil), texts...)
	if f.embedErr != nil {
		return nil, "", f.embedErr
	}
	return f.vectors, "test-model", nil
}

func (f *fakeEmbeddings) Rerank(_ context.Context, _, _ string, documents []string) ([]llmembed.Hit, error) {
	f.rerankCalls++
	f.lastDocs = append([]string(nil), documents...)
	if f.rerankErr != nil {
		return nil, f.rerankErr
	}
	return f.rerankHits, nil
}

// decodeJSON re-decodes a response so a test can assert on the JSON key set
// (presence and absence), which is what the smoke workflow compares.
func decodeJSON(t *testing.T, value encodedResponse) map[string]json.RawMessage {
	t.Helper()
	raw, err := value.encodeJSON()
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return decoded
}
