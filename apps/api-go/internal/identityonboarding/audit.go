package identityonboarding

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

// This file reproduces writeAuditLogBestEffort from
// modules/audit/audit-log.writer.ts: write AuditLog first, and on failure enqueue
// an equivalent AuditLogOutbox payload for the NestJS consumer. A failed audit
// trail never turns a committed invitation, decision or organization into a
// request failure.
//
// No path here passes an IP address: the NestJS controller does not forward one
// for these handlers, so the column stays NULL instead of inventing a value from
// the body.

// inviteCreateAudit is the users/invite_create metadata.
type inviteCreateAudit struct {
	InviteID      string   `json:"inviteId"`
	Email         string   `json:"email"`
	PrimaryRoleID string   `json:"primaryRoleId"`
	RoleIDs       []string `json:"roleIds"`
}

// inviteResendAudit is the users/invite_resend metadata.
type inviteResendAudit struct {
	InviteID string `json:"inviteId"`
	Email    string `json:"email"`
}

// inviteRevokeAudit is the users/invite_revoke metadata.
type inviteRevokeAudit struct {
	InviteID string `json:"inviteId"`
	Email    string `json:"email"`
}

// approveJoinAudit is the registration_application/approve_join metadata.
type approveJoinAudit struct {
	ApplicationID string   `json:"applicationId"`
	InviteID      string   `json:"inviteId"`
	PrimaryRoleID string   `json:"primaryRoleId"`
	RoleIDs       []string `json:"roleIds"`
	Email         string   `json:"email"`
}

// rejectJoinAudit is the registration_application/reject_join metadata.
type rejectJoinAudit struct {
	ApplicationID  string  `json:"applicationId"`
	DecisionReason *string `json:"decisionReason"`
	Email          string  `json:"email"`
}

// orgApplicationApprovedAudit is the org/registration_application_approved
// metadata.
type orgApplicationApprovedAudit struct {
	ApplicationID string `json:"applicationId"`
	InviteID      string `json:"inviteId"`
}

// auditTimestamp renders a JavaScript Date.toISOString equivalent.
func auditTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// auditOutboxPayload mirrors createOutboxPayload in audit-log.writer.ts.
type auditOutboxPayload[T any] struct {
	OrgID     string  `json:"orgId"`
	ActorID   *string `json:"actorId"`
	Resource  string  `json:"resource"`
	Action    string  `json:"action"`
	Metadata  T       `json:"metadata"`
	IPAddress *string `json:"ipAddress"`
	CreatedAt string  `json:"createdAt"`
}

// writeAuditBestEffort writes one AuditLog row, or enqueues the outbox payload
// when the direct insert fails. It accepts the shared dbtx surface so the
// organization-bootstrap transaction can carry its own audit row.
func writeAuditBestEffort[T any](ctx context.Context, exec dbtx, orgID, actorID, resource, action string, metadata T) {
	if exec == nil {
		return
	}
	metaRaw, err := json.Marshal(metadata)
	if err != nil {
		metaRaw = []byte("null")
	}
	now := nowMillis()
	if id, idErr := newRowID(); idErr == nil {
		_, err = exec.ExecContext(ctx,
			"INSERT INTO `AuditLog` (`id`, `orgId`, `actorId`, `resource`, `action`, `metadata`, `ipAddress`, `createdAt`) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, nullableActor(actorID), resource, action, metaRaw, now)
		if err == nil {
			return
		}
	}

	var actorPtr *string
	if actorID != "" {
		actorPtr = &actorID
	}
	payload := auditOutboxPayload[T]{
		OrgID:     orgID,
		ActorID:   actorPtr,
		Resource:  resource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: auditTimestamp(now),
	}
	payloadRaw, payloadErr := json.Marshal(payload)
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("identityonboarding audit: failed to write audit log and outbox payload: %v", err)
		return
	}
	if _, outboxErr := exec.ExecContext(ctx,
		"INSERT INTO `AuditLogOutbox` (`id`, `orgId`, `payload`, `status`, `attempts`, `availableAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payloadRaw, now, now, now); outboxErr != nil {
		log.Printf("identityonboarding audit: failed to write audit log and enqueue outbox: %v", err)
	}
}

// nullableActor stores an empty actor id as SQL NULL.
func nullableActor(actorID string) any {
	if actorID == "" {
		return nil
	}
	return actorID
}
