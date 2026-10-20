package newseventstimeline

import (
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// This file holds the JavaScript primitive semantics the port has to reproduce
// value by value. Each helper documents the exact spec rule it implements,
// because the timeline thresholds are close enough to the boundaries that a
// "close" float or string result is not equivalent.

// jsCaseLower/jsCaseUpper apply Unicode Default Case Conversion with full
// (unconditional) special casing, which is what String.prototype.toLowerCase and
// String.prototype.toUpperCase do for the root locale. Plain strings.ToLower
// only applies the simple per-rune mapping, so it turns "ß" into "ß" instead of
// "SS" and "İ" into "i" instead of "i̇".
var (
	jsCaseLower = cases.Lower(language.Und)
	jsCaseUpper = cases.Upper(language.Und)
)

func jsToLower(value string) string { return jsCaseLower.String(value) }

func jsToUpper(value string) string { return jsCaseUpper.String(value) }

// jsIsSpace reports whether r is matched by the JavaScript \s class, which is
// also the set String.prototype.trim removes: TAB, LF, VT, FF, CR, SP, NBSP,
// ZWNBSP, the Zs category characters (except NEL, which JavaScript does not
// treat as whitespace) and the two line separators.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
		'\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// jsTrim is String.prototype.trim. It is not strings.TrimSpace: Go keeps
// U+FEFF and drops U+0085 while JavaScript does the opposite.
func jsTrim(value string) string {
	return strings.TrimFunc(value, jsIsSpace)
}

// normalizeOptionalString mirrors normalizeOptionalString: a non-string or a
// string that trims to empty becomes null.
func normalizeOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := jsTrim(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// capitalizeWord mirrors capitalizeWord: trim, default to "mixed", uppercase the
// first UTF-16 code unit and append the rest of the UTF-16 string.
//
// charAt(0) splits a surrogate pair, and toUpperCase on a lone surrogate is the
// identity, so for a non-BMP first character the result is the input unchanged.
func capitalizeWord(value string) string {
	normalized := "mixed"
	if trimmed := normalizeOptionalString(&value); trimmed != nil {
		normalized = *trimmed
	}
	first, size := utf8.DecodeRuneInString(normalized)
	if first == utf8.RuneError && size <= 1 {
		return normalized
	}
	if utf16.RuneLen(first) == 2 {
		return normalized
	}
	return jsToUpper(string(first)) + normalized[size:]
}

// jsRound is Math.round: floor(x) + 1 when the fractional part is at least 0.5.
//
// It is not math.Floor(x + 0.5). For 0.49999999999999994, x + 0.5 rounds up to
// 1.0 in binary floating point, while the exact difference from the floor is
// 0.49999999999999994, so JavaScript returns 0. Every Math.round(x * 10000) /
// 10000 in the timeline service goes through here.
func jsRound(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	floor := math.Floor(value)
	if value-floor >= 0.5 {
		return floor + 1
	}
	return floor
}

func jsRoundInt(value float64) int {
	return int(jsRound(value))
}

// roundTo4 mirrors Math.round(value * 10000) / 10000.
func roundTo4(value float64) float64 {
	return jsRound(value*10000) / 10000
}

// jsToFixed mirrors Number.prototype.toFixed for the digit counts the timeline
// uses (1 and 3).
//
// The spec picks the integer n that minimises |n / 10^digits - x| and, on an
// exact tie, picks the larger n. That decision has to be made on the exact
// binary value of x: strconv.FormatFloat rounds ties to even, and computing
// x * 10^digits in float64 introduces its own error. big.Rat holds the exact
// float64 value, so the comparison is exact.
func jsToFixed(value float64, digits int) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.Abs(value) >= 1e21 {
		// The spec falls back to Number::toString here. No timeline percentage or
		// KL value can reach this magnitude; the branch exists only so the helper
		// has no silent wrong answer.
		return strconv.FormatFloat(value, 'g', -1, 64)
	}
	rational := new(big.Rat).SetFloat64(math.Abs(value))
	if rational == nil {
		return "NaN"
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	scaled := new(big.Rat).Mul(rational, new(big.Rat).SetInt(scale))
	// floor(scaled) is exact for a non-negative rational, and the half-up rule is
	// "add the fraction to the floor when 2*remainder >= denominator".
	floor := new(big.Int).Quo(scaled.Num(), scaled.Denom())
	remainder := new(big.Int).Sub(scaled.Num(), new(big.Int).Mul(floor, scaled.Denom()))
	if new(big.Int).Lsh(remainder, 1).Cmp(scaled.Denom()) >= 0 {
		floor.Add(floor, big.NewInt(1))
	}
	text := floor.String()
	if len(text) <= digits {
		text = strings.Repeat("0", digits-len(text)+1) + text
	}
	out := text[:len(text)-digits]
	if digits > 0 {
		out += "." + text[len(text)-digits:]
	}
	// The sign follows the sign of x, not the rounded integer: JavaScript prints
	// (-0.0001).toFixed(3) as "-0.000" but (-0).toFixed(3) as "0.000".
	if value < 0 {
		out = "-" + out
	}
	return out
}

// maxArrayIndex is 2^32-2, the largest canonical array-index property name.
const maxArrayIndex = 4294967294

// arrayIndexKey reports whether key is a canonical array-index property name
// (a decimal integer in 0 .. 2^32-2 without leading zeros). Object.keys lists
// those first in ascending numeric order and every other key in insertion order.
func arrayIndexKey(key string) (uint64, bool) {
	if key == "" || len(key) > 10 {
		return 0, false
	}
	if key == "0" {
		return 0, true
	}
	if key[0] < '1' || key[0] > '9' {
		return 0, false
	}
	for index := 1; index < len(key); index++ {
		if key[index] < '0' || key[index] > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseUint(key, 10, 64)
	if err != nil || value > maxArrayIndex {
		return 0, false
	}
	return value, true
}

// objectKeyOrder returns keys in the order Object.keys would enumerate them.
func objectKeyOrder(keys []string) []string {
	indexKeys := make([]uint64, 0, len(keys))
	named := make([]string, 0, len(keys))
	for _, key := range keys {
		if index, ok := arrayIndexKey(key); ok {
			indexKeys = append(indexKeys, index)
			continue
		}
		named = append(named, key)
	}
	if len(indexKeys) == 0 {
		return named
	}
	sort.Slice(indexKeys, func(i, j int) bool { return indexKeys[i] < indexKeys[j] })
	out := make([]string, 0, len(keys))
	for _, index := range indexKeys {
		out = append(out, strconv.FormatUint(index, 10))
	}
	return append(out, named...)
}

// utf16Less orders two strings by UTF-16 code unit, which is what the default
// Array.prototype.sort comparator does. For ASCII it is the same as byte order;
// the comparator stays explicit because article ids are not formally ASCII.
func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	for index := 0; index < len(leftUnits) && index < len(rightUnits); index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

// parseJSTimestamp mirrors Date.parse for the bucket keys this package can
// encounter.
//
// NestJS always writes Date.toISOString keys ("2026-10-20T00:00:00.000Z"), and
// those parse exactly. A bare date ("2026-10-20") is interpreted as UTC and a
// date-time without an offset as local time, matching the ECMAScript rule. Any
// other shape is reported as unparseable, and the caller then keeps the bucket
// instead of pruning it.
func parseJSTimestamp(value string) (int64, bool) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return 0, false
	}
	if parsed, err := parseDateOnly(trimmed); err == nil {
		return parsed.UnixMilli(), true
	}
	if parsed, err := timeParseRFC3339(trimmed); err == nil {
		return parsed.UnixMilli(), true
	}
	if parsed, err := parseLocalDateTime(trimmed); err == nil {
		return parsed.UnixMilli(), true
	}
	return 0, false
}
