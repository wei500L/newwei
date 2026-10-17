package modelaccesssettings

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"
)

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload exactly so
// the existing retry worker can replay it. Metadata is passed through as raw
// bytes because the concrete metadata type is a named struct per action.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors apps/api writeAuditLogBestEffort for THIS call
// chain, including its failure behaviour:
//
//  1. INSERT the AuditLog row;
//  2. on failure, build the outbox payload and INSERT an AuditLogOutbox entry;
//  3. if either the payload cannot be built or the outbox insert fails, return
//     the ORIGINAL error so the caller surfaces a 500.
//
// Step 3 is deliberately different from the other Go settings packages, which log
// and swallow the final failure: the NestJS helper this endpoint calls rethrows,
// and the smoke suite asserts the resulting 500. Swallowing it here would
// silently diverge from the reference implementation.
//
// The configuration row has already been committed when this runs, and the caller
// holds the global settings lock until this returns, so audit handling stays inside
// the critical section. Neither the log nor the outbox payload ever carries a
// plaintext secret: the metadata structs only hold counts and normalised
// non-secret fields.
func (s *Service) writeAuditLogBestEffort(
	ctx context.Context,
	orgID string,
	actorID string,
	action string,
	metadata json.RawMessage,
) error {
	if s == nil || s.audit == nil {
		return errNoDatabase
	}
	actor := nullableActorID(actorID)
	now := nowMillis()

	id, idErr := newRowID()
	if idErr != nil {
		return s.enqueueAuditOutbox(ctx, orgID, actor, action, metadata, now, idErr)
	}
	if err := s.audit.InsertAuditLog(ctx, auditLogEntry{
		ID:        id,
		OrgID:     orgID,
		ActorID:   actor,
		Action:    action,
		Metadata:  metadata,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	}); err != nil {
		return s.enqueueAuditOutbox(ctx, orgID, actor, action, metadata, now, err)
	}
	return nil
}

// enqueueAuditOutbox writes the retry row and returns auditErr when the outbox
// entry cannot be written, matching NestJS throwing the original audit error.
func (s *Service) enqueueAuditOutbox(
	ctx context.Context,
	orgID string,
	actor *string,
	action string,
	metadata json.RawMessage,
	now time.Time,
	auditErr error,
) error {
	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  settingsResourceName,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	if payloadErr != nil {
		log.Printf("modelaccesssettings: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return auditErr
	}
	outboxID, outboxIDErr := newRowID()
	if outboxIDErr != nil {
		log.Printf("modelaccesssettings: failed to allocate audit outbox id for %s: %v", action, outboxIDErr)
		return auditErr
	}
	createdAt := now.Format("2006-01-02T15:04:05.000Z")
	if err := s.audit.InsertAuditOutbox(ctx, auditOutboxEntry{
		ID:          outboxID,
		OrgID:       orgID,
		Payload:     payload,
		Status:      "pending",
		Attempts:    0,
		AvailableAt: createdAt,
		CreatedAt:   createdAt,
		UpdatedAt:   createdAt,
	}); err != nil {
		log.Printf("modelaccesssettings: failed to enqueue audit outbox for %s: %v", action, err)
		return auditErr
	}
	log.Printf("modelaccesssettings: audit log insert failed for %s; enqueued for retry", action)
	return nil
}

// mysqlAuditor writes the audit trail through the shared pool.
type mysqlAuditor struct {
	db *sql.DB
}

// InsertAuditLog writes one AuditLog row.
func (a *mysqlAuditor) InsertAuditLog(ctx context.Context, entry auditLogEntry) error {
	if a == nil || a.db == nil {
		return errNoDatabase
	}
	_, err := a.db.ExecContext(ctx,
		"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
			"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
		entry.ID, entry.OrgID, entry.ActorID, settingsResourceName, entry.Action, []byte(entry.Metadata), entry.CreatedAt)
	return err
}

// InsertAuditOutbox writes one pending AuditLogOutbox row.
func (a *mysqlAuditor) InsertAuditOutbox(ctx context.Context, entry auditOutboxEntry) error {
	if a == nil || a.db == nil {
		return errNoDatabase
	}
	_, err := a.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		entry.ID, entry.OrgID, []byte(entry.Payload), entry.Status, entry.Attempts,
		entry.AvailableAt, entry.CreatedAt, entry.UpdatedAt)
	return err
}
