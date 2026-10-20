package accountdata

import (
	"context"
	"encoding/json"
	"log"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// dataExportAuditMetadata is the metadata document of the data_export/download
// audit row.
type dataExportAuditMetadata struct {
	Format       string      `json:"format"`
	Version      int         `json:"version"`
	ByteLength   int64       `json:"byteLength"`
	Sections     []string    `json:"sections"`
	RecordCounts recordCount `json:"recordCounts"`
}

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. The field set matches AuditLogOutbox and the NestJS writer so
// the existing retry worker can replay it.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeExportAuditLog is the best-effort audit for one completed download. It
// runs only after the whole document has been flushed, so the recorded
// byteLength is the real attachment size. A failure never changes the already
// sent response: it falls back to AuditLogOutbox and is logged.
func (s *Service) writeExportAuditLog(ctx context.Context, identity *accountsecurity.Identity, ipAddress *string, byteLength int64, counts recordCount) {
	if s == nil || s.db == nil || identity == nil {
		return
	}
	metadata, err := json.Marshal(dataExportAuditMetadata{
		Format:       exportFormat,
		Version:      exportVersion,
		ByteLength:   byteLength,
		Sections:     sectionsKeys,
		RecordCounts: counts,
	})
	if err != nil {
		log.Printf("accountdata: failed to build data export audit metadata: %v", err)
		return
	}
	actor := nullableActorID(identity)
	now := nowMillis()
	if id, idErr := s.newID(); idErr == nil {
		_, err := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, 'data_export', 'download', ?, ?, ?)",
			id, identity.OrgID, actor, []byte(metadata), ipAddress, now)
		if err == nil {
			return
		}
		log.Printf("accountdata: direct export audit insert failed, enqueueing outbox: %v", err)
	} else {
		log.Printf("accountdata: failed to allocate export audit id: %v", idErr)
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     identity.OrgID,
		ActorID:   actor,
		Resource:  "data_export",
		Action:    "download",
		Metadata:  json.RawMessage(metadata),
		IPAddress: ipAddress,
		CreatedAt: now.Format(jsDateLayout),
	})
	outboxID, outboxIDErr := s.newID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("accountdata: failed to build export audit outbox payload: %v", payloadErr)
		return
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, identity.OrgID, payload, now, now, now); err != nil {
		log.Printf("accountdata: failed to write export audit log and enqueue outbox: %v", err)
	}
}

// nullableActorID mirrors the AuditLog foreign key: a machine identity
// (machine:<id>) is not a User row, so actorId must be NULL.
func nullableActorID(identity *accountsecurity.Identity) *string {
	if identity == nil || identity.UserID == "" || strings.HasPrefix(identity.UserID, "machine:") {
		return nil
	}
	value := identity.UserID
	return &value
}
