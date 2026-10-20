package newssourcescheduler

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// jsonObject is the JSON object view used for the extension-shaped parts of
// NewsSource.config, the workflow seed overlay and the discovery cache. Business
// data is carried by the named types in model.go; these helpers only traverse
// the extension JSON leaves, exactly like the `typeof value === "…"` checks in
// the NestJS service.
type jsonObject map[string]json.RawMessage

// decodeObject decodes a JSON object; anything else is reported as absent.
func decodeObject(raw json.RawMessage) (jsonObject, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var object jsonObject
	if err := json.Unmarshal(trimmed, &object); err != nil {
		return nil, false
	}
	return object, true
}

// objectField returns a nested object.
func (o jsonObject) objectField(key string) (jsonObject, bool) {
	raw, ok := o[key]
	if !ok {
		return nil, false
	}
	return decodeObject(raw)
}

// stringField returns a non-empty string value.
func (o jsonObject) stringField(key string) (string, bool) {
	raw, ok := o[key]
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// numberField returns a finite JSON number.
func (o jsonObject) numberField(key string) (float64, bool) {
	raw, ok := o[key]
	if !ok {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// boolField returns a boolean value.
func (o jsonObject) boolField(key string) (bool, bool) {
	raw, ok := o[key]
	if !ok {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

// arrayField returns the raw elements of an array value.
func (o jsonObject) arrayField(key string) ([]json.RawMessage, bool) {
	raw, ok := o[key]
	if !ok {
		return nil, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var values []json.RawMessage
	if err := json.Unmarshal(trimmed, &values); err != nil {
		return nil, false
	}
	return values, true
}

// stringListField ports normalizeStringList: only string entries survive, each
// trimmed, empties dropped.
func stringListField(value json.RawMessage) []string {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return []string{}
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		var text string
		if err := json.Unmarshal(entry, &text); err != nil {
			continue
		}
		text = strings.TrimSpace(text)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

// jsonMarshal renders a value as a JSON string for the Redis writers.
func jsonMarshal(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// jsonRaw wraps a cache string as raw JSON.
func jsonRaw(value string) json.RawMessage {
	return json.RawMessage(value)
}

// rawValue converts typed JSON values into raw messages for the merge helpers.
func rawValue(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(encoded)
}

// mergeObjects is `{...base, ...override}` for the extension JSON leaves.
func mergeObjects(base, override jsonObject) jsonObject {
	if base == nil && override == nil {
		return nil
	}
	out := make(jsonObject, len(base)+len(override))
	for key, value := range base {
		out[key] = value
	}
	for key, value := range override {
		out[key] = value
	}
	return out
}

// jsRound is Math.round: halves round toward positive infinity.
func jsRound(value float64) float64 {
	return math.Floor(value + 0.5)
}

// isoMillis formats a time as Date.prototype.toISOString.
func isoMillis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// isoMillisPtr formats an optional time.
func isoMillisPtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := isoMillis(*value)
	return &formatted
}

// parseISOTime parses an ISO-8601 timestamp (the values stored in Redis).
func parseISOTime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// truncateUTF16 ports String.prototype.slice for a code-unit limit: the cut is
// counted in UTF-16 code units so a name built with an astral character is cut
// exactly where JavaScript would cut it.
func truncateUTF16(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := 0
	for index, r := range value {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if units+size > limit {
			return value[:index]
		}
		units += size
	}
	return value
}

// utf16Length is String.prototype.length.
func utf16Length(value string) int {
	units := 0
	for _, r := range value {
		if r > 0xffff {
			units += 2
			continue
		}
		units++
	}
	return units
}

// isJSSpace reports whether r is removed by String.prototype.trim.
func isJSSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r', 0x00a0, 0x1680, 0x2028, 0x2029,
		0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// trimJS is String.prototype.trim.
func trimJS(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

// lowerTrim is value.trim().toLowerCase().
func lowerTrim(value string) string {
	return strings.ToLower(trimJS(value))
}

// trimEndJS is String.prototype.trimEnd.
func trimEndJS(value string) string {
	return strings.TrimRightFunc(value, isJSSpace)
}

// validUTF8 reports whether a byte slice is valid UTF-8 text.
func validUTF8(value []byte) bool {
	return utf8.Valid(value)
}

// formatJSNumber renders a float the way String(number) does for the integer
// values the scheduler writes into Redis and MySQL.
func formatJSNumber(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}
