package runtimesettings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// This file holds the request models and the class-validator equivalent. Every
// DTO field is decoded as json.RawMessage so that a single wrong type never
// aborts the whole decode: the per-field validators below reproduce the exact
// class-validator default messages and the order in which NestJS's
// ValidationPipe collects them (declaration order, joined with "; ").
//
// The validators never use any / interface{}: each helper takes a concrete
// json.RawMessage and returns a concrete Go type.

// maxJSONBodyBytes mirrors apps/api/src/main.ts json({limit:"10mb"}).
const maxJSONBodyBytes = 10 << 20

// validationErrors accumulates class-validator style messages.
type validationErrors struct {
	messages []string
}

// add appends one message.
func (v *validationErrors) add(message string) {
	v.messages = append(v.messages, message)
}

// empty reports whether no message was collected.
func (v *validationErrors) empty() bool { return len(v.messages) == 0 }

// err converts the collected messages into the 400 the client sees:
// GlobalExceptionFilter joins a class-validator message array with "; ".
func (v *validationErrors) err() error {
	if v.empty() {
		return nil
	}
	return &httpError{status: http.StatusBadRequest, message: strings.Join(v.messages, "; ")}
}

// present reports whether a decoded field holds any JSON at all. An absent key
// leaves json.RawMessage nil; `null` is present with the four bytes "null".
func present(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// isNull reports whether the field holds the JSON literal null. NestJS
// distinguishes undefined (absent) from null in the @IsOptional paths.
func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// isJSONNumber reports whether the raw token is a JSON number (not a string,
// boolean, null, array or object). class-validator's @IsInt does not coerce.
func isJSONNumber(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')
}

// numberField validates @IsInt/@Min/@Max and returns the value.
//
// required controls what an absent or null field does: a required field reports
// all three constraint messages (class-validator runs every decorator on the
// property), while an optional field reports nothing and lets the service layer
// apply its default or raise its own flat 400.
func numberField(v *validationErrors, raw json.RawMessage, field string, required bool, min, max int) (int, bool) {
	if !present(raw) || isNull(raw) {
		if required {
			addIntegerMessages(v, field, min, max)
		}
		return 0, false
	}
	return integerConstraint(v, raw, field, min, max)
}

// addIntegerMessages appends the three class-validator default messages an
// integer property produces when its value is absent, null or not a number.
func addIntegerMessages(v *validationErrors, field string, min, max int) {
	v.add(field + " must be an integer number")
	v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
}

// integerConstraint evaluates @IsInt/@Min/@Max independently, exactly like
// class-validator does, and reports whether the value passed all three.
func integerConstraint(v *validationErrors, raw json.RawMessage, field string, min, max int) (int, bool) {
	isNumber := isJSONNumber(raw)
	value := math.NaN()
	if isNumber {
		parsed, err := parseJSONFloat(raw)
		if err != nil {
			isNumber = false
		} else {
			value = parsed
		}
	}
	integerOK := isNumber && jsIsInteger(value)
	if !integerOK {
		v.add(field + " must be an integer number")
	}
	minOK := isNumber && value >= float64(min)
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	maxOK := isNumber && value <= float64(max)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
	}
	if !integerOK || !minOK || !maxOK {
		return 0, false
	}
	return int(value), true
}

// floatField validates @IsNumber({maxDecimalPlaces})/@Min/@Max, evaluating each
// constraint independently like class-validator.
func floatField(v *validationErrors, raw json.RawMessage, field string, required bool, min, max float64, maxDecimals int) (float64, bool) {
	if !present(raw) || isNull(raw) {
		if required {
			addFloatMessages(v, field, min, max)
		}
		return 0, false
	}
	isNumber := isJSONNumber(raw)
	value := math.NaN()
	if isNumber {
		parsed, err := parseJSONFloat(raw)
		if err != nil {
			isNumber = false
		} else {
			value = parsed
		}
	}
	numberOK := isNumber && !math.IsNaN(value) && !math.IsInf(value, 0) && hasAtMostDecimals(value, maxDecimals)
	if !numberOK {
		v.add(field + " must be a number conforming to the specified constraints")
	}
	minOK := isNumber && value >= min
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, int(min)))
	}
	maxOK := isNumber && value <= max
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, int(max)))
	}
	if !numberOK || !minOK || !maxOK {
		return 0, false
	}
	return value, true
}

// addFloatMessages appends the default messages a numeric property produces for
// an absent or null value.
func addFloatMessages(v *validationErrors, field string, min, max float64) {
	v.add(field + " must be a number conforming to the specified constraints")
	v.add(fmt.Sprintf("%s must not be less than %d", field, int(min)))
	v.add(fmt.Sprintf("%s must not be greater than %d", field, int(max)))
}

// parseJSONFloat parses a raw JSON number token into a float64. The raw token
// is guaranteed to be a JSON number by isJSONNumber at every call site.
func parseJSONFloat(raw json.RawMessage) (float64, error) {
	return strconv.ParseFloat(string(bytes.TrimSpace(raw)), 64)
}

// hasAtMostDecimals reports whether the value needs no more than maxDecimals
// decimal places, matching class-validator's maxDecimalPlaces check.
func hasAtMostDecimals(value float64, maxDecimals int) bool {
	scaled := value * math.Pow(10, float64(maxDecimals))
	return math.Abs(scaled-math.Round(scaled)) < 1e-9
}

// stringField validates @IsString and returns the value. present reports
// whether the key existed at all (needed for the description clearing rules).
func stringField(v *validationErrors, raw json.RawMessage, field string, required bool) (string, bool) {
	if !present(raw) {
		if required {
			v.add(field + " must be a string")
		}
		return "", false
	}
	if isNull(raw) {
		// @IsOptional skips null; @IsString on a required field rejects it.
		if required {
			v.add(field + " must be a string")
		}
		return "", true
	}
	if !bytes.HasPrefix(bytes.TrimSpace(raw), []byte{'"'}) {
		v.add(field + " must be a string")
		return "", true
	}
	var text string
	if err := json.Unmarshal(bytes.TrimSpace(raw), &text); err != nil {
		v.add(field + " must be a string")
		return "", true
	}
	return text, true
}

// matchesField validates @Matches on top of @IsString.
func matchesField(v *validationErrors, raw json.RawMessage, field, pattern string, patternOK func(string) bool) (string, bool) {
	text, ok := stringField(v, raw, field, true)
	if !ok {
		return "", false
	}
	if !patternOK(text) {
		v.add(fmt.Sprintf("%s must match %s regular expression", field, pattern))
		return "", false
	}
	return text, true
}

// boolField validates @IsBoolean.
func boolField(v *validationErrors, raw json.RawMessage, field string, required bool) (bool, bool) {
	if !present(raw) {
		if required {
			v.add(field + " must be a boolean value")
		}
		return false, false
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("true")) {
		return true, true
	}
	if bytes.Equal(trimmed, []byte("false")) {
		return false, true
	}
	v.add(field + " must be a boolean value")
	return false, false
}

// enumField validates @IsIn(allowed). The property carries no @IsString, so a
// missing, null or non-string value produces exactly one message.
func enumField(v *validationErrors, raw json.RawMessage, field string, allowed []string) (string, bool) {
	if present(raw) && !isNull(raw) {
		text, ok := stringField(&validationErrors{}, raw, field, false)
		if ok {
			for _, candidate := range allowed {
				if text == candidate {
					return text, true
				}
			}
		}
	}
	v.add(fmt.Sprintf("%s must be one of the following values: %s", field, strings.Join(allowed, ", ")))
	return "", false
}

// stringListField validates @IsArray/@ArrayMaxSize/@IsString(each)/
// @MaxLength(64, each)/@Matches(each) and returns the raw entries in order.
func stringListField(v *validationErrors, raw json.RawMessage, field string, maxItems, maxLength int) ([]string, bool) {
	if !present(raw) {
		v.add(field + " must be an array")
		return nil, false
	}
	if !bytes.HasPrefix(bytes.TrimSpace(raw), []byte{'['}) {
		v.add(field + " must be an array")
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &items); err != nil {
		v.add(field + " must be an array")
		return nil, false
	}
	if len(items) > maxItems {
		v.add(fmt.Sprintf("%s must contain not more than %d elements", field, maxItems))
		return nil, false
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if !bytes.HasPrefix(bytes.TrimSpace(item), []byte{'"'}) {
			v.add(field + " must be an array")
			return nil, false
		}
		var text string
		if err := json.Unmarshal(bytes.TrimSpace(item), &text); err != nil {
			v.add(field + " must be an array")
			return nil, false
		}
		if len([]rune(text)) > maxLength {
			v.add(fmt.Sprintf("%s must be shorter than or equal to %d characters", field, maxLength))
			return nil, false
		}
		if !queryParamAllowlistEntry(text) {
			v.add(fmt.Sprintf("%s must match %s regular expression", field, queryParamAllowlistPattern))
			return nil, false
		}
		out = append(out, text)
	}
	return out, true
}

// newStrictDecoder builds a decoder that rejects unknown properties, which is
// how the global ValidationPipe is configured (whitelist +
// forbidNonWhitelisted). Unknown property errors keep the exact NestJS message
// "property <name> should not exist".
func newStrictDecoder(body []byte) *json.Decoder {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	return decoder
}

// decodeBodyError maps a json.Decoder failure onto the ValidationPipe
// contract. An unknown property becomes the exact NestJS message
// "property <name> should not exist"; every other decode failure becomes a
// generic 400 (the concrete field is validated afterwards by the typed
// helpers, which emit class-validator's own wording).
func decodeBodyError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if strings.HasPrefix(message, "json: unknown field ") {
		name := strings.Trim(strings.TrimPrefix(message, "json: unknown field "), "\"")
		return &httpError{status: http.StatusBadRequest, message: "property " + name + " should not exist"}
	}
	return &httpError{status: http.StatusBadRequest, message: "Invalid request body"}
}

// queryParamAllowlistPattern is the regular expression the
// seedUrlQueryParamAllowlist DTO field validates each entry against, reproduced
// from @Matches(/^[a-z0-9_.-]{1,64}$/i).
const queryParamAllowlistPattern = "/^[a-z0-9_.-]{1,64}$/i"

// queryParamAllowlistEntry reports whether one allowlist entry matches
// ^[a-z0-9_.-]{1,64}$ case-insensitively.
func queryParamAllowlistEntry(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '.' || r == '-':
		default:
			return false
		}
	}
	return true
}
