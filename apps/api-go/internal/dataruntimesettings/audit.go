package dataruntimesettings

import (
	"context"
	"encoding/json"
	"log"
)

// auditResource is the AuditLog.resource value every settings write uses.
const auditResource = "system_settings"

// Typed audit metadata documents. Named structs keep secret material out of the
// payload by construction: no field can carry a plaintext secret, a ciphertext or
// a full request body.

// realtimeSecretsUpdated records which secret fields the request provided.
// Following the NestJS rule, a field provided as JSON null counts as provided.
type realtimeSecretsUpdated struct {
	AisRelaySharedSecret bool `json:"aisRelaySharedSecret"`
	OpenskyClientSecret  bool `json:"openskyClientSecret"`
	AcledOauthPassword   bool `json:"acledOauthPassword"`
	CloudflareAPIToken   bool `json:"cloudflareApiToken"`
	WingbitsAPIKey       bool `json:"wingbitsApiKey"`
}

// realtimeUpdateAuditMetadata is the realtime_signals_update payload.
type realtimeUpdateAuditMetadata struct {
	OK             bool                   `json:"ok"`
	UpdatedFields  []string               `json:"updatedFields"`
	SecretsUpdated realtimeSecretsUpdated `json:"secretsUpdated"`
}

// resetAuditMetadata is the {ok:true} payload both reset actions use.
type resetAuditMetadata struct {
	OK bool `json:"ok"`
}

// archivePreparationAuditMetadata is the archive_preparation_update payload.
type archivePreparationAuditMetadata struct {
	JobBatchSize            int `json:"jobBatchSize"`
	EmbeddingBatchSize      int `json:"embeddingBatchSize"`
	EmbeddingMaxConcurrency int `json:"embeddingMaxConcurrency"`
	RerankMaxConcurrency    int `json:"rerankMaxConcurrency"`
}

// nominatimAuditMetadata is the geo_nominatim_settings_update payload. It records
// the overrides, never the effective identity, and both members are ordinary
// JSON null when the override is absent.
type nominatimAuditMetadata struct {
	UserAgent *string `json:"userAgent"`
	Email     *string `json:"email"`
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

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort in apps/api: insert the
// AuditLog row first and fall back to an AuditLogOutbox entry on failure.
//
// When both writes fail it returns the original audit error, which the caller
// propagates: NestJS's helper re-throws in that case, so the request fails with
// a 500 even though the configuration was already persisted. The realtime and
// archive-preparation writers await this; the Nominatim writer deliberately
// swallows it to preserve its fire-and-forget contract.
//
// Machine tokens write a NULL actorId (the column is a nullable foreign key into
// User) instead of "machine:<id>".
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
		log.Printf("dataruntimesettings: audit log write failed for %s: %v", action, err)
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
		log.Printf("dataruntimesettings: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return auditErr
	}
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("dataruntimesettings: failed to write audit log and enqueue outbox for %s: %v", action, err)
		return auditErr
	}
	return nil
}
