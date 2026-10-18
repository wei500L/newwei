package knowledgereview

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
)

// reviewStatus is the persisted review verdict. The three literals are the
// NestJS @IsIn whitelist; anything else is rejected before the transaction.
type reviewStatus string

const (
	reviewStatusApproved  reviewStatus = "approved"
	reviewStatusRejected  reviewStatus = "rejected"
	reviewStatusCorrected reviewStatus = "corrected"
)

// reviewInput is the parsed ReviewKnowledgeGraphEvidenceInput DTO.
type reviewInput struct {
	// EvidenceID is the evidence primary key. An empty string is a legal value
	// that simply does not resolve, exactly like the NestJS resolver.
	EvidenceID string
	Status     reviewStatus
	// Note keeps the submitted text verbatim (including the empty string); nil
	// means the field was omitted or null.
	Note *string
	// CorrectedRelation is the submitted JSON scalar, absent when omitted or
	// null. It is stored in the review sub-document as submitted for every
	// status; only status=corrected additionally parses it into an edge.
	CorrectedRelation json.RawMessage
}

// reviewedEntityRef is one normalized subject/object of a corrected relation.
// The NestJS parseSeedEntityRef also reads subject/object properties, but
// upsertEntity never persists them, so the write path ignores them on purpose.
type reviewedEntityRef struct {
	Name    string
	Type    string
	Aliases []string
}

// reviewedRelation is a corrected relation that can be applied to the graph.
type reviewedRelation struct {
	Subject    reviewedEntityRef
	Predicate  string
	Object     reviewedEntityRef
	Properties json.RawMessage
}

// reviewedRelationDocument is the correctedRelation JSON object shape.
type reviewedRelationDocument struct {
	Subject    reviewedEntityDocument `json:"subject"`
	Predicate  json.RawMessage        `json:"predicate"`
	Object     reviewedEntityDocument `json:"object"`
	Properties json.RawMessage        `json:"properties"`
}

// reviewedEntityDocument is the subject/object shape. Subject/object properties
// are not modelled because they are never read or persisted on this path.
type reviewedEntityDocument struct {
	Name    json.RawMessage `json:"name"`
	Type    json.RawMessage `json:"type"`
	Aliases json.RawMessage `json:"aliases"`
}

// evidenceReviewDocument is the review sub-document written into the evidence
// JSON. Every key is always present; an absent note or correctedRelation
// marshals as null, matching the NestJS object literal.
type evidenceReviewDocument struct {
	Status            reviewStatus    `json:"status"`
	Note              *string         `json:"note"`
	CorrectedRelation json.RawMessage `json:"correctedRelation"`
	ReviewerID        string          `json:"reviewerId"`
	ReviewedAt        string          `json:"reviewedAt"`
}

// parseReviewInput reproduces the DTO plus the class-validator constraints. The
// SDL already guarantees evidenceId and status are present strings, so the only
// reachable constraint failures are the @IsIn whitelist and the @MaxLength(500)
// note.
func parseReviewInput(args map[string]any) (reviewInput, error) {
	raw, ok := contract.MapArg(args, "input")
	if !ok {
		return reviewInput{}, newInputFailure("input must be an object")
	}

	evidenceID, _ := raw["evidenceId"].(string)

	statusText, _ := raw["status"].(string)
	status := reviewStatus(statusText)
	switch status {
	case reviewStatusApproved, reviewStatusRejected, reviewStatusCorrected:
	default:
		return reviewInput{}, newInputFailure("status must be one of the following values: approved, rejected, corrected")
	}

	var note *string
	if value, present := raw["note"]; present && value != nil {
		text, isString := value.(string)
		if !isString {
			// class-validator has no @IsString on note, so a non-string fails
			// @MaxLength with its own message. The SDL String! coercion makes
			// this unreachable for a well-formed document.
			return reviewInput{}, newInputFailure("note must be shorter than or equal to 500 characters")
		}
		// class-validator MaxLength uses validator.js isLength, not raw UTF-16
		// length: see maxLengthLen.
		if maxLengthLen(text) > 500 {
			return reviewInput{}, newInputFailure("note must be shorter than or equal to 500 characters")
		}
		copied := text
		note = &copied
	}

	var correctedRelation json.RawMessage
	if value, present := raw["correctedRelation"]; present && value != nil {
		encoded, err := json.Marshal(value)
		if err != nil {
			return reviewInput{}, newInputFailure("correctedRelation must be a valid JSON value")
		}
		correctedRelation = encoded
	}

	return reviewInput{
		EvidenceID:        evidenceID,
		Status:            status,
		Note:              note,
		CorrectedRelation: correctedRelation,
	}, nil
}

// buildReviewDocument renders the review sub-document. reviewedAt is a
// server-side ISO UTC millisecond timestamp and reviewerId comes from the
// derived identity, never from the client.
func buildReviewDocument(input reviewInput, reviewerID string, reviewedAt string) (json.RawMessage, error) {
	encoded, err := json.Marshal(evidenceReviewDocument{
		Status:            input.Status,
		Note:              input.Note,
		CorrectedRelation: input.CorrectedRelation,
		ReviewerID:        reviewerID,
		ReviewedAt:        reviewedAt,
	})
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

// parseReviewedRelation normalizes a correctedRelation value. It returns false
// for anything the NestJS normalizeReviewedRelation rejects: a non-object, a
// subject/object without a non-empty name and type, or an unknown predicate.
func parseReviewedRelation(raw json.RawMessage) (reviewedRelation, bool) {
	if len(raw) == 0 {
		return reviewedRelation{}, false
	}
	var document reviewedRelationDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return reviewedRelation{}, false
	}

	subject, ok := parseReviewedEntityRef(document.Subject)
	if !ok {
		return reviewedRelation{}, false
	}
	object, ok := parseReviewedEntityRef(document.Object)
	if !ok {
		return reviewedRelation{}, false
	}

	predicateText, ok := decodeJSONString(document.Predicate)
	if !ok {
		return reviewedRelation{}, false
	}
	predicate, ok := normalizeRelationType(predicateText)
	if !ok {
		return reviewedRelation{}, false
	}

	properties, _ := jsonObjectOrNil(document.Properties)

	return reviewedRelation{
		Subject:    subject,
		Predicate:  predicate,
		Object:     object,
		Properties: properties,
	}, true
}

// parseReviewedEntityRef reproduces parseSeedEntityRef: name and type must be
// JSON strings that trim to a non-empty value, aliases keep only the strings
// trimmed and capped at 20.
func parseReviewedEntityRef(document reviewedEntityDocument) (reviewedEntityRef, bool) {
	nameText, ok := decodeJSONString(document.Name)
	if !ok {
		return reviewedEntityRef{}, false
	}
	canonicalName := knowledgegraph.CollapseEntityName(nameText)
	if canonicalName == "" {
		return reviewedEntityRef{}, false
	}

	typeText, ok := decodeJSONString(document.Type)
	if !ok || knowledgegraph.TrimSpace(typeText) == "" {
		return reviewedEntityRef{}, false
	}

	return reviewedEntityRef{
		Name:    canonicalName,
		Type:    typeText,
		Aliases: decodeAliases(document.Aliases),
	}, true
}

// decodeAliases keeps only string entries, trims them, drops the empty strings
// and caps the list at 20 entries, in submission order.
func decodeAliases(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	aliases := make([]string, 0, len(entries))
	for _, entry := range entries {
		if len(aliases) >= 20 {
			break
		}
		text, ok := decodeJSONString(entry)
		if !ok {
			continue
		}
		trimmed := knowledgegraph.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		aliases = append(aliases, trimmed)
	}
	return aliases
}

// normalizeRelationType maps a predicate to the Prisma KnowledgeRelationType.
// The token step folds case and turns whitespace/hyphen runs into underscores;
// the switch keeps every NestJS synonym.
func normalizeRelationType(value string) (string, bool) {
	switch knowledgegraph.ReviewRelationToken(value) {
	case "belongs_to_industry", "belong_to_industry":
		return "belongs_to_industry", true
	case "supplies", "supplier_of":
		return "supplies", true
	case "customer_of", "buys_from":
		return "customer_of", true
	case "competes_with", "competitor_of":
		return "competes_with", true
	case "holds_position", "works_for", "employed_by":
		return "holds_position", true
	case "affects_industry":
		return "affects_industry", true
	case "affects_company":
		return "affects_company", true
	case "upstream_of":
		return "upstream_of", true
	case "downstream_of":
		return "downstream_of", true
	case "has_ticker", "ticker_of":
		return "has_ticker", true
	default:
		return "", false
	}
}

// normalizeEntityType reproduces normalizeEntityType in knowledgeGraphService:
// a case-insensitive contains test in declaration order, with every unknown
// non-empty type falling back to organization.
func normalizeEntityType(value string) string {
	entityType := strings.ToLower(knowledgegraph.TrimSpace(value))
	if entityType == "" {
		return "organization"
	}
	switch {
	case strings.Contains(entityType, "person") || strings.Contains(entityType, "people"):
		return "person"
	case strings.Contains(entityType, "policy") || strings.Contains(entityType, "regulation") || strings.Contains(entityType, "law"):
		return "policy"
	case strings.Contains(entityType, "industry") || strings.Contains(entityType, "sector"):
		return "industry"
	case strings.Contains(entityType, "commodity"):
		return "commodity"
	case strings.Contains(entityType, "stock") || strings.Contains(entityType, "equity") ||
		strings.Contains(entityType, "index") || strings.Contains(entityType, "ticker") ||
		strings.Contains(entityType, "future") || strings.Contains(entityType, "etf"):
		return "instrument"
	case strings.Contains(entityType, "company") || strings.Contains(entityType, "corp") || strings.Contains(entityType, "inc"):
		return "company"
	default:
		return "organization"
	}
}

// decodeJSONString reads a JSON string leaf. JSON null is not a string, so a
// null name/type fails the parse exactly like the NestJS typeof check.
func decodeJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsonObjectOrNil returns a compact copy of a JSON object, or nil when the
// value is absent, null, an array or any other non-object.
func jsonObjectOrNil(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return nil, false
	}
	copied := make(json.RawMessage, len(trimmed))
	copy(copied, trimmed)
	return copied, true
}

// maxLengthLen mirrors the validator.js isLength used by class-validator
// MaxLength: JavaScript String.length minus the surrogate pairs and the
// presentation sequences (U+FE0F/U+FE0E). Under Go's rune iteration that is
// exactly the rune count with the variation selectors removed, so an astral
// character counts as one and a trailing emoji variation selector as zero.
func maxLengthLen(text string) int {
	length := 0
	for _, r := range text {
		if r == 0xFE0F || r == 0xFE0E {
			continue
		}
		length++
	}
	return length
}

// clampConfidence is toConfidence: non-finite values are missing, finite values
// are clamped into 0..1.
func clampConfidence(value float64) (float64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	if value < 0 {
		return 0, true
	}
	if value > 1 {
		return 1, true
	}
	return value, true
}

// confidenceOrDefault is the `toConfidence(value) ?? 0.5` chain used for a new
// edge's confidence.
func confidenceOrDefault(value float64, valid bool) float64 {
	if !valid {
		return 0.5
	}
	if clamped, ok := clampConfidence(value); ok {
		return clamped
	}
	return 0.5
}
