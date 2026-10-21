package graphqlsubscriptions

import (
	"context"
	"testing"
	"time"
)

// fakeExportStore is a QueueStore with only the read surfaces this test needs.
type fakeExportStore struct {
	jobData        map[string]string
	sharedContext  map[string]string
	writtenShared  map[string]string
	writeSharedTTL time.Duration
}

func newFakeExportStore() *fakeExportStore {
	return &fakeExportStore{
		jobData:       map[string]string{},
		sharedContext: map[string]string{},
		writtenShared: map[string]string{},
	}
}

func (s *fakeExportStore) ReadStream(context.Context, string, string, int64, time.Duration) ([]StreamEntry, error) {
	return nil, nil
}

func (s *fakeExportStore) ReadJobData(_ context.Context, queue, jobID string) (string, bool, error) {
	value, ok := s.jobData[queue+"/"+jobID]
	return value, ok, nil
}

func (s *fakeExportStore) ReadSharedContext(_ context.Context, key string) ([]byte, bool, error) {
	value, ok := s.sharedContext[key]
	return []byte(value), ok, nil
}

func (s *fakeExportStore) WriteSharedContext(_ context.Context, key string, body []byte, ttl time.Duration) error {
	s.writtenShared[key] = string(body)
	s.writeSharedTTL = ttl
	return nil
}

func (s *fakeExportStore) Close() error { return nil }

func TestPipelineJobContextResolverPrecedence(t *testing.T) {
	store := newFakeExportStore()
	store.jobData[itemPipelineQueueName+"/job-1"] = `{"orgId":" org-1 ","pipelineJobId":"p1","sourceId":"s1","rawItemId":"r1","itemMetaId":"m1","processedItemId":"x1"}`
	resolver := NewPipelineJobContextResolver(store)

	contextValue, ok := resolver.Resolve(t.Context(), "job-1")
	if !ok || contextValue.OrgID != "org-1" || contextValue.PipelineJobID != "p1" || contextValue.ProcessedItemID != "x1" {
		t.Fatalf("context = %#v/%v", contextValue, ok)
	}
	// The parsed context is mirrored into the shared cache for other instances.
	sharedKey := jobContextKey("job-1")
	if _, ok := store.writtenShared[sharedKey]; !ok {
		t.Fatal("shared context was not written")
	}
	if store.writeSharedTTL != sharedContextTTL {
		t.Fatalf("shared TTL = %s", store.writeSharedTTL)
	}

	// 2. Removed job: the per-process cache still answers.
	delete(store.jobData, itemPipelineQueueName+"/job-1")
	contextValue, ok = resolver.Resolve(t.Context(), "job-1")
	if !ok || contextValue.OrgID != "org-1" {
		t.Fatalf("cached context = %#v/%v", contextValue, ok)
	}

	// 3. Cold instance: the shared cache answers.
	store.sharedContext[sharedKey] = `{"orgId":"org-2"}`
	cold := NewPipelineJobContextResolver(store)
	contextValue, ok = cold.Resolve(t.Context(), "job-1")
	if !ok || contextValue.OrgID != "org-2" {
		t.Fatalf("shared context = %#v/%v", contextValue, ok)
	}

	// A job without any orgId is not resolvable.
	if _, ok := resolver.Resolve(t.Context(), "missing"); ok {
		t.Fatal("unknown job must not resolve")
	}
}
