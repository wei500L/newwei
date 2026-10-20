package newseventstimeline

import (
	"bytes"
	"encoding/json"
	"math"
	"time"
)

// storedTimelineEntryDocument is one raw metadata.timeline.entries value.
type storedTimelineEntryDocument struct {
	CategoryPath       json.RawMessage `json:"categoryPath"`
	CategoryConfidence json.RawMessage `json:"categoryConfidence"`
	Tentative          json.RawMessage `json:"tentative"`
	Anchor             json.RawMessage `json:"anchor"`
	ImportanceScore    json.RawMessage `json:"importanceScore"`
	ItemCount          json.RawMessage `json:"itemCount"`
}

// normalizeTimelineEntries mirrors normalizeTimelineEntries: entries must be a
// JSON object, each value must be a JSON object, and every leaf is coerced with
// the JavaScript typeof/Boolean rules.
func normalizeTimelineEntries(raw json.RawMessage) map[string]timelineEntryClassification {
	out := make(map[string]timelineEntryClassification)
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return out
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil {
		return out
	}
	for bucketKey, value := range object {
		entry, ok := normalizeTimelineEntry(value)
		if !ok {
			continue
		}
		out[bucketKey] = entry
	}
	return out
}

// normalizeTimelineEntry normalizes one stored entry. ok is false when the value
// is not a JSON object (the NestJS loop skips null, arrays and scalars).
func normalizeTimelineEntry(raw json.RawMessage) (timelineEntryClassification, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return timelineEntryClassification{}, false
	}
	var document storedTimelineEntryDocument
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return timelineEntryClassification{}, false
	}
	entry := timelineEntryClassification{
		CategoryPath: normalizeCategoryPath(rawJSONString(document.CategoryPath)),
		Tentative:    rawJSONTruthy(document.Tentative),
		Anchor:       rawJSONTruthy(document.Anchor),
	}
	if value, ok := rawJSONNumber(document.CategoryConfidence); ok {
		clamped := math.Max(0, math.Min(1, value))
		entry.CategoryConfidence = &clamped
	}
	if value, ok := rawJSONNumber(document.ImportanceScore); ok {
		entry.ImportanceScore = value
	}
	if value, ok := rawJSONNumber(document.ItemCount); ok && value > 0 {
		entry.ItemCount = jsRoundInt(value)
	}
	return entry, true
}

// rawJSONString reports the value as a string pointer only when it is a JSON
// string, matching a typeof === "string" check.
func rawJSONString(raw json.RawMessage) *string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil
	}
	return &value
}

// rawJSONNumber reports the value only when it is a finite JSON number,
// matching a typeof === "number" plus Number.isFinite check.
func rawJSONNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// rawJSONTruthy applies JavaScript Boolean(x) to a raw JSON value: absent, null,
// false, 0, -0, NaN and "" are false; every other value, including an empty
// object or array, is true.
func rawJSONTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	switch trimmed[0] {
	case 't':
		return true
	case 'f', 'n':
		return false
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return false
		}
		return text != ""
	case '{', '[':
		return true
	}
	if value, ok := rawJSONNumber(trimmed); ok {
		return value != 0
	}
	return false
}

// mergeTimelineMetadata mirrors mergeTimelineMetadata for the O2 read shape: the
// caller supplies only the previously stored metadata.timeline.entries (the rest
// of the metadata object is preserved by the JSON_SET write itself).
//
// Buckets whose key points before the retention window are dropped; a key Date.parse
// cannot read is kept, because the NestJS code keeps it too.
func mergeTimelineMetadata(
	eventID string,
	existingEntries map[string]timelineEntryClassification,
	bucketEntries map[string]timelineEntryClassification,
	analysis timelineAnalysis,
	retainSince time.Time,
	updatedAt time.Time,
) timelineMetadata {
	retainSinceMillis := retainSince.UnixMilli()
	merged := make(map[string]timelineEntryClassification, len(existingEntries)+len(bucketEntries))
	for bucketKey, entry := range existingEntries {
		if bucketMillis, ok := parseJSTimestamp(bucketKey); !ok || bucketMillis >= retainSinceMillis {
			merged[bucketKey] = entry
		}
	}
	for bucketKey, entry := range bucketEntries {
		merged[bucketKey] = entry
	}
	return timelineMetadata{
		Entries:              merged,
		CategoryDistribution: analysis.CategoryDistribution,
		TopicDriftWarning:    analysis.TopicDriftWarning,
		TopicDriftSummary:    analysis.TopicDriftSummary,
		DriftWarnings:        analysis.DriftWarnings,
		PhaseSummaries:       analysis.PhaseSummaries,
		SubEvents:            buildTimelineSubEvents(eventID, analysis.PhaseSummaries),
		UpdatedAt:            formatISOMillis(updatedAt),
	}
}
