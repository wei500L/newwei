package itemsingest

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// inTx runs fn in a MySQL transaction and rolls back on any error.
func (s *Service) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// hydrate refreshes the read model for one item. A nil hydrator keeps unit
// tests and background-only compositions usable without changing the write
// contract.
func (s *Service) hydrate(ctx context.Context, orgID, itemMetaID string) error {
	if s.hydrator == nil {
		return nil
	}
	return s.hydrator.HydrateItemReadModel(ctx, orgID, itemMetaID)
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}

// isTruthyJSON is JavaScript truthiness for a parsed JSON value. Update treats
// null, false, 0 and "" as "no payload change"; create always normalizes.
func isTruthyJSON(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	value, _ := jsonValueKind(trimmed)
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		number, err := typed.Float64()
		return err != nil || number != 0
	default:
		return true
	}
}

// createAuditMetadata is the create audit metadata: the DTO plus the normalized
// payload, with absent optional status omitted like JSON.stringify(undefined).
type createAuditMetadata struct {
	ExternalID string          `json:"externalId"`
	Name       string          `json:"name"`
	Status     *string         `json:"status,omitempty"`
	Payload    json.RawMessage `json:"payload"`
}

type updateAuditMetadata struct {
	ID      string          `json:"id"`
	Name    *string         `json:"name,omitempty"`
	Status  *string         `json:"status,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func buildCreateAuditMetadata(input CreateItemInput, payload NormalizedNewsPayload) createAuditMetadata {
	encoded, _ := json.Marshal(payload)
	return createAuditMetadata{
		ExternalID: input.ExternalID,
		Name:       input.Name,
		Status:     input.Status,
		Payload:    encoded,
	}
}

func buildUpdateAuditMetadata(input UpdateItemInput, payload *NormalizedNewsPayload) updateAuditMetadata {
	metadata := updateAuditMetadata{ID: input.ID, Name: input.Name, Status: input.Status}
	if payload != nil {
		encoded, _ := json.Marshal(*payload)
		metadata.Payload = encoded
	} else if len(input.Payload) > 0 {
		// A parsed falsy value (null/false/0/"") does not update the raw item
		// but remains part of the audit metadata, exactly like spreading the
		// original DTO.
		metadata.Payload = append(json.RawMessage(nil), input.Payload...)
	}
	return metadata
}

// AsFailure returns the typed failure or nil.
func AsFailure(err error) *Failure {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure
	}
	return nil
}
