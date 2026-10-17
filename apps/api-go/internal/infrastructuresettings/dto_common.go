package infrastructuresettings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// This file holds the request-decoding helpers shared by the three DTOs. They
// reproduce two ValidationPipe behaviours exactly:
//
//   - the whitelist pass: undeclared members produce
//     "property <name> should not exist" *before* any per-property message;
//   - the per-property pass: every decorator on a property is evaluated
//     independently, and its default message is appended in the order the
//     decorators registered their metadata (bottom-up, so the last decorator in
//     the source is evaluated first).
//
// Nothing here uses any / interface{}: every helper takes a concrete
// json.RawMessage and returns a concrete Go type.

// strictObjectTarget receives one top-level JSON member at a time. set reports
// whether the member name is a declared DTO property; unknown members are
// collected by decodeStrictObject instead of failing the whole decode, which is
// what makes it possible to emit the whitelist message and the field messages in
// NestJS order.
type strictObjectTarget interface {
	setField(name string, value json.RawMessage) bool
}

// errInvalidBody reports a body that is not a JSON object at all. NestJS maps
// such a body to a generic 400 (the exact text depends on class-transformer and
// is outside this unit's contract).
var errInvalidBody = &httpError{status: http.StatusBadRequest, message: "Invalid request body"}

// decodeStrictObject streams a JSON object body and feeds each member to the
// target. It returns the undeclared member names in body order.
//
// A JSON null body is treated as an empty object, exactly like NestJS's
// ValidationPipe.toEmptyIfNil.
func decodeStrictObject(body []byte, target strictObjectTarget) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil {
		return nil, errInvalidBody
	}
	if token == nil {
		// JSON null: NestJS replaces the value with {} before validation.
		return nil, nil
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return nil, errInvalidBody
	}
	var unknown []string
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errInvalidBody
		}
		name, ok := keyToken.(string)
		if !ok {
			return nil, errInvalidBody
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, errInvalidBody
		}
		if !target.setField(name, raw) {
			unknown = append(unknown, name)
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errInvalidBody
	}
	return unknown, nil
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

// skippedOptional reports whether @IsOptional() short-circuits every decorator
// on the property (absent or null).
func skippedOptional(raw json.RawMessage) bool {
	return !present(raw) || isNull(raw)
}

// boolConstraint validates @IsBoolean.
func boolConstraint(v *validationErrors, raw json.RawMessage, field string, required bool) (bool, bool) {
	if !present(raw) || isNull(raw) {
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

// stringConstraint validates @IsString. A null value fails it unless the
// property is optional (callers skip optional properties before calling).
func stringConstraint(v *validationErrors, raw json.RawMessage, field string, required bool) (string, bool) {
	if !present(raw) || isNull(raw) {
		if required {
			v.add(field + " must be a string")
		}
		return "", false
	}
	trimmed := bytes.TrimSpace(raw)
	if trimmed[0] != '"' {
		v.add(field + " must be a string")
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		v.add(field + " must be a string")
		return "", false
	}
	return text, true
}

// minThenIntConstraint evaluates @IsInt plus @Min in metadata order
// (@Min registered after @IsInt, so it is evaluated first).
func minThenIntConstraint(v *validationErrors, raw json.RawMessage, field string, min int) (int, bool) {
	value, isNumber := jsonNumberStrict(raw)
	minOK := isNumber && value >= float64(min)
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	intOK := isNumber && jsIsInteger(value)
	if !intOK {
		v.add(field + " must be an integer number")
	}
	if !minOK || !intOK {
		return 0, false
	}
	return int(value), true
}

// maxMinIntConstraint evaluates @IsInt, @Min and @Max in metadata order
// (@Max registered last, so it is evaluated first).
func maxMinIntConstraint(v *validationErrors, raw json.RawMessage, field string, min, max int) (int, bool) {
	value, isNumber := jsonNumberStrict(raw)
	maxOK := isNumber && value <= float64(max)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
	}
	minOK := isNumber && value >= float64(min)
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	intOK := isNumber && jsIsInteger(value)
	if !intOK {
		v.add(field + " must be an integer number")
	}
	if !maxOK || !minOK || !intOK {
		return 0, false
	}
	return int(value), true
}

// enumConstraint validates @IsIn(allowed). The property carries no @IsString,
// so a missing, null or non-matching value produces exactly one message.
func enumConstraint(v *validationErrors, raw json.RawMessage, field string, allowed []string) (string, bool) {
	if present(raw) && !isNull(raw) {
		text, ok := stringConstraint(&validationErrors{}, raw, field, false)
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

// maxLengthConstraint counts code points, mirroring class-validator's
// @MaxLength (validator.isLength accounts for surrogate pairs). The service
// layer later uses UTF-16 code units, which is a deliberately different count.
func maxLengthConstraint(v *validationErrors, text, field string, max int) bool {
	if len([]rune(text)) > max {
		v.add(fmt.Sprintf("%s must be shorter than or equal to %d characters", field, max))
		return false
	}
	return true
}
