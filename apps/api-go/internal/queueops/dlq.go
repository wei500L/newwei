package queueops

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// This file ports the itemPipelineDlq inspection, replay and deletion duties the
// NestJS process had no route for.
//
// QueueProcessor's 'failed' listener appends the failure context to the original
// job payload before it enqueues the dead-letter job (itempipeline/processor.go):
//
//	{...data, originalQueue, originalJobId, failedAt, attempts, attemptsMade,
//	 errorKind, error}
//
// The spread keeps the position of a key that already existed, so a field the
// original payload happens to share with the envelope is overwritten in place.
// Replaying such a payload would silently lose the original value, which is why
// the strip below refuses anything it can prove polluted instead of guessing.

// dlqEnvelopeKeys is the ordered field list the dead-letter envelope appends. The
// order is the order processor.go passes to mergeOrderedJSON.
var dlqEnvelopeKeys = []string{
	"originalQueue",
	"originalJobId",
	"failedAt",
	"attempts",
	"attemptsMade",
	"errorKind",
	"error",
}

// dlqEnvelope is one stripped dead-letter payload.
type dlqEnvelope struct {
	// Queue is the originalQueue envelope field: the queue the job came from.
	Queue string
	// JobID is the originalJobId envelope field; empty when the payload stored
	// null (the processor writes null for a job without an id).
	JobID string
	// OrgID is the orgId of the stripped payload.
	OrgID string
	// Data is the original payload with every envelope field removed.
	Data json.RawMessage
}

// jsonMember is one member of a stored JSON object, keeping its position.
type jsonMember struct {
	key     string
	encoded json.RawMessage
}

// replayJobID is the deterministic job id of one replay. Because the id only
// depends on the dead-letter job id, repeating a replay cannot create a second
// itemPipeline job.
func replayJobID(dlqJobID string) string {
	return replayJobIDPrefix + dlqJobID
}

// isDLQEnvelopeKey reports whether key belongs to the dead-letter envelope.
func isDLQEnvelopeKey(key string) bool {
	for _, candidate := range dlqEnvelopeKeys {
		if candidate == key {
			return true
		}
	}
	return false
}

// parseOrderedObject decodes a JSON object into its members in document order.
// A non-object document is an envelope error: BullMQ payloads are always objects.
func parseOrderedObject(data json.RawMessage) ([]jsonMember, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, newEnvelopeError("dead-letter payload is empty")
	}
	if trimmed[0] != '{' {
		return nil, newEnvelopeError("dead-letter payload is not a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, newEnvelopeError("dead-letter payload is not valid JSON")
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, newEnvelopeError("dead-letter payload is not a JSON object")
	}
	members := make([]jsonMember, 0, 12)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, newEnvelopeError("dead-letter payload is not valid JSON")
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, newEnvelopeError("dead-letter payload key is not a string")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, newEnvelopeError("dead-letter payload is not valid JSON")
		}
		members = append(members, jsonMember{key: key, encoded: value})
	}
	return members, nil
}

// encodeOrderedObject renders members back into a JSON object, keeping order.
func encodeOrderedObject(members []jsonMember) json.RawMessage {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, member := range members {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := json.Marshal(member.key)
		if err != nil {
			continue
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(member.encoded)
	}
	buffer.WriteByte('}')
	return json.RawMessage(buffer.Bytes())
}

// stripDLQEnvelope validates and removes the dead-letter envelope.
//
// It answers an envelopeError (HTTP 422) in every case it refuses:
//
//   - originalQueue is missing, not a string, or not "itemPipeline";
//   - an envelope field other than originalQueue appears before originalQueue,
//     which proves the original payload had that field and the envelope
//     overwrote it in place;
//   - the stripped payload has no non-empty orgId.
//
// One case cannot be detected and is accepted: if the original payload itself
// contained "originalQueue", the envelope overwrote it in place and the stripped
// payload is missing that field. Nothing in the dead-letter document records
// whether it was there, so the replay proceeds with the rest of the payload
// intact. It is documented here so the gap is explicit rather than silent.
func stripDLQEnvelope(data json.RawMessage) (dlqEnvelope, error) {
	members, err := parseOrderedObject(data)
	if err != nil {
		return dlqEnvelope{}, err
	}
	queueIndex := -1
	for index, member := range members {
		if member.key == "originalQueue" {
			queueIndex = index
			break
		}
	}
	if queueIndex < 0 {
		return dlqEnvelope{}, newEnvelopeError("dead-letter payload is not an itemPipeline envelope: originalQueue is missing")
	}
	var originalQueue string
	if err := json.Unmarshal(members[queueIndex].encoded, &originalQueue); err != nil || originalQueue == "" {
		return dlqEnvelope{}, newEnvelopeError("dead-letter payload is not an itemPipeline envelope: originalQueue is not a non-empty string")
	}
	if originalQueue != pipelineenqueue.QueueName {
		return dlqEnvelope{}, newEnvelopeError(fmt.Sprintf(
			"dead-letter payload is not an itemPipeline envelope: originalQueue is %q, want %q",
			originalQueue, pipelineenqueue.QueueName))
	}
	conflicts := make([]string, 0, 2)
	for index := 0; index < queueIndex; index++ {
		if isDLQEnvelopeKey(members[index].key) {
			conflicts = append(conflicts, members[index].key)
		}
	}
	if len(conflicts) > 0 {
		return dlqEnvelope{}, newEnvelopeError(fmt.Sprintf(
			"dead-letter payload is polluted: %s appear before originalQueue, so the original value of each was overwritten by the envelope; refusing to replay",
			quoteJoin(conflicts)))
	}
	originalJobID := ""
	stripped := make([]jsonMember, 0, len(members))
	for _, member := range members {
		if !isDLQEnvelopeKey(member.key) {
			stripped = append(stripped, member)
			continue
		}
		if member.key == "originalJobId" {
			var text string
			if err := json.Unmarshal(member.encoded, &text); err == nil {
				originalJobID = text
			}
		}
	}
	payload := encodeOrderedObject(stripped)
	orgID := bullmqwire.OrgIDFromData(payload)
	if orgID == "" {
		return dlqEnvelope{}, newEnvelopeError("dead-letter payload has no orgId after the envelope was stripped; refusing to replay")
	}
	return dlqEnvelope{
		Queue: originalQueue,
		JobID: originalJobID,
		OrgID: orgID,
		Data:  payload,
	}, nil
}

// quoteJoin renders field names for an operator-facing message.
func quoteJoin(names []string) string {
	quoted := make([]string, 0, len(names))
	for _, name := range names {
		quoted = append(quoted, fmt.Sprintf("%q", name))
	}
	return strings.Join(quoted, ", ")
}

// ReplayDLQ replays one dead-letter job into itemPipeline.
//
// The new job is added first; the dead-letter job is deleted only after the add
// succeeded. If the add succeeded and the delete did not, the call still answers
// 200 with replayed=true, dlqRemoved=false and a warning: the determinism of the
// replay job id means the next replay returns the existing job instead of adding
// a second one.
func (s *Service) ReplayDLQ(ctx context.Context, actor Actor, dlqJobID string, dryRun bool) (DLQReplayResult, error) {
	if s == nil || s.redis == nil {
		return DLQReplayResult{}, errRedisUnavailable
	}
	result, err := s.replayOne(ctx, dlqJobID, dryRun)
	if err != nil {
		return DLQReplayResult{}, err
	}
	if !dryRun {
		s.auditDLQReplay(ctx, actor, dlqReplayAuditMetadata{
			Queue:         dlqQueue,
			JobID:         dlqJobID,
			OriginalJobID: result.OriginalJobID,
			NewJobID:      result.NewJobID,
			TargetOrgID:   result.OrgID,
		})
	}
	return result, nil
}

// ReplayDLQBatch replays a page of dead-letter jobs.
//
// One item never aborts the batch: a missing or malformed dead-letter job is
// reported in its own result (replayed=false, warning explains why). When the
// plan carries no explicit ids, the first plan.Limit waiting dead-letter jobs are
// replayed.
func (s *Service) ReplayDLQBatch(ctx context.Context, actor Actor, plan replayPlan) (DLQReplayResponse, error) {
	if s == nil || s.redis == nil {
		return DLQReplayResponse{}, errRedisUnavailable
	}
	ids := plan.JobIDs
	if len(ids) == 0 {
		raw, err := scriptGetRanges.Run(ctx, s.redis, []string{s.queueKeys(dlqQueue).Base},
			0, int64(plan.Limit-1), "0", "wait").Result()
		if err != nil {
			return DLQReplayResponse{}, err
		}
		ids = firstRangeIDs(raw)
	}
	results := make([]DLQReplayResult, 0, len(ids))
	for _, jobID := range ids {
		result, err := s.replayOne(ctx, jobID, plan.DryRun)
		if err != nil {
			log.Printf("queueops: dlq replay failed for %s: %v", jobID, err)
			message := err.Error()
			results = append(results, DLQReplayResult{DlqJobID: jobID, Warning: &message})
			continue
		}
		if !plan.DryRun {
			s.auditDLQReplay(ctx, actor, dlqReplayAuditMetadata{
				Queue:         dlqQueue,
				JobID:         jobID,
				OriginalJobID: result.OriginalJobID,
				NewJobID:      result.NewJobID,
				TargetOrgID:   result.OrgID,
			})
		}
		results = append(results, result)
	}
	return DLQReplayResponse{Results: results}, nil
}

// replayEnqueuer is the itemPipeline add step of one dead-letter replay.
type replayEnqueuer func(ctx context.Context, jobID string, data json.RawMessage, orgID string) (string, error)

// replayRemover is the dead-letter cleanup step of one dead-letter replay.
type replayRemover func(ctx context.Context, queue, jobID string) (bool, error)

// replayOne is the shared single-job replay used by both replay routes.
func (s *Service) replayOne(ctx context.Context, dlqJobID string, dryRun bool) (DLQReplayResult, error) {
	if !dryRun && s.producer == nil {
		return DLQReplayResult{}, fmt.Errorf("queueops: replay producer is not configured")
	}
	keys := s.queueKeys(dlqQueue)
	job, err := bullmqwire.ReadJob(ctx, s.redis, keys, dlqJobID)
	if err != nil {
		return DLQReplayResult{}, err
	}
	if job == nil {
		return DLQReplayResult{}, newStatus(http.StatusNotFound, "dead-letter job not found")
	}
	envelope, err := stripDLQEnvelope(job.Data)
	if err != nil {
		return DLQReplayResult{}, err
	}
	enqueue := func(ctx context.Context, jobID string, data json.RawMessage, orgID string) (string, error) {
		return s.producer.EnqueueReplay(ctx, jobID, data, orgID)
	}
	remove := func(ctx context.Context, queue, jobID string) (bool, error) {
		return s.removeJob(ctx, queue, jobID)
	}
	return s.applyReplay(ctx, dlqJobID, envelope, dryRun, enqueue, remove)
}

// applyReplay is the add-then-delete sequence of one replay.
//
// The two side effects are injected so the "added but not cleaned up" outcome is
// testable without Redis. The order is the contract: the dead-letter job is only
// removed after the itemPipeline job exists, and a removal failure leaves
// replayed=true, dlqRemoved=false and a warning instead of failing the request.
// A failed add is a returned error because nothing was replayed; the batch route
// turns that error into one result with replayed=false.
func (s *Service) applyReplay(
	ctx context.Context,
	dlqJobID string,
	envelope dlqEnvelope,
	dryRun bool,
	enqueue replayEnqueuer,
	remove replayRemover,
) (DLQReplayResult, error) {
	result := DLQReplayResult{
		DlqJobID:      dlqJobID,
		OriginalJobID: envelope.JobID,
		OriginalQueue: envelope.Queue,
		OrgID:         envelope.OrgID,
		NewJobID:      replayJobID(dlqJobID),
	}
	if dryRun {
		warning := "dry run: no itemPipeline job was added and the dead-letter job was not removed"
		result.Warning = &warning
		return result, nil
	}
	if enqueue == nil || remove == nil {
		return DLQReplayResult{}, fmt.Errorf("queueops: replay step is not configured")
	}
	enqueuedID, err := enqueue(ctx, result.NewJobID, envelope.Data, envelope.OrgID)
	if err != nil {
		return DLQReplayResult{}, err
	}
	result.NewJobID = enqueuedID
	result.Replayed = true
	if _, err := remove(ctx, dlqQueue, dlqJobID); err != nil {
		warning := fmt.Sprintf("itemPipeline job %s was added but the dead-letter job was not removed: %v; repeating the replay returns the existing job because the id is deterministic",
			result.NewJobID, err)
		result.Warning = &warning
		return result, nil
	}
	result.DlqRemoved = true
	return result, nil
}

// DeleteDLQ removes one dead-letter job. A locked job is a 409; a missing job is
// a 404.
func (s *Service) DeleteDLQ(ctx context.Context, actor Actor, dlqJobID string) (DLQDeleteResult, error) {
	if s == nil || s.redis == nil {
		return DLQDeleteResult{}, errRedisUnavailable
	}
	result, err := s.deleteOneDLQ(ctx, dlqJobID)
	if err != nil {
		return DLQDeleteResult{}, err
	}
	if result.Deleted {
		s.auditJob(ctx, actor, actionDLQDelete, dlqQueue, dlqJobID)
	}
	return result, nil
}

// DeleteDLQBatch removes a page of dead-letter jobs, one result per id. A job
// that is missing or locked reports deleted=false instead of failing the batch.
func (s *Service) DeleteDLQBatch(ctx context.Context, actor Actor, dlqJobIDs []string) (DLQDeleteResponse, error) {
	if s == nil || s.redis == nil {
		return DLQDeleteResponse{}, errRedisUnavailable
	}
	results := make([]DLQDeleteResult, 0, len(dlqJobIDs))
	for _, jobID := range dlqJobIDs {
		result, err := s.deleteOneDLQ(ctx, jobID)
		if err != nil {
			log.Printf("queueops: dlq delete failed for %s: %v", jobID, err)
			results = append(results, DLQDeleteResult{DlqJobID: jobID})
			continue
		}
		if result.Deleted {
			s.auditJob(ctx, actor, actionDLQDelete, dlqQueue, jobID)
		}
		results = append(results, result)
	}
	return DLQDeleteResponse{Results: results}, nil
}

// deleteOneDLQ is the shared single-job deletion used by both delete routes.
func (s *Service) deleteOneDLQ(ctx context.Context, dlqJobID string) (DLQDeleteResult, error) {
	keys := s.queueKeys(dlqQueue)
	job, err := bullmqwire.ReadJob(ctx, s.redis, keys, dlqJobID)
	if err != nil {
		return DLQDeleteResult{}, err
	}
	if job == nil {
		return DLQDeleteResult{}, newStatus(http.StatusNotFound, "dead-letter job not found")
	}
	if _, err := s.removeJob(ctx, dlqQueue, dlqJobID); err != nil {
		return DLQDeleteResult{}, err
	}
	return DLQDeleteResult{DlqJobID: dlqJobID, Deleted: true}, nil
}
