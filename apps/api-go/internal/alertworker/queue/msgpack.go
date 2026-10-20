package queue

import (
	"fmt"
	"math"
	"sort"
)

// This file is a minimal MessagePack encoder for the exact value shapes BullMQ
// packs into the `alerts` queue commands. It exists so api-go does not need a
// new module dependency (and the matching go.sum regeneration) for one encoder.
//
// The profile is msgpackr's `new Packr({useRecords: false, encodeUndefinedAsNil: true})`:
// maps (not records), arrays, strings, booleans, numbers, nil. Redis only hands
// the blob to `cmsgpack.unpack`, so the integer width chosen here is
// irrelevant; the value must round-trip.
//
// Supported Go values:
//
//	nil, bool, string, []byte, float64, float32,
//	int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64,
//	[]any, []string, map[string]any

// errUnsupportedMsgpack reports a value this encoder refuses to guess at.
type errUnsupportedMsgpack struct{ value any }

func (e errUnsupportedMsgpack) Error() string {
	return fmt.Sprintf("alertworker/queue: cannot MessagePack encode %T", e.value)
}

func appendMsgpack(dst []byte, value any) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return append(dst, 0xc0), nil
	case bool:
		if typed {
			return append(dst, 0xc3), nil
		}
		return append(dst, 0xc2), nil
	case string:
		return appendMsgpackString(dst, typed), nil
	case []byte:
		return appendMsgpackBytes(dst, typed), nil
	case float64:
		return appendMsgpackFloat64(dst, typed), nil
	case float32:
		return appendMsgpackFloat64(dst, float64(typed)), nil
	case int:
		return appendMsgpackInt64(dst, int64(typed)), nil
	case int8:
		return appendMsgpackInt64(dst, int64(typed)), nil
	case int16:
		return appendMsgpackInt64(dst, int64(typed)), nil
	case int32:
		return appendMsgpackInt64(dst, int64(typed)), nil
	case int64:
		return appendMsgpackInt64(dst, typed), nil
	case uint:
		return appendMsgpackUint64(dst, uint64(typed)), nil
	case uint8:
		return appendMsgpackUint64(dst, uint64(typed)), nil
	case uint16:
		return appendMsgpackUint64(dst, uint64(typed)), nil
	case uint32:
		return appendMsgpackUint64(dst, uint64(typed)), nil
	case uint64:
		return appendMsgpackUint64(dst, typed), nil
	case []any:
		return appendMsgpackArray(dst, typed)
	case []string:
		values := make([]any, len(typed))
		for index, entry := range typed {
			values[index] = entry
		}
		return appendMsgpackArray(dst, values)
	case map[string]any:
		return appendMsgpackMap(dst, typed)
	default:
		return nil, errUnsupportedMsgpack{value: value}
	}
}

// MarshalMsgpack encodes value with the queue's MessagePack profile.
func MarshalMsgpack(value any) ([]byte, error) {
	return appendMsgpack(make([]byte, 0, 64), value)
}

func appendMsgpackArray(dst []byte, values []any) ([]byte, error) {
	length := len(values)
	switch {
	case length < 16:
		dst = append(dst, 0x90|byte(length))
	case length <= math.MaxUint16:
		dst = append(dst, 0xdc, byte(length>>8), byte(length))
	default:
		dst = append(dst, 0xdd, byte(length>>24), byte(length>>16), byte(length>>8), byte(length))
	}
	for _, value := range values {
		next, err := appendMsgpack(dst, value)
		if err != nil {
			return nil, err
		}
		dst = next
	}
	return dst, nil
}

func appendMsgpackMap(dst []byte, values map[string]any) ([]byte, error) {
	length := len(values)
	switch {
	case length < 16:
		dst = append(dst, 0x80|byte(length))
	case length <= math.MaxUint16:
		dst = append(dst, 0xde, byte(length>>8), byte(length))
	default:
		dst = append(dst, 0xdf, byte(length>>24), byte(length>>16), byte(length>>8), byte(length))
	}
	// Go map iteration order is random, so the key order is made deterministic.
	// Redis unpacks into a Lua table, so the order carries no meaning; sorting
	// only makes the encoded bytes stable for tests and logs.
	keys := make([]string, 0, length)
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		dst = appendMsgpackString(dst, key)
		next, err := appendMsgpack(dst, values[key])
		if err != nil {
			return nil, err
		}
		dst = next
	}
	return dst, nil
}

func appendMsgpackString(dst []byte, value string) []byte {
	length := len(value)
	switch {
	case length < 32:
		dst = append(dst, 0xa0|byte(length))
	case length <= math.MaxUint8:
		dst = append(dst, 0xd9, byte(length))
	case length <= math.MaxUint16:
		dst = append(dst, 0xda, byte(length>>8), byte(length))
	default:
		dst = append(dst, 0xdb, byte(length>>24), byte(length>>16), byte(length>>8), byte(length))
	}
	return append(dst, value...)
}

func appendMsgpackBytes(dst []byte, value []byte) []byte {
	length := len(value)
	switch {
	case length <= math.MaxUint8:
		dst = append(dst, 0xc4, byte(length))
	case length <= math.MaxUint16:
		dst = append(dst, 0xc5, byte(length>>8), byte(length))
	default:
		dst = append(dst, 0xc6, byte(length>>24), byte(length>>16), byte(length>>8), byte(length))
	}
	return append(dst, value...)
}

func appendMsgpackFloat64(dst []byte, value float64) []byte {
	bits := math.Float64bits(value)
	return append(dst, 0xcb,
		byte(bits>>56), byte(bits>>48), byte(bits>>40), byte(bits>>32),
		byte(bits>>24), byte(bits>>16), byte(bits>>8), byte(bits))
}

func appendMsgpackInt64(dst []byte, value int64) []byte {
	switch {
	case value >= 0:
		return appendMsgpackUint64(dst, uint64(value))
	case value >= -32:
		return append(dst, byte(value))
	case value >= math.MinInt8:
		return append(dst, 0xd0, byte(value))
	case value >= math.MinInt16:
		return append(dst, 0xd1, byte(uint16(value)>>8), byte(value))
	case value >= math.MinInt32:
		return append(dst, 0xd2,
			byte(uint32(value)>>24), byte(uint32(value)>>16), byte(uint32(value)>>8), byte(value))
	default:
		return append(dst, 0xd3,
			byte(uint64(value)>>56), byte(uint64(value)>>48), byte(uint64(value)>>40), byte(uint64(value)>>32),
			byte(uint64(value)>>24), byte(uint64(value)>>16), byte(uint64(value)>>8), byte(value))
	}
}

func appendMsgpackUint64(dst []byte, value uint64) []byte {
	switch {
	case value <= 0x7f:
		return append(dst, byte(value))
	case value <= math.MaxUint8:
		return append(dst, 0xcc, byte(value))
	case value <= math.MaxUint16:
		return append(dst, 0xcd, byte(value>>8), byte(value))
	case value <= math.MaxUint32:
		return append(dst, 0xce, byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
	default:
		return append(dst, 0xcf,
			byte(value>>56), byte(value>>48), byte(value>>40), byte(value>>32),
			byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
	}
}
