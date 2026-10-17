package orgaccesswrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"
)

// orgCreateAudit is the AuditLog metadata written by createOrg. Field names
// match the NestJS object literal and bootstrapWarnings is present only when a
// default role referenced a permission name the database does not have.
type orgCreateAudit struct {
	Slug              string             `json:"slug"`
	Name              string             `json:"name"`
	BootstrapWarnings []bootstrapWarning `json:"bootstrapWarnings,omitempty"`
}

// bootstrapWarning is one entry of bootstrapWarnings.
type bootstrapWarning struct {
	Role               string   `json:"role"`
	MissingPermissions []string `json:"missingPermissions"`
}

// orgUpdateAudit is the AuditLog metadata written by updateOrg. A property the
// caller omitted is itself omitted from the JSON, matching the NestJS object
// literal whose undefined values Prisma drops.
type orgUpdateAudit struct {
	Name        *optionalAuditField `json:"name,omitempty"`
	Slug        *optionalAuditField `json:"slug,omitempty"`
	Description *optionalAuditField `json:"description,omitempty"`
}

// orgSetActiveAudit is the AuditLog metadata written by setOrgActive.
type orgSetActiveAudit struct {
	IsActive bool `json:"isActive"`
}

// optionalAuditField is a tri-state JSON field: the enclosing key is omitted
// when the value is nil, and an explicit null marshals as null.
type optionalAuditField struct{ value *string }

// MarshalJSON writes null for an explicit null and the string otherwise.
func (f *optionalAuditField) MarshalJSON() ([]byte, error) {
	if f == nil || f.value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*f.value)
}

func auditString(value *string) *optionalAuditField {
	return &optionalAuditField{value: value}
}

// auditExecutor is the subset of database/sql shared by *sql.DB and *sql.Tx,
// so the createOrg audit row can be written inside the create transaction.
type auditExecutor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
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

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort in
// modules/audit/audit-log.writer.ts: write AuditLog first, and on failure
// enqueue an equivalent AuditLogOutbox payload. Only when both fail is the
// failure logged; a committed organization write is never rolled back into a
// 500 by the audit trail.
//
// metadata is carried by a named struct; the generic type parameter is only a
// serialization boundary.
func writeAuditLogBestEffort[T any](ctx context.Context, exec auditExecutor, orgID, actorID, resource, action string, metadata T) {
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
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
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
		log.Printf("orgaccesswrite audit: failed to write audit log and outbox payload: %v", err)
		return
	}
	if _, outboxErr := exec.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payloadRaw, now, now, now); outboxErr != nil {
		log.Printf("orgaccesswrite audit: failed to write audit log and enqueue outbox: %v", err)
	}
}

// nullableActor stores an empty actor id as SQL NULL.
func nullableActor(actorID string) any {
	if actorID == "" {
		return nil
	}
	return actorID
}
