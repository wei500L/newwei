package crawlreadtelemetry

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// RawJSON carries a schema-less JSON value: a Mongoose Mixed field decoded from
// MongoDB or a Prisma Json column read from MySQL. It is the strongly typed
// stand-in for TypeScript's Record<string, unknown> / unknown: the wrapper
// never exposes Go's untyped any to this package.
//
// Decoding a BSON value converts it to relaxed, standard JSON (the same shape
// JSON.stringify produces for plain strings, numbers, booleans, arrays and
// objects). MySQL Json columns are stored verbatim.
type RawJSON []byte

// UnmarshalBSONValue implements bson.ValueUnmarshaler. It keeps the raw BSON
// value and re-encodes it as relaxed JSON so nested Mixed documents survive a
// response round trip without being re-modelled field by field.
func (r *RawJSON) UnmarshalBSONValue(valueType byte, data []byte) error {
	// A BSON null / undefined field is represented as a nil RawJSON so callers
	// can distinguish "absent" from "present".
	if bson.Type(valueType) == bson.TypeNull || bson.Type(valueType) == bson.TypeUndefined {
		*r = nil
		return nil
	}
	encoded, err := bson.MarshalExtJSON(bson.RawValue{Type: bson.Type(valueType), Value: data}, false, false)
	if err != nil {
		return err
	}
	*r = encoded
	return nil
}

// MarshalJSON implements json.Marshaler. An empty RawJSON renders as JSON null,
// matching NestJS where an absent schema-less value is serialized as null.
func (r RawJSON) MarshalJSON() ([]byte, error) {
	if len(bytes.TrimSpace(r)) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}

// IsEmpty reports whether the raw value holds no JSON payload.
func (r RawJSON) IsEmpty() bool {
	return len(bytes.TrimSpace(r)) == 0
}

// Clone returns a defensive copy so callers never alias driver-owned buffers.
func (r RawJSON) Clone() RawJSON {
	if r == nil {
		return nil
	}
	out := make([]byte, len(r))
	copy(out, r)
	return out
}

// objectJSONOrNull mirrors the NestJS guard
//
//	task.config && typeof task.config === "object" && !Array.isArray(task.config)
//
// It returns the raw object only when the payload is a JSON object, and JSON
// null otherwise.
func objectJSONOrNull(raw []byte) RawJSON {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	return RawJSON(trimmed)
}

// stringArrayFromJSON mirrors fromJsonArray / normalizeKeywords input handling:
// a JSON array of strings becomes a []string, every other entry is dropped and
// a non-array payload becomes an empty slice. []json.RawMessage keeps the
// decoding strongly typed: non-string entries are skipped instead of failing
// the whole array.
func stringArrayFromJSON(raw []byte) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return []string{}
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmedEntry := bytes.TrimSpace(entry)
		// json.Unmarshal accepts a JSON null into a string without an error, so
		// the quoted-string shape is checked first: only entries that are
		// actually JSON strings survive, exactly like the TypeScript
		// `typeof entry === "string"` filter.
		if len(trimmedEntry) == 0 || trimmedEntry[0] != '"' {
			continue
		}
		var text string
		if err := json.Unmarshal(trimmedEntry, &text); err == nil {
			out = append(out, text)
		}
	}
	return out
}

// jsISOLayout is the JavaScript Date.toISOString() layout (millisecond UTC).
// Go's default RFC3339Nano layout omits trailing zeros, so timestamps would not
// match the NestJS response bytes.
const jsISOLayout = "2006-01-02T15:04:05.000Z"

// JSTime serializes a timestamp exactly like JavaScript's Date.toISOString().
type JSTime struct {
	time.Time
}

// MarshalJSON writes the millisecond UTC ISO string used by NestJS.
func (t JSTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.UTC().Format(jsISOLayout) + `"`), nil
}

// UnmarshalJSON accepts the JavaScript ISO string form on the way back in (the
// ObservabilitySnapshot payload is re-parsed by the source endpoint).
func (t *JSTime) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return err
	}
	t.Time = parsed
	return nil
}

// UnmarshalBSONValue decodes a BSON DateTime into a JSTime so task log
// timestamps survive a Mongo projection without an intermediate conversion.
func (t *JSTime) UnmarshalBSONValue(valueType byte, data []byte) error {
	if bson.Type(valueType) == bson.TypeNull {
		t.Time = time.Time{}
		return nil
	}
	var parsed time.Time
	if err := bson.UnmarshalValue(bson.Type(valueType), data, &parsed); err != nil {
		return err
	}
	t.Time = parsed
	return nil
}

// jsTimePtr wraps a database timestamp for JSON output.
func jsTimePtr(value time.Time) *JSTime {
	converted := JSTime{Time: value}
	return &converted
}

// jsTimePtrFromNull converts a nullable SQL timestamp: NULL becomes nil so the
// field serializes as JSON null, matching the NestJS `?? null` handling.
func jsTimePtrFromNull(value sql.NullTime) *JSTime {
	if !value.Valid {
		return nil
	}
	return jsTimePtr(value.Time)
}
