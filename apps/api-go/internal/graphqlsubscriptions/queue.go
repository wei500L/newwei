package graphqlsubscriptions

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

const (
	itemPipelineQueueName = "itemPipeline"
	bullPrefix            = "bull"
	itemPipelineStream    = "bull:itemPipeline:events"
	jobContextKeyPrefix   = "queue:pipeline:jobctx:"

	localContextTTL      = 10 * time.Minute
	sharedContextTTL     = 600 * time.Second
	contextPruneInterval = 60 * time.Second
	streamReadBlock      = time.Second
	streamReadCount      = 100
)

// StreamEntry is one BullMQ event stream entry with string fields.
type StreamEntry struct {
	ID     string
	Fields map[string]string
}

// QueueStore is the read-only Redis surface of the observer. Only XREAD of the
// shared stream and the existing job hash / jobctx cache are used: no
// XREADGROUP, no ACK, no worker and no stream or job mutation.
type QueueStore interface {
	ReadStream(ctx context.Context, stream, lastID string, count int64, block time.Duration) ([]StreamEntry, error)
	ReadJobData(ctx context.Context, queue, jobID string) (string, bool, error)
	ReadSharedContext(ctx context.Context, key string) ([]byte, bool, error)
	WriteSharedContext(ctx context.Context, key string, body []byte, ttl time.Duration) error
	Close() error
}

type redisQueueStore struct {
	blocking *redis.Client
	shared   *redis.Client
}

func newRedisQueueStore(blockingOptions *redis.Options, shared *redis.Client) *redisQueueStore {
	return &redisQueueStore{
		blocking: redis.NewClient(blockingOptions),
		shared:   shared,
	}
}

func (s *redisQueueStore) ReadStream(ctx context.Context, stream, lastID string, count int64, block time.Duration) ([]StreamEntry, error) {
	streams, err := s.blocking.XRead(ctx, &redis.XReadArgs{
		Streams: []string{stream, lastID},
		Count:   count,
		Block:   block,
	}).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries := make([]StreamEntry, 0)
	for _, item := range streams {
		for _, message := range item.Messages {
			fields := make(map[string]string, len(message.Values))
			for key, value := range message.Values {
				if text, ok := value.(string); ok {
					fields[key] = text
				}
			}
			entries = append(entries, StreamEntry{ID: message.ID, Fields: fields})
		}
	}
	return entries, nil
}

func (s *redisQueueStore) ReadJobData(ctx context.Context, queue, jobID string) (string, bool, error) {
	value, err := s.shared.HGet(ctx, bullPrefix+":"+queue+":"+jobID, "data").Result()
	if err == redis.Nil {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (s *redisQueueStore) ReadSharedContext(ctx context.Context, key string) ([]byte, bool, error) {
	value, err := s.shared.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

func (s *redisQueueStore) WriteSharedContext(ctx context.Context, key string, body []byte, ttl time.Duration) error {
	return s.shared.Set(ctx, key, body, ttl).Err()
}

func (s *redisQueueStore) Close() error {
	if s == nil || s.blocking == nil {
		return nil
	}
	return s.blocking.Close()
}

// queueJobContext is the tenant routing record stored in the job data and in
// the shared queue:pipeline:jobctx:<jobId> cache. Optional identifiers are kept
// so a shared-cache write never drops a field another instance may need.
type queueJobContext struct {
	OrgID           string `json:"orgId"`
	PipelineJobID   string `json:"pipelineJobId,omitempty"`
	SourceID        string `json:"sourceId,omitempty"`
	RawItemID       string `json:"rawItemId,omitempty"`
	ItemMetaID      string `json:"itemMetaId,omitempty"`
	ProcessedItemID string `json:"processedItemId,omitempty"`
}

type jobDataPayload struct {
	OrgID           *string `json:"orgId"`
	PipelineJobID   *string `json:"pipelineJobId"`
	SourceID        *string `json:"sourceId"`
	RawItemID       *string `json:"rawItemId"`
	ItemMetaID      *string `json:"itemMetaId"`
	ProcessedItemID *string `json:"processedItemId"`
}

type localContextEntry struct {
	context   queueJobContext
	expiresAt time.Time
}

type queueFeed struct {
	channel chan FeedEvent
}

type queueHub struct {
	mu      sync.Mutex
	feeds   map[string]map[*queueFeed]struct{}
	closing bool
}

func newQueueHub() *queueHub {
	return &queueHub{feeds: map[string]map[*queueFeed]struct{}{}}
}

func (h *queueHub) subscribe(orgID string) (*queueFeed, func()) {
	feed := &queueFeed{channel: make(chan FeedEvent, feedBuffer)}
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		close(feed.channel)
		return feed, func() {}
	}
	if h.feeds[orgID] == nil {
		h.feeds[orgID] = map[*queueFeed]struct{}{}
	}
	h.feeds[orgID][feed] = struct{}{}
	h.mu.Unlock()
	return feed, func() {
		h.mu.Lock()
		feeds := h.feeds[orgID]
		if feeds != nil {
			if _, ok := feeds[feed]; ok {
				delete(feeds, feed)
				if len(feeds) == 0 {
					delete(h.feeds, orgID)
				}
				close(feed.channel)
			}
		}
		h.mu.Unlock()
	}
}

// publish fans out to matching organizations only. Non-terminal events may be
// dropped for a full (slow) feed; a terminal completed/failed event evicts one
// older item so the terminal state is not lost.
func (h *queueHub) publish(orgID string, event FeedEvent, terminal bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return
	}
	for feed := range h.feeds[orgID] {
		select {
		case feed.channel <- event:
		default:
			if !terminal {
				continue
			}
			select {
			case <-feed.channel:
			default:
			}
			select {
			case feed.channel <- event:
			default:
			}
		}
	}
}

func (h *queueHub) closeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return
	}
	h.closing = true
	for _, feeds := range h.feeds {
		for feed := range feeds {
			close(feed.channel)
		}
	}
	h.feeds = map[string]map[*queueFeed]struct{}{}
}

// QueueObserver is the single per-process BullMQ observation chain. It starts
// once and keeps observing even when no local operation is subscribed, so an
// active/progress event can populate the shared job context before
// removeOnComplete removes the job.
type QueueObserver struct {
	store QueueStore
	clock func() time.Time
	hub   *queueHub

	mu        sync.Mutex
	local     map[string]localContextEntry
	lastPrune time.Time

	// completedMu guards the extra consumers registered on this read loop.
	// Review-seed triggering and any future itemPipeline observer share the one
	// XREAD loop instead of opening a second one (optimization O2).
	completedMu       sync.Mutex
	completedHandlers map[uint64]PipelineCompletedHandler
	nextCompletedID   uint64

	startOnce sync.Once
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

func NewQueueObserver(store QueueStore) *QueueObserver {
	return &QueueObserver{
		store: store,
		clock: time.Now,
		hub:   newQueueHub(),
		local: map[string]localContextEntry{},
	}
}

// NewRedisQueueObserver builds the production observer. The blocking XREAD
// client is independent from sharedClient, which is used for the job hash and
// the existing jobctx cache.
func NewRedisQueueObserver(blockingOptions *redis.Options, sharedClient *redis.Client) *QueueObserver {
	return NewQueueObserver(newRedisQueueStore(blockingOptions, sharedClient))
}

func (q *QueueObserver) Start(ctx context.Context) {
	if q == nil || q.store == nil {
		return
	}
	q.startOnce.Do(func() {
		runCtx, cancel := context.WithCancel(ctx)
		q.mu.Lock()
		q.cancel = cancel
		q.wg.Add(1)
		q.mu.Unlock()
		go func() {
			defer q.wg.Done()
			q.readLoop(runCtx)
		}()
	})
}

func (q *QueueObserver) readLoop(ctx context.Context) {
	lastID := "$"
	for {
		if ctx.Err() != nil {
			return
		}
		entries, err := q.store.ReadStream(ctx, itemPipelineStream, lastID, streamReadCount, streamReadBlock)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("graphqlsubscriptions: BullMQ stream read: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}
		for _, entry := range entries {
			// Advance even for ignored event names so a reconnect resumes after
			// the last observed entry instead of replaying the whole stream.
			lastID = entry.ID
			q.handle(ctx, entry)
		}
	}
}

func (q *QueueObserver) handle(ctx context.Context, entry StreamEntry) {
	eventName, ok := entry.Fields["event"]
	if !ok {
		return
	}
	jobID := entry.Fields["jobId"]
	if jobID == "" {
		return
	}
	event, terminal, supported := queueEventName(eventName)
	if !supported {
		return
	}
	jobContext, ok := q.resolveContext(ctx, jobID)
	if !ok || jobContext.OrgID == "" {
		return
	}
	data, _ := queueEventData(eventName, entry.Fields)
	model := workspace.QueueEventModel{
		Data:      data,
		Event:     event,
		JobID:     jobID,
		Timestamp: contract.FormatDateTime(q.clock().UTC()),
	}
	q.hub.publish(jobContext.OrgID, FeedEvent{Value: model}, terminal)
	if event == "COMPLETED" {
		// Extra consumers (classification review seed) observe the same entry
		// after the GraphQL feed has been handed off, so enqueue latency never
		// delays a subscriber. Handlers resolve their own errors.
		q.dispatchPipelineCompleted(ctx, entry.ID, jobID, jobContext.OrgID, data)
	}
	if terminal {
		// Keep the shared cache so a cold instance can still resolve the
		// removed job; only this instance's local context is gone.
		q.deleteLocal(jobID)
	}
}

func queueEventName(name string) (string, bool, bool) {
	switch name {
	case "active":
		return "ACTIVE", false, true
	case "progress":
		return "PROGRESS", false, true
	case "completed":
		return "COMPLETED", true, true
	case "failed":
		return "FAILED", true, true
	default:
		return "", false, false
	}
}

type activeQueueData struct {
	Prev string `json:"prev"`
}

type progressQueueData struct {
	Progress json.RawMessage `json:"progress"`
}

type completedQueueData struct {
	Returnvalue json.RawMessage `json:"returnvalue"`
}

type failedQueueData struct {
	Reason string `json:"reason"`
}

// queueEventData mirrors QueueEventPublisher's payload construction. BullMQ
// writes progress.data and completed.returnvalue as JSON text; they are parsed
// once here and never double-encoded.
func queueEventData(name string, fields map[string]string) (*string, bool) {
	switch name {
	case "active":
		prev, present := fields["prev"]
		if !present || prev == "" {
			return nil, false
		}
		encoded, err := json.Marshal(activeQueueData{Prev: prev})
		if err != nil {
			return nil, false
		}
		text := string(encoded)
		return &text, true
	case "progress":
		raw, present := fields["data"]
		if !present || !json.Valid([]byte(raw)) {
			return nil, false
		}
		trimmed := bytes.TrimSpace([]byte(raw))
		if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
			text := string(trimmed)
			return &text, true
		}
		encoded, err := json.Marshal(progressQueueData{Progress: json.RawMessage(trimmed)})
		if err != nil {
			return nil, false
		}
		text := string(encoded)
		return &text, true
	case "completed":
		raw, present := fields["returnvalue"]
		if !present || !json.Valid([]byte(raw)) {
			return nil, false
		}
		trimmed := bytes.TrimSpace([]byte(raw))
		if len(trimmed) > 0 && trimmed[0] == '{' {
			text := string(trimmed)
			return &text, true
		}
		encoded, err := json.Marshal(completedQueueData{Returnvalue: json.RawMessage(trimmed)})
		if err != nil {
			return nil, false
		}
		text := string(encoded)
		return &text, true
	case "failed":
		reason, _ := fields["failedReason"]
		if reason == "" {
			return nil, false
		}
		encoded, err := json.Marshal(failedQueueData{Reason: reason})
		if err != nil {
			return nil, false
		}
		text := string(encoded)
		return &text, true
	default:
		return nil, false
	}
}

func (q *QueueObserver) resolveContext(ctx context.Context, jobID string) (queueJobContext, bool) {
	cached, hasCached := q.cachedContext(jobID)
	if raw, ok, err := q.store.ReadJobData(ctx, itemPipelineQueueName, jobID); err == nil && ok {
		if jobContext, valid := extractJobContext([]byte(raw)); valid {
			q.storeContext(jobID, jobContext)
			return jobContext, true
		}
	} else if err != nil {
		log.Printf("graphqlsubscriptions: queue job context read %s: %v", jobID, err)
	}
	if hasCached {
		return cached, true
	}
	// Cross-instance fallback: the job may already be removed after a terminal
	// event, and this instance may never have observed the earlier active.
	if raw, ok, err := q.store.ReadSharedContext(ctx, jobContextKey(jobID)); err == nil && ok {
		if jobContext, valid := extractJobContext(raw); valid {
			q.warmLocal(jobID, jobContext)
			return jobContext, true
		}
	} else if err != nil {
		log.Printf("graphqlsubscriptions: shared queue job context read %s: %v", jobID, err)
	}
	return queueJobContext{}, false
}

func extractJobContext(raw []byte) (queueJobContext, bool) {
	var payload jobDataPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return queueJobContext{}, false
	}
	orgID := trimmedPointer(payload.OrgID)
	if orgID == "" {
		return queueJobContext{}, false
	}
	return queueJobContext{
		OrgID:           orgID,
		PipelineJobID:   trimmedPointer(payload.PipelineJobID),
		SourceID:        trimmedPointer(payload.SourceID),
		RawItemID:       trimmedPointer(payload.RawItemID),
		ItemMetaID:      trimmedPointer(payload.ItemMetaID),
		ProcessedItemID: trimmedPointer(payload.ProcessedItemID),
	}, true
}

func trimmedPointer(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func jobContextKey(jobID string) string {
	return jobContextKeyPrefix + jobID
}

func (q *QueueObserver) cachedContext(jobID string) (queueJobContext, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := q.clock()
	q.pruneLocked(now)
	entry, ok := q.local[jobID]
	if !ok {
		return queueJobContext{}, false
	}
	if !now.Before(entry.expiresAt) {
		delete(q.local, jobID)
		return queueJobContext{}, false
	}
	return entry.context, true
}

func (q *QueueObserver) warmLocal(jobID string, jobContext queueJobContext) {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := q.clock()
	q.pruneLocked(now)
	q.local[jobID] = localContextEntry{context: jobContext, expiresAt: now.Add(localContextTTL)}
}

func (q *QueueObserver) storeContext(jobID string, jobContext queueJobContext) {
	q.warmLocal(jobID, jobContext)
	encoded, err := json.Marshal(jobContext)
	if err != nil {
		return
	}
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := q.store.WriteSharedContext(writeCtx, jobContextKey(jobID), encoded, sharedContextTTL); err != nil {
		log.Printf("graphqlsubscriptions: shared queue job context write %s: %v", jobID, err)
	}
}

func (q *QueueObserver) deleteLocal(jobID string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	delete(q.local, jobID)
}

func (q *QueueObserver) pruneLocked(now time.Time) {
	if now.Sub(q.lastPrune) < contextPruneInterval {
		return
	}
	for jobID, entry := range q.local {
		if !now.Before(entry.expiresAt) {
			delete(q.local, jobID)
		}
	}
	q.lastPrune = now
}

// Subscribe registers one organization feed on this instance. It never
// publishes to Redis: each API instance already reads the same BullMQ stream,
// so re-publishing would deliver a job once per instance.
func (q *QueueObserver) Subscribe(ctx context.Context, orgID string) <-chan FeedEvent {
	feed, remove := q.hub.subscribe(orgID)
	go func() {
		<-ctx.Done()
		remove()
	}()
	return feed.channel
}

func (q *QueueObserver) Close(ctx context.Context) error {
	if q == nil {
		return nil
	}
	q.mu.Lock()
	cancel := q.cancel
	q.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() {
		q.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	q.hub.closeAll()
	q.completedMu.Lock()
	q.completedHandlers = nil
	q.completedMu.Unlock()
	if q.store != nil {
		return q.store.Close()
	}
	return nil
}
