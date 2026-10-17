package classificationrssops

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
)

// errNoDatabase is returned by writers invoked without a MySQL pool.
var errNoDatabase = errors.New("mysql is not configured")

// reviewDecisionAuditMetadata is the exact JSON written into AuditLog.metadata
// for a single review decision.
type reviewDecisionAuditMetadata struct {
	ReviewID string               `json:"reviewId"`
	Status   ReviewDecisionStatus `json:"status"`
}

// reviewBatchAuditMetadata is the exact JSON written into AuditLog.metadata for
// a batch review decision.
type reviewBatchAuditMetadata struct {
	Count  int                  `json:"count"`
	Status ReviewDecisionStatus `json:"status"`
}

// auditOutboxPayload mirrors createOutboxPayload in audit-log.writer.ts: the
// retry payload queued when the direct AuditLog insert fails.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort from
// apps/api/src/modules/audit/audit-log.writer.ts: insert the AuditLog row and,
// when that fails, enqueue the equivalent AuditLogOutbox payload. Both steps
// failing only logs — a review decision that already updated Mongo must never be
// turned into a 500 by an audit write.
//
// The caller passes the machine-token actorId as the empty string, which is
// stored as SQL NULL: AuditLog.actorId is a User foreign key and "machine:<id>"
// is not a user id.
func (s *Service) writeAuditLogBestEffort(
	ctx context.Context,
	orgID, actorID, resource, action string,
	metadata json.RawMessage,
) {
	if s.db == nil {
		return
	}
	now := nowMillis()
	var actor *string
	if trimmed := strings.TrimSpace(actorID); trimmed != "" {
		value := trimmed
		actor = &value
	}

	if id, err := newRowID(); err == nil {
		if _, err := s.db.ExecContext(ctx, `
INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt)
VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
			id, orgID, actor, resource, action, []byte(metadata), now); err == nil {
			return
		} else {
			log.Printf("classification rss ops: failed to write audit log: %v", err)
		}
	}

	payload := auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: formatJSTime(now),
	}
	payloadRaw, payloadErr := json.Marshal(payload)
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("classification rss ops: failed to build audit outbox payload: %v", payloadErr)
		return
	}
	if _, outboxErr := s.db.ExecContext(ctx, `
INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt)
VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
		outboxID, orgID, []byte(payloadRaw), now, now, now); outboxErr != nil {
		log.Printf("classification rss ops: failed to enqueue audit outbox: %v", outboxErr)
	}
}

// auditActorID normalizes the actor written into MySQL. Machine tokens carry
// "machine:<id>", which is a valid Mongo reviewerId but not a User row, so the
// AuditLog foreign key receives NULL instead.
func auditActorID(actorID string) string {
	if strings.HasPrefix(actorID, "machine:") {
		return ""
	}
	return actorID
}
