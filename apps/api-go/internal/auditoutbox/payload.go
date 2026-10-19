package auditoutbox

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

// invalidPayloadMessage is the exact lastError the NestJS consumer writes for
// an unparsable envelope and for a payload whose orgId does not match the
// outbox row.
const invalidPayloadMessage = "Invalid outbox payload"

// payloadEnvelope is the producer contract. The four required members are
// plain strings because a non-string value is an invalid payload; actorId and
// ipAddress accept any JSON type and normalize non-strings to null.
type payloadEnvelope struct {
	OrgID     string          `json:"orgId"`
	ActorID   nullableString  `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress nullableString  `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// nullableString keeps a JSON string verbatim and normalizes a missing member,
// an explicit null or any other JSON type to nil, mirroring the NestJS
// `typeof value === "string" ? value : null` normalization. The value is never
// trimmed or checked for emptiness, and no user lookup is performed.
type nullableString struct {
	value *string
}

func (n *nullableString) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		n.value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		n.value = nil
		return nil
	}
	n.value = &value
	return nil
}

// parsePayload validates the stored JSON document. The root must be an object
// and orgId/resource/action/createdAt must be non-blank strings; trim is used
// only to decide validity and never rewrites the stored value. Metadata keeps
// the input presence: a missing member leaves the raw message nil, an explicit
// null keeps the four bytes `null`.
func parsePayload(raw json.RawMessage) (*normalizedPayload, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}

	var envelope payloadEnvelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return nil, false
	}
	if strings.TrimSpace(envelope.OrgID) == "" ||
		strings.TrimSpace(envelope.Resource) == "" ||
		strings.TrimSpace(envelope.Action) == "" ||
		strings.TrimSpace(envelope.CreatedAt) == "" {
		return nil, false
	}

	createdAt, ok := parseCreatedAt(envelope.CreatedAt)
	if !ok {
		return nil, false
	}

	return &normalizedPayload{
		OrgID:     envelope.OrgID,
		ActorID:   envelope.ActorID.value,
		Resource:  envelope.Resource,
		Action:    envelope.Action,
		Metadata:  envelope.Metadata,
		IPAddress: envelope.IPAddress.value,
		CreatedAt: createdAt,
	}, true
}

// parseCreatedAt follows the JS `new Date(string)` semantics for the shapes
// producers actually write. Normal producers emit `toISOString()` at
// millisecond precision, which RFC3339Nano covers. A timestamp without a zone
// and a date-only value are accepted as UTC, matching a NestJS process running
// with TZ=UTC; the millisecond truncation matches DATETIME(3) and the dedupe
// comparison. Anything else is an invalid payload.
func parseCreatedAt(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02",
	} {
		parsed, err := time.Parse(layout, trimmed)
		if err == nil {
			return parsed.UTC().Truncate(time.Millisecond), true
		}
	}
	return time.Time{}, false
}
