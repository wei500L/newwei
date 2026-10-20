package realtimesignals

import (
	"bytes"
	"encoding/json"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

// This file holds the JavaScript semantics the stored documents depend on. Using
// Go's default helpers instead would silently change numeric output, timestamp
// shapes and string ordering, so every helper here documents the exact JS rule it
// reproduces and is covered by unit tests.

// jsonRawMessage is the decoded JSON leaf type. Named fields use it for values
// whose shape is defined by an external API, never for business objects.
type jsonRawMessage = json.RawMessage

// decodeJSONPayload decodes raw JSON into a typed target.
func decodeJSONPayload(payload []byte, target any) error {
	return json.Unmarshal(payload, target)
}

var (
	numericStringPattern = regexp.MustCompile(`^-?\d+(\.\d+)?$`)
	compactDayPattern    = regexp.MustCompile(`^\d{8}$`)
	compactTimePattern   = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$`)
)

// isJSWhitespace reports whether a rune is trimmed by String.prototype.trim.
func isJSWhitespace(r rune) bool {
	return unicode.IsSpace(r) || r == '\uFEFF'
}

// jsTrim reproduces String.prototype.trim. Go's strings.TrimSpace already
// removes every Unicode space separator and line terminator, but not U+FEFF,
// which JavaScript also trims.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

// decodeJSONString decodes a JSON string token. ok is false for a non-string
// value (including null and a number).
func decodeJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

// normalizeStringRaw is normalizeString for a JSON field: trim, and treat an
// empty string as absent.
func normalizeStringRaw(raw json.RawMessage) string {
	value, ok := decodeJSONString(raw)
	if !ok {
		return ""
	}
	return jsTrim(value)
}

// toFiniteNumber reproduces toFiniteNumber: accept a JSON number or a string that
// Number() converts to a finite value. Booleans, null and objects are rejected.
func toFiniteNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return 0, false
	}
	if trimmed[0] == '"' {
		text, ok := decodeJSONString(trimmed)
		if !ok {
			return 0, false
		}
		return parseJSNumber(text)
	}
	if trimmed[0] == 't' || trimmed[0] == 'f' || trimmed[0] == '{' || trimmed[0] == '[' {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// parseJSNumber applies JavaScript's Number(string) coercion: an empty or
// whitespace-only string is 0, "0x" prefixes are hexadecimal, and a non-finite
// result is rejected.
func parseJSNumber(value string) (float64, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return 0, true
	}
	switch trimmed {
	case "Infinity", "+Infinity":
		return 0, false
	case "-Infinity", "NaN":
		return 0, false
	}
	if len(trimmed) > 2 && trimmed[0] == '0' && (trimmed[1] == 'x' || trimmed[1] == 'X') {
		parsed, err := strconv.ParseUint(trimmed[2:], 16, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// rawIsAbsent reports whether a raw member is missing or the JSON literal null,
// which is the `??` fall-through condition.
func rawIsAbsent(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

// isJSONNull reports whether the raw value is the JSON literal null.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// isJSONObject reports whether the raw value is an object.
func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// isJSONArray reports whether the raw value is a JSON array. It mirrors
// Array.isArray, which is what the AIS relay contract is validated with.
func isJSONArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

// rawStringExact decodes a JSON string without trimming, for strict equality
// checks such as `record.status === "open"`.
func rawStringExact(raw json.RawMessage) string {
	value, ok := decodeJSONString(raw)
	if !ok {
		return ""
	}
	return value
}

// rawBool reads a JSON boolean, defaulting to false for anything else. NestJS
// uses strict `=== true` comparisons for relay flags.
func rawBool(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("true"))
}

// firstRaw mirrors `a ?? b ?? c` over raw JSON members: a missing member and an
// explicit null both fall through.
func firstRaw(values ...json.RawMessage) json.RawMessage {
	for _, value := range values {
		if len(bytes.TrimSpace(value)) == 0 || isJSONNull(value) {
			continue
		}
		return value
	}
	return nil
}

// jsonStringToken renders a Go string as a JSON string token.
func jsonStringToken(value string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

// readArray reproduces readArray: a non-array value is an empty array.
func readArray(raw json.RawMessage) []json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return []json.RawMessage{}
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(trimmed, &rows); err != nil || rows == nil {
		return []json.RawMessage{}
	}
	return rows
}

// jsRound reproduces Math.round: the closest integer, with an exact tie rounded
// toward +Infinity. Go's math.Round rounds half away from zero, which differs for
// every negative half (Math.round(-1.5) === -1).
//
// The closest-integer formulation also reproduces the documented
// Math.round(0.49999999999999994) === 0 result that floor(x+0.5) gets wrong.
func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value == 0 {
		return value
	}
	floor := math.Floor(value)
	if value-floor < 0.5 {
		return floor
	}
	return floor + 1
}

// jsTrunc reproduces Math.trunc (toward zero for negatives).
func jsTrunc(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return int64(math.Trunc(value))
}

// jsToFixed reproduces Number.prototype.toFixed, including the exact-tie rule
// (the larger scaled integer wins, i.e. half away from zero) and the binary value
// the rounding operates on. Implementing it on math/big over the exact float
// avoids both Go's round-half-to-even and the "shortest decimal" trap where
// 1.005 would round as if it were exactly 1.005.
func jsToFixed(value float64, digits int) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	negative := value < 0
	rational := new(big.Rat).SetFloat64(math.Abs(value))
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	numerator := new(big.Int).Mul(rational.Num(), scale)
	quotient, remainder := new(big.Int).QuoRem(numerator, rational.Denom(), new(big.Int))
	if new(big.Int).Mul(remainder, big.NewInt(2)).Cmp(rational.Denom()) >= 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	text := quotient.String()
	if digits > 0 {
		if len(text) <= digits {
			text = strings.Repeat("0", digits-len(text)+1) + text
		}
		text = text[:len(text)-digits] + "." + text[len(text)-digits:]
	}
	if negative {
		return "-" + text
	}
	return text
}

// jsFixedNumber is `Number(x.toFixed(digits))`: the decimal string parsed back to
// a float64, which is the value JavaScript stores.
func jsFixedNumber(value float64, digits int) float64 {
	parsed, err := strconv.ParseFloat(jsToFixed(value, digits), 64)
	if err != nil {
		return value
	}
	return parsed
}

// jsNumberString reproduces String(number) for the finite values this collector
// formats (coordinates, scores and rate limits). The boundary rules match
// Number::toString: plain decimal in [1e-6, 1e21), scientific outside it, no
// trailing zeros, and "+0" for either zero.
func jsNumberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	if value == 0 {
		return "0"
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	text := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponent, found := strings.Cut(text, "e")
	if !found {
		return text
	}
	parsed, err := strconv.Atoi(exponent)
	if err != nil {
		return text
	}
	sign := "+"
	if parsed < 0 {
		sign = "-"
		parsed = -parsed
	}
	return mantissa + "e" + sign + strconv.Itoa(parsed)
}

// encodeURIComponentJS reproduces encodeURIComponent: ASCII alphanumerics and
// -_.!~*'() stay literal, everything else is percent-encoded with uppercase hex.
func encodeURIComponentJS(value string) string {
	const hexDigits = "0123456789ABCDEF"
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		ch := value[index]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			builder.WriteByte(ch)
		case strings.ContainsRune("-_.!~*'()", rune(ch)):
			builder.WriteByte(ch)
		default:
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[ch>>4])
			builder.WriteByte(hexDigits[ch&0x0f])
		}
	}
	return builder.String()
}

// encodeFormPairs serializes application/x-www-form-urlencoded members in
// insertion order. URLSearchParams preserves insertion order, unlike
// url.Values.Encode which sorts keys, and every external URL in this package is
// built with URLSearchParams.
func encodeFormPairs(pairs ...[2]string) string {
	var builder strings.Builder
	for index, pair := range pairs {
		if index > 0 {
			builder.WriteByte('&')
		}
		builder.WriteString(encodeURIComponentForm(pair[0]))
		builder.WriteByte('=')
		builder.WriteString(encodeURIComponentForm(pair[1]))
	}
	return builder.String()
}

// encodeURIComponentForm matches the URLSearchParams serializer: ASCII
// alphanumerics plus *-._ stay literal, a space becomes '+', everything else is
// percent-encoded with uppercase hex.
func encodeURIComponentForm(value string) string {
	const hexDigits = "0123456789ABCDEF"
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		ch := value[index]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			builder.WriteByte(ch)
		case ch == '*', ch == '-', ch == '.', ch == '_':
			builder.WriteByte(ch)
		case ch == ' ':
			builder.WriteByte('+')
		default:
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[ch>>4])
			builder.WriteByte(hexDigits[ch&0x0f])
		}
	}
	return builder.String()
}

// compareUTF16 compares two strings by UTF-16 code unit, which is the collation
// Array.prototype.sort uses with no comparator. UTF-8 byte order agrees with code
// point order but not with UTF-16 for supplementary characters, so the explicit
// conversion is required.
func compareUTF16(left, right string) int {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] != rightUnits[index] {
			if leftUnits[index] < rightUnits[index] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(leftUnits) < len(rightUnits):
		return -1
	case len(leftUnits) > len(rightUnits):
		return 1
	default:
		return 0
	}
}

// sortStringsJS sorts in place with the default Array.prototype.sort collation.
func sortStringsJS(values []string) {
	sort.SliceStable(values, func(left, right int) bool {
		return compareUTF16(values[left], values[right]) < 0
	})
}

// dedupeStringsPreserve is Array.from(new Set(values)): first occurrence wins.
func dedupeStringsPreserve(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

// parseJSTimeMillis is the Date.parse subset the collector consumes: ISO-8601,
// the compact GDELT shapes, numeric epoch values and the 8-digit date form the
// NestJS helper special-cases. A value Date.parse would reject returns ok=false.
func parseJSTimeMillis(value string) (int64, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return 0, false
	}
	if compactDayPattern.MatchString(trimmed) {
		if parsed, ok := utcDate(trimmed[0:4], trimmed[4:6], trimmed[6:8], "00", "00", "00"); ok {
			return parsed, true
		}
		return 0, false
	}
	if matches := compactTimePattern.FindStringSubmatch(trimmed); matches != nil {
		if parsed, ok := utcDate(matches[1], matches[2], matches[3], matches[4], matches[5], matches[6]); ok {
			return parsed, true
		}
		return 0, false
	}
	if numericStringPattern.MatchString(trimmed) {
		numeric, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(numeric) || math.IsInf(numeric, 0) {
			return 0, false
		}
		millis := numeric
		if numeric <= 1_000_000_000_000 {
			millis = numeric * 1000
		}
		return int64(millis), true
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02",
		"2006-01-02 15:04:05",
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UnixMilli(), true
		}
	}
	return 0, false
}

// utcDate builds a UTC timestamp only when the components form a real date, so
// "20240230" is rejected instead of being normalized into March.
func utcDate(year, month, day, hour, minute, second string) (int64, bool) {
	y, err1 := strconv.Atoi(year)
	m, err2 := strconv.Atoi(month)
	d, err3 := strconv.Atoi(day)
	h, err4 := strconv.Atoi(hour)
	mi, err5 := strconv.Atoi(minute)
	s, err6 := strconv.Atoi(second)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil || err6 != nil {
		return 0, false
	}
	parsed := time.Date(y, time.Month(m), d, h, mi, s, 0, time.UTC)
	if parsed.Year() != y || int(parsed.Month()) != m || parsed.Day() != d ||
		parsed.Hour() != h || parsed.Minute() != mi || parsed.Second() != s {
		return 0, false
	}
	return parsed.UnixMilli(), true
}

// formatISO reproduces Date.prototype.toISOString: UTC, millisecond precision and
// a trailing Z.
func formatISO(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z")
}

// formatISOFromTime is formatISO for a time.Time, truncated to milliseconds so a
// nanosecond value cannot produce a fractional millisecond.
func formatISOFromTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

// toDateBucket reproduces toDateBucket: the UTC date of a parseable timestamp, or
// today's UTC date when it is not parseable.
func toDateBucket(value string) string {
	if millis, ok := parseJSTimeMillis(value); ok {
		return formatISO(millis)[:10]
	}
	return time.Now().UTC().Format("2006-01-02")
}

// toCompactDayString reproduces toCompactDayString: the UTC date without dashes.
func toCompactDayString(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("20060102")
}

func millisNow() int64 { return time.Now().UnixMilli() }

// toIsoTimestamp reproduces toIsoTimestamp for the JSON values the external
// payloads contain: a string in one of the accepted shapes, a numeric epoch, or
// the current time when nothing parses.
func toIsoTimestamp(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return formatISO(millisNow())
	}
	if trimmed[0] == '"' {
		text, ok := decodeJSONString(trimmed)
		if !ok {
			return formatISO(millisNow())
		}
		normalized := jsTrim(text)
		if normalized == "" {
			return formatISO(millisNow())
		}
		if millis, ok := parseJSTimeMillis(normalized); ok {
			return formatISO(millis)
		}
		return formatISO(millisNow())
	}
	if value, ok := toFiniteNumber(trimmed); ok {
		if value >= 10_000_000 && value <= 99_999_999 {
			dayValue := strconv.FormatInt(jsTrunc(value), 10)
			if millis, ok := utcDate(dayValue[0:4], dayValue[4:6], dayValue[6:8], "00", "00", "00"); ok {
				return formatISO(millis)
			}
		}
		millis := value
		if value <= 1_000_000_000_000 {
			millis = value * 1000
		}
		return formatISO(int64(millis))
	}
	return formatISO(millisNow())
}

// toIsoTimestampFromTime is toIsoTimestamp for a Go time value.
func toIsoTimestampFromTime(value time.Time) string {
	return formatISOFromTime(value)
}

// isValidCoordinate mirrors isValidCoordinate.
func isValidCoordinate(lat, lng *float64) bool {
	if lat == nil || lng == nil {
		return false
	}
	return !math.IsNaN(*lat) && !math.IsInf(*lat, 0) &&
		!math.IsNaN(*lng) && !math.IsInf(*lng, 0) &&
		math.Abs(*lat) <= 90 && math.Abs(*lng) <= 180
}

// finitePtr returns a pointer to a finite float, or nil when the value is missing
// or non-finite.
func finitePtr(value float64, ok bool) *float64 {
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

// roundSeconds is Math.max(0, Math.round(deltaMs / 1000)).
func roundSeconds(deltaMs int64) int {
	value := int(jsRound(float64(deltaMs) / 1000))
	if value < 0 {
		value = 0
	}
	return value
}
