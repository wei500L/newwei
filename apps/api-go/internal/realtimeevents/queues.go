package realtimeevents

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
)

// BullMQ event streams.
//
// Every process reads every stream from "$" with a plain XREAD (no consumer
// group, no ACK), which is exactly how BullMQ QueueEvents behaves on the NestJS
// side: events are delivered to every instance and the realtimeevents layer
// pushes only to the connections of this process (B1). The queue/ops/quality
// adapter channels are never subscribed.
const (
	queuePipeline  = "itemPipeline"
	queueCrawlHot  = "crawl4ai-hot"
	queueCrawlNorm = "crawl4ai-normal"
	queueAnalysis  = "analysis"
	queueAssistant = "assistant"
	queueAlerts    = "alerts"

	queueStreamReadCount = 100
	queueStreamReadBlock = time.Second
	queueStreamRetry     = 200 * time.Millisecond
	queueStreamKeyPrefix = "bull:"
	queueStreamSuffix    = ":events"
)

// queueKind identifies the publisher family of one stream. It decides the orgId
// resolution chain and the ops/quality "source" label.
type queueKind uint8

const (
	queueKindPipeline queueKind = iota
	queueKindCrawl
	queueKindAnalysis
	queueKindAssistant
	queueKindAlerts
)

// source is the ops/quality event source label, mirroring the NestJS gateways.
func (k queueKind) source() string {
	switch k {
	case queueKindPipeline:
		return "pipeline"
	case queueKindCrawl:
		return "crawl"
	case queueKindAnalysis:
		return "analysis"
	case queueKindAssistant:
		return "assistant"
	case queueKindAlerts:
		return "alerts"
	default:
		return ""
	}
}

// queueStream is one BullMQ events stream read by this process.
type queueStream struct {
	queue string
	kind  queueKind
}

var queueStreams = []queueStream{
	{queue: queuePipeline, kind: queueKindPipeline},
	{queue: queueCrawlHot, kind: queueKindCrawl},
	{queue: queueCrawlNorm, kind: queueKindCrawl},
	{queue: queueAnalysis, kind: queueKindAnalysis},
	{queue: queueAssistant, kind: queueKindAssistant},
	{queue: queueAlerts, kind: queueKindAlerts},
}

// ensureStore creates the BullMQ read surface and the resolvers. Called once
// from Start (the store needs the dedicated blocking client).
func (s *Sources) ensureStore() {
	if s.store == nil {
		if s.options.Store != nil {
			s.store = s.options.Store
		} else {
			s.store = s.newBlockingStore()
		}
	}
	if s.pipelineContext == nil {
		s.pipelineContext = graphqlsubscriptions.NewPipelineJobContextResolver(s.store)
	}
	if s.orgResolvers == nil {
		s.orgResolvers = newQueueOrgResolvers(s.options, s.store, s.pipelineContext)
	}
}

// startQueueReaders starts one loop per stream. The loops stop when ctx is
// cancelled or Close runs.
func (s *Sources) startQueueReaders(ctx context.Context) {
	if s.store == nil {
		return
	}
	for _, stream := range queueStreams {
		stream := stream
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.readQueueStream(ctx, stream)
		}()
	}
}

// readQueueStream is the per-queue XREAD loop: "$" start, count 100, block 1s,
// 200ms retry on read errors (the same values the GraphQL queue observer uses).
func (s *Sources) readQueueStream(ctx context.Context, stream queueStream) {
	streamKey := queueStreamKeyPrefix + stream.queue + queueStreamSuffix
	lastID := "$"
	for {
		if ctx.Err() != nil {
			return
		}
		entries, err := s.store.ReadStream(ctx, streamKey, lastID, queueStreamReadCount, queueStreamReadBlock)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("realtimeevents: BullMQ stream read %s: %v", streamKey, err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(queueStreamRetry):
			}
			continue
		}
		for _, entry := range entries {
			// Advance even for ignored entries so a reconnect resumes after the
			// last observed id instead of replaying the whole stream.
			lastID = entry.ID
			s.handleQueueEntry(ctx, stream, entry)
		}
	}
}

// handleQueueEntry maps one BullMQ event to the local queue/ops/quality pushes.
func (s *Sources) handleQueueEntry(ctx context.Context, stream queueStream, entry graphqlsubscriptions.StreamEntry) {
	eventName, ok := entry.Fields["event"]
	if !ok {
		return
	}
	event, supported := upperQueueEvent(eventName)
	if !supported {
		return
	}
	jobID := entry.Fields["jobId"]
	if jobID == "" {
		return
	}
	sink := s.sinkSnapshot()
	if sink == nil {
		return
	}
	resolver := s.orgResolvers[stream.queue]
	if resolver == nil {
		return
	}
	resolved, ok := resolver.Resolve(ctx, jobID)
	if !ok || resolved.OrgID == "" {
		// The NestJS publishers silently skip events without org context (their
		// debug log). Resolver-level infrastructure problems were logged once by
		// the resolver itself, so this path stays quiet to avoid one line per job.
		return
	}
	if event == "COMPLETED" || event == "FAILED" {
		resolver.Forget(jobID)
	}
	data, hasData := buildQueueEventData(event, entry.Fields)
	timestamp := formatISOMillis(s.now())

	if stream.kind == queueKindPipeline {
		if payload, err := buildQueueEventPayload(resolved, event, jobID, data, hasData, timestamp); err == nil {
			sink.PublishOrg(NamespaceQueue, resolved.OrgID, "queue:event", payload)
		} else {
			log.Printf("realtimeevents: encode queue event failed: %v", err)
		}
	}
	if payload, err := buildOpsEventPayload(stream.kind.source(), resolved, event, jobID, data, hasData, timestamp); err == nil {
		sink.PublishOrg(NamespaceOps, resolved.OrgID, "ops:event", payload)
	} else {
		log.Printf("realtimeevents: encode ops event failed: %v", err)
	}
	if payload, err := buildQualityEventPayload(stream.kind.source(), resolved.OrgID, event, jobID, timestamp); err == nil {
		sink.PublishOrg(NamespaceQuality, resolved.OrgID, "quality:event", payload)
	} else {
		log.Printf("realtimeevents: encode quality event failed: %v", err)
	}
}

// upperQueueEvent maps the BullMQ lowercase event name to the wire event name.
func upperQueueEvent(name string) (string, bool) {
	switch name {
	case "active":
		return "ACTIVE", true
	case "progress":
		return "PROGRESS", true
	case "completed":
		return "COMPLETED", true
	case "failed":
		return "FAILED", true
	default:
		return "", false
	}
}

// buildQueueEventData mirrors the data field the five NestJS publishers build:
//
//	ACTIVE    -> {prev} when prev is truthy, absent otherwise
//	PROGRESS  -> the parsed progress object/array verbatim, or {progress: value}
//	COMPLETED -> the parsed returnvalue object verbatim, or {returnvalue: value}
//	FAILED    -> {reason: failedReason} when non-empty
//
// BullMQ already JSON-parses progress and returnvalue before emitting the
// QueueEvents event, so the Go side has to parse the stream field exactly once
// (the GraphQL observer does the same).
func buildQueueEventData(event string, fields map[string]string) (json.RawMessage, bool) {
	switch event {
	case "ACTIVE":
		prev := fields["prev"]
		if prev == "" {
			return nil, false
		}
		encoded, err := json.Marshal(struct {
			Prev string `json:"prev"`
		}{Prev: prev})
		if err != nil {
			return nil, false
		}
		return encoded, true
	case "PROGRESS":
		raw, present := fields["data"]
		if !present || !json.Valid([]byte(raw)) {
			return nil, false
		}
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return nil, false
		}
		if trimmed[0] == '{' || trimmed[0] == '[' {
			return json.RawMessage(trimmed), true
		}
		encoded, err := json.Marshal(struct {
			Progress json.RawMessage `json:"progress"`
		}{Progress: json.RawMessage(trimmed)})
		if err != nil {
			return nil, false
		}
		return encoded, true
	case "COMPLETED":
		raw, present := fields["returnvalue"]
		if !present || !json.Valid([]byte(raw)) {
			return nil, false
		}
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return nil, false
		}
		if trimmed[0] == '{' {
			return json.RawMessage(trimmed), true
		}
		encoded, err := json.Marshal(struct {
			Returnvalue json.RawMessage `json:"returnvalue"`
		}{Returnvalue: json.RawMessage(trimmed)})
		if err != nil {
			return nil, false
		}
		return encoded, true
	case "FAILED":
		reason := fields["failedReason"]
		if reason == "" {
			return nil, false
		}
		encoded, err := json.Marshal(struct {
			Reason string `json:"reason"`
		}{Reason: reason})
		if err != nil {
			return nil, false
		}
		return encoded, true
	default:
		return nil, false
	}
}

// ---- orgId / job context resolution -------------------------------------

// queueContext is the tenant plus the optional job identifiers the ops/queue
// payloads forward.
type queueContext struct {
	OrgID           string
	PipelineJobID   string
	SourceID        string
	RawItemID       string
	ItemMetaID      string
	ProcessedItemID string
	TaskID          string
	PriorityClass   string
	SourcePriority  *int
}

// queueContextResolver resolves the tenant of one job for a specific stream.
type queueContextResolver interface {
	Resolve(ctx context.Context, jobID string) (queueContext, bool)
	Forget(jobID string)
}

// queueContextCache is the per-instance 10 minute context cache all NestJS
// publishers keep (opportunistic 60s pruning).
type queueContextCache struct {
	mu         sync.Mutex
	entries    map[string]cachedQueueContext
	ttl        time.Duration
	pruneEvery time.Duration
	lastPrune  time.Time
	clock      func() time.Time
}

type cachedQueueContext struct {
	context   queueContext
	expiresAt time.Time
}

func newQueueContextCache(clock func() time.Time) *queueContextCache {
	return &queueContextCache{
		entries:    map[string]cachedQueueContext{},
		ttl:        10 * time.Minute,
		pruneEvery: time.Minute,
		clock:      clock,
	}
}

func (c *queueContextCache) get(key string) (queueContext, bool) {
	if c == nil {
		return queueContext{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock()
	c.pruneLocked(now)
	entry, ok := c.entries[key]
	if !ok {
		return queueContext{}, false
	}
	if !now.Before(entry.expiresAt) {
		delete(c.entries, key)
		return queueContext{}, false
	}
	return entry.context, true
}

func (c *queueContextCache) set(key string, value queueContext) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock()
	c.pruneLocked(now)
	c.entries[key] = cachedQueueContext{context: value, expiresAt: now.Add(c.ttl)}
}

func (c *queueContextCache) forget(key string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

func (c *queueContextCache) pruneLocked(now time.Time) {
	if now.Sub(c.lastPrune) < c.pruneEvery {
		return
	}
	for key, entry := range c.entries {
		if !now.Before(entry.expiresAt) {
			delete(c.entries, key)
		}
	}
	c.lastPrune = now
}

// pipelineResolver adapts the shared graphqlsubscriptions resolver.
type pipelineResolver struct {
	resolver *graphqlsubscriptions.PipelineJobContextResolver
}

func (r *pipelineResolver) Resolve(ctx context.Context, jobID string) (queueContext, bool) {
	if r == nil || r.resolver == nil {
		return queueContext{}, false
	}
	context, ok := r.resolver.Resolve(ctx, jobID)
	if !ok {
		return queueContext{}, false
	}
	return queueContext{
		OrgID:           context.OrgID,
		PipelineJobID:   context.PipelineJobID,
		SourceID:        context.SourceID,
		RawItemID:       context.RawItemID,
		ItemMetaID:      context.ItemMetaID,
		ProcessedItemID: context.ProcessedItemID,
	}, true
}

func (r *pipelineResolver) Forget(string) {}

// crawlResolver resolves a crawl4ai-hot/crawl4ai-normal tenant from the job
// data, with the per-instance cache the NestJS publisher keeps (no shared cache
// for crawl).
type crawlResolver struct {
	store graphqlsubscriptions.QueueStore
	queue string
	cache *queueContextCache
}

func (r *crawlResolver) Resolve(ctx context.Context, jobID string) (queueContext, bool) {
	cacheKey := r.queue + ":" + jobID
	cached, hasCached := r.cache.get(cacheKey)
	raw, ok, err := r.store.ReadJobData(ctx, r.queue, jobID)
	if err == nil && ok {
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &fields) == nil {
			if resolved, valid := crawlContextFromJobFields(fields); valid {
				r.cache.set(cacheKey, resolved)
				return resolved, true
			}
		}
	} else if err != nil {
		log.Printf("realtimeevents: crawl job context read %s/%s: %v", r.queue, jobID, err)
	}
	if hasCached {
		return cached, true
	}
	return queueContext{}, false
}

func (r *crawlResolver) Forget(jobID string) {
	r.cache.forget(r.queue + ":" + jobID)
}

// crawlContextFromJobFields mirrors extractJobContext of the crawl publisher:
// orgId is required and trimmed; sourceId/taskId/priorityClass/sourcePriority are
// optional and a malformed optional field is ignored rather than dropping the
// whole context (the NestJS publisher reads each field independently).
func crawlContextFromJobFields(fields map[string]json.RawMessage) (queueContext, bool) {
	orgID, ok := jobDataTrimmedString(fields, "orgId")
	if !ok {
		return queueContext{}, false
	}
	resolved := queueContext{OrgID: orgID}
	if value, ok := jobDataTrimmedString(fields, "sourceId"); ok {
		resolved.SourceID = value
	}
	if value, ok := jobDataTrimmedString(fields, "taskId"); ok {
		resolved.TaskID = value
	}
	if value, ok := jobDataTrimmedString(fields, "priorityClass"); ok && (value == "hot" || value == "normal") {
		resolved.PriorityClass = value
	}
	if raw, ok := fields["sourcePriority"]; ok {
		var value float64
		if json.Unmarshal(raw, &value) == nil && isFinite(value) {
			// Math.round is floor(x + 0.5) for every finite double.
			rounded := int(math.Floor(value + 0.5))
			resolved.SourcePriority = &rounded
		}
	}
	return resolved, true
}

// simpleOrgResolver is the shared chain for analysis/assistant/alerts: job data
// orgId first (if the queue's job data carries it), then a queue-specific
// lookup, then a job-id-derived fallback, then the per-instance cache.
type simpleOrgResolver struct {
	queue  string
	store  graphqlsubscriptions.QueueStore
	cache  *queueContextCache
	lookup orgIDLookup
}

func (r *simpleOrgResolver) Resolve(ctx context.Context, jobID string) (queueContext, bool) {
	cached, hasCached := r.cache.get(jobID)
	raw, ok, err := r.store.ReadJobData(ctx, r.queue, jobID)
	if err == nil && ok {
		var fields map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &fields) == nil {
			if orgID, found := r.lookup.OrgIDFromJobData(fields); found {
				resolved := queueContext{OrgID: orgID}
				r.cache.set(jobID, resolved)
				return resolved, true
			}
			if identifier, found := r.lookup.IdentifierFromJobData(fields); found {
				if orgID, resolved := r.lookup.ResolveIdentifier(ctx, identifier); resolved {
					resolvedContext := queueContext{OrgID: orgID}
					r.cache.set(jobID, resolvedContext)
					return resolvedContext, true
				}
			}
		}
	} else if err != nil {
		log.Printf("realtimeevents: %s job context read %s: %v", r.queue, jobID, err)
	}
	if identifier, found := r.lookup.InferIdentifier(jobID); found {
		if orgID, resolved := r.lookup.ResolveIdentifier(ctx, identifier); resolved {
			resolvedContext := queueContext{OrgID: orgID}
			r.cache.set(jobID, resolvedContext)
			return resolvedContext, true
		}
	}
	if hasCached {
		return cached, true
	}
	return queueContext{}, false
}

func (r *simpleOrgResolver) Forget(jobID string) {
	r.cache.forget(jobID)
}

// newQueueOrgResolvers builds one resolver per stream.
func newQueueOrgResolvers(options Options, store graphqlsubscriptions.QueueStore, pipeline *graphqlsubscriptions.PipelineJobContextResolver) map[string]queueContextResolver {
	clock := options.Now
	if clock == nil {
		clock = time.Now
	}
	resolvers := map[string]queueContextResolver{
		queuePipeline:  &pipelineResolver{resolver: pipeline},
		queueCrawlHot:  &crawlResolver{store: store, queue: queueCrawlHot, cache: newQueueContextCache(clock)},
		queueCrawlNorm: &crawlResolver{store: store, queue: queueCrawlNorm, cache: newQueueContextCache(clock)},
		queueAnalysis: &simpleOrgResolver{
			queue: queueAnalysis, store: store, cache: newQueueContextCache(clock),
			lookup: newAnalysisOrgLookup(options.Mongo),
		},
		queueAssistant: &simpleOrgResolver{
			queue: queueAssistant, store: store, cache: newQueueContextCache(clock),
			lookup: newAssistantOrgLookup(options.Mongo),
		},
		queueAlerts: &simpleOrgResolver{
			queue: queueAlerts, store: store, cache: newQueueContextCache(clock),
			lookup: newAlertsOrgLookup(options.DB),
		},
	}
	return resolvers
}

var assistantJobIDPattern = regexp.MustCompile(`^assistant:(query|report|forecast):(.+)$`)
