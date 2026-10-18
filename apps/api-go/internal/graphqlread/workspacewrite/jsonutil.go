package workspacewrite

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
)

// jsonMember is one member of a JSON object during a canonical comparison or a
// merge. The value stays an opaque JSON leaf, so an unknown member survives a
// rewrite with its exact JSON text (a null leaf included).
type jsonMember struct {
	Key   string
	Value json.RawMessage
}

// jsonShape classifies a JSON document by its first non-space byte.
type jsonShape byte

const (
	jsonShapeAbsent jsonShape = 0
	jsonShapeObject jsonShape = '{'
	jsonShapeArray  jsonShape = '['
	jsonShapeScalar jsonShape = 's'
)

func jsonShapeOf(raw json.RawMessage) jsonShape {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return jsonShapeAbsent
	}
	switch trimmed[0] {
	case '{':
		return jsonShapeObject
	case '[':
		return jsonShapeArray
	default:
		return jsonShapeScalar
	}
}

// jsonEqual reports whether two JSON documents are semantically equal: object
// member order is ignored and array order is significant.
//
// Scalars are compared as text. That is conservative for MySQL JSON columns,
// which re-encode what they store: two logically equal scalars written with a
// different escape or number form are reported as changed, so the supplied
// value is written instead of a needed write being skipped.
func jsonEqual(left, right json.RawMessage) bool {
	shape := jsonShapeOf(left)
	if shape != jsonShapeOf(right) {
		return false
	}
	switch shape {
	case jsonShapeObject:
		leftMembers, ok := jsonObjectMembers(left)
		if !ok {
			return false
		}
		rightMembers, ok := jsonObjectMembers(right)
		if !ok {
			return false
		}
		if len(leftMembers) != len(rightMembers) {
			return false
		}
		sortJSONMembers(leftMembers)
		sortJSONMembers(rightMembers)
		for i := range leftMembers {
			if leftMembers[i].Key != rightMembers[i].Key {
				return false
			}
			if !jsonEqual(leftMembers[i].Value, rightMembers[i].Value) {
				return false
			}
		}
		return true
	case jsonShapeArray:
		leftItems, ok := jsonArrayItems(left)
		if !ok {
			return false
		}
		rightItems, ok := jsonArrayItems(right)
		if !ok {
			return false
		}
		if len(leftItems) != len(rightItems) {
			return false
		}
		for i := range leftItems {
			if !jsonEqual(leftItems[i], rightItems[i]) {
				return false
			}
		}
		return true
	case jsonShapeAbsent:
		return true
	default:
		return bytes.Equal(bytes.TrimSpace(left), bytes.TrimSpace(right))
	}
}

// jsonObjectMembers decodes a JSON object into its member list in document
// order. A non-object document reports ok = false.
func jsonObjectMembers(raw json.RawMessage) ([]jsonMember, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, false
	}
	members := make([]jsonMember, 0, 4)
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
		members = append(members, jsonMember{Key: key, Value: value})
	}
	return members, true
}

// jsonArrayItems decodes a JSON array into its items in document order. A
// non-array document reports ok = false.
func jsonArrayItems(raw json.RawMessage) ([]json.RawMessage, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if delim, ok := token.(json.Delim); !ok || delim != '[' {
		return nil, false
	}
	items := make([]json.RawMessage, 0, 4)
	for decoder.More() {
		var item json.RawMessage
		if err := decoder.Decode(&item); err != nil {
			return nil, false
		}
		items = append(items, item)
	}
	return items, true
}

func sortJSONMembers(members []jsonMember) {
	sort.SliceStable(members, func(i, j int) bool {
		return members[i].Key < members[j].Key
	})
}

// jsonObjectMember returns one member of a JSON object and whether it exists.
func jsonObjectMember(raw json.RawMessage, key string) (json.RawMessage, bool) {
	members, ok := jsonObjectMembers(raw)
	if !ok {
		return nil, false
	}
	for _, member := range members {
		if member.Key == key {
			return member.Value, true
		}
	}
	return nil, false
}

// mergeJSONObject rebuilds a JSON object: every member of base is copied except
// the keys named by overrides, then the overrides are appended. A base that is
// not a JSON object is treated as an empty object, which mirrors
// `{ ...(existing ?? {}) }` in the NestJS service.
//
// The rewrite copies unknown members as opaque JSON leaves, so unrelated
// context metrics and feedback fields are never dropped. Overriding a key with
// json.RawMessage("null") keeps an explicit null member.
func mergeJSONObject(base json.RawMessage, overrides []jsonMember) (json.RawMessage, error) {
	members, ok := jsonObjectMembers(base)
	if !ok {
		members = nil
	}
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	written := 0
	writeMember := func(key string, value json.RawMessage) error {
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return err
		}
		if written > 0 {
			buffer.WriteByte(',')
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		if !json.Valid(value) {
			return errors.New("workspacewrite: invalid json member")
		}
		buffer.Write(value)
		written++
		return nil
	}
	for _, member := range members {
		if overriddenKey(member.Key, overrides) {
			continue
		}
		if err := writeMember(member.Key, member.Value); err != nil {
			return nil, err
		}
	}
	for _, override := range overrides {
		if err := writeMember(override.Key, override.Value); err != nil {
			return nil, err
		}
	}
	buffer.WriteByte('}')
	return json.RawMessage(buffer.Bytes()), nil
}

// overriddenKey reports whether the overrides replace key.
func overriddenKey(key string, overrides []jsonMember) bool {
	for _, override := range overrides {
		if override.Key == key {
			return true
		}
	}
	return false
}
