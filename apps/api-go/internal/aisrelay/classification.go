package aisrelay

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
)

// Candidate classification and the value normalisers that feed the vessel index.
//
// Everything here is derived from apps/ais-relay/src/candidate-classification.ts.
// The relay receives arbitrary strings from AISStream, so the normalisers follow
// JavaScript coercion rules instead of Go's stricter parsing: a field that JS would
// treat as absent must stay absent, otherwise vessels, candidates and the health
// reasons would drift between the two implementations.

// jsWhitespaceClassBody is ECMAScript WhiteSpace plus LineTerminator, spelled out
// for Go's regexp engine. Go's `\s` is the ASCII Perl class, which would miss the
// Unicode spaces that JS `\s` accepts, so both patterns below build their classes
// from this body instead.
const jsWhitespaceClassBody = `\t\n\x0b\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// jsWhitespaceClass is jsWhitespaceClassBody as a standalone character class.
const jsWhitespaceClass = `[` + jsWhitespaceClassBody + `]`

var (
	// navalPrefixPattern reproduces NAVAL_PREFIX_RE. Go's `\b` is an ASCII word
	// boundary exactly like JS's, so the boundary behaviour is unchanged; the
	// trailing `[-\s]` is widened to the full JS whitespace set.
	navalPrefixPattern = regexp.MustCompile(
		`(?i)^(?:USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI|USCG|CCG|PCG|CG)(?:\b|[-` + jsWhitespaceClassBody + `])`,
	)

	// militaryKeywordPattern reproduces MILITARY_KEYWORD_RE.
	militaryKeywordPattern = regexp.MustCompile(
		`(?i)\b(?:WARSHIP|NAVY|NAVAL|COAST` + jsWhitespaceClass + `+GUARD|PATROL|CUSTOMS|POLICE)\b`,
	)
)

// decodeJSONString decodes a JSON string token. ok is false for any non-string
// value, including null and numbers, which mirrors `typeof value !== "string"`.
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

// isJSONNull reports whether the raw value is the JSON literal null.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// isAbsentRaw reports whether a raw member is missing or null, which is the `??`
// fall-through condition.
func isAbsentRaw(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

// isJSONObject reports whether the raw value is a JSON object. Together with
// isAbsentRaw this reproduces the Node guard
// `value && typeof value === "object" && !Array.isArray(value)`.
func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// normalizeStringRaw reproduces normalizeString(meta.ShipName): only a JSON string
// survives, it is JS-trimmed, and an empty result is absent.
func normalizeStringRaw(raw json.RawMessage) *string {
	value, ok := decodeJSONString(raw)
	if !ok {
		return nil
	}
	trimmed := jsTrim(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeMmsiRaw reproduces normalizeMmsi: a finite JSON number becomes
// String(Math.trunc(value)), anything else goes through normalizeString.
//
// The truncation path uses JS number formatting, so a value such as 1e21 becomes
// "1e+21" exactly as String(Math.trunc(1e21)) does in the Node relay.
func normalizeMmsiRaw(raw json.RawMessage) *string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '"' {
		return normalizeStringRaw(trimmed)
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	text := jsNumberString(jsTrunc(value))
	return &text
}

// getNumberRaw reproduces getNumber: a finite JSON number passes through, and a
// JSON string is parsed with Number() semantics, but only when it is not blank.
//
// The blank check happens before parsing, so "" is absent rather than 0, while
// "  7  " is 7 and "0x10" is 16.
func getNumberRaw(raw json.RawMessage) *float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '"' {
		text, ok := decodeJSONString(trimmed)
		if !ok {
			return nil
		}
		if jsTrim(text) == "" {
			return nil
		}
		parsed, ok := parseJSNumber(text)
		if !ok {
			return nil
		}
		return &parsed
	}
	// Booleans, objects and arrays are not `typeof value === "number"`.
	switch trimmed[0] {
	case 't', 'f', '{', '[':
		return nil
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

// isLikelyMilitaryCandidate reproduces isLikelyMilitaryCandidate: a ShipType of 35
// (military ops) or 50-59 (special craft, tugs, law enforcement), or a name that
// starts with a naval prefix or contains a military keyword.
//
// The name is upper-cased with JS semantics first, because the Node version applies
// toUpperCase() before testing the (case-insensitive) patterns.
func isLikelyMilitaryCandidate(meta map[string]json.RawMessage) bool {
	if shipType := getNumberRaw(meta["ShipType"]); shipType != nil {
		if *shipType == 35 || (*shipType >= 50 && *shipType <= 59) {
			return true
		}
	}

	name := normalizeStringRaw(meta["ShipName"])
	if name == nil {
		return false
	}
	upper := jsToUpper(*name)
	if navalPrefixPattern.MatchString(upper) {
		return true
	}
	return militaryKeywordPattern.MatchString(upper)
}
