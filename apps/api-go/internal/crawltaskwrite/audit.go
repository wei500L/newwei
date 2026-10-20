package crawltaskwrite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"time"
)

// execer is the MySQL handle shared by *sql.DB and *sql.Tx. The delete path
// writes the audit row inside the transaction exactly like Prisma's
// $transaction callback.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// auditOutboxPayload is the AuditLogOutbox payload document. Its field set and
// order match writeAuditLogBestEffort in modules/audit/audit-log.writer.ts so
// the retry worker can replay a Go-written row without changes.
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

// writeAuditLogBestEffort mirrors the NestJS writer: insert the AuditLog row,
// fall back to an AuditLogOutbox entry on failure, and only report an error
// when both writes fail (the NestJS writer then rejects, rolling back the
// delete transaction).
func writeAuditLogBestEffort(ctx context.Context, exec execer, entry auditEntry) error {
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
			id, entry.OrgID, actor, entry.Resource, entry.Action, metadata, now); err == nil {
			return nil
		} else {
			log.Printf("crawltaskwrite: audit insert failed for %s/%s: %v", entry.Resource, entry.Action, err)
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
		log.Printf("crawltaskwrite: audit outbox insert failed for %s/%s: %v", entry.Resource, entry.Action, err)
		return err
	}
	return nil
}

// newRowID writes a Prisma cuid-shaped column ('c' plus 24 hex characters).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
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
