package crawlworker

// Insertion-ordered JSON object used for the memory pressure retry state.
//
// The NestJS handler persists the requeue counter with
// `job.updateData({...job.data, memoryPressureRequeues: n})`: an object spread
// keeps the original key order and appends a key that did not exist yet.
// JSON.stringify writes that order byte for byte, and the bullmq job hash `data`
// is re-read by NestJS producers, logs and the admin UI, so a Go map (whose
// iteration order is randomised) would make the stored document differ on every
// write. This type keeps the order.

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// jsonObject is an insertion-ordered JSON object.
type jsonObject struct {
	keys   []string
	values map[string]json.RawMessage
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
	object := &jsonObject{values: map[string]json.RawMessage{}}
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
		object.set(key, value)
	}
	if _, err := decoder.Token(); err != nil {
		return nil, false
	}
	return object, true
}

// set inserts or replaces one key, keeping the original position on replace.
func (o *jsonObject) set(key string, value json.RawMessage) {
	if o.values == nil {
		o.values = map[string]json.RawMessage{}
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// setRawNumber inserts a number from its JSON text.
func (o *jsonObject) setRawNumber(key, number string) {
	o.set(key, json.RawMessage(number))
}

// marshal renders the object with its insertion order preserved.
func (o *jsonObject) marshal() json.RawMessage {
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

// withJSONIntegerField is `{...data, key: value}` for an integer value. The
// original payload is returned unchanged when the key already holds the same
// number, so an unchanged retry counter never rewrites the hash.
func withJSONIntegerField(data json.RawMessage, key string, value int) (json.RawMessage, error) {
	object, ok := parseJSONObject(data)
	if !ok {
		return nil, errJobPayloadNotObject
	}
	object.setRawNumber(key, strconv.Itoa(value))
	return object.marshal(), nil
}
