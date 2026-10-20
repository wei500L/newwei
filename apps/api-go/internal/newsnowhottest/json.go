package newsnowhottest

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// This file holds the JSON primitives that keep the shared Redis documents
// byte-compatible with JSON.stringify in the NestJS implementation.
//
// The two encoders differ in exactly two places that matter here:
//   - Go escapes <, >, &, U+2028 and U+2029 by default; JSON.stringify does not.
//     Every write therefore goes through marshalJSON with SetEscapeHTML(false).
//   - JSON.stringify omits undefined object members while Go omits only the
//     members tagged omitempty. Optional members are modelled as pointers with
//     omitempty, and nullable members as nullable* values that always render
//     null instead of disappearing.

// marshalJSON mirrors JSON.stringify: no HTML escaping and no trailing newline.
// The cache documents are compared by other processes, so the encoder detail is
// part of the contract.
func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// encodeJSONString encodes one string the way JSON.stringify does.
func encodeJSONString(value string) []byte {
	encoded, err := marshalJSON(value)
	if err != nil {
		return []byte(`""`)
	}
	return encoded
}

// nullableString is a `string | null` JSON leaf. The zero value renders null,
// which is also what a missing member decodes to.
type nullableString struct {
	Value string
	Valid bool
}

// stringOrNull builds a present nullable string.
func stringOrNull(value string) nullableString {
	return nullableString{Value: value, Valid: true}
}

// stringPtrOrNull converts an optional Go string.
func stringPtrOrNull(value *string) nullableString {
	if value == nil {
		return nullableString{}
	}
	return nullableString{Value: *value, Valid: true}
}

// Ptr returns the value as an optional string.
func (n nullableString) Ptr() *string {
	if !n.Valid {
		return nil
	}
	value := n.Value
	return &value
}

// MarshalJSON writes the string or null.
func (n nullableString) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}
	return encodeJSONString(n.Value), nil
}

// UnmarshalJSON accepts a string or null. Any other shape is a decode error,
// matching the typed cache documents this package writes.
func (n *nullableString) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		n.Value = ""
		n.Valid = false
		return nil
	}
	if trimmed[0] != '"' {
		return errors.New("newsnowhottest: expected a JSON string or null")
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return err
	}
	n.Value = value
	n.Valid = true
	return nil
}

// nullableNumber is a `number | null` JSON leaf.
type nullableNumber struct {
	Value float64
	Valid bool
}

// numberOrNull builds a present nullable number.
func numberOrNull(value float64) nullableNumber {
	return nullableNumber{Value: value, Valid: true}
}

// Ptr returns the value as an optional float.
func (n nullableNumber) Ptr() *float64 {
	if !n.Valid {
		return nil
	}
	value := n.Value
	return &value
}

// OrZero returns the number or zero, which is the `?? 0` idiom the scoring
// helpers use.
func (n nullableNumber) OrZero() float64 {
	if !n.Valid {
		return 0
	}
	return n.Value
}

// MarshalJSON writes the number or null. A non-finite value becomes null,
// exactly like JSON.stringify(NaN).
func (n nullableNumber) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}
	return marshalJSON(n.Value)
}

// UnmarshalJSON accepts a number or null.
func (n *nullableNumber) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		n.Value = 0
		n.Valid = false
		return nil
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return err
	}
	n.Value = value
	n.Valid = true
	return nil
}

// nullableInt is a `number | null` integer leaf (signal ranks).
type nullableInt struct {
	Value int64
	Valid bool
}

// intOrNull builds a present nullable integer.
func intOrNull(value int64) nullableInt {
	return nullableInt{Value: value, Valid: true}
}

// MarshalJSON writes the integer or null.
func (n nullableInt) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}
	return []byte(strconv.FormatInt(n.Value, 10)), nil
}

// UnmarshalJSON accepts an integral number or null.
func (n *nullableInt) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		n.Value = 0
		n.Valid = false
		return nil
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return err
	}
	n.Value = int64(value)
	n.Valid = true
	return nil
}

// isoTime formats an instant like Date.prototype.toISOString: UTC, millisecond
// precision, trailing Z. Every cached timestamp uses this shape because the
// NestJS side parses it with Date.parse.
func isoTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// parseISOTime is the Date.parse equivalent used for freshness. It accepts the
// ISO-8601 shapes the writers produce; anything else reports false, which the
// caller turns into the twelve-hour fallback age.
func parseISOTime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, false
	}
	return parsed.UTC(), true
}

// jsLength is String.prototype.length: the number of UTF-16 code units, not
// runes. The similarity and model-schema limits are expressed in that unit.
func jsLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// jsWhitespaceClass is the ECMAScript \s character class. Go's \s is ASCII-only,
// while JavaScript also treats the ideographic space U+3000, the byte-order mark
// and the Unicode space separators as whitespace; hot-list titles do contain
// U+3000.
const jsWhitespaceClass = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// isJSSpace reports whether one rune is whitespace in ECMAScript.
func isJSSpace(value rune) bool {
	switch value {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return value >= 0x2000 && value <= 0x200a
}

// jsTrim is String.prototype.trim.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

// nullableDate is the `number | string | null` publication timestamp the source
// cache produces. The original JSON literal is preserved: a provider may emit a
// numeric millisecond timestamp or a relative-date string, and the
// recommendation must return the same shape the source returned.
type nullableDate struct {
	Raw   json.RawMessage
	Valid bool
}

// MarshalJSON writes the original literal or null.
func (d nullableDate) MarshalJSON() ([]byte, error) {
	if !d.Valid || len(d.Raw) == 0 {
		return []byte("null"), nil
	}
	return d.Raw, nil
}

// UnmarshalJSON accepts a number, a string or null.
func (d *nullableDate) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		d.Raw = nil
		d.Valid = false
		return nil
	}
	if !json.Valid(trimmed) {
		return errors.New("newsnowhottest: invalid publication date")
	}
	d.Raw = append(json.RawMessage(nil), trimmed...)
	d.Valid = true
	return nil
}

// decodeJSONString decodes a JSON string document. An invalid value yields the
// empty string, which the signature comparison treats as a miss.
func decodeJSONString(value string) string {
	var decoded string
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return ""
	}
	return decoded
}
