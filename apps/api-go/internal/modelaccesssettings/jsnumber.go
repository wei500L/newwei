package modelaccesssettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
)

// This file reproduces JavaScript's Number() coercion for values that were
// already read out of a stored SystemSetting row. The NestJS read paths use
// `typeof value === "number" ? value : Number(value)` followed by
// Number.isFinite/Math.floor, so a legacy row may legitimately hold
// "15000", " 2 ", true, null, [5] or "0x10" as timeoutMs/maxRetries.

// jsNumberFromJSON mirrors JavaScript's Number(value) for one decoded JSON
// value. The second return value is false only when the field is absent, which
// means "fall back to the environment default"; a present but unparseable value
// returns NaN with true.
func jsNumberFromJSON(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		text, ok := jsonString(trimmed)
		if !ok {
			return math.NaN(), true
		}
		return jsStringToNumber(text), true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return 0, true
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return math.NaN(), true
		}
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			// Number([x]) is Number(String([x])) === Number(String(x)):
			// recursion reproduces [5] -> 5, [[5]] -> 5 and [null] -> 0. A single
			// boolean is the exception: String([true]) is "true" and
			// Number("true") is NaN, so recursing (which reads Number(true) === 1)
			// would invent a value.
			single := bytes.TrimSpace(items[0])
			if len(single) > 0 && (single[0] == 't' || single[0] == 'f') {
				return math.NaN(), true
			}
			return jsNumberFromJSON(single)
		default:
			// String([1,2]) === "1,2", which Number() cannot parse.
			return math.NaN(), true
		}
	case '{':
		return math.NaN(), true
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				// JSON.parse("1e999") is Infinity, not an error.
				return value, true
			}
			return math.NaN(), true
		}
		return value, true
	}
}

// jsStringToNumber mirrors JavaScript's Number(string): the empty string is 0,
// only the three canonical Infinity spellings are accepted, and the 0x/0o/0b
// literal forms are unsigned integers.
func jsStringToNumber(text string) float64 {
	trimmed := jsTrimSpace(text)
	if trimmed == "" {
		return 0
	}
	// The spec accepts exactly these three spellings; "infinity", "inf" and
	// "nan" are NaN even though Go's strconv.ParseFloat accepts several of them.
	switch trimmed {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if isNaNOrInfinitySpelling(trimmed) {
		return math.NaN()
	}
	// Non-decimal literals carry no sign: Number("-0x10") is NaN.
	if len(trimmed) > 2 && trimmed[0] == '0' {
		base := 0
		switch trimmed[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			value, err := strconv.ParseInt(trimmed[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(value)
		}
	}
	// Go accepts underscores in numeric literals where JavaScript does not, so
	// they are rejected up front (Number("1_0") is NaN).
	if strings.ContainsRune(trimmed, '_') {
		return math.NaN()
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			return value
		}
		return math.NaN()
	}
	return value
}

// isNaNOrInfinitySpelling reports whether the text is one of the spellings
// JavaScript's Number() rejects even though Go's strconv.ParseFloat accepts it
// ("inf", "infinity", "nan" in any case). The three canonical Infinity spellings
// must already have been handled by the caller.
func isNaNOrInfinitySpelling(text string) bool {
	lower := strings.ToLower(text)
	signless := lower
	if strings.HasPrefix(signless, "+") || strings.HasPrefix(signless, "-") {
		signless = signless[1:]
	}
	return signless == "inf" || signless == "infinity" || signless == "nan"
}

// jsIsInteger mirrors Number.isInteger: finite and without a fractional part.
func jsIsInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// asPositiveInt mirrors ModelServiceSettingsService.asPositiveInt: Number(value)
// must be finite and > 0, then Math.floor applies. ok is false when the value
// must fall back to the environment default.
func asPositiveInt(raw json.RawMessage) (int, bool) {
	value, present := jsNumberFromJSON(raw)
	if !present || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0, false
	}
	return int(math.Floor(value)), true
}

// asNonNegativeInt mirrors ModelServiceSettingsService.asNonNegativeInt.
func asNonNegativeInt(raw json.RawMessage) (int, bool) {
	value, present := jsNumberFromJSON(raw)
	if !present || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	return int(math.Floor(value)), true
}

// asPositiveIntEnv mirrors the NestJS env schema for MODEL_SERVICE_TIMEOUT_MS:
// z.coerce.number().int().positive(). The ok flag reports whether the value is
// usable at all; invalid reports a configuration error (NestJS refuses to start).
func asPositiveIntEnv(value string) (parsed int, ok bool, invalid bool) {
	trimmed := jsTrimSpace(value)
	if trimmed == "" {
		return 0, false, false
	}
	number := jsStringToNumber(trimmed)
	if math.IsNaN(number) || math.IsInf(number, 0) || !jsIsInteger(number) || number <= 0 {
		return 0, false, true
	}
	return int(number), true, false
}

// asNonNegativeIntEnv mirrors the NestJS env schema for
// MODEL_SERVICE_MAX_RETRIES: z.coerce.number().int().nonnegative().
func asNonNegativeIntEnv(value string) (parsed int, ok bool, invalid bool) {
	trimmed := jsTrimSpace(value)
	if trimmed == "" {
		return 0, false, false
	}
	number := jsStringToNumber(trimmed)
	if math.IsNaN(number) || math.IsInf(number, 0) || !jsIsInteger(number) || number < 0 {
		return 0, false, true
	}
	return int(number), true, false
}

// jsEnvBoolean mirrors the NestJS envBoolean preprocessor:
//
//	boolean        -> itself
//	number 1 or 0  -> true / false, any other number is a configuration error
//	string trimmed lowercased:
//	  ""                                    -> unset (the schema default applies)
//	  true|1|yes|y|on                       -> true
//	  false|0|no|n|off                      -> false
//	  anything else                         -> configuration error
//
// The third return value reports a configuration error; this package only turns
// it into a startup failure in go mode, so a legacy deployment keeps its exact
// previous behaviour.
func jsEnvBoolean(value string) (result bool, set bool, invalid bool) {
	normalized := strings.ToLower(jsTrimSpace(value))
	switch normalized {
	case "":
		return false, false, false
	case "true", "1", "yes", "y", "on":
		return true, true, false
	case "false", "0", "no", "n", "off":
		return false, true, false
	default:
		return false, false, true
	}
}
