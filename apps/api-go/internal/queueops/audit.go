package queueops

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"time"
)

// The audit vocabulary of this console.
const (
	// auditResource is the AuditLog resource of every queue operation.
	auditResource = "queue"

	// actionJobRetry is Job.retry.
	actionJobRetry = "job_retry"
	// actionJobDelete is Job.remove.
	actionJobDelete = "job_delete"
	// actionJobPromote is Job.promote.
	actionJobPromote = "job_promote"
	// actionQueueRetryFailed is the batch retry of the failed set.
	actionQueueRetryFailed = "queue_retry_failed"
	// actionQueueClean is Queue.clean.
	actionQueueClean = "queue_clean"
	// actionQueuePause is Queue.pause.
	actionQueuePause = "queue_pause"
	// actionQueueResume is Queue.resume.
	actionQueueResume = "queue_resume"
	// actionDLQReplay is the itemPipelineDlq replay.
	actionDLQReplay = "dlq_replay"
	// actionDLQDelete is the itemPipelineDlq deletion.
	actionDLQDelete = "dlq_delete"
)

// auditExecer is the MySQL handle the audit chain writes through. *sql.DB
// satisfies it; the unit tests inject a recording fake so no MySQL is needed.
type auditExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// auditOutboxPayload is the AuditLogOutbox payload document. Its field set and
// order match writeAuditLogBestEffort in modules/audit/audit-log.writer.ts so the
// retry worker can replay a Go-written row without changes.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// auditEntry is one best-effort AuditLog row.
type auditEntry struct {
	OrgID    string
	ActorID  string
	Resource string
	Action   string
	Metadata json.RawMessage
}

// The audit metadata documents. Every one is a named struct: no schema-less map
// ever reaches the AuditLog.metadata column.

// jobAuditMetadata is the metadata of one per-job operation.
type jobAuditMetadata struct {
	Queue string `json:"queue"`
	JobID string `json:"jobId"`
}

// retryFailedAuditMetadata is the metadata of the batch failed-set retry.
type retryFailedAuditMetadata struct {
	Queue   string `json:"queue"`
	Limit   int    `json:"limit"`
	Matched int    `json:"matched"`
	Retried int    `json:"retried"`
}

// cleanAuditMetadata is the metadata of Queue.clean. Grace is in milliseconds.
type cleanAuditMetadata struct {
	Queue   string `json:"queue"`
	State   string `json:"state"`
	Grace   int64  `json:"grace"`
	Limit   int    `json:"limit"`
	Removed int    `json:"removed"`
}

// pauseAuditMetadata is the metadata of Queue.pause and Queue.resume.
type pauseAuditMetadata struct {
	Queue  string `json:"queue"`
	Paused bool   `json:"paused"`
}

// dlqReplayAuditMetadata is the metadata of one dead-letter replay.
type dlqReplayAuditMetadata struct {
	Queue         string `json:"queue"`
	JobID         string `json:"jobId"`
	OriginalJobID string `json:"originalJobId"`
	NewJobID      string `json:"newJobId"`
	TargetOrgID   string `json:"targetOrgId"`
}

// writeAuditLogBestEffort mirrors the NestJS writer: insert the AuditLog row,
// fall back to an AuditLogOutbox entry on failure, and only report an error when
// both writes fail.
func writeAuditLogBestEffort(ctx context.Context, exec auditExecer, entry auditEntry) error {
	metadata := entry.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage("null")
	}
	now := nowMillis()
	actor := nullableActorID(entry.ActorID)
	if id, err := newRowID(); err == nil {
		if _, err := exec.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, entry.OrgID, actor, entry.Resource, entry.Action, []byte(metadata), now); err == nil {
			return nil
		} else {
			log.Printf("queueops: audit insert failed for %s/%s: %v", entry.Resource, entry.Action, err)
		}
	}
	payload, err := json.Marshal(auditOutboxPayload{
		OrgID:     entry.OrgID,
		ActorID:   actor,
		Resource:  entry.Resource,
		Action:    entry.Action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		return err
	}
	outboxID, err := newRowID()
	if err != nil {
		return err
	}
	if _, err := exec.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, entry.OrgID, payload, now, now, now); err != nil {
		log.Printf("queueops: audit outbox insert failed for %s/%s: %v", entry.Resource, entry.Action, err)
		return err
	}
	return nil
}

// audit writes one best-effort AuditLog row for an applied mutation.
//
// The Redis mutation already happened, so a complete audit failure is logged
// instead of turning the applied change into an HTTP error, exactly like
// platformgovernance.writeAuditLogBestEffort.
func (s *Service) audit(ctx context.Context, actor Actor, action string, metadata json.RawMessage) {
	if s == nil || s.db == nil {
		return
	}
	entry := auditEntry{
		OrgID:    actor.OrgID,
		ActorID:  actor.UserID,
		Resource: auditResource,
		Action:   action,
		Metadata: metadata,
	}
	if err := writeAuditLogBestEffort(ctx, s.db, entry); err != nil {
		log.Printf("queueops: audit write failed action=%s: %v", action, err)
	}
}

// auditJob records one per-job mutation.
func (s *Service) auditJob(ctx context.Context, actor Actor, action, queue, jobID string) {
	metadata, err := json.Marshal(jobAuditMetadata{Queue: queue, JobID: jobID})
	if err != nil {
		log.Printf("queueops: audit metadata marshal failed action=%s: %v", action, err)
		return
	}
	s.audit(ctx, actor, action, metadata)
}

// auditRetryFailed records the batch failed-set retry.
func (s *Service) auditRetryFailed(ctx context.Context, actor Actor, queue string, limit, matched, retried int) {
	metadata, err := json.Marshal(retryFailedAuditMetadata{
		Queue: queue, Limit: limit, Matched: matched, Retried: retried,
	})
	if err != nil {
		log.Printf("queueops: audit metadata marshal failed action=%s: %v", actionQueueRetryFailed, err)
		return
	}
	s.audit(ctx, actor, actionQueueRetryFailed, metadata)
}

// auditClean records one Queue.clean call.
func (s *Service) auditClean(ctx context.Context, actor Actor, queue string, state CleanState, grace int64, limit, removed int) {
	metadata, err := json.Marshal(cleanAuditMetadata{
		Queue: queue, State: string(state), Grace: grace, Limit: limit, Removed: removed,
	})
	if err != nil {
		log.Printf("queueops: audit metadata marshal failed action=%s: %v", actionQueueClean, err)
		return
	}
	s.audit(ctx, actor, actionQueueClean, metadata)
}

// auditPause records Queue.pause and Queue.resume.
func (s *Service) auditPause(ctx context.Context, actor Actor, action, queue string, paused bool) {
	metadata, err := json.Marshal(pauseAuditMetadata{Queue: queue, Paused: paused})
	if err != nil {
		log.Printf("queueops: audit metadata marshal failed action=%s: %v", action, err)
		return
	}
	s.audit(ctx, actor, action, metadata)
}

// auditDLQReplay records one dead-letter replay.
func (s *Service) auditDLQReplay(ctx context.Context, actor Actor, metadata dlqReplayAuditMetadata) {
	encoded, err := json.Marshal(metadata)
	if err != nil {
		log.Printf("queueops: audit metadata marshal failed action=%s: %v", actionDLQReplay, err)
		return
	}
	s.audit(ctx, actor, actionDLQReplay, encoded)
}

// newRowID writes a Prisma cuid-shaped column ('c' plus 24 hex characters).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// nowMillis returns the current UTC time truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// nullableActorID converts an empty actor into SQL NULL.
func nullableActorID(actorID string) *string {
	if actorID == "" {
		return nil
	}
	return &actorID
}
