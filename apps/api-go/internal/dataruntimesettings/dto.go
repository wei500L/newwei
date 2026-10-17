package dataruntimesettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// This file holds the request models and the class-validator / class-transformer
// equivalent for the three DTOs this unit owns. Every field is decoded as
// json.RawMessage so that a single wrong type never aborts the whole decode, and
// the validators below reproduce the exact class-validator 0.14.2 default
// messages together with the order NestJS's ValidationPipe collects them in.
//
// The collection order was verified against the merged infrastructure-settings
// smoke assertions:
//   - properties appear in DTO declaration order;
//   - within one property the constraints appear in REVERSE decorator order,
//     because TypeScript applies property decorators bottom-up and
//     class-validator keeps the registration order (so
//     `@IsInt() @Min(x) @Max(y)` produces Max, Min, IsInt);
//   - unknown-property ("whitelist") errors come first, in body key order,
//     since class-validator runs the whitelist pass before property validation;
//   - the whole array is joined with "; " by GlobalExceptionFilter.
//
// The validators never use any / interface{}: each helper takes a concrete
// json.RawMessage and returns a concrete Go type.

// ---- JavaScript compatibility primitives ----

// jsNumberFromJSON mirrors JavaScript's Number(value) for a decoded JSON value.
//
// The stored-value readers coerce with Number(), which accepts numeric strings
// ("4", " 4 ", "0x4"), booleans (true -> 1, false -> 0), null (-> 0) and
// single-element arrays ([4] -> 4). The second return value is false only when
// raw is empty, which means "the key is absent" rather than "the value is NaN":
// absent members fall back to their defaults, present but unparseable members
// fall back too (no stored row is ever rejected for a bad member).
func jsNumberFromJSON(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
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
			return jsNumberFromJSON(items[0])
		default:
			// JS Array.prototype.toString joins with "," which Number() cannot
			// parse, so a multi-element array is NaN.
			return math.NaN(), true
		}
	case '{':
		return math.NaN(), true
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				// JSON.parse("1e999") and Number("1e999") are Infinity.
				return value, true
			}
			return math.NaN(), true
		}
		return value, true
	}
}

// jsStringToNumber mirrors JavaScript's Number(string) coercion, including the
// hex/octal/binary literal forms and the empty-string rule (Number("") === 0).
func jsStringToNumber(text string) float64 {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0o") || strings.HasPrefix(lower, "0b") {
		base := 16
		switch lower[1] {
		case 'o':
			base = 8
		case 'b':
			base = 2
		}
		value, err := strconv.ParseInt(trimmed[2:], base, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(value)
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

// jsIsInteger mirrors Number.isInteger: finite values with no fractional part.
func jsIsInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// jsonNumberValue parses a raw JSON number token. ok reports whether the token is
// a JSON number at all; the value may still be +/-Inf for an out-of-range literal
// such as 1e999, exactly like JSON.parse.
func jsonNumberValue(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return 0, false
	}
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			return value, true
		}
		return math.NaN(), false
	}
	return value, true
}

// jsCodePointLength counts Unicode code points, which is what validator.js
// isLength (and therefore @MinLength) measures: an astral character counts once,
// not as two UTF-16 units.
func jsCodePointLength(value string) int {
	return utf8.RuneCountInString(value)
}

// ---- presence tri-state ----

// presence is the tri-state a JSON member can have. NestJS distinguishes absent
// (undefined) from JSON null in every @IsOptional path, and the merge semantics
// depend on that difference.
type presence uint8

const (
	// presenceMissing means the key was absent from the request body.
	presenceMissing presence = iota
	// presenceNull means the key was present with the JSON literal null.
	presenceNull
	// presenceValue means the key was present with a value.
	presenceValue
)

// optionalBool is a validated @IsBoolean() member.
type optionalBool struct {
	state presence
	value bool
}

// optionalNumber is a validated numeric member. The value is the JSON number (or
// the class-transformer coercion of the raw member) so the merge can apply the
// exact JS Math.trunc / clamp semantics.
type optionalNumber struct {
	state presence
	value float64
}

// optionalString is a validated @IsString() member.
type optionalString struct {
	state presence
	value string
}

// coalesceBool mirrors the JavaScript `a ?? b` operator for booleans: a value
// (including false) wins, while null and undefined fall through to b. This is
// what keeps the canonical/legacy alias pairs identical to NestJS; "is the key
// present" would NOT be equivalent, because a null canonical value with an
// absent alias must reach resolveNext* as undefined.
func coalesceBool(a, b optionalBool) optionalBool {
	if a.state == presenceValue {
		return a
	}
	return b
}

// coalesceNumber mirrors `a ?? b` for numbers.
func coalesceNumber(a, b optionalNumber) optionalNumber {
	if a.state == presenceValue {
		return a
	}
	return b
}

// coalesceString mirrors `a ?? b` for strings.
func coalesceString(a, b optionalString) optionalString {
	if a.state == presenceValue {
		return a
	}
	return b
}

// provided reports whether the member was present at all (null counts as
// provided). The audit `secretsUpdated` flags use exactly this test.
func provided(state presence) bool { return state != presenceMissing }

// ---- ordered body decoding ----

// bodyField is one member of the request body in source order.
type bodyField struct {
	Key string
	Raw json.RawMessage
}

// bodyMembers is the request body as an ordered list of members.
type bodyMembers []bodyField

// decodeBodyMembers decodes the body into ordered members. A body that is not a
// JSON object is reported as a 400 with the same message the NestJS body parser
// path produces.
func decodeBodyMembers(body []byte) (bodyMembers, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, &httpError{status: http.StatusBadRequest, message: "Unexpected token in JSON body"}
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, &httpError{status: http.StatusBadRequest, message: "Invalid request body"}
	}
	members := bodyMembers{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, &httpError{status: http.StatusBadRequest, message: "Invalid request body"}
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, &httpError{status: http.StatusBadRequest, message: "Invalid request body"}
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, &httpError{status: http.StatusBadRequest, message: "Invalid request body"}
		}
		members = append(members, bodyField{Key: key, Raw: raw})
	}
	return members, nil
}

// last returns the member value for key using the LAST occurrence, which is what
// JSON.parse produces for a duplicated key.
func (m bodyMembers) last(key string) json.RawMessage {
	var found json.RawMessage
	for _, member := range m {
		if member.Key == key {
			found = member.Raw
		}
	}
	return found
}

// keys returns the member names in first-occurrence order with duplicates
// removed, which is the key order of the object JSON.parse would build.
func (m bodyMembers) keys() []string {
	seen := make(map[string]bool, len(m))
	out := make([]string, 0, len(m))
	for _, member := range m {
		if seen[member.Key] {
			continue
		}
		seen[member.Key] = true
		out = append(out, member.Key)
	}
	return out
}

// rejectUnknown appends one "property X should not exist" message per unknown
// member, in body key order, using the exact ValidationPipe/class-validator text.
func rejectUnknown(v *validationErrors, m bodyMembers, allowed map[string]bool) {
	for _, key := range m.keys() {
		if allowed[key] {
			continue
		}
		v.add("property " + key + " should not exist")
	}
}

// ---- field validators ----

// isNullRaw reports whether a present member holds the JSON literal null.
func isNullRaw(raw json.RawMessage) bool {
	return raw != nil && bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// optionalBoolField validates @IsOptional() @IsBoolean().
func optionalBoolField(v *validationErrors, raw json.RawMessage, field string) optionalBool {
	if raw == nil {
		return optionalBool{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalBool{state: presenceNull}
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("true")) {
		return optionalBool{state: presenceValue, value: true}
	}
	if bytes.Equal(trimmed, []byte("false")) {
		return optionalBool{state: presenceValue, value: false}
	}
	v.add(field + " must be a boolean value")
	return optionalBool{state: presenceValue}
}

// optionalIntField validates @IsOptional() @IsInt() @Min(min) @Max(max).
//
// The messages are emitted in class-validator's registration order, which is the
// reverse of the decorator source order: Max, Min, IsInt.
func optionalIntField(v *validationErrors, raw json.RawMessage, field string, min, max float64) optionalNumber {
	if raw == nil {
		return optionalNumber{state: presenceMissing}
	}
	if isNullRaw(raw) {
		// @IsOptional() skips validation; the service layer turns null into
		// Number(null) === 0 and clamps it to the lower bound.
		return optionalNumber{state: presenceNull}
	}
	value, isNumber := jsonNumberValue(raw)
	maxOK := isNumber && !math.IsNaN(value) && value <= max
	minOK := isNumber && !math.IsNaN(value) && value >= min
	intOK := isNumber && jsIsInteger(value)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %s", field, jsConstraintText(max)))
	}
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %s", field, jsConstraintText(min)))
	}
	if !intOK {
		v.add(field + " must be an integer number")
	}
	if !maxOK || !minOK || !intOK {
		return optionalNumber{state: presenceValue}
	}
	return optionalNumber{state: presenceValue, value: value}
}

// optionalFloatField validates @IsOptional() @IsNumber() @Min(min) @Max(max).
// Order: Max, Min, IsNumber.
func optionalFloatField(v *validationErrors, raw json.RawMessage, field string, min, max float64) optionalNumber {
	if raw == nil {
		return optionalNumber{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalNumber{state: presenceNull}
	}
	value, isNumber := jsonNumberValue(raw)
	maxOK := isNumber && !math.IsNaN(value) && value <= max
	minOK := isNumber && !math.IsNaN(value) && value >= min
	numberOK := isNumber && !math.IsNaN(value) && !math.IsInf(value, 0)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %s", field, jsConstraintText(max)))
	}
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %s", field, jsConstraintText(min)))
	}
	if !numberOK {
		v.add(field + " must be a number conforming to the specified constraints")
	}
	if !maxOK || !minOK || !numberOK {
		return optionalNumber{state: presenceValue}
	}
	return optionalNumber{state: presenceValue, value: value}
}

// optionalStringField validates @IsOptional() @IsString().
func optionalStringField(v *validationErrors, raw json.RawMessage, field string) optionalString {
	if raw == nil {
		return optionalString{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalString{state: presenceNull}
	}
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return optionalString{state: presenceValue}
	}
	return optionalString{state: presenceValue, value: text}
}

// geoNamesStringField validates @IsOptional() @IsString() @MinLength(1).
// Order: MinLength, IsString.
func geoNamesStringField(v *validationErrors, raw json.RawMessage, field string) optionalString {
	if raw == nil {
		return optionalString{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalString{state: presenceNull}
	}
	text, ok := decodeJSONString(raw)
	minLengthOK := ok && jsCodePointLength(text) >= 1
	if !minLengthOK {
		v.add(field + " must be longer than or equal to 1 characters")
	}
	if !ok {
		v.add(field + " must be a string")
		return optionalString{state: presenceValue}
	}
	if !minLengthOK {
		return optionalString{state: presenceValue, value: text}
	}
	return optionalString{state: presenceValue, value: text}
}

// geoEmailField validates @IsOptional() @IsString() @IsEmail().
// Order: IsEmail, IsString.
func geoEmailField(v *validationErrors, raw json.RawMessage, field string) optionalString {
	if raw == nil {
		return optionalString{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalString{state: presenceNull}
	}
	text, ok := decodeJSONString(raw)
	emailOK := ok && validatorIsEmail(text)
	if !emailOK {
		v.add(field + " must be an email")
	}
	if !ok {
		v.add(field + " must be a string")
		return optionalString{state: presenceValue}
	}
	return optionalString{state: presenceValue, value: text}
}

// decodeJSONString decodes a JSON string member. A non-string member reports
// ok=false without an error; the callers add the class-validator message.
func decodeJSONString(raw json.RawMessage) (string, bool) {
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

// jsConstraintText renders a numeric constraint the way class-validator
// interpolates $constraint1 into its default messages.
func jsConstraintText(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e15 {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// ---- realtime_signals_settings DTO ----

// realtimeDTOFieldOrder is the declaration order of
// UpdateRealtimeSignalsSettingsDto.
//
// The NestJS audit records `Object.keys(input)` on the validated DTO instance.
// With target ES2022 and useDefineForClassFields=true, TypeScript emits every
// declaration as a class field, so the constructed instance owns all of them
// (as undefined) in declaration order and class-transformer's plain-to-class
// copy never changes that order. `Object.keys(input)` is therefore this constant
// list regardless of which members the request actually sent, and the Go audit
// records the same list.
var realtimeDTOFieldOrder = []string{
	"enabled",
	"requestTimeoutMs",
	"maxRetries",
	"openskyEnabled",
	"adsbEnabled",
	"openskyIntervalSec",
	"openskyDailyCreditBudget",
	"openskyDayIntervalSec",
	"openskyNightIntervalSec",
	"openskyDayStartHourHkt",
	"openskyNightStartHourHkt",
	"openskyWarningRemainingPct",
	"openskyCriticalRemainingPct",
	"adsbIntervalSec",
	"aisEnabled",
	"aisIntervalSec",
	"unrestEnabled",
	"unrestIntervalSec",
	"outagesEnabled",
	"outagesIntervalSec",
	"keywordSpikeEnabled",
	"keywordSpikeIntervalSec",
	"pizzintEnabled",
	"pizzintIntervalSec",
	"gdeltTensionEnabled",
	"gdeltTensionIntervalSec",
	"polymarketLeadsEnabled",
	"polymarketLeadsIntervalSec",
	"keywordSpikeMinCount",
	"keywordSpikeMultiplier",
	"predictionShiftThreshold",
	"predictionNewsActivityThreshold",
	"openskyBaseUrl",
	"adsbBaseUrl",
	"openskyTokenUrl",
	"aisRelayBaseUrl",
	"relayBaseUrl",
	"openskyClientId",
	"openskyClientSecret",
	"aisRelaySharedSecret",
	"relaySharedSecret",
	"acledOauthUsername",
	"acledOauthPassword",
	"acledOauthClientId",
	"cloudflareApiToken",
	"wingbitsApiKey",
	"polymarketProxyUrl",
}

// realtimeAllowedFields is the whitelist derived from the DTO declaration.
var realtimeAllowedFields = func() map[string]bool {
	allowed := make(map[string]bool, len(realtimeDTOFieldOrder))
	for _, name := range realtimeDTOFieldOrder {
		allowed[name] = true
	}
	return allowed
}()

// realtimeSettingsUpdate is the validated partial update.
type realtimeSettingsUpdate struct {
	Enabled                         optionalBool
	RequestTimeoutMs                optionalNumber
	MaxRetries                      optionalNumber
	OpenskyEnabled                  optionalBool
	AdsbEnabled                     optionalBool
	OpenskyIntervalSec              optionalNumber
	AdsbIntervalSec                 optionalNumber
	OpenskyDailyCreditBudget        optionalNumber
	OpenskyDayIntervalSec           optionalNumber
	OpenskyNightIntervalSec         optionalNumber
	OpenskyDayStartHourHKT          optionalNumber
	OpenskyNightStartHourHKT        optionalNumber
	OpenskyWarningRemainingPct      optionalNumber
	OpenskyCriticalRemainingPct     optionalNumber
	AisEnabled                      optionalBool
	AisIntervalSec                  optionalNumber
	UnrestEnabled                   optionalBool
	UnrestIntervalSec               optionalNumber
	OutagesEnabled                  optionalBool
	OutagesIntervalSec              optionalNumber
	KeywordSpikeEnabled             optionalBool
	KeywordSpikeIntervalSec         optionalNumber
	PizzintEnabled                  optionalBool
	PizzintIntervalSec              optionalNumber
	GdeltTensionEnabled             optionalBool
	GdeltTensionIntervalSec         optionalNumber
	PolymarketLeadsEnabled          optionalBool
	PolymarketLeadsIntervalSec      optionalNumber
	KeywordSpikeMinCount            optionalNumber
	KeywordSpikeMultiplier          optionalNumber
	PredictionShiftThreshold        optionalNumber
	PredictionNewsActivityThreshold optionalNumber
	OpenskyBaseURL                  optionalString
	AdsbBaseURL                     optionalString
	OpenskyTokenURL                 optionalString
	AisRelayBaseURL                 optionalString
	RelayBaseURL                    optionalString
	OpenskyClientID                 optionalString
	OpenskyClientSecret             optionalString
	AisRelaySharedSecret            optionalString
	RelaySharedSecret               optionalString
	AcledOauthUsername              optionalString
	AcledOauthPassword              optionalString
	AcledOauthClientID              optionalString
	CloudflareAPIToken              optionalString
	WingbitsAPIKey                  optionalString
	PolymarketProxyURL              optionalString
}

// parseRealtimeSettingsUpdate reproduces the ValidationPipe result for
// UpdateRealtimeSignalsSettingsDto: the whitelist pass first, then every field in
// declaration order. Fields are optional, so absent and null members are accepted
// and their distinction is preserved into the merge.
func parseRealtimeSettingsUpdate(body []byte) (*realtimeSettingsUpdate, error) {
	members, err := decodeBodyMembers(body)
	if err != nil {
		return nil, err
	}
	v := &validationErrors{}
	rejectUnknown(v, members, realtimeAllowedFields)
	update := &realtimeSettingsUpdate{
		Enabled:                         optionalBoolField(v, members.last("enabled"), "enabled"),
		RequestTimeoutMs:                optionalIntField(v, members.last("requestTimeoutMs"), "requestTimeoutMs", 1_000, 120_000),
		MaxRetries:                      optionalIntField(v, members.last("maxRetries"), "maxRetries", 0, 6),
		OpenskyEnabled:                  optionalBoolField(v, members.last("openskyEnabled"), "openskyEnabled"),
		AdsbEnabled:                     optionalBoolField(v, members.last("adsbEnabled"), "adsbEnabled"),
		OpenskyIntervalSec:              optionalIntField(v, members.last("openskyIntervalSec"), "openskyIntervalSec", 30, 86_400),
		AdsbIntervalSec:                 optionalIntField(v, members.last("adsbIntervalSec"), "adsbIntervalSec", 30, 86_400),
		OpenskyDailyCreditBudget:        optionalIntField(v, members.last("openskyDailyCreditBudget"), "openskyDailyCreditBudget", 1, 100_000),
		OpenskyDayIntervalSec:           optionalIntField(v, members.last("openskyDayIntervalSec"), "openskyDayIntervalSec", 30, 86_400),
		OpenskyNightIntervalSec:         optionalIntField(v, members.last("openskyNightIntervalSec"), "openskyNightIntervalSec", 30, 86_400),
		OpenskyDayStartHourHKT:          optionalIntField(v, members.last("openskyDayStartHourHkt"), "openskyDayStartHourHkt", 0, 23),
		OpenskyNightStartHourHKT:        optionalIntField(v, members.last("openskyNightStartHourHkt"), "openskyNightStartHourHkt", 0, 23),
		OpenskyWarningRemainingPct:      optionalIntField(v, members.last("openskyWarningRemainingPct"), "openskyWarningRemainingPct", 1, 99),
		OpenskyCriticalRemainingPct:     optionalIntField(v, members.last("openskyCriticalRemainingPct"), "openskyCriticalRemainingPct", 0, 98),
		AisEnabled:                      optionalBoolField(v, members.last("aisEnabled"), "aisEnabled"),
		AisIntervalSec:                  optionalIntField(v, members.last("aisIntervalSec"), "aisIntervalSec", 30, 86_400),
		UnrestEnabled:                   optionalBoolField(v, members.last("unrestEnabled"), "unrestEnabled"),
		UnrestIntervalSec:               optionalIntField(v, members.last("unrestIntervalSec"), "unrestIntervalSec", 30, 86_400),
		OutagesEnabled:                  optionalBoolField(v, members.last("outagesEnabled"), "outagesEnabled"),
		OutagesIntervalSec:              optionalIntField(v, members.last("outagesIntervalSec"), "outagesIntervalSec", 30, 86_400),
		KeywordSpikeEnabled:             optionalBoolField(v, members.last("keywordSpikeEnabled"), "keywordSpikeEnabled"),
		KeywordSpikeIntervalSec:         optionalIntField(v, members.last("keywordSpikeIntervalSec"), "keywordSpikeIntervalSec", 30, 86_400),
		PizzintEnabled:                  optionalBoolField(v, members.last("pizzintEnabled"), "pizzintEnabled"),
		PizzintIntervalSec:              optionalIntField(v, members.last("pizzintIntervalSec"), "pizzintIntervalSec", 30, 86_400),
		GdeltTensionEnabled:             optionalBoolField(v, members.last("gdeltTensionEnabled"), "gdeltTensionEnabled"),
		GdeltTensionIntervalSec:         optionalIntField(v, members.last("gdeltTensionIntervalSec"), "gdeltTensionIntervalSec", 30, 86_400),
		PolymarketLeadsEnabled:          optionalBoolField(v, members.last("polymarketLeadsEnabled"), "polymarketLeadsEnabled"),
		PolymarketLeadsIntervalSec:      optionalIntField(v, members.last("polymarketLeadsIntervalSec"), "polymarketLeadsIntervalSec", 30, 86_400),
		KeywordSpikeMinCount:            optionalIntField(v, members.last("keywordSpikeMinCount"), "keywordSpikeMinCount", 1, 500),
		KeywordSpikeMultiplier:          optionalFloatField(v, members.last("keywordSpikeMultiplier"), "keywordSpikeMultiplier", 1, 100),
		PredictionShiftThreshold:        optionalFloatField(v, members.last("predictionShiftThreshold"), "predictionShiftThreshold", 1, 100),
		PredictionNewsActivityThreshold: optionalIntField(v, members.last("predictionNewsActivityThreshold"), "predictionNewsActivityThreshold", 0, 1_000),
		OpenskyBaseURL:                  optionalStringField(v, members.last("openskyBaseUrl"), "openskyBaseUrl"),
		AdsbBaseURL:                     optionalStringField(v, members.last("adsbBaseUrl"), "adsbBaseUrl"),
		OpenskyTokenURL:                 optionalStringField(v, members.last("openskyTokenUrl"), "openskyTokenUrl"),
		AisRelayBaseURL:                 optionalStringField(v, members.last("aisRelayBaseUrl"), "aisRelayBaseUrl"),
		RelayBaseURL:                    optionalStringField(v, members.last("relayBaseUrl"), "relayBaseUrl"),
		OpenskyClientID:                 optionalStringField(v, members.last("openskyClientId"), "openskyClientId"),
		OpenskyClientSecret:             optionalStringField(v, members.last("openskyClientSecret"), "openskyClientSecret"),
		AisRelaySharedSecret:            optionalStringField(v, members.last("aisRelaySharedSecret"), "aisRelaySharedSecret"),
		RelaySharedSecret:               optionalStringField(v, members.last("relaySharedSecret"), "relaySharedSecret"),
		AcledOauthUsername:              optionalStringField(v, members.last("acledOauthUsername"), "acledOauthUsername"),
		AcledOauthPassword:              optionalStringField(v, members.last("acledOauthPassword"), "acledOauthPassword"),
		AcledOauthClientID:              optionalStringField(v, members.last("acledOauthClientId"), "acledOauthClientId"),
		CloudflareAPIToken:              optionalStringField(v, members.last("cloudflareApiToken"), "cloudflareApiToken"),
		WingbitsAPIKey:                  optionalStringField(v, members.last("wingbitsApiKey"), "wingbitsApiKey"),
		PolymarketProxyURL:              optionalStringField(v, members.last("polymarketProxyUrl"), "polymarketProxyUrl"),
	}
	if err := v.err(); err != nil {
		return nil, err
	}
	return update, nil
}

// ---- archive_preparation_settings DTO ----

// archiveAllowedFields is the whitelist of
// UpdateArchivePreparationSettingsDto.
var archiveAllowedFields = map[string]bool{
	"jobBatchSize":            true,
	"embeddingBatchSize":      true,
	"embeddingMaxConcurrency": true,
	"rerankMaxConcurrency":    true,
}

// archivePreparationUpdate is the validated full replacement.
type archivePreparationUpdate struct {
	JobBatchSize            int
	EmbeddingBatchSize      int
	EmbeddingMaxConcurrency int
	RerankMaxConcurrency    int
}

// parseArchivePreparationUpdate reproduces the ValidationPipe result for
// UpdateArchivePreparationSettingsDto.
//
// This DTO is the opposite of the realtime one: every field is required and
// carries @Type(() => Number), so class-transformer runs Number() over the raw
// member BEFORE validation. Number("") is 0 and Number("50") is 50, while an
// explicit null is returned unchanged by class-transformer's null guard (it is
// NOT turned into 0), and an array/object member stays a non-number. The
// validators then see those values, which is why a numeric string passes here but
// not on the realtime DTO.
func parseArchivePreparationUpdate(body []byte) (*archivePreparationUpdate, error) {
	members, err := decodeBodyMembers(body)
	if err != nil {
		return nil, err
	}
	v := &validationErrors{}
	rejectUnknown(v, members, archiveAllowedFields)
	update := &archivePreparationUpdate{
		JobBatchSize:            typedIntField(v, members.last("jobBatchSize"), "jobBatchSize", 1, 100),
		EmbeddingBatchSize:      typedIntField(v, members.last("embeddingBatchSize"), "embeddingBatchSize", 1, 100),
		EmbeddingMaxConcurrency: typedIntField(v, members.last("embeddingMaxConcurrency"), "embeddingMaxConcurrency", 1, 8),
		RerankMaxConcurrency:    typedIntField(v, members.last("rerankMaxConcurrency"), "rerankMaxConcurrency", 1, 8),
	}
	if err := v.err(); err != nil {
		return nil, err
	}
	return update, nil
}

// typedIntField validates one @Type(() => Number) @IsInt() @Min(min) @Max(max)
// property. Message order is Max, Min, IsInt.
func typedIntField(v *validationErrors, raw json.RawMessage, field string, min, max int) int {
	value, ok := classTransformerNumber(raw)
	maxOK := ok && !math.IsNaN(value) && value <= float64(max)
	minOK := ok && !math.IsNaN(value) && value >= float64(min)
	intOK := ok && jsIsInteger(value)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
	}
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	if !intOK {
		v.add(field + " must be an integer number")
	}
	if !maxOK || !minOK || !intOK {
		return min
	}
	return int(value)
}

// classTransformerNumber mirrors what `@Type(() => Number)` produces for one
// member, including the class-transformer null/undefined guard and the array
// branch (an array member becomes an array of numbers, never a number).
//
// ok reports whether the transformed value is a JavaScript number; the value is
// only meaningful when ok is true.
func classTransformerNumber(raw json.RawMessage) (float64, bool) {
	if raw == nil {
		// Absent: class-transformer never assigns, so the class field keeps
		// undefined, which is not a number.
		return 0, false
	}
	trimmed := bytes.TrimSpace(raw)
	if isNullRaw(raw) {
		// `if (value === null || value === undefined) return value;`
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		text, ok := decodeJSONString(trimmed)
		if !ok {
			return math.NaN(), true
		}
		return jsStringToNumber(text), true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case '[':
		// The array branch maps each element through Number() and returns an
		// array, which is never typeof "number".
		return math.NaN(), false
	case '{':
		return math.NaN(), false
	default:
		return jsonNumberValue(trimmed)
	}
}

// ---- geo_nominatim_identity DTO ----

// nominatimAllowedFields is the whitelist of UpdateGeoNominatimSettingsDto.
var nominatimAllowedFields = map[string]bool{
	"userAgent": true,
	"email":     true,
}

// nominatimUpdate is the validated partial update.
type nominatimUpdate struct {
	UserAgent optionalString
	Email     optionalString
}

// parseNominatimUpdate reproduces the ValidationPipe result for
// UpdateGeoNominatimSettingsDto. Both members are optional and nullable; the
// distinction between an absent member (keep the override) and null (clear it)
// survives into the merge.
func parseNominatimUpdate(body []byte) (*nominatimUpdate, error) {
	members, err := decodeBodyMembers(body)
	if err != nil {
		return nil, err
	}
	v := &validationErrors{}
	rejectUnknown(v, members, nominatimAllowedFields)
	update := &nominatimUpdate{
		UserAgent: geoNamesStringField(v, members.last("userAgent"), "userAgent"),
		Email:     geoEmailField(v, members.last("email"), "email"),
	}
	if err := v.err(); err != nil {
		return nil, err
	}
	return update, nil
}

// ---- email validation (validator.js default options) ----

// The four regular expressions below are direct ports of validator.js
// isEmail/isFQDN patterns (see the vendor sources for validator 13.x). They are
// declared once so the quoted/unquoted local-part rules stay identical.
var (
	// emailUserUTF8PartRe is validator.js `emailUserUtf8Part` (allow_utf8_local_part
	// defaults to true).
	emailUserUTF8PartRe = regexp.MustCompile("(?i)^[a-z\\d!#$%&'*+\\-/=?^_`{|}~\\x{00A1}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]+$")
	// quotedEmailUserRe is validator.js `quotedEmailUserUtf8`.
	quotedEmailUserRe = regexp.MustCompile("(?i)^([\\s\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\x21-\\x5b\\x5d-\\x7e\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]|(\\\\[\\x01-\\x09\\x0b\\x0c\\x0d-\\x7f\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]))*$")
	// fqdnTLDRe is the TLD branch of validator.js isFQDN with require_tld=true and
	// allow_numeric_tld=false (a numeric TLD never matches).
	fqdnTLDRe = regexp.MustCompile("(?i)^([a-z\\x{00A1}-\\x{00A8}\\x{00AA}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$")
	// fqdnPartRe is validator.js isFQDN's per-label pattern.
	fqdnPartRe = regexp.MustCompile("(?i)^[a-z_\\x{00A1}-\\x{FFFF}0-9-]+$")
	// fullWidthRe rejects the full-width character block.
	fullWidthRe = regexp.MustCompile("[\\x{FF01}-\\x{FF5E}]")
)

// validatorIsEmail mirrors validator.js isEmail with class-validator's default
// options: allow_utf8_local_part=true, require_tld=true,
// allow_underscores=false, ignore_max_length=false, no display names, no quoted
// local parts special-casing beyond the quoted form, no IP-literal domains.
//
// The port covers the rules that decide ordinary addresses: the 254 byte limit,
// the 64 byte local part, the FQDN domain shape (at least one dot, each label
// 1..63 characters of [A-Za-z0-9_-] with no leading/trailing hyphen and no
// underscore, a non-numeric alphabetic TLD of two or more characters) and the
// local-part character set. Exotic forms (quoted local parts with escaped
// controls, punycode TLD variants, IP-literal domains) are accepted only when
// they also satisfy those rules.
func validatorIsEmail(value string) bool {
	if len(value) > 254 {
		return false
	}
	at := strings.LastIndex(value, "@")
	if at < 0 {
		// split('@') with no separator leaves domain = value and user = "".
		return validatorIsFQDN(value)
	}
	user := value[:at]
	domain := value[at+1:]
	if len([]byte(user)) == 0 || len([]byte(user)) > 64 {
		return false
	}
	if len([]byte(domain)) == 0 || len([]byte(domain)) > 254 {
		return false
	}
	if !validatorIsFQDN(domain) {
		return false
	}
	if strings.HasPrefix(user, `"`) && strings.HasSuffix(user, `"`) && len(user) >= 2 {
		return quotedEmailUserRe.MatchString(user[1 : len(user)-1])
	}
	for _, part := range strings.Split(user, ".") {
		if part == "" || !emailUserUTF8PartRe.MatchString(part) {
			return false
		}
	}
	return true
}

// validatorIsFQDN mirrors validator.js isFQDN with require_tld=true,
// allow_underscores=false, allow_numeric_tld=false, allow_trailing_dot=false.
func validatorIsFQDN(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	tld := parts[len(parts)-1]
	if !fqdnTLDRe.MatchString(tld) {
		return false
	}
	if strings.ContainsAny(tld, " \t\n\r\f\v") {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 63 {
			return false
		}
		if !fqdnPartRe.MatchString(part) {
			return false
		}
		if fullWidthRe.MatchString(part) {
			return false
		}
		if strings.HasPrefix(part, "-") || strings.HasSuffix(part, "-") {
			return false
		}
		if strings.Contains(part, "_") {
			return false
		}
	}
	return true
}
