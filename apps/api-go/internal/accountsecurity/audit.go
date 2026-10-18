package accountsecurity

import (
	"context"
	"encoding/json"
	"log"
)

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload exactly so
// the existing retry worker can replay it. Metadata is omitted when the writer
// was not given any (that is the logout case).
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort in apps/api: insert the
// AuditLog row first, fall back to an AuditLogOutbox entry on failure, and never
// turn an already-applied state change into an HTTP error. A failure of both
// writes is logged, never disguised as success of the audit itself.
//
// actorID is normalised through nullableActorID, so a machine token writes NULL
// instead of "machine:<id>" (the column is a nullable foreign key into User).
// metadata is always a named struct marshalled to JSON at the call site; this
// unit currently writes none (logout carries no metadata, exactly like NestJS).
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, resource, action string, metadata json.RawMessage) {
	if s == nil || s.db == nil {
		return
	}
	actor := nullableActorID(actorID)
	now := nowMillis()

	if id, idErr := newRowID(); idErr == nil {
		var rawMetadata []byte
		if len(metadata) > 0 {
			rawMetadata = []byte(metadata)
		}
		_, err := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, resource, action, rawMetadata, now)
		if err == nil {
			return
		}
		log.Printf("accountsecurity: direct audit insert failed, enqueueing outbox: %v", err)
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: formatJSMillis(now),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("accountsecurity: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("accountsecurity: failed to write audit log and enqueue outbox for %s: %v", action, err)
	}
}

// auditOrgID mirrors the NestJS logout membership lookup:
// findFirst({ where: { userId, ...(orgId ? { orgId } : {}) } }).
func (s *Service) auditOrgID(ctx context.Context, userID, orgID string) (*string, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	var resolved string
	var err error
	if orgID != "" {
		err = s.db.QueryRowContext(ctx,
			"SELECT `orgId` FROM `Membership` WHERE `userId` = ? AND `orgId` = ? LIMIT 1",
			userID, orgID).Scan(&resolved)
	} else {
		err = s.db.QueryRowContext(ctx,
			"SELECT `orgId` FROM `Membership` WHERE `userId` = ? LIMIT 1", userID).Scan(&resolved)
	}
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, dbWrap(err)
	}
	return &resolved, nil
}
