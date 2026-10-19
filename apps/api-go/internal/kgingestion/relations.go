package kgingestion

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
)

// Relation is one normalized knowledge-graph relation ready for validation and
// the transactional write.
type Relation struct {
	Subject    EntityRef
	Predicate  string
	Object     EntityRef
	Confidence float64
	// Properties is the extension JSON object carried through untouched.
	Properties json.RawMessage
	// Evidence is the trimmed quote, nil when the source relation had none.
	Evidence *string
	// Validation is the multi-model validation document. It is nil unless the
	// relation went through validation.
	Validation json.RawMessage
}

// EntityRef is one relation endpoint.
type EntityRef struct {
	Name string
	Type string
}

// relationDocument is the raw stored relation. Every leaf stays RawMessage so
// the type checks below match the NestJS `typeof` checks exactly.
type relationDocument struct {
	Subject    json.RawMessage `json:"subject"`
	Object     json.RawMessage `json:"object"`
	Predicate  json.RawMessage `json:"predicate"`
	Confidence json.RawMessage `json:"confidence"`
	Properties json.RawMessage `json:"properties"`
	Evidence   json.RawMessage `json:"evidence"`
	Validation json.RawMessage `json:"validation"`
}

// normalizeRelations reproduces KnowledgeGraphQualityService.normalizeRelations:
// a JSON string is parsed first, only arrays survive, and an entry is kept only
// when both endpoints have a non-empty trimmed name and type, the predicate is
// non-empty and the confidence is a finite number clamped to 0..1.
func normalizeRelations(raw json.RawMessage) []Relation {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var value json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return normalizeRelationsValue(value)
}

func normalizeRelationsValue(value json.RawMessage) []Relation {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	// Nest parses a stored JSON string before inspecting the array.
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return nil
		}
		return normalizeRelationsValue(json.RawMessage(text))
	}
	if trimmed[0] != '[' {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil
	}

	relations := make([]Relation, 0, len(entries))
	for _, entry := range entries {
		document, ok := decodeRelationDocument(entry)
		if !ok {
			continue
		}
		subject, ok := decodeEntityRef(document.Subject)
		if !ok {
			continue
		}
		object, ok := decodeEntityRef(document.Object)
		if !ok {
			continue
		}
		predicate, ok := decodeJSONString(document.Predicate)
		if !ok {
			continue
		}
		predicate = knowledgegraph.TrimSpace(predicate)
		if predicate == "" {
			continue
		}
		confidence, ok := decodeConfidence(document.Confidence)
		if !ok {
			continue
		}
		properties, _ := decodeJSONObject(document.Properties)
		evidence, _ := decodeJSONString(document.Evidence)
		evidence = knowledgegraph.TrimSpace(evidence)
		var evidencePtr *string
		if evidence != "" {
			evidencePtr = &evidence
		}
		validation, _ := decodeJSONObject(document.Validation)

		relations = append(relations, Relation{
			Subject:    subject,
			Predicate:  predicate,
			Object:     object,
			Confidence: confidence,
			Properties: properties,
			Evidence:   evidencePtr,
			Validation: validation,
		})
	}
	return relations
}

func decodeRelationDocument(raw json.RawMessage) (relationDocument, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return relationDocument{}, false
	}
	var document relationDocument
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return relationDocument{}, false
	}
	return document, true
}

func decodeEntityRef(raw json.RawMessage) (EntityRef, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return EntityRef{}, false
	}
	var document struct {
		Name json.RawMessage `json:"name"`
		Type json.RawMessage `json:"type"`
	}
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return EntityRef{}, false
	}
	name, ok := decodeJSONString(document.Name)
	if !ok {
		return EntityRef{}, false
	}
	entityType, ok := decodeJSONString(document.Type)
	if !ok {
		return EntityRef{}, false
	}
	name = knowledgegraph.TrimSpace(name)
	entityType = knowledgegraph.TrimSpace(entityType)
	if name == "" || entityType == "" {
		return EntityRef{}, false
	}
	return EntityRef{Name: name, Type: entityType}, true
}

// decodeJSONString reads a JSON string leaf. JSON null, numbers and booleans
// are rejected, matching the NestJS typeof check.
func decodeJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// decodeJSONObject keeps an object leaf as compact JSON. null and arrays are
// rejected.
func decodeJSONObject(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil, false
	}
	compact, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	return compact, true
}

func decodeConfidence(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return clampConfidence(value), true
}

// decodeStrictConfidence parses a model verdict confidence. The zod schemas
// reject values outside 0..1 instead of clamping them, so a model that answers
// 1.2 is treated as an invalid response.
func decodeStrictConfidence(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	if value < 0 || value > 1 {
		return 0, false
	}
	return value, true
}

func clampConfidence(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// computeMinConfidenceThreshold reproduces computeMinConfidenceThreshold: the
// configured base when dynamic confidence is disabled, otherwise the larger of
// the base and the requested confidence quantile.
func computeMinConfidenceThreshold(confidences []float64, settings Settings) float64 {
	base := clampNumber(settings.MinEdgeConfidence, 0, 1, 0.55)
	if !settings.DynamicEdgeConfidenceEnabled {
		return base
	}
	quantile := clampNumber(settings.DynamicEdgeConfidenceQuantile, 0, 1, 0.25)
	if len(confidences) == 0 {
		return base
	}
	sorted := append([]float64(nil), confidences...)
	sort.Float64s(sorted)
	index := int(math.Floor(float64(len(sorted)-1) * quantile))
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	value := sorted[index]
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return base
	}
	return math.Max(base, value)
}

func clampNumber(value, minimum, maximum, fallback float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampInt(value, minimum, maximum, fallback int) int {
	rounded := int(math.Round(float64(value)))
	if rounded < minimum {
		return minimum
	}
	if rounded > maximum {
		return maximum
	}
	return rounded
}
