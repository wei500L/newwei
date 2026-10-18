package situationsignals

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// This file reproduces the JavaScript Number() conversion used by the NestJS
// implementations this package mirrors: controller.parsePositiveInt (string
// branch), the Telegram cursor / lastPollAt normalization, the OREF history
// counters and the situation-monitor settings resolvers.
//
// strconv.ParseFloat is deliberately not used as the decision procedure: it
// accepts forms JavaScript rejects (underscore separators, leading "+" with
// hex, trailing garbage in some Go versions) and rejects forms JavaScript
// accepts (hex/binary/octal literals, "Infinity", whitespace padding). Callers
// must go through parseJSNumberString / jsNumber.

// isJSWhiteSpace reports whether r is part of the ECMAScript WhiteSpace or
// LineTerminator production (the set String.prototype.trim removes).
func isJSWhiteSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff':
		return true
	}
	// Unicode "Space_Separator" (Zs) category.
	switch {
	case r >= 0x1680 && r <= 0x1680:
		return true
	case r >= 0x2000 && r <= 0x200a:
		return true
	case r >= 0x2028 && r <= 0x2029:
		return true
	case r >= 0x202f && r <= 0x202f:
		return true
	case r >= 0x205f && r <= 0x205f:
		return true
	case r >= 0x3000 && r <= 0x3000:
		return true
	}
	return false
}

// jsTrim mirrors String.prototype.trim (ECMAScript white space only). Go's
// strings.TrimSpace uses a different Unicode set, which would accept inputs
// JavaScript converts to NaN.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSWhiteSpace)
}

// parseJSNumberString converts a string with JavaScript Number(string)
// semantics. The second result is false exactly when JavaScript yields NaN.
//
// JavaScript yields NaN for Infinity/NaN/undefined inputs; callers that need
// those must handle them separately, so only finite results are reported as
// valid here. "+Infinity" and "-Infinity" are treated as invalid for the same
// reason (no caller in this batch can act on an infinite bound).
func parseJSNumberString(raw string) (float64, bool) {
	text := jsTrim(raw)
	if text == "" {
		// Number("") === 0.
		return 0, true
	}
	if nonDecimal, ok := parseJSNonDecimalLiteral(text); ok {
		return nonDecimal, true
	}
	negative := false
	body := text
	switch body[0] {
	case '+':
		body = body[1:]
	case '-':
		negative = true
		body = body[1:]
	}
	if body == "" {
		return 0, false
	}
	if !isJSDecimalLiteral(body) {
		return 0, false
	}
	value, err := strconv.ParseFloat(strings.TrimPrefix(body, "+"), 64)
	if err != nil {
		// Overflow ("1e999") is +Inf in JavaScript and therefore not usable by
		// any caller here; underflow ("1e-999") is 0 and ParseFloat reports
		// ErrRange for both, so handle them explicitly.
		if numErr, ok := err.(*strconv.NumError); ok && numErr.Err == strconv.ErrRange {
			if math.IsInf(value, 0) {
				return 0, false
			}
			return value, true
		}
		return 0, false
	}
	if negative {
		value = -value
	}
	return value, true
}

// parseJSNonDecimalLiteral handles 0x/0X, 0b/0B and 0o/0O integer literals.
// JavaScript rejects a sign in front of them (Number("-0x10") === NaN), which
// is why this runs before the sign is stripped.
func parseJSNonDecimalLiteral(text string) (float64, bool) {
	if len(text) < 3 || text[0] != '0' {
		return 0, false
	}
	var base int
	switch text[1] {
	case 'x', 'X':
		base = 16
	case 'b', 'B':
		base = 2
	case 'o', 'O':
		base = 8
	default:
		return 0, false
	}
	digits := text[2:]
	if digits == "" {
		return 0, false
	}
	for _, r := range digits {
		if !isDigitForBase(r, base) {
			return 0, false
		}
	}
	// ParseUint caps at 64 bits; longer literals are accumulated in float64,
	// which matches JavaScript's rounding for every realistic input.
	if value, err := strconv.ParseUint(digits, base, 64); err == nil {
		return float64(value), true
	}
	var value float64
	for _, r := range digits {
		value = value*float64(base) + float64(digitValue(r))
		if math.IsInf(value, 0) {
			return 0, false
		}
	}
	return value, true
}

func isDigitForBase(r rune, base int) bool {
	switch {
	case r >= '0' && r <= '9':
		return int(r-'0') < base
	case r >= 'a' && r <= 'f':
		return base == 16
	case r >= 'A' && r <= 'F':
		return base == 16
	}
	return false
}

func digitValue(r rune) int {
	switch {
	case r >= '0' && r <= '9':
		return int(r - '0')
	case r >= 'a' && r <= 'f':
		return int(r-'a') + 10
	case r >= 'A' && r <= 'F':
		return int(r-'A') + 10
	}
	return 0
}

// isJSDecimalLiteral validates the StrUnsignedDecimalLiteral grammar without a
// sign: DecimalDigits[.DecimalDigits][(e|E)[+|-]DecimalDigits] or
// .DecimalDigits[(e|E)[+|-]DecimalDigits].
func isJSDecimalLiteral(text string) bool {
	index := 0
	digits := 0
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
		digits++
	}
	if index < len(text) && text[index] == '.' {
		index++
		for index < len(text) && text[index] >= '0' && text[index] <= '9' {
			index++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if index == len(text) {
		return true
	}
	if text[index] != 'e' && text[index] != 'E' {
		return false
	}
	index++
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		index++
	}
	exponentDigits := 0
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
		exponentDigits++
	}
	if exponentDigits == 0 {
		return false
	}
	return index == len(text)
}

// jsNumber converts a decoded JSON value with JavaScript Number(value)
// semantics:
//
//	number          -> the number
//	string          -> parseJSNumberString
//	true / false    -> 1 / 0
//	null            -> 0
//	[] / [x]        -> 0 / Number(x)
//	[a, b, ...]     -> NaN
//	object          -> NaN
//
// The second result is false when the value is NaN. An empty raw slice means
// the value was absent (JavaScript undefined) and is also NaN.
func jsNumber(raw json.RawMessage, present bool) (float64, bool) {
	if !present {
		return 0, false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0, false
		}
		return parseJSNumberString(text)
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		// null
		return 0, true
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return 0, false
		}
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			return jsNumber(items[0], true)
		default:
			return 0, false
		}
	case '{':
		return 0, false
	default:
		value, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, false
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	}
}

// jsFloor mirrors Math.floor for the finite values this package handles.
func jsFloor(value float64) float64 {
	return math.Floor(value)
}
