package crawlfrontierllm

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Object is a JSON object that preserves key insertion order and every unknown
// key. Nest stores metadata, diagnostics and candidate payloads as
// Record<string, unknown>; a Go map would lose the order the workflow recorder
// and Prisma serialized the object in, so the leaf type keeps an explicit key
// slice.
//
// The merge helper (mergeObjects) mirrors mergeMetadataRecords: later records
// win, an existing key keeps its first position, and a key whose value is
// undefined is skipped. JSON null is a real value and is preserved.
type Object struct {
	keys   []string
	values map[string]json.RawMessage
}

// NewObject returns an empty ordered object.
func NewObject() *Object {
	return &Object{values: map[string]json.RawMessage{}}
}

// ParseObject decodes a JSON object leaf. A missing, null or non-object value
// returns (nil, false) exactly like isPlainObject.
func ParseObject(raw json.RawMessage) (*Object, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return nil, false
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &values); err != nil {
		return nil, false
	}
	decoded, err := decodeOrderedObject(trimmed)
	if err != nil {
		return nil, false
	}
	return decoded, true
}

// decodeOrderedObject walks the top-level members in document order.
func decodeOrderedObject(raw []byte) (*Object, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, errNotObject
	}
	out := NewObject()
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, _ := keyToken.(string)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		out.SetRaw(key, value)
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	return out, nil
}

// ObjectFromAny converts an already-decoded JSON value into an ordered object
// when it is a plain object.
func ObjectFromAny(value any) (*Object, bool) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	return ParseObject(encoded)
}

// Keys returns the key order.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	out := make([]string, len(o.keys))
	copy(out, o.keys)
	return out
}

// Len returns the member count.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Has reports whether key is present (even with a null value).
func (o *Object) Has(key string) bool {
	if o == nil {
		return false
	}
	_, ok := o.values[key]
	return ok
}

// Raw returns the raw value for key.
func (o *Object) Raw(key string) (json.RawMessage, bool) {
	if o == nil {
		return nil, false
	}
	value, ok := o.values[key]
	return value, ok
}

// SetRaw stores a raw JSON value; an existing key keeps its position.
func (o *Object) SetRaw(key string, value json.RawMessage) {
	if o == nil || key == "" {
		return
	}
	if o.values == nil {
		o.values = map[string]json.RawMessage{}
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = append(json.RawMessage(nil), value...)
}

// Set stores a JSON-encodable value. A nil value writes JSON null, matching a
// present `key: null` leaf.
func (o *Object) Set(key string, value any) {
	encoded, err := marshalJSON(value)
	if err != nil {
		return
	}
	o.SetRaw(key, encoded)
}

// SetString stores a string leaf.
func (o *Object) SetString(key, value string) { o.Set(key, value) }

// SetBool stores a boolean leaf.
func (o *Object) SetBool(key string, value bool) { o.Set(key, value) }

// SetNumber stores a finite number leaf.
func (o *Object) SetNumber(key string, value float64) {
	if !isFinite(value) {
		return
	}
	o.Set(key, numberJSON(value))
}

// SetNull stores an explicit JSON null.
func (o *Object) SetNull(key string) { o.SetRaw(key, json.RawMessage("null")) }

// Delete removes a key while preserving the order of the rest.
func (o *Object) Delete(key string) {
	if o == nil {
		return
	}
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for index, existing := range o.keys {
		if existing == key {
			o.keys = append(o.keys[:index], o.keys[index+1:]...)
			break
		}
	}
}

// Clone returns an independent copy.
func (o *Object) Clone() *Object {
	if o == nil {
		return nil
	}
	out := NewObject()
	for _, key := range o.keys {
		out.SetRaw(key, o.values[key])
	}
	return out
}

// MarshalJSON writes the members in insertion order.
func (o *Object) MarshalJSON() ([]byte, error) {
	if o == nil {
		return []byte("null"), nil
	}
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		value := o.values[key]
		if len(value) == 0 {
			value = json.RawMessage("null")
		}
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// String reads a string leaf exactly like asString: a non-string or an
// all-whitespace string is absent, and a present string is trimmed.
func (o *Object) String(key string) (string, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	trimmed := jsTrim(value)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// UntrimmedString reads a string leaf without trimming.
func (o *Object) UntrimmedString(key string) (string, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// Bool reads a boolean leaf.
func (o *Object) Bool(key string) (bool, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

// Number reads a number leaf with the JS Number coercion toFiniteNumber uses.
func (o *Object) Number(key string) (float64, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return 0, false
	}
	return toFiniteNumber(raw)
}

// Object reads a nested plain object leaf.
func (o *Object) Object(key string) (*Object, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return nil, false
	}
	return ParseObject(raw)
}

// Strings reads a string array leaf with coerceStringArray semantics: only
// strings are kept, each is trimmed, empty entries are dropped, and an empty
// result is absent.
func (o *Object) Strings(key string) ([]string, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return nil, false
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(values))
	for _, entry := range values {
		var text string
		if err := json.Unmarshal(entry, &text); err != nil {
			continue
		}
		trimmed := jsTrim(text)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

// StringsKeepEmpty reads a raw string array (Array.isArray checks that keep
// non-string values filtered but empty strings intact).
func (o *Object) StringsKeepEmpty(key string) ([]string, bool) {
	raw, ok := o.Raw(key)
	if !ok {
		return nil, false
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(values))
	for _, entry := range values {
		var text string
		if err := json.Unmarshal(entry, &text); err != nil {
			continue
		}
		out = append(out, text)
	}
	return out, true
}

// BumpCount mirrors bumpCount on an ordered numeric record.
func bumpObjectCount(object *Object, key string) {
	if object == nil {
		return
	}
	current, ok := object.Number(key)
	if !ok {
		current = 0
	}
	object.SetNumber(key, current+1)
}

// toNumericObject mirrors toNumericRecord: every finite numeric coercion is
// kept, in source order; an object with no numeric member is nil.
func toNumericObject(object *Object) *Object {
	if object == nil {
		return nil
	}
	out := NewObject()
	for _, key := range object.keys {
		value, ok := toFiniteNumber(object.values[key])
		if !ok {
			continue
		}
		out.SetNumber(key, value)
	}
	if out.Len() == 0 {
		return nil
	}
	return out
}

// mergeObjects mirrors mergeMetadataRecords. It returns nil when the merged
// object has no member.
func mergeObjects(records ...*Object) *Object {
	out := NewObject()
	for _, record := range records {
		if record == nil {
			continue
		}
		for _, key := range record.keys {
			out.SetRaw(key, record.values[key])
		}
	}
	if out.Len() == 0 {
		return nil
	}
	return out
}

// objectOrEmpty returns an empty object for a missing leaf.
func objectOrEmpty(object *Object) *Object {
	if object == nil {
		return NewObject()
	}
	return object
}

// isObjectLeaf reports whether raw is a plain JSON object.
func isObjectLeaf(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

// Array is a JSON array of raw members. It mirrors the JSON column values the
// recorder writes (sampleUrls, stepResults, candidates, traces) without
// forcing every member into map[string]any.
type Array struct {
	items []json.RawMessage
}

// NewArray returns an empty array.
func NewArray() *Array { return &Array{} }

// Append adds one raw member.
func (a *Array) Append(raw json.RawMessage) {
	if a == nil {
		return
	}
	a.items = append(a.items, append(json.RawMessage(nil), raw...))
}

// Len returns the member count.
func (a *Array) Len() int {
	if a == nil {
		return 0
	}
	return len(a.items)
}

// MarshalJSON writes the members in order.
func (a *Array) MarshalJSON() ([]byte, error) {
	if a == nil {
		return []byte("[]"), nil
	}
	var buffer bytes.Buffer
	buffer.WriteByte('[')
	for index, item := range a.items {
		if index > 0 {
			buffer.WriteByte(',')
		}
		if len(item) == 0 {
			buffer.WriteString("null")
			continue
		}
		buffer.Write(item)
	}
	buffer.WriteByte(']')
	return buffer.Bytes(), nil
}

var errNotObject = jsonError("json value is not an object")

type jsonError string

func (e jsonError) Error() string { return string(e) }
