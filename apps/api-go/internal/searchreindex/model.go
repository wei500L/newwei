package searchreindex

import (
	"crypto/rand"
	"fmt"
	"time"
)

// JobStatus is the reindex job state enum (SearchReindexJobStatus in
// search-reindex-job.store.ts).
type JobStatus string

const (
	// JobStatusQueued is the state persisted before the background run starts.
	JobStatusQueued JobStatus = "queued"
	// JobStatusRunning is the state while the organization is being rebuilt.
	JobStatusRunning JobStatus = "running"
	// JobStatusCompleted marks a rebuild whose final refresh succeeded.
	JobStatusCompleted JobStatus = "completed"
	// JobStatusFailed marks a run that stopped after an error; indexed keeps
	// the documents that were actually written before the failure.
	JobStatusFailed JobStatus = "failed"
)

// isTerminal reports whether the status uses the shorter terminal retention.
func (s JobStatus) isTerminal() bool {
	return s == JobStatusCompleted || s == JobStatusFailed
}

// Job is the Redis job document and the response body of both endpoints.
//
// The field order matches the NestJS object: a created job serializes as
// id, orgId, status, indexed, createdAt, updatedAt, and a failed job gains the
// error field last, exactly like the NestJS object spread in
// SearchReindexJobStore.update.
type Job struct {
	ID        string    `json:"id"`
	OrgID     string    `json:"orgId"`
	Status    JobStatus `json:"status"`
	Indexed   int       `json:"indexed"`
	CreatedAt string    `json:"createdAt"`
	UpdatedAt string    `json:"updatedAt"`
	Error     string    `json:"error,omitempty"`
}

// ItemSearchDocument is one Elasticsearch item document. The declaration order
// mirrors ItemSearchDocument in items-elasticsearch.service.ts so the serialized
// JSON key order matches NestJS, and the pointer fields keep the existing
// null versus empty-string semantics.
type ItemSearchDocument struct {
	OrgID       string   `json:"orgId"`
	ItemMetaID  string   `json:"itemMetaId"`
	Title       string   `json:"title"`
	ExternalID  string   `json:"externalId"`
	SourceName  *string  `json:"sourceName"`
	Summary     *string  `json:"summary"`
	Topics      []string `json:"topics"`
	Entities    []string `json:"entities"`
	Region      *string  `json:"region"`
	Location    *string  `json:"location"`
	Sentiment   *string  `json:"sentiment"`
	ContentType *string  `json:"contentType"`
	SearchText  string   `json:"searchText"`
	SortAt      string   `json:"sortAt"`
	CreatedAt   string   `json:"createdAt"`
}

// isoTimestamp renders a time exactly like JavaScript Date.toISOString(): UTC
// with millisecond precision and a trailing Z.
func isoTimestamp(when time.Time) string {
	return when.UTC().Format("2006-01-02T15:04:05.000Z")
}

// newJobID returns a random RFC 4122 version 4 UUID, keeping the id shape of the
// NestJS randomUUID() call.
func newJobID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

// newOwnerToken returns the random lock owner token used by SET NX PX.
func newOwnerToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", raw[:]), nil
}
