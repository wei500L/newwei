package crawlmetadata

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

// This file holds the JavaScript compatibility helpers: the validation
// primitives the class-validator DTO semantics need, and a JSON.stringify
// equivalent for the JSON-LD branch (compact output, insertion-order keys and
// ECMAScript number formatting).

// jsString decodes a raw JSON value that is actually a JSON string.
func jsString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsNumber decodes a raw JSON value that is actually a JSON number.
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(trimmed, &number); err != nil {
		return 0, false
	}
	return number, true
}

// jsInteger decodes a JSON number that is an integer (class-validator IsInt).
func jsInteger(raw json.RawMessage) (int, bool) {
	number, ok := jsNumber(raw)
	if !ok || number != math.Trunc(number) {
		return 0, false
	}
	return int(number), true
}

// jsBoolean decodes a raw JSON value that is actually a JSON boolean.
func jsBoolean(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// jsLen is the JavaScript string length (UTF-16 code units), which is what
// class-validator MaxLength measures.
func jsLen(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// marshalJSCompact matches JSON.stringify: no HTML escaping, no trailing
// newline.
func marshalJSCompact(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// jsJSONValue is an ordered JSON tree. JSON.stringify re-serializes parsed JSON
// with the source key order, which a Go map cannot preserve, so the JSON-LD
// branch decodes into this shape and re-encodes it.
type jsJSONValue any

// jsJSONObject keeps member order.
type jsJSONObject struct {
	keys   []string
	values []jsJSONValue
}

// stringifyCompactJSON implements JSON.stringify(JSON.parse(raw)). The second
// result is false when raw is not valid JSON, in which case the caller keeps
// the trimmed source text.
func stringifyCompactJSON(raw string) (string, bool) {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeJSJSON(decoder)
	if err != nil {
		return "", false
	}
	// Reject trailing content, exactly like JSON.parse.
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return "", false
	}
	var buf bytes.Buffer
	if err := writeJSJSON(&buf, value); err != nil {
		return "", false
	}
	return buf.String(), true
}

func decodeJSJSON(decoder *json.Decoder) (jsJSONValue, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}
	switch delim {
	case '{':
		object := &jsJSONObject{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, _ := keyToken.(string)
			value, err := decodeJSJSON(decoder)
			if err != nil {
				return nil, err
			}
			object.keys = append(object.keys, key)
			object.values = append(object.values, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		array := []jsJSONValue{}
		for decoder.More() {
			value, err := decodeJSJSON(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return array, nil
	default:
		return nil, errUnexpectedJSONToken
	}
}

var errUnexpectedJSONToken = errors.New("unexpected JSON token")

func writeJSJSON(buf *bytes.Buffer, value jsJSONValue) error {
	switch typed := value.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if typed {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		encoded, err := marshalJSCompact(typed)
		if err != nil {
			return err
		}
		buf.Write(encoded)
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return err
		}
		buf.Write(appendJSFloat(nil, number))
	case *jsJSONObject:
		buf.WriteByte('{')
		for index, key := range typed.keys {
			if index > 0 {
				buf.WriteByte(',')
			}
			encodedKey, err := marshalJSCompact(key)
			if err != nil {
				return err
			}
			buf.Write(encodedKey)
			buf.WriteByte(':')
			if err := writeJSJSON(buf, typed.values[index]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []jsJSONValue:
		buf.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				buf.WriteByte(',')
			}
			if err := writeJSJSON(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	default:
		return errUnexpectedJSONToken
	}
	return nil
}

// appendJSFloat formats a float64 the way ECMAScript's Number::toString does
// for JSON.stringify output: fixed notation between 1e-6 (inclusive) and 1e21
// (exclusive), exponential outside, and no zero-padded exponent.
func appendJSFloat(buf []byte, value float64) []byte {
	// JSON.stringify(-0) is "0".
	if value == 0 {
		return append(buf, '0')
	}
	format := byte('f')
	if abs := math.Abs(value); abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	buf = strconv.AppendFloat(buf, value, format, -1, 64)
	if format == 'e' {
		length := len(buf)
		if length >= 4 && buf[length-4] == 'e' && buf[length-3] == '-' && buf[length-2] == '0' {
			buf[length-2] = buf[length-1]
			buf = buf[:length-1]
		}
	}
	return buf
}
