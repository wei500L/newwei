package authlogin

import (
	"context"
	"encoding/json"
	"log"
)

// auditOutboxPayload is the document enqueued when the direct AuditLog insert
// fails. Its key order and member set match the NestJS createOutboxPayload so the
// existing outbox consumer can replay it unchanged.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// Audit metadata documents. Each event names its own struct so the payload stays
// typed end to end instead of being assembled from an untyped map.
type loginAuditMetadata struct {
	Email     string  `json:"email"`
	UserAgent *string `json:"userAgent"`
}

type pendingEmailAuditMetadata struct {
	PendingEmail string `json:"pendingEmail"`
}

type emailAuditMetadata struct {
	Email string `json:"email"`
}

// writeAuditLogBestEffort mirrors the NestJS writer: insert the AuditLog row,
// fall back to an AuditLogOutbox entry when that fails, and never turn an
// already-applied business change into an error. The caller's IP is stored in
// both paths — unlike the older account-security port, which hard-coded NULL.
//
// The actor column is a nullable foreign key into User, so an empty actor is
// written as SQL NULL instead of an empty string.
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, resource, action string, metadata json.RawMessage, ipAddress *string) {
	if s == nil || s.db == nil {
		return
	}
	actor := nullableAuditActor(actorID)
	now := nowMillis()
	var rawMetadata []byte
	if len(metadata) > 0 {
		rawMetadata = []byte(metadata)
	}

	if id, idErr := newRowID(); idErr == nil {
		_, err := s.db.ExecContext(ctx,
			"INSERT INTO `AuditLog` (`id`, `orgId`, `actorId`, `resource`, `action`, `metadata`, `ipAddress`, `createdAt`) "+
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			id, orgID, actor, resource, action, rawMetadata, osNullString(ipAddress), now)
		if err == nil {
			return
		}
		log.Printf("authlogin: direct audit insert failed, enqueueing outbox: %v", err)
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: ipAddress,
		CreatedAt: nestTimestamp(now),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("authlogin: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `AuditLogOutbox` (`id`, `orgId`, `payload`, `status`, `attempts`, `availableAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("authlogin: failed to write audit log and enqueue outbox for %s: %v", action, err)
	}
}

// nullableAuditActor mirrors normalizeAuditActorId for the nullable actor column:
// an empty actor becomes SQL NULL, a real user id is kept.
func nullableAuditActor(actorID string) *string {
	if actorID == "" {
		return nil
	}
	value := actorID
	return &value
}
