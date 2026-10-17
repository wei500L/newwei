package settingscrawl

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// This file holds the strongly typed readers for stored setting values. NestJS
// parses the SystemSetting.value JSON column into plain objects and then reads
// individual keys with untyped JavaScript coercion helpers. The Go port must
// reproduce those helpers exactly, but it must not reintroduce an untyped
// container: every stored document is decoded into a named struct whose fields
// are json.RawMessage, and the coercion helpers below operate on those raw
// JSON values.

// settingIsArray reports whether a stored value is a JSON array. NestJS uses
// Array.isArray to choose between normalizing the value and returning the
// fallback list untouched.
func settingIsArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

// settingIsObject reports whether a stored value is a JSON object.
func settingIsObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// settingFloatOnly decodes a stored value that must already be a finite JSON
// number. It mirrors the helpers that never parse strings, such as
// ClassificationQualitySettingsService.clampFloat, AuthCacheSettingsService
// toInt and AuditLogSettingsService.normalize.
func settingFloatOnly(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(trimmed, &number); err != nil {
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

// settingNumber decodes a stored value with JavaScript Number() semantics and
// rejects the empty string, mirroring the toNumber helpers of the knowledge
// graph, news events, classification, dedupe, indicator, extraction and source
// policy services. A non-finite or unparsable value falls back.
func settingNumber(raw json.RawMessage, fallback float64) float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return fallback
	}
	if number, ok := settingFloatOnly(trimmed); ok {
		return number
	}
	if trimmed[0] != '"' {
		return fallback
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return fallback
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return parsed
}

// settingNumberLenient mirrors EntityImpactGraphSettingsService.toNumber, which
// has no empty-string guard: Number("") === 0, so an empty string yields zero
// rather than the fallback. It also accepts JavaScript booleans, where
// Number(true) === 1.
func settingNumberLenient(raw json.RawMessage, fallback float64) float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return fallback
	}
	if number, ok := settingFloatOnly(trimmed); ok {
		return number
	}
	switch string(trimmed) {
	case "true":
		return 1
	case "false":
		return 0
	case "null":
		return 0
	}
	if trimmed[0] != '"' {
		return fallback
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return fallback
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return parsed
}

// settingNumberOrNaN decodes a stored value with JavaScript Number() semantics
// and reports NaN instead of a fallback when the value cannot be converted.
// The rate limit buckets need this shape: a bucket object whose keys are absent
// yields NaN, and the clamp turns NaN into the minimum rather than into the
// environment fallback.
func settingNumberOrNaN(raw json.RawMessage) float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return math.NaN()
	}
	if number, ok := settingFloatOnly(trimmed); ok {
		return number
	}
	switch string(trimmed) {
	case "true":
		return 1
	case "false", "null":
		return 0
	}
	if trimmed[0] != '"' {
		return math.NaN()
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return math.NaN()
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return 0
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return math.NaN()
	}
	return parsed
}

// settingBool decodes a stored value that must strictly be a JSON boolean,
// mirroring the `typeof value === "boolean"` guards.
func settingBool(raw json.RawMessage, fallback bool) bool {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

// settingString decodes a stored value that must be a JSON string.
func settingString(raw json.RawMessage) (string, bool) {
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

// settingStringList decodes a stored JSON array into its string entries,
// dropping every entry that is not a JSON string. The leading-quote check is
// required because json.Unmarshal accepts a JSON null into a string, which
// would otherwise turn a null entry into an empty string.
func settingStringList(raw json.RawMessage) ([]string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if text, ok := settingString(entry); ok {
			out = append(out, text)
		}
	}
	return out, true
}

// cleanString trims a stored string and reports nil for a non-string or an
// empty result, mirroring cleanString / cleanNullableString.
func cleanString(raw json.RawMessage) *string {
	text, ok := settingString(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// cleanStringLimited applies cleanString and truncates the result to max
// characters, mirroring the JavaScript String.prototype.slice(max) caps.
func cleanStringLimited(raw json.RawMessage, max int) *string {
	cleaned := cleanString(raw)
	if cleaned == nil {
		return nil
	}
	clipped := truncateRunes(*cleaned, max)
	return &clipped
}

// cleanStringFallback mirrors cleanNullableString: a JSON null stays null, a
// missing or unusable value falls back, and a usable string is trimmed and
// truncated.
func cleanStringFallback(raw json.RawMessage, max int, fallback *string) *string {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fallback
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil
	}
	cleaned := cleanStringLimited(raw, max)
	if cleaned == nil {
		return fallback
	}
	return cleaned
}

// truncateRunes truncates a string to max characters. JavaScript slice() counts
// UTF-16 code units while this counts runes; for the ASCII templates and
// single-codepoint CJK labels handled here the two agree.
func truncateRunes(value string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(value) <= max {
		return value
	}
	count := 0
	for index := range value {
		if count == max {
			return value[:index]
		}
		count++
	}
	return value
}

// jsFloor is JavaScript Math.floor.
func jsFloor(value float64) float64 {
	return math.Floor(value)
}

// jsRound is JavaScript Math.round: half-way values round toward +Infinity,
// unlike Go's math.Round which rounds half away from zero.
func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	return math.Floor(value + 0.5)
}

// roundTo rounds to a fixed number of decimals. JavaScript's Number(x.toFixed(n))
// is used by the classification quality (4) and crawl client (3) clamps.
func roundTo(value float64, decimals int) float64 {
	factor := math.Pow(10, float64(decimals))
	return jsRound(value*factor) / factor
}

// clampFloatBounds applies clamp(value, min, max) without a fallback: a NaN
// value becomes min, a value below min becomes min and a value above max
// becomes max.
func clampFloatBounds(value, min, max float64) float64 {
	if math.IsNaN(value) || value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// clampIntRounded rounds with Math.round and then applies clamp(value, min, max).
func clampIntRounded(value, min, max float64) int {
	return int(clampFloatBounds(jsRound(value), min, max))
}

// jsonScalar converts a nullable MySQL JSON column into a GraphQL JSON scalar.
// An empty column and the JSON literal null both become GraphQL null so the
// executor never emits a quoted empty string.
func jsonScalar(raw []byte) *json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil
	}
	message := json.RawMessage(append([]byte(nil), trimmed...))
	return &message
}
