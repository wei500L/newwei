package infrastructuresettings

import (
	"context"
	"encoding/json"
	"log"
)

// auditResource is the AuditLog.resource value every infrastructure settings
// write uses, matching the NestJS calls.
const auditResource = "system_settings"

// Typed audit metadata documents. Using named structs keeps secret material out
// of the payload by construction: only the two fingerprint fields ever carry a
// derived value, and the full secret/access-key id are never fields.

// vectorAuditMetadata is the vector_service_update payload.
type vectorAuditMetadata struct {
	Enabled         bool    `json:"enabled"`
	FallbackToMongo bool    `json:"fallbackToMongo"`
	BaseURL         *string `json:"baseUrl"`
	TimeoutMs       int     `json:"timeoutMs"`
	MaxRetries      int     `json:"maxRetries"`
	TokenUpdated    bool    `json:"tokenUpdated"`
	TokenConfigured bool    `json:"tokenConfigured"`
}

// vectorResetAuditMetadata is the vector_service_reset payload.
type vectorResetAuditMetadata struct {
	OK bool `json:"ok"`
}

// storageAuditMetadata is the storage_settings_update payload. Endpoint,
// forcePathStyle and presignedUrlTtlSeconds use json.RawMessage so an explicit
// JSON null survives (a *bool/*int with omitempty would drop false and 0).
type storageAuditMetadata struct {
	CrawlImageStorage      *string         `json:"crawlImageStorage,omitempty"`
	AccessKeyIDFingerprint *string         `json:"accessKeyIdFingerprint,omitempty"`
	SecretAccessKey        *string         `json:"secretAccessKey,omitempty"`
	Region                 *string         `json:"region,omitempty"`
	Bucket                 *string         `json:"bucket,omitempty"`
	Endpoint               json.RawMessage `json:"endpoint,omitempty"`
	PublicBaseURL          *string         `json:"publicBaseUrl,omitempty"`
	ForcePathStyle         json.RawMessage `json:"forcePathStyle,omitempty"`
	PresignedURLTTLSeconds json.RawMessage `json:"presignedUrlTtlSeconds,omitempty"`
}

// runtimeSecretsAuditMetadata is the news_source_runtime_secrets_update payload.
// Counts only: never the values, the ciphertext or the raw request.
type runtimeSecretsAuditMetadata struct {
	Upserts      int `json:"upserts"`
	Removes      int `json:"removes"`
	EntriesAfter int `json:"entriesAfter"`
}

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches the NestJS createOutboxPayload exactly so
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

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort in apps/api: insert
// the AuditLog row first and fall back to an AuditLogOutbox entry on failure.
//
// When both writes fail it returns the original audit error, which the caller
// propagates: NestJS's helper re-throws in that case, so the request fails with
// a 500 even though the configuration was already persisted. Machine tokens
// write a NULL actorId (the column is a nullable foreign key into User) instead
// of "machine:<id>".
func (s *Service) writeAuditLogBestEffort(ctx context.Context, orgID, actorID, action string, metadata json.RawMessage) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	actor := nullableActorID(actorID)
	now := nowMillis()

	var auditErr error
	if id, idErr := newRowID(); idErr == nil {
		_, err := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, auditResource, action, []byte(metadata), now)
		if err == nil {
			return nil
		}
		auditErr = err
		log.Printf("infrastructuresettings: audit log write failed for %s: %v", action, err)
	} else {
		auditErr = idErr
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  auditResource,
		Action:    action,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: nestTimestamp(now),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("infrastructuresettings: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return auditErr
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("infrastructuresettings: failed to write audit log and enqueue outbox for %s: %v", action, err)
		return auditErr
	}
	return nil
}
