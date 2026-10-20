package crawltaskwrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// errAuditExportDatabase reports a missing MySQL handle to the maintenance
// audit wrapper.
var errAuditExportDatabase = errors.New("crawltaskwrite: mysql is not configured")

// MaintenanceAuditEntry is one best-effort AuditLog row written by a
// maintenance cron (actorId NULL). Metadata is a JSON leaf so callers keep
// their own typed document.
type MaintenanceAuditEntry struct {
	OrgID    string
	Resource string
	Action   string
	Metadata json.RawMessage
}

// WriteAuditLogBestEffort exposes the shared writer used by the crawl task
// lifecycle: insert the AuditLog row and fall back to the AuditLogOutbox entry
// when the direct insert fails. The caller only warns on an error, matching the
// NestJS janitor's catch-and-warn behaviour.
func WriteAuditLogBestEffort(ctx context.Context, db *sql.DB, entry MaintenanceAuditEntry) error {
	if db == nil {
		return errAuditExportDatabase
	}
	return writeAuditLogBestEffort(ctx, db, auditEntry{
		OrgID:    entry.OrgID,
		ActorID:  "",
		Resource: entry.Resource,
		Action:   entry.Action,
		Metadata: entry.Metadata,
	})
}

// NewRowID exposes the Prisma cuid-shaped id generator ('c' plus 24 hex
// characters) for maintenance rows written by this batch.
func NewRowID() (string, error) {
	return newRowID()
}
