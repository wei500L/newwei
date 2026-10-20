package graphqlsubscriptions

import (
	"context"
	"encoding/json"
)

// PipelineCompleted is one completed itemPipeline event with its tenant already
// resolved by the shared observer. Data is the parsed completed payload exactly
// as QueueEventPublisher builds it for the GraphQL feed (the returnvalue object,
// or {"returnvalue": ...} for a non-object returnvalue).
type PipelineCompleted struct {
	// EntryID is the stream entry id that produced the event.
	EntryID string
	// JobID is the BullMQ itemPipeline job id.
	JobID string
	// OrgID is the tenant resolved from the job data, the local jobctx cache or
	// the shared queue:pipeline:jobctx cache, in that order.
	OrgID string
	// Data is nil when the event carried no usable payload.
	Data json.RawMessage
}

// PipelineCompletedHandler consumes completed events inside the observer read
// loop. It must not block; enqueue failures are handled (and logged) by the
// consumer.
type PipelineCompletedHandler func(context.Context, PipelineCompleted)

// AddPipelineCompletedHandler registers one extra consumer on the process-wide
// XREAD loop and returns an unsubscribe function. Any number of consumers can
// share the observer; a nil observer or handler is a no-op.
//
// This is the reuse point for the classification review-seed trigger: when the
// GraphQL subscription runtime is active it already owns the loop, so the seed
// consumer attaches here instead of opening a second XREAD connection (O2).
func (q *QueueObserver) AddPipelineCompletedHandler(handler PipelineCompletedHandler) func() {
	if q == nil || handler == nil {
		return func() {}
	}
	q.completedMu.Lock()
	if q.completedHandlers == nil {
		q.completedHandlers = map[uint64]PipelineCompletedHandler{}
	}
	q.nextCompletedID++
	id := q.nextCompletedID
	q.completedHandlers[id] = handler
	q.completedMu.Unlock()
	return func() {
		q.completedMu.Lock()
		delete(q.completedHandlers, id)
		q.completedMu.Unlock()
	}
}

// dispatchPipelineCompleted snapshots the handlers and invokes them in
// registration order. A handler panic is not recovered: the consumers here are
// internal loops that must not hide programming errors.
func (q *QueueObserver) dispatchPipelineCompleted(ctx context.Context, entryID, jobID, orgID string, data *string) {
	q.completedMu.Lock()
	handlers := make([]PipelineCompletedHandler, 0, len(q.completedHandlers))
	for _, handler := range q.completedHandlers {
		handlers = append(handlers, handler)
	}
	q.completedMu.Unlock()
	if len(handlers) == 0 {
		return
	}
	event := PipelineCompleted{EntryID: entryID, JobID: jobID, OrgID: orgID}
	if data != nil && *data != "" {
		event.Data = json.RawMessage(*data)
	}
	for _, handler := range handlers {
		handler(ctx, event)
	}
}
