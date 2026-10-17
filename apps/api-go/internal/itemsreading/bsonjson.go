package itemsreading

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// This file converts raw BSON bytes into compact JSON without decoding into an
// untyped map. It mirrors the converter that already ships in
// apps/api-go/internal/graphqlread/workspace so the two packages format
// documents, arrays, dates and numbers identically; the helpers are unexported
// there, which is why this package carries its own copy rather than modifying
// the workspace package's behavior.

// bsonDocumentToJSON renders a raw BSON document as a compact JSON object.
func bsonDocumentToJSON(document []byte) (json.RawMessage, bool) {
	out, ok := appendBSONDocument(make([]byte, 0, len(document)*2), document)
	if !ok || !json.Valid(out) {
		return nil, false
	}
	return json.RawMessage(out), true
}

// bsonArrayToJSON renders a raw BSON array document as a compact JSON array.
func bsonArrayToJSON(document []byte) (json.RawMessage, bool) {
	out, ok := appendBSONArray(make([]byte, 0, len(document)*2), document)
	if !ok || !json.Valid(out) {
		return nil, false
	}
	return json.RawMessage(out), true
}

// appendBSONDocument reads "int32 size, elements, 0x00" and writes a JSON
// object. Every length is validated before slicing so a corrupt document is
// rejected instead of panicking.
func appendBSONDocument(out []byte, document []byte) ([]byte, bool) {
	size, ok := bsonDocumentSize(document)
	if !ok {
		return nil, false
	}
	body := document[:size]
	out = append(out, '{')
	offset := 4
	first := true
	for {
		if offset >= len(body) {
			return nil, false
		}
		elementType := body[offset]
		offset++
		if elementType == 0x00 {
			break
		}
		key, next, readOK := readCString(body, offset)
		if !readOK {
			return nil, false
		}
		offset = next
		if !first {
			out = append(out, ',')
		}
		first = false
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, false
		}
		out = append(out, encodedKey...)
		out = append(out, ':')
		out, offset, ok = appendBSONValue(out, body, offset, elementType)
		if !ok {
			return nil, false
		}
	}
	out = append(out, '}')
	return out, true
}

// appendBSONArray reads a BSON array document and writes a JSON array. BSON
// array keys are decimal indexes and are intentionally ignored.
func appendBSONArray(out []byte, document []byte) ([]byte, bool) {
	size, ok := bsonDocumentSize(document)
	if !ok {
		return nil, false
	}
	body := document[:size]
	out = append(out, '[')
	offset := 4
	first := true
	for {
		if offset >= len(body) {
			return nil, false
		}
		elementType := body[offset]
		offset++
		if elementType == 0x00 {
			break
		}
		if _, next, readOK := readCString(body, offset); readOK {
			offset = next
		} else {
			return nil, false
		}
		if !first {
			out = append(out, ',')
		}
		first = false
		out, offset, ok = appendBSONValue(out, body, offset, elementType)
		if !ok {
			return nil, false
		}
	}
	out = append(out, ']')
	return out, true
}

// appendBSONValue writes one element value and returns the next offset.
func appendBSONValue(out []byte, body []byte, offset int, elementType byte) ([]byte, int, bool) {
	switch elementType {
	case 0x01: // double
		if offset+8 > len(body) {
			return nil, 0, false
		}
		number := math.Float64frombits(binary.LittleEndian.Uint64(body[offset : offset+8]))
		out = appendFiniteFloat(out, number)
		return out, offset + 8, true
	case 0x02, 0x0D, 0x0E: // string, JavaScript code, symbol
		return appendBSONString(out, body, offset)
	case 0x03: // embedded document
		size, ok := bsonDocumentSize(body[offset:])
		if !ok || offset+size > len(body) {
			return nil, 0, false
		}
		out, ok = appendBSONDocument(out, body[offset:offset+size])
		if !ok {
			return nil, 0, false
		}
		return out, offset + size, true
	case 0x04: // array
		size, ok := bsonDocumentSize(body[offset:])
		if !ok || offset+size > len(body) {
			return nil, 0, false
		}
		out, ok = appendBSONArray(out, body[offset:offset+size])
		if !ok {
			return nil, 0, false
		}
		return out, offset + size, true
	case 0x05: // binary
		if offset+4 > len(body) {
			return nil, 0, false
		}
		length := int(int32(binary.LittleEndian.Uint32(body[offset : offset+4])))
		if length < 0 || offset+5+length > len(body) {
			return nil, 0, false
		}
		payload := body[offset+5 : offset+5+length]
		out = strconv.AppendQuote(out, base64.StdEncoding.EncodeToString(payload))
		return out, offset + 5 + length, true
	case 0x06, 0x0A, 0x7F, 0xFF: // undefined, null, max key, min key
		out = append(out, "null"...)
		return out, offset, true
	case 0x07: // ObjectId
		if offset+12 > len(body) {
			return nil, 0, false
		}
		out = strconv.AppendQuote(out, hex.EncodeToString(body[offset:offset+12]))
		return out, offset + 12, true
	case 0x08: // boolean
		if offset+1 > len(body) {
			return nil, 0, false
		}
		if body[offset] != 0 {
			out = append(out, "true"...)
		} else {
			out = append(out, "false"...)
		}
		return out, offset + 1, true
	case 0x09: // UTC datetime
		if offset+8 > len(body) {
			return nil, 0, false
		}
		millis := int64(binary.LittleEndian.Uint64(body[offset : offset+8]))
		out = strconv.AppendQuote(out, FormatISOTime(time.UnixMilli(millis).UTC()))
		return out, offset + 8, true
	case 0x0B: // regex: pattern and options collapse to {}
		if _, next, ok := readCString(body, offset); ok {
			if _, after, ok := readCString(body, next); ok {
				out = append(out, "{}"...)
				return out, after, true
			}
		}
		return nil, 0, false
	case 0x0F: // JavaScript code with scope: keep the code, drop the scope
		if offset+4 > len(body) {
			return nil, 0, false
		}
		total := int(int32(binary.LittleEndian.Uint32(body[offset : offset+4])))
		if total < 4 || offset+total > len(body) {
			return nil, 0, false
		}
		encoded, _, ok := appendBSONString(out, body, offset+4)
		if !ok {
			return nil, 0, false
		}
		return encoded, offset + total, true
	case 0x10: // int32
		if offset+4 > len(body) {
			return nil, 0, false
		}
		value := int32(binary.LittleEndian.Uint32(body[offset : offset+4]))
		out = strconv.AppendInt(out, int64(value), 10)
		return out, offset + 4, true
	case 0x11: // timestamp: seconds then increment
		if offset+8 > len(body) {
			return nil, 0, false
		}
		seconds := binary.LittleEndian.Uint32(body[offset : offset+4])
		out = strconv.AppendUint(out, uint64(seconds), 10)
		return out, offset + 8, true
	case 0x12: // int64
		if offset+8 > len(body) {
			return nil, 0, false
		}
		value := int64(binary.LittleEndian.Uint64(body[offset : offset+8]))
		out = strconv.AppendInt(out, value, 10)
		return out, offset + 8, true
	case 0x13: // decimal128
		out = append(out, "null"...)
		return out, offset + 16, true
	default:
		return nil, 0, false
	}
}

// appendBSONString writes a length-prefixed BSON string as a JSON string.
func appendBSONString(out []byte, body []byte, offset int) ([]byte, int, bool) {
	if offset+4 > len(body) {
		return nil, 0, false
	}
	length := int(int32(binary.LittleEndian.Uint32(body[offset : offset+4])))
	if length < 1 || offset+4+length > len(body) {
		return nil, 0, false
	}
	text := string(body[offset+4 : offset+4+length-1])
	out = strconv.AppendQuote(out, text)
	return out, offset + 4 + length, true
}

// appendFiniteFloat writes a float, or JSON null for NaN and infinities.
func appendFiniteFloat(out []byte, number float64) []byte {
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return append(out, "null"...)
	}
	return strconv.AppendFloat(out, number, 'g', -1, 64)
}

// bsonDocumentSize validates the leading int32 size of a BSON document.
func bsonDocumentSize(document []byte) (int, bool) {
	if len(document) < 5 {
		return 0, false
	}
	size := int(int32(binary.LittleEndian.Uint32(document[:4])))
	if size < 5 || size > len(document) {
		return 0, false
	}
	return size, true
}

// readCString reads a NUL-terminated key and returns the offset after it.
func readCString(body []byte, offset int) (string, int, bool) {
	end := offset
	for end < len(body) && body[end] != 0x00 {
		end++
	}
	if end >= len(body) {
		return "", 0, false
	}
	return string(body[offset:end]), end + 1, true
}

// jsonBytesToBSON encodes compact JSON as a BSON document so an open schema
// field can be written back to Mongo without an untyped map at the call site.
func jsonBytesToBSON(raw []byte) ([]byte, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var document bson.D
	if err := bson.UnmarshalExtJSON(raw, false, &document); err != nil {
		return nil, false
	}
	encoded, err := bson.Marshal(document)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

// isValidObjectIDHex reports whether the string is a 24 character ObjectId
// hex value. mongo-driver v2 dropped bson.IsValidObjectID, so the check is
// expressed through ObjectIDFromHex.
func isValidObjectIDHex(value string) bool {
	if len(value) != 24 {
		return false
	}
	if _, err := bson.ObjectIDFromHex(value); err != nil {
		return false
	}
	return true
}
