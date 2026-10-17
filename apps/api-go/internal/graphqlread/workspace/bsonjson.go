package workspace

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// bsonValueToJSON converts one BSON value into a compact JSON token. BSON
// documents and arrays are decoded by a small reader instead of an untyped
// map so the GraphQL JSON scalar stays strongly typed. The second return
// value is false when the value cannot be represented.
func bsonValueToJSON(value bson.RawValue) (json.RawMessage, bool) {
	if value.IsZero() || value.Type == bson.TypeNull || value.Type == bson.TypeUndefined {
		return nil, true
	}
	switch value.Type {
	case bson.TypeEmbeddedDocument, bson.TypeArray:
		document, ok := bsonDocumentBytes(value)
		if !ok {
			return nil, false
		}
		if value.Type == bson.TypeArray {
			return bsonArrayToJSON(document)
		}
		return bsonDocumentToJSON(document)
	case bson.TypeString:
		text, ok := rawStringValue(value)
		if !ok {
			return nil, false
		}
		return marshalJSONString(text)
	case bson.TypeDouble:
		var number float64
		if err := value.Unmarshal(&number); err != nil {
			return nil, false
		}
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return json.RawMessage("null"), true
		}
		return json.RawMessage(strconv.FormatFloat(number, 'g', -1, 64)), true
	case bson.TypeInt32:
		var number int32
		if err := value.Unmarshal(&number); err != nil {
			return nil, false
		}
		return json.RawMessage(strconv.FormatInt(int64(number), 10)), true
	case bson.TypeInt64:
		var number int64
		if err := value.Unmarshal(&number); err != nil {
			return nil, false
		}
		return json.RawMessage(strconv.FormatInt(number, 10)), true
	case bson.TypeBoolean:
		var boolean bool
		if err := value.Unmarshal(&boolean); err != nil {
			return nil, false
		}
		if boolean {
			return json.RawMessage("true"), true
		}
		return json.RawMessage("false"), true
	case bson.TypeObjectID:
		var id bson.ObjectID
		if err := value.Unmarshal(&id); err != nil {
			return nil, false
		}
		return marshalJSONString(id.Hex())
	case bson.TypeDateTime:
		stamp, ok := rawTimeValue(value)
		if !ok {
			return nil, false
		}
		return marshalJSONString(contract.FormatDateTime(stamp))
	case bson.TypeDecimal128:
		var decimal bson.Decimal128
		if err := value.Unmarshal(&decimal); err != nil {
			return nil, false
		}
		return marshalJSONString(decimal.String())
	default:
		// Binary, regex, JavaScript, timestamp, and min/max keys are not part
		// of a processed result document. They become GraphQL null rather
		// than an invalid JSON token.
		return nil, true
	}
}

// marshalJSONString encodes a Go string as a compact JSON string token.
func marshalJSONString(value string) (json.RawMessage, bool) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	return json.RawMessage(encoded), true
}

// bsonDocumentBytes extracts the raw bytes of an embedded document or array.
func bsonDocumentBytes(value bson.RawValue) ([]byte, bool) {
	var document bson.Raw
	if err := value.Unmarshal(&document); err != nil {
		return nil, false
	}
	return []byte(document), true
}

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
// object. It validates every length before slicing so a corrupt document is
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
// array keys are the decimal indexes and are intentionally ignored.
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
		out = strconv.AppendQuote(out, contract.FormatDateTime(time.UnixMilli(millis).UTC()))
		return out, offset + 8, true
	case 0x0B: // regex: pattern and options cstrings collapse to {}
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
		// Decimals cannot occur in the result subdocument schema; a null keeps
		// the token valid without guessing a representation.
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
