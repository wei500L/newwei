package newspipeline

// Shared in-memory stage cache fake for the retry-reuse regression tests.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// memoryStageCache is an in-memory stageCache used by the retry-reuse tests.
// It mirrors the Redis key shape so the staged and clean tests exercise the same
// cache identity as production.
type memoryStageCache struct {
	mu     sync.Mutex
	values map[string][]byte
}

func newMemoryStageCache() *memoryStageCache {
	return &memoryStageCache{values: map[string][]byte{}}
}

func (m *memoryStageCache) key(orgID, stage, provider, contentHash, promptVersion, model string) string {
	if strings.TrimSpace(model) == "" {
		model = "default"
	}
	if provider == "" {
		provider = "default"
	}
	return fmt.Sprintf("pipeline:stage:%s:%s:%s:%s:%s:%s", orgID, stage, provider, contentHash, promptVersion, model)
}

func (m *memoryStageCache) get(_ context.Context, key string, dst any) bool {
	m.mu.Lock()
	raw, ok := m.values[key]
	m.mu.Unlock()
	if !ok {
		return false
	}
	return json.Unmarshal(raw, dst) == nil
}

func (m *memoryStageCache) set(_ context.Context, key string, value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		return
	}
	m.mu.Lock()
	m.values[key] = raw
	m.mu.Unlock()
}

// pipelineEqualStringPointer reports whether two optional strings are equal.
func pipelineEqualStringPointer(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
