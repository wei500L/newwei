package crawlfrontierruns

import (
	"bytes"
	"encoding/json"
)

// RawJSON carries a schema-less JSON column (metadata, keywords, config
// output, workflow input/output/graphSnapshot, parameterSources, sampleUrls,
// metrics, ruleHits, snapshots, event details and repair payloads). It is the
// strongly typed stand-in for "arbitrary JSON": the wrapper never exposes a Go
// untyped container to this package.
//
// A raw value is passed through byte-for-byte when it is serialized, and an
// empty value renders as JSON null, which matches the NestJS `?? null`
// handling for absent schema-less columns.
type RawJSON []byte

// MarshalJSON implements json.Marshaler. An empty RawJSON renders as JSON
// null; every other value is emitted verbatim.
func (r RawJSON) MarshalJSON() ([]byte, error) {
	if len(bytes.TrimSpace(r)) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}

// UnmarshalJSON implements json.Unmarshaler by keeping the raw bytes.
func (r *RawJSON) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	*r = append((*r)[:0], trimmed...)
	return nil
}

// IsEmpty reports whether the value holds no JSON payload.
func (r RawJSON) IsEmpty() bool {
	return len(bytes.TrimSpace(r)) == 0
}

// IsObject reports whether the value is a JSON object, mirroring the NestJS
// `isPlainObject` guard.
func (r RawJSON) IsObject() bool {
	return rawIsObject(r)
}

// IsArray reports whether the value is a JSON array.
func (r RawJSON) IsArray() bool {
	return rawIsArray(r)
}

// rawIsObject reports whether raw holds a valid JSON object.
func rawIsObject(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(trimmed)
}

// rawIsArray reports whether raw holds a valid JSON array.
func rawIsArray(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '[' && json.Valid(trimmed)
}

// rawIsString reports whether raw holds a JSON string.
func rawIsString(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"' && json.Valid(trimmed)
}

// rawIsNumber reports whether raw holds a JSON number.
func rawIsNumber(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return false
	}
	var number json.Number
	return json.Unmarshal(trimmed, &number) == nil
}

// objectJSONOrNull mirrors
//
//	value && typeof value === "object" && !Array.isArray(value) ? value : null
//
// It returns the raw object only when the payload is a JSON object and JSON
// null otherwise.
func objectJSONOrNull(raw []byte) RawJSON {
	if !rawIsObject(raw) {
		return nil
	}
	return RawJSON(bytes.TrimSpace(raw))
}

// objectJSONOrEmpty returns the raw object when the payload is a JSON object
// and `{}` otherwise.
func objectJSONOrEmpty(raw []byte) RawJSON {
	if !rawIsObject(raw) {
		return RawJSON("{}")
	}
	return RawJSON(bytes.TrimSpace(raw))
}

// arrayJSONOrEmpty returns the raw array when the payload is a JSON array and
// `[]` otherwise.
func arrayJSONOrEmpty(raw []byte) RawJSON {
	if !rawIsArray(raw) {
		return RawJSON("[]")
	}
	return RawJSON(bytes.TrimSpace(raw))
}

// arrayJSONOrNil returns the raw array when the payload is a JSON array and nil
// otherwise, so an omitted-free field can be dropped from the response.
func arrayJSONOrNil(raw []byte) RawJSON {
	if !rawIsArray(raw) {
		return nil
	}
	return RawJSON(bytes.TrimSpace(raw))
}
