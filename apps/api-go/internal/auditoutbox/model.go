package auditoutbox

import (
	"encoding/json"
	"time"
)

// Status is one value of the persisted AuditLogOutbox.status enum.
type Status string

const (
	StatusPending    Status = "pending"
	StatusProcessing Status = "processing"
	StatusFailed     Status = "failed"
	StatusDead       Status = "dead"
)

// Candidate is the lightweight row the per-minute scan selects. The payload is
// deliberately absent: the batch reads payloads only for the entries that
// survive the global cut, so a tick never moves up to 600 large JSON documents
// to process 200.
type Candidate struct {
	ID        string
	OrgID     string
	Status    Status
	Attempts  int
	CreatedAt time.Time
}

// Claimed is the row read back after the conditional claim. The delivery chain
// uses the incremented attempts value for the backoff and the dead transition.
type Claimed struct {
	ID       string
	OrgID    string
	Attempts int
}

// AuditIdentity is the five-column dedupe identity of the AuditLog lookup. It
// matches the NestJS findFirst where clause exactly; metadata and ipAddress are
// intentionally not part of it.
type AuditIdentity struct {
	OrgID     string
	ActorID   *string
	Resource  string
	Action    string
	CreatedAt time.Time
}

// AuditLogEntry is one row to insert into AuditLog. Metadata keeps the input
// presence: a nil slice writes SQL NULL (payload member absent) while the
// literal "null" writes a JSON null value (explicit null).
type AuditLogEntry struct {
	ID          string
	OrgID       string
	ActorID     *string
	Resource    string
	Action      string
	Metadata    json.RawMessage
	HasMetadata bool
	IPAddress   *string
	CreatedAt   time.Time
}

// StatusUpdate is the failure or dead write-back. AvailableAt is the retry
// instant (failure time plus backoff) or the current instant for dead.
type StatusUpdate struct {
	ID          string
	OrgID       string
	Attempts    int
	Message     string
	AvailableAt time.Time
}

// normalizedPayload is the validated envelope. CreatedAt is the business time
// carried by the payload, never the outbox row time or the replay time.
type normalizedPayload struct {
	OrgID     string
	ActorID   *string
	Resource  string
	Action    string
	Metadata  json.RawMessage
	IPAddress *string
	CreatedAt time.Time
}
