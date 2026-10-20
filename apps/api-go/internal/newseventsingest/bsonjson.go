package newseventsingest

import (
	"bytes"
	"encoding/json"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// errInvalidJSONLeaf reports an extended-JSON conversion that did not produce a
// single value. It can only happen for a BSON type the driver cannot render.
var errInvalidJSONLeaf = errors.New("newseventsingest: invalid JSON leaf")

// jsonLeaf carries a schema-less JSON value — a ProcessedItem.result member or
// the BERTopic diagnostics — as relaxed extended JSON. It is the strongly typed
// stand-in for TypeScript's unknown: the wrapper never exposes Go's untyped any.
//
// The BSON decoding mirrors crawlreadtelemetry.RawJSON: the raw value is kept
// and re-encoded as relaxed JSON so a nested Mixed document survives without
// being re-modelled field by field. A BSON null or undefined becomes nil, so
// "absent" stays distinguishable from "present".
type jsonLeaf []byte

// UnmarshalBSONValue implements bson.ValueUnmarshaler.
func (r *jsonLeaf) UnmarshalBSONValue(valueType byte, data []byte) error {
	if bson.Type(valueType) == bson.TypeNull || bson.Type(valueType) == bson.TypeUndefined {
		*r = nil
		return nil
	}
	encoded, err := bsonValueToJSON(valueType, data)
	if err != nil {
		return err
	}
	*r = jsonLeaf(encoded)
	return nil
}

// MarshalJSON keeps the raw document bytes; a nil leaf renders as JSON null.
func (r jsonLeaf) MarshalJSON() ([]byte, error) {
	trimmed := bytes.TrimSpace(r)
	if len(trimmed) == 0 {
		return []byte("null"), nil
	}
	return trimmed, nil
}

// bsonValueToJSON converts one BSON value to relaxed extended JSON.
//
// The extended-JSON writer can only emit a scalar while it is positioned on a
// document element, so the raw value is wrapped in a one-field document and the
// wrapper is stripped afterwards.
func bsonValueToJSON(valueType byte, data []byte) (json.RawMessage, error) {
	wrapped, err := bson.MarshalExtJSON(
		bson.D{{Key: "v", Value: bson.RawValue{Type: bson.Type(valueType), Value: data}}},
		false, false,
	)
	if err != nil {
		return nil, err
	}
	colon := bytes.IndexByte(wrapped, ':')
	if colon < 0 || len(wrapped) < colon+2 || wrapped[len(wrapped)-1] != '}' {
		return nil, errInvalidJSONLeaf
	}
	inner := bytes.TrimSpace(wrapped[colon+1 : len(wrapped)-1])
	encoded := make([]byte, len(inner))
	copy(encoded, inner)
	return json.RawMessage(encoded), nil
}
