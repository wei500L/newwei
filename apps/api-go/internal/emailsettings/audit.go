package emailsettings

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
)

// auditOutboxPayload matches the document the NestJS audit writer enqueues when
// the direct AuditLog insert fails, so the existing retry worker can replay it.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// audit is the best-effort write: AuditLog first, AuditLogOutbox on failure. The
// NestJS controller calls writeAuditLogBestEffort(...).catch(() => undefined), so
// the request still succeeds when both writes fail.
func (s *Service) audit(ctx context.Context, orgID, actorID string, metadata json.RawMessage) {
	if s == nil || s.settingsDB == nil {
		return
	}
	actor := platformgovernance.NullableActorID(actorID)
	now := s.now().UTC().Truncate(time.Millisecond)

	if id, err := settingshttp.NewRowID(); err == nil {
		if err := s.settingsDB.Exec(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, emailAuditResource, emailAuditAction, []byte(metadata), now); err == nil {
			return
		}
	}

	payload, err := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  emailAuditResource,
		Action:    emailAuditAction,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: settingshttp.NestTimestamp(now),
	})
	if err != nil {
		log.Printf("emailsettings: build audit outbox payload failed")
		return
	}
	id, err := settingshttp.NewRowID()
	if err != nil {
		return
	}
	if err := s.settingsDB.Exec(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		id, orgID, payload, now, now, now); err != nil {
		log.Printf("emailsettings: audit log and outbox both failed")
	}
}
