package graphqlsubscriptions

// Export surface for the other Go realtime consumers of the BullMQ event
// streams. The itemPipeline observer in queue.go keeps its private cache
// implementation; this file exposes the same job-context resolution rules (job
// hash first, then the per-process cache, then the shared
// queue:pipeline:jobctx:{jobId} entry) so a new consumer does not have to copy
// the parsing rules or the shared cache contract.

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// PipelineJobContext is the exported tenant routing record of one itemPipeline
// job. All optional identifiers are the trimmed values the NestJS
// QueueEventPublisher forwards; an empty string means the job did not carry it.
type PipelineJobContext struct {
	OrgID           string
	PipelineJobID   string
	SourceID        string
	RawItemID       string
	ItemMetaID      string
	ProcessedItemID string
}

// NewRedisQueueStore builds the read-only Redis surface used by BullMQ stream
// consumers. The blocking client is created from blockingOptions and must be
// closed through QueueStore.Close; sharedClient is the command client used for
// the job hash and the shared jobctx cache.
func NewRedisQueueStore(blockingOptions *redis.Options, sharedClient *redis.Client) QueueStore {
	return newRedisQueueStore(blockingOptions, sharedClient)
}

// PipelineJobContextResolver resolves the tenant of an itemPipeline job with
// the exact NestJS/QueueObserver precedence:
//
//  1. the job hash bull:itemPipeline:<jobId> field "data" (and mirror the parsed
//     context into the shared cache, so a cold instance can resolve a removed
//     job later);
//  2. this resolver's per-process cache (10 minute TTL);
//  3. the shared queue:pipeline:jobctx:<jobId> entry (and warm the local cache).
type PipelineJobContextResolver struct {
	store     QueueStore
	clock     func() time.Time
	mu        sync.Mutex
	local     map[string]localContextEntry
	lastPrune time.Time
}

// NewPipelineJobContextResolver builds a resolver over the given read surface.
func NewPipelineJobContextResolver(store QueueStore) *PipelineJobContextResolver {
	return &PipelineJobContextResolver{
		store: store,
		clock: time.Now,
		local: map[string]localContextEntry{},
	}
}

// Resolve returns the context of jobID. ok is false when no source carries an
// orgId; callers must drop the event in that case (the NestJS publishers log
// "Skipping ... without org context" and return).
func (r *PipelineJobContextResolver) Resolve(ctx context.Context, jobID string) (PipelineJobContext, bool) {
	if r == nil || r.store == nil || jobID == "" {
		return PipelineJobContext{}, false
	}
	cached, hasCached := r.cachedContext(jobID)
	if raw, ok, err := r.store.ReadJobData(ctx, itemPipelineQueueName, jobID); err == nil && ok {
		if jobContext, valid := extractJobContext([]byte(raw)); valid {
			r.storeContext(jobID, jobContext)
			return exportPipelineJobContext(jobContext), true
		}
	} else if err != nil {
		log.Printf("graphqlsubscriptions: pipeline job context read %s: %v", jobID, err)
	}
	if hasCached {
		return exportPipelineJobContext(cached), true
	}
	// Cross-instance fallback: the job may already be removed after a terminal
	// event, and this instance may never have observed the earlier active.
	if raw, ok, err := r.store.ReadSharedContext(ctx, jobContextKey(jobID)); err == nil && ok {
		if jobContext, valid := extractJobContext(raw); valid {
			r.warmLocal(jobID, jobContext)
			return exportPipelineJobContext(jobContext), true
		}
	} else if err != nil {
		log.Printf("graphqlsubscriptions: shared queue job context read %s: %v", jobID, err)
	}
	return PipelineJobContext{}, false
}

func exportPipelineJobContext(jobContext queueJobContext) PipelineJobContext {
	return PipelineJobContext{
		OrgID:           jobContext.OrgID,
		PipelineJobID:   jobContext.PipelineJobID,
		SourceID:        jobContext.SourceID,
		RawItemID:       jobContext.RawItemID,
		ItemMetaID:      jobContext.ItemMetaID,
		ProcessedItemID: jobContext.ProcessedItemID,
	}
}

func (r *PipelineJobContextResolver) cachedContext(jobID string) (queueJobContext, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock()
	r.pruneLocked(now)
	entry, ok := r.local[jobID]
	if !ok {
		return queueJobContext{}, false
	}
	if !now.Before(entry.expiresAt) {
		delete(r.local, jobID)
		return queueJobContext{}, false
	}
	return entry.context, true
}

func (r *PipelineJobContextResolver) warmLocal(jobID string, jobContext queueJobContext) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock()
	r.pruneLocked(now)
	r.local[jobID] = localContextEntry{context: jobContext, expiresAt: now.Add(localContextTTL)}
}

func (r *PipelineJobContextResolver) storeContext(jobID string, jobContext queueJobContext) {
	r.warmLocal(jobID, jobContext)
	encoded, err := json.Marshal(jobContext)
	if err != nil {
		return
	}
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := r.store.WriteSharedContext(writeCtx, jobContextKey(jobID), encoded, sharedContextTTL); err != nil {
		log.Printf("graphqlsubscriptions: shared queue job context write %s: %v", jobID, err)
	}
}

func (r *PipelineJobContextResolver) pruneLocked(now time.Time) {
	if now.Sub(r.lastPrune) < contextPruneInterval {
		return
	}
	for jobID, entry := range r.local {
		if !now.Before(entry.expiresAt) {
			delete(r.local, jobID)
		}
	}
	r.lastPrune = now
}
