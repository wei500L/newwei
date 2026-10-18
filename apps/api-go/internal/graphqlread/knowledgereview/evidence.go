package knowledgereview

import (
	"bytes"
	"encoding/json"
	"strings"
)

// The evidence JSON is an open document: the reviewer only replaces its
// `review` sibling, everything else must survive untouched. The helpers below
// therefore decode into a typed map of raw leaves instead of a struct, so an
// unknown sibling (for example a future extractor field) is preserved verbatim.

// decodeEvidenceObject decodes a JSON object into its raw leaves. An absent
// value, JSON null, an array or invalid JSON yields an empty object, mirroring
// the NestJS asRecord helper.
func decodeEvidenceObject(raw []byte) map[string]json.RawMessage {
	fields := map[string]json.RawMessage{}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fields
	}
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return map[string]json.RawMessage{}
	}
	return fields
}

// withReview replaces the review sub-document and keeps every sibling field.
func withReview(previous []byte, review json.RawMessage) json.RawMessage {
	fields := decodeEvidenceObject(previous)
	fields["review"] = cloneRaw(review)
	return marshalObject(fields)
}

// mergeDuplicateEvidence reproduces the NestJS spread order
// `{...previous, ...duplicate, review}`: duplicate leaves win over the original
// ones and the fresh review always wins last.
func mergeDuplicateEvidence(previous, duplicate []byte, review json.RawMessage) json.RawMessage {
	fields := decodeEvidenceObject(previous)
	for key, value := range decodeEvidenceObject(duplicate) {
		fields[key] = value
	}
	fields["review"] = cloneRaw(review)
	return marshalObject(fields)
}

func marshalObject(fields map[string]json.RawMessage) json.RawMessage {
	encoded, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	copied := make(json.RawMessage, len(raw))
	copy(copied, raw)
	return copied
}

// isRejectedEvidence reports whether review.status trims to exactly
// "rejected". A missing review, a non-object review, an unknown status or any
// other verdict counts as active.
func isRejectedEvidence(raw []byte) bool {
	reviewRaw, ok := decodeEvidenceObject(raw)["review"]
	if !ok {
		return false
	}
	statusRaw, ok := decodeEvidenceObject(reviewRaw)["status"]
	if !ok {
		return false
	}
	status, ok := decodeJSONString(statusRaw)
	if !ok {
		return false
	}
	return strings.TrimSpace(status) == string(reviewStatusRejected)
}

// durableRecordSource reports whether the edge properties carry a recordSource
// that keeps an evidence-less edge alive: seed, user or derived.
func durableRecordSource(properties []byte) bool {
	sourceRaw, ok := decodeEvidenceObject(properties)["recordSource"]
	if !ok {
		return false
	}
	source, ok := decodeJSONString(sourceRaw)
	if !ok {
		return false
	}
	switch source {
	case "seed", "user", "derived":
		return true
	default:
		return false
	}
}

// edgePropertiesWithRecordSource builds `{...relation.properties, recordSource}`
// with the user source, or just `{recordSource}` when the relation carried no
// properties object.
func edgePropertiesWithRecordSource(properties json.RawMessage) json.RawMessage {
	fields := map[string]json.RawMessage{}
	if len(properties) > 0 {
		_ = json.Unmarshal(properties, &fields)
	}
	fields["recordSource"] = json.RawMessage(`"user"`)
	return marshalObject(fields)
}
