package classificationreviewseed

import (
	"bytes"
	"encoding/json"
	"strings"
)

// ReviewSeedJobPrefix is REVIEW_SEED_QUEUE_JOB_PREFIX in
// classification-quality.service.ts.
const ReviewSeedJobPrefix = "classification-quality-review-seed-item:"

// ReviewSeedJobID builds the BullMQ job id for one processed item. NestJS uses
// the same value both as the job name and as the job id option, which is what
// makes replaying the event idempotent.
func ReviewSeedJobID(orgID, processedItemID string) string {
	return ReviewSeedJobPrefix + orgID + ":" + processedItemID
}

// processedItemFields is the completed returnvalue subset read by the trigger.
// RawMessage keeps the original JSON type so only genuine JSON strings are
// accepted, exactly like `typeof candidate === "string"`.
type processedItemFields struct {
	ID              json.RawMessage `json:"id"`
	MongoID         json.RawMessage `json:"_id"`
	ProcessedItemID json.RawMessage `json:"processedItemId"`
}

// ProcessedItemID returns the first non-empty trimmed string of id, _id and
// processedItemId, or "" when the payload is not an object or has no string
// candidate. Arrays and non-object return values are ignored (the NestJS
// trigger rejects them before reading the fields).
func ProcessedItemID(data json.RawMessage) string {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return ""
	}
	var fields processedItemFields
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return ""
	}
	for _, candidate := range []json.RawMessage{fields.ID, fields.MongoID, fields.ProcessedItemID} {
		text, ok := jsonString(candidate)
		if !ok {
			continue
		}
		if normalized := strings.TrimSpace(text); normalized != "" {
			return normalized
		}
	}
	return ""
}

// jsonString accepts only a JSON string literal. json.Unmarshal also accepts
// null into a string, so the leading quote is checked explicitly.
func jsonString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}
