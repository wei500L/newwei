package situationsignals

import (
	"encoding/json"
	"strings"
)

// This file holds the named loose JSON types used for payloads this package
// does not fully own: pass-through response documents (refresh-run signals /
// cache / warnings elements), cached state written by the NestJS schedulers and
// SystemSetting fields whose runtime type is only known after the fact.
//
// Every one of them is a named struct type with an explicit UnmarshalJSON, so
// no untyped value ever crosses a package boundary.

// rawJSON is an opaque JSON value that is decoded and re-encoded verbatim.
// It is used for the pass-through parts of a cached record (a refresh run's
// `signals` and `cache`, every `warnings` element, a Telegram item, an OREF
// alert) so this package never has to model a document it does not own and
// never loses a field the writer stored.
type rawJSON struct {
	raw json.RawMessage
}

// UnmarshalJSON stores the exact bytes of the value.
func (r *rawJSON) UnmarshalJSON(data []byte) error {
	r.raw = append(r.raw[:0], data...)
	return nil
}

// MarshalJSON re-emits the stored bytes.
func (r rawJSON) MarshalJSON() ([]byte, error) {
	if len(r.raw) == 0 {
		return []byte("null"), nil
	}
	return r.raw, nil
}

// IsObject reports whether the value is a JSON object.
func (r rawJSON) IsObject() bool {
	trimmed := strings.TrimSpace(string(r.raw))
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// IsArray reports whether the value is a JSON array.
func (r rawJSON) IsArray() bool {
	trimmed := strings.TrimSpace(string(r.raw))
	return len(trimmed) > 0 && trimmed[0] == '['
}

// isNull reports whether the value is JSON null (or absent).
func (r rawJSON) isNull() bool {
	trimmed := strings.TrimSpace(string(r.raw))
	return trimmed == "" || trimmed == "null"
}

// isTruthy mirrors JavaScript truthiness for a parsed JSON value: null, false,
// 0 and "" are falsy, every object, array, non-empty string and non-zero number
// is truthy. JSON.parse can never produce NaN or undefined.
func (r rawJSON) isTruthy() bool {
	trimmed := strings.TrimSpace(string(r.raw))
	switch trimmed {
	case "", "null", "false", "\"\"":
		return false
	}
	if trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9') {
		value, ok := jsNumber(r.raw, true)
		return !ok || value != 0
	}
	return true
}

// isFalsy is the negation of isTruthy. It is the guard
// `if (!raw) return undefined` used by resolveStoredApiKey and
// normalizeString's callers.
func (r rawJSON) isFalsy() bool { return !r.isTruthy() }

// asObject decodes the value as a JSON object. Absent, null or non-object
// values report false.
func (r rawJSON) asObject() (map[string]json.RawMessage, bool) {
	if !r.IsObject() {
		return nil, false
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(r.raw, &decoded); err != nil {
		return nil, false
	}
	return decoded, true
}

// asArray decodes the value as a JSON array. Absent, null or non-array values
// report false.
func (r rawJSON) asArray() ([]json.RawMessage, bool) {
	if !r.IsArray() {
		return nil, false
	}
	var decoded []json.RawMessage
	if err := json.Unmarshal(r.raw, &decoded); err != nil {
		return nil, false
	}
	return decoded, true
}

// asString decodes the value as a JSON string. Any other type reports false,
// which is exactly the `typeof value === "string"` guard used by NestJS.
func (r rawJSON) asString() (string, bool) {
	trimmed := strings.TrimSpace(string(r.raw))
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(r.raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsonObjectFields keeps the top-level keys of a JSON object in the order they
// appeared, mirroring Node's Object.keys insertion order. The order matters for
// the class-validator message sequence the feedback DTO reproduces.
type jsonObjectFields struct {
	values map[string]json.RawMessage
	order  []string
}

// decodeObjectFields parses a JSON object body. A non-object body reports
// ok=false, which the caller maps onto the class-validator
// "an unknown value was passed to the validate function" message.
func decodeObjectFields(body []byte) (jsonObjectFields, bool) {
	trimmed := strings.TrimSpace(string(body))
	if len(trimmed) == 0 {
		// body-parser turns an empty body into `{}`.
		return jsonObjectFields{values: map[string]json.RawMessage{}}, true
	}
	if trimmed[0] != '{' {
		return jsonObjectFields{}, false
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return jsonObjectFields{}, false
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return jsonObjectFields{}, false
	}
	fields := jsonObjectFields{values: map[string]json.RawMessage{}}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return jsonObjectFields{}, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return jsonObjectFields{}, false
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return jsonObjectFields{}, false
		}
		if _, exists := fields.values[key]; !exists {
			fields.order = append(fields.order, key)
		}
		fields.values[key] = raw
	}
	return fields, true
}

// trimmedString decodes a JSON value that NestJS reads through
// normalizeString(): only a string survives, and only after trimming.
type trimmedString struct {
	present bool
	raw     json.RawMessage
}

// UnmarshalJSON records the raw value.
func (t *trimmedString) UnmarshalJSON(data []byte) error {
	t.present = true
	t.raw = append(t.raw[:0], data...)
	return nil
}

// Value returns the trimmed string and whether it is non-empty.
func (t trimmedString) Value() (string, bool) {
	if !t.present {
		return "", false
	}
	text, ok := rawJSON{raw: t.raw}.asString()
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// IsSet reports whether the key existed at all, even with a null value.
func (t trimmedString) IsSet() bool { return t.present }

// jsNumberish decodes a JSON value that NestJS resolves with Number(value).
// The zero value means "the key was absent", which JavaScript sees as
// undefined: Number(undefined) is NaN, while Number(null) is 0. Keeping the two
// apart is required by the settings resolvers.
type jsNumberish struct {
	present bool
	raw     json.RawMessage
}

// UnmarshalJSON records the raw value.
func (n *jsNumberish) UnmarshalJSON(data []byte) error {
	n.present = true
	n.raw = append(n.raw[:0], data...)
	return nil
}

// Number resolves JavaScript Number(value). The second result is false when the
// result is NaN.
func (n jsNumberish) Number() (float64, bool) {
	if !n.present {
		return 0, false
	}
	return jsNumber(n.raw, true)
}

// IsSet reports whether the key existed at all.
func (n jsNumberish) IsSet() bool { return n.present }

// jsStringList decodes a JSON array of strings. Non-array values decode to an
// empty (nil) slice, mirroring `Array.isArray(value) ? ... : []`.
type jsStringList struct {
	values []string
}

// UnmarshalJSON keeps the string elements in order and drops everything else.
func (l *jsStringList) UnmarshalJSON(data []byte) error {
	items, ok := rawJSON{raw: append([]byte(nil), data...)}.asArray()
	if !ok {
		l.values = nil
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := rawJSON{raw: item}.asString()
		if !ok {
			continue
		}
		out = append(out, text)
	}
	l.values = out
	return nil
}

// Values returns the decoded elements.
func (l jsStringList) Values() []string {
	if l.values == nil {
		return []string{}
	}
	return l.values
}

// jsRawList decodes a JSON array into opaque elements, dropping nothing: an
// element that is itself null or an object stays a rawJSON value.
type jsRawList struct {
	values []rawJSON
}

// UnmarshalJSON keeps every element verbatim.
func (l *jsRawList) UnmarshalJSON(data []byte) error {
	items, ok := rawJSON{raw: append([]byte(nil), data...)}.asArray()
	if !ok {
		l.values = nil
		return nil
	}
	out := make([]rawJSON, 0, len(items))
	for _, item := range items {
		out = append(out, rawJSON{raw: append([]byte(nil), item...)})
	}
	l.values = out
	return nil
}

// Values returns the decoded elements.
func (l jsRawList) Values() []rawJSON {
	if l.values == nil {
		return []rawJSON{}
	}
	return l.values
}

// IsArray reports whether the source value was a JSON array. An empty array is
// still an array, which is what `Array.isArray(cached.items)` distinguishes from
// a missing or non-array field.
func (l jsRawList) IsArray() bool { return l.values != nil }
