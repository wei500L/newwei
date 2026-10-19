package alertworker

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
)

// jsonObject is an insertion-ordered JSON object. The alert event context is
// built in JavaScript with object spreads (`{latest, previous, changePercent,
// ...providerContext, ...triggered.context}`) and JSON.stringify preserves that
// insertion order, so the published alertEvents envelope (and the context
// column) must preserve it too. A Go map cannot.
type jsonObject struct {
	keys   []string
	values map[string]json.RawMessage
}

func newJSONObject() *jsonObject {
	return &jsonObject{values: map[string]json.RawMessage{}}
}

// parseJSONObject decodes a JSON object and remembers its key order. A JSON
// null, an empty value or a non-object reports false.
func parseJSONObject(raw json.RawMessage) (*jsonObject, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, false
	}
	object := newJSONObject()
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false
		}
		object.Set(key, value)
	}
	if _, err := decoder.Token(); err != nil {
		return nil, false
	}
	return object, true
}

// Set inserts or replaces one key, keeping the original position on replace.
func (o *jsonObject) Set(key string, value json.RawMessage) {
	if o.values == nil {
		o.values = map[string]json.RawMessage{}
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// SetString inserts a JSON string value.
func (o *jsonObject) SetString(key, value string) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	o.Set(key, encoded)
}

// SetRawNumber inserts a number from its JSON text (jsnum.Format output).
func (o *jsonObject) SetRawNumber(key, number string) {
	o.Set(key, json.RawMessage(number))
}

// SetNull inserts a JSON null.
func (o *jsonObject) SetNull(key string) {
	o.Set(key, json.RawMessage("null"))
}

// SetObject merges every key of another object, replacing the values of keys
// that already exist (JavaScript object spread semantics).
func (o *jsonObject) SetObject(other *jsonObject) {
	if other == nil {
		return
	}
	for _, key := range other.keys {
		o.Set(key, other.values[key])
	}
}

// Get returns one raw value.
func (o *jsonObject) Get(key string) (json.RawMessage, bool) {
	if o == nil {
		return nil, false
	}
	value, ok := o.values[key]
	return value, ok
}

// Has reports whether the key is present.
func (o *jsonObject) Has(key string) bool {
	if o == nil {
		return false
	}
	_, ok := o.values[key]
	return ok
}

// Len is the number of keys.
func (o *jsonObject) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Marshal renders the object with its insertion order preserved.
func (o *jsonObject) Marshal() json.RawMessage {
	if o == nil {
		return nil
	}
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			continue
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		value := o.values[key]
		if len(value) == 0 {
			buffer.WriteString("null")
			continue
		}
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

// stringField reads a string field of a JSON object, mirroring the
// `typeof x === "string"` guards in the NestJS service.
func stringField(object *jsonObject, key string) (string, bool) {
	raw, ok := object.Get(key)
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// boolField reads a boolean field of a JSON object.
func boolField(object *jsonObject, key string) (bool, bool) {
	raw, ok := object.Get(key)
	if !ok {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

// numberField reads a finite number field of a JSON object, mirroring
// `typeof x === "number" && Number.isFinite(x)`.
func numberField(object *jsonObject, key string) (float64, bool) {
	raw, ok := object.Get(key)
	if !ok {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	if !isFinite(value) {
		return 0, false
	}
	return value, true
}

// rawStringValue decodes a JSON string, number or boolean into its JavaScript
// String() value, for the mute-until fields whose type varies.
func rawStringValue(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", false
	}
	if trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return "", false
		}
		return value, true
	}
	var number json.Number
	if err := json.Unmarshal(trimmed, &number); err == nil {
		return number.String(), true
	}
	var boolean bool
	if err := json.Unmarshal(trimmed, &boolean); err == nil {
		return strconv.FormatBool(boolean), true
	}
	return "", false
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
