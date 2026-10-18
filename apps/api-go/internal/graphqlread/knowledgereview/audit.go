package knowledgereview

import (
	"context"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	auditResource = "knowledge_graph"
	auditAction   = "knowledge_graph_evidence_review"
)

// reviewAuditMetadata is the named AuditLog metadata of one review. It carries
// the submitted evidence id, the verdict, every touched edge and the returned
// evidence id (null when the review deleted it).
type reviewAuditMetadata struct {
	EvidenceID         string       `json:"evidenceId"`
	Status             reviewStatus `json:"status"`
	EdgeIDs            []string     `json:"edgeIds"`
	ReturnedEvidenceID *string      `json:"returnedEvidenceId"`
	DeletedEdgeIDs     []string     `json:"deletedEdgeIds"`
}

// auditOutboxPayload mirrors createOutboxPayload in
// modules/audit/audit-log.writer.ts so the existing NestJS
// AuditLogOutboxService can replay it unchanged.
type auditOutboxPayload struct {
	OrgID     string              `json:"orgId"`
	ActorID   *string             `json:"actorId"`
	Resource  string              `json:"resource"`
	Action    string              `json:"action"`
	Metadata  reviewAuditMetadata `json:"metadata"`
	IPAddress *string             `json:"ipAddress"`
	CreatedAt string              `json:"createdAt"`
}

// writeReviewAudit reproduces writeAuditLogBestEffort in
// modules/audit/audit-log.writer.ts, including its error contract: a direct
// AuditLog insert that succeeds ends the call; a direct failure that is
// recovered through AuditLogOutbox also ends the call (the committed graph
// update is never rolled back); when both fail the original audit error is
// returned to the caller.
func (s *service) writeReviewAudit(
	ctx context.Context,
	identity contract.Identity,
	input reviewInput,
	result reviewResult,
) error {
	metadata := reviewAuditMetadata{
		EvidenceID:         input.EvidenceID,
		Status:             input.Status,
		EdgeIDs:            nonNilStrings(result.EdgeIDs),
		ReturnedEvidenceID: result.EvidenceID,
		DeletedEdgeIDs:     nonNilStrings(result.DeletedEdgeIDs),
	}
	metaRaw, err := json.Marshal(metadata)
	if err != nil {
		metaRaw = []byte("null")
	}

	now := s.timestamp()
	actorID := identity.UserID
	var directErr error
	if id, idErr := newRowID(); idErr == nil {
		_, execErr := s.db.ExecContext(ctx,
			"INSERT INTO AuditLog (`id`, `orgId`, `actorId`, `resource`, `action`, `metadata`, `ipAddress`, `createdAt`) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, identity.OrgID, actorID, auditResource, auditAction, metaRaw, now)
		if execErr == nil {
			return nil
		}
		directErr = execErr
	} else {
		directErr = idErr
	}

	payload := auditOutboxPayload{
		OrgID:     identity.OrgID,
		ActorID:   &actorID,
		Resource:  auditResource,
		Action:    auditAction,
		Metadata:  metadata,
		IPAddress: nil,
		CreatedAt: contract.FormatDateTime(now),
	}
	payloadRaw, marshalErr := json.Marshal(payload)
	outboxID, outboxIDErr := newRowID()
	if marshalErr != nil || outboxIDErr != nil {
		return directErr
	}
	if _, outboxErr := s.db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (`id`, `orgId`, `payload`, `status`, `attempts`, `availableAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, identity.OrgID, payloadRaw, now, now, now); outboxErr != nil {
		return directErr
	}
	return nil
}

// nonNilStrings keeps the JSON arrays as [] instead of null.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
