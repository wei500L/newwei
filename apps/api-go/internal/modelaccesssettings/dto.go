package modelaccesssettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// This file reproduces the three request DTOs and the class-validator behaviour
// the NestJS ValidationPipe applies to them:
//
//   - every message is the class-validator default message, verbatim;
//   - a property's constraints are evaluated independently (no stop-at-first),
//     in the order the decorators were applied (bottom-up, so the decorator
//     written closest to the property runs first);
//   - properties are reported in declaration order and the messages are joined
//     with "; " by GlobalExceptionFilter;
//   - unknown properties are reported FIRST, in request-body order, because
//     ValidationExecutor.whitelist runs before the per-property validations;
//   - there is no implicit type coercion: "100" is not 100 and "true" is not
//     true (the DTOs carry no @Type and no @Transform).

// validationErrors accumulates class-validator style messages.
type validationErrors struct {
	messages []string
}

// add appends one message.
func (v *validationErrors) add(message string) {
	v.messages = append(v.messages, message)
}

// mark records the current message count so a field validator can decide whether
// its property produced any message.
func (v *validationErrors) mark() int {
	return len(v.messages)
}

// failedSince reports whether at least one message was added after mark.
func (v *validationErrors) failedSince(mark int) bool {
	return len(v.messages) > mark
}

// err converts the collected messages into the 400 the client sees.
func (v *validationErrors) err() error {
	if len(v.messages) == 0 {
		return nil
	}
	return &httpError{status: 400, message: strings.Join(v.messages, "; ")}
}

// jsonMember is one top-level body member in document order.
type jsonMember struct {
	Name string
	Raw  json.RawMessage
}

// bodyShape classifies the decoded JSON body the way the ValidationPipe does.
type bodyShape int

const (
	// bodyShapeObject is a JSON object, the shape of every documented request.
	bodyShapeObject bodyShape = iota
	// bodyShapeArray is a JSON array. class-transformer mutates its constructor
	// to the DTO class, so the DTO's metadata applies and every index is an
	// unknown property.
	bodyShapeArray
	// bodyShapeNull is the JSON literal null; toEmptyIfNil turns it into {}.
	bodyShapeNull
	// bodyShapePrimitive is a string/number/boolean body. The pipe replaces the
	// validation target with `{ constructor: Dto }`, so it validates exactly like
	// an empty object.
	bodyShapePrimitive
)

// classification is one decoded body: its shape plus the members (or array
// indices) in document order.
type classification struct {
	Shape   bodyShape
	Members []jsonMember
}

// classifyRequestBody decodes a validated JSON body into a shape and an ordered
// member list. Duplicate keys keep the position of the first occurrence and the
// value of the last one, exactly like JSON.parse followed by Object.keys.
func classifyRequestBody(body []byte) (classification, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return classification{Shape: bodyShapeNull}, nil
	}
	switch trimmed[0] {
	case '{':
		members, err := decodeOrderedObject(trimmed)
		if err != nil {
			return classification{}, err
		}
		return classification{Shape: bodyShapeObject, Members: members}, nil
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return classification{}, err
		}
		members := make([]jsonMember, 0, len(items))
		for index, item := range items {
			members = append(members, jsonMember{Name: strconv.Itoa(index), Raw: item})
		}
		return classification{Shape: bodyShapeArray, Members: members}, nil
	default:
		return classification{Shape: bodyShapePrimitive}, nil
	}
}

// decodeOrderedObject reads the top-level members of a JSON object in document
// order. encoding/json exposes no ordered object type, so the token stream is
// scanned directly; values are still captured as raw JSON and immediately
// validated into typed request structs.
func decodeOrderedObject(body []byte) ([]jsonMember, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, errors.New("modelaccesssettings: body is not a json object")
	}
	members := make([]jsonMember, 0, 8)
	position := make(map[string]int, 8)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		name, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("modelaccesssettings: body key is not a string")
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, err
		}
		if index, seen := position[name]; seen {
			// JSON.parse keeps the position of the first occurrence and the value
			// of the last one.
			members[index].Raw = raw
			continue
		}
		position[name] = len(members)
		members = append(members, jsonMember{Name: name, Raw: raw})
	}
	if _, err := decoder.Token(); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return members, nil
}

// member looks up a decoded member and reports whether the key was present.
func member(members []jsonMember, name string) (json.RawMessage, bool) {
	for _, entry := range members {
		if entry.Name == name {
			return entry.Raw, true
		}
	}
	return nil, false
}

// unknownPropertyMessages reproduces ValidationExecutor.whitelist: every body
// member without validation metadata is reported, in body order, BEFORE the
// per-property messages. `__proto__` is excluded because the ValidationPipe's
// stripProtoKeys deletes it first.
func unknownPropertyMessages(members []jsonMember, allowed []string) []string {
	allowedSet := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = true
	}
	var messages []string
	for _, entry := range members {
		if entry.Name == "__proto__" {
			continue
		}
		if allowedSet[entry.Name] {
			continue
		}
		messages = append(messages, "property "+entry.Name+" should not exist")
	}
	return messages
}

// optionalStringKind distinguishes the three states of an @IsOptional()
// @IsString() property. Absent and null must not be conflated: a PUT that omits
// internalToken keeps the stored secret, while null clears it.
type optionalStringKind int

const (
	// optionalStringAbsent means the JSON key was not present.
	optionalStringAbsent optionalStringKind = iota
	// optionalStringNull means the key was present with the value null.
	optionalStringNull
	// optionalStringValue means the key was a JSON string.
	optionalStringValue
)

// optionalString is the presence-aware value of an optional string property.
type optionalString struct {
	Kind  optionalStringKind
	Value string
}

// parseBoolField validates a required @IsBoolean() property.
func parseBoolField(v *validationErrors, members []jsonMember, field string) (bool, bool) {
	raw, present := member(members, field)
	if present {
		trimmed := bytes.TrimSpace(raw)
		if bytes.Equal(trimmed, []byte("true")) {
			return true, true
		}
		if bytes.Equal(trimmed, []byte("false")) {
			return false, true
		}
	}
	v.add(field + " must be a boolean value")
	return false, false
}

// parseOptionalStringField validates an @IsOptional() @IsString() property:
// absent and null both pass without a message.
func parseOptionalStringField(v *validationErrors, members []jsonMember, field string) (optionalString, bool) {
	raw, present := member(members, field)
	if !present {
		return optionalString{Kind: optionalStringAbsent}, true
	}
	if jsonIsNull(raw) {
		return optionalString{Kind: optionalStringNull}, true
	}
	if text, ok := jsonString(raw); ok {
		return optionalString{Kind: optionalStringValue, Value: text}, true
	}
	v.add(field + " must be a string")
	return optionalString{Kind: optionalStringValue}, false
}

// intConstraintKind is one @IsInt/@Min/@Max constraint.
type intConstraintKind int

const (
	// intConstraintIsInt is @IsInt().
	intConstraintIsInt intConstraintKind = iota
	// intConstraintMin is @Min(bound).
	intConstraintMin
	// intConstraintMax is @Max(bound).
	intConstraintMax
)

// intConstraint is one ordered integer constraint.
type intConstraint struct {
	Kind  intConstraintKind
	Bound int
}

// parseNumberToken parses a JSON number token, keeping ±Inf for values that
// overflow float64 (JSON.parse("1e999") is Infinity in JavaScript).
func parseNumberToken(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if !jsonIsNumber(trimmed) {
		return math.NaN(), false
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

// parseIntConstraints evaluates an ordered constraint list independently, like
// class-validator does.
func parseIntConstraints(
	v *validationErrors,
	members []jsonMember,
	field string,
	constraints []intConstraint,
) (int, bool) {
	mark := v.mark()
	raw, present := member(members, field)
	value := math.NaN()
	isNumber := false
	if present {
		value, isNumber = parseNumberToken(raw)
	}
	for _, constraint := range constraints {
		switch constraint.Kind {
		case intConstraintIsInt:
			if !(isNumber && jsIsInteger(value)) {
				v.add(field + " must be an integer number")
			}
		case intConstraintMin:
			if !(isNumber && value >= float64(constraint.Bound)) {
				v.add(fmt.Sprintf("%s must not be less than %d", field, constraint.Bound))
			}
		case intConstraintMax:
			if !(isNumber && value <= float64(constraint.Bound)) {
				v.add(fmt.Sprintf("%s must not be greater than %d", field, constraint.Bound))
			}
		}
	}
	if v.failedSince(mark) {
		return 0, false
	}
	return int(value), true
}

// parseStringArrayListField validates
// @IsArray() @ArrayMaxSize(maxItems) @IsString({ each: true }).
//
// The decorator closest to the property is @IsString({ each: true }), so the
// "each value in ..." message comes first, then the size message, then
// "must be an array" — each constraint evaluated independently.
//
// class-validator applies an `each` validator to the value itself when the value
// is not an array (or Set/Map), which is why a number, null or an object reports
// the "each value in" message too.
func parseStringArrayListField(
	v *validationErrors,
	members []jsonMember,
	field string,
	maxItems int,
) ([]string, bool) {
	mark := v.mark()
	raw, present := member(members, field)

	items := []json.RawMessage(nil)
	isArray := false
	decoded := []string(nil)
	if present {
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) > 0 && trimmed[0] == '[' {
			if err := json.Unmarshal(trimmed, &items); err == nil {
				isArray = true
				decoded = make([]string, 0, len(items))
				for _, item := range items {
					text, ok := jsonString(item)
					if !ok {
						decoded = nil
						break
					}
					decoded = append(decoded, text)
				}
			}
		}
	}

	// @IsString({ each: true })
	if isArray {
		if decoded == nil {
			v.add("each value in " + field + " must be a string")
		}
	} else if !jsonIsString(raw) {
		v.add("each value in " + field + " must be a string")
	}

	// @ArrayMaxSize(maxItems)
	if !isArray || len(items) > maxItems {
		v.add(fmt.Sprintf("%s must contain no more than %d elements", field, maxItems))
	}

	// @IsArray()
	if !isArray {
		v.add(field + " must be an array")
	}

	if v.failedSince(mark) {
		return nil, false
	}
	if decoded == nil {
		decoded = []string{}
	}
	return decoded, true
}

// parseEnumField validates @IsString() @IsIn(allowed). @IsIn sits closest to the
// property, so its message comes first.
func parseEnumField(
	v *validationErrors,
	members []jsonMember,
	field string,
	allowed []string,
) (string, bool) {
	mark := v.mark()
	raw, present := member(members, field)

	matched := false
	text := ""
	if present {
		if decoded, ok := jsonString(raw); ok {
			text = decoded
			for _, candidate := range allowed {
				if decoded == candidate {
					matched = true
					break
				}
			}
		}
	}
	if !matched {
		v.add(fmt.Sprintf("%s must be one of the following values: %s", field, strings.Join(allowed, ", ")))
	}
	if !jsonIsString(raw) {
		v.add(field + " must be a string")
	}
	if v.failedSince(mark) {
		return "", false
	}
	return text, true
}

// updateModelServiceSettingsRequest is the validated UpdateModelServiceSettingsDto.
type updateModelServiceSettingsRequest struct {
	Enabled       bool
	BaseURL       optionalString
	InternalToken optionalString
	TimeoutMs     int
	MaxRetries    int
}

// modelServiceRequestFields lists the DTO's declared properties: they are the
// only body members with validation metadata.
var modelServiceRequestFields = []string{"enabled", "baseUrl", "internalToken", "timeoutMs", "maxRetries"}

// TimeoutMs constraint order: @IsInt() @Min(100) applied bottom-up is Min, IsInt.
// There is no upper bound on timeoutMs.
var modelServiceTimeoutConstraints = []intConstraint{
	{Kind: intConstraintMin, Bound: 100},
	{Kind: intConstraintIsInt},
}

// MaxRetries constraint order: @IsInt() @Min(0) @Max(10) applied bottom-up is
// Max, Min, IsInt.
var modelServiceMaxRetriesConstraints = []intConstraint{
	{Kind: intConstraintMax, Bound: 10},
	{Kind: intConstraintMin, Bound: 0},
	{Kind: intConstraintIsInt},
}

// parseUpdateModelServiceSettingsRequest validates a PUT body against the model
// service DTO. The returned messages are already "; " joined in the contract
// order.
func parseUpdateModelServiceSettingsRequest(body []byte) (updateModelServiceSettingsRequest, error) {
	classified, err := classifyRequestBody(body)
	if err != nil {
		return updateModelServiceSettingsRequest{}, &httpError{status: 400, message: "Invalid request body"}
	}
	v := &validationErrors{}
	for _, message := range unknownPropertyMessages(classified.Members, modelServiceRequestFields) {
		v.add(message)
	}

	var request updateModelServiceSettingsRequest
	// Declaration order: enabled, baseUrl, internalToken, timeoutMs, maxRetries.
	request.Enabled, _ = parseBoolField(v, classified.Members, "enabled")
	request.BaseURL, _ = parseOptionalStringField(v, classified.Members, "baseUrl")
	request.InternalToken, _ = parseOptionalStringField(v, classified.Members, "internalToken")
	request.TimeoutMs, _ = parseIntConstraints(v, classified.Members, "timeoutMs", modelServiceTimeoutConstraints)
	request.MaxRetries, _ = parseIntConstraints(v, classified.Members, "maxRetries", modelServiceMaxRetriesConstraints)

	if err := v.err(); err != nil {
		return updateModelServiceSettingsRequest{}, err
	}
	return request, nil
}

// updateOpenAiKeysSettingsRequest is the validated UpdateOpenAiKeysSettingsDto.
type updateOpenAiKeysSettingsRequest struct {
	Keys []string
}

// openAiKeysRequestFields lists the DTO's declared properties.
var openAiKeysRequestFields = []string{"keys"}

// parseUpdateOpenAiKeysSettingsRequest validates a PUT/POST body against the
// OpenAI keys DTO. An empty array is valid; empty strings and duplicates pass the
// DTO and are normalized by the business layer afterwards.
func parseUpdateOpenAiKeysSettingsRequest(body []byte) (updateOpenAiKeysSettingsRequest, error) {
	classified, err := classifyRequestBody(body)
	if err != nil {
		return updateOpenAiKeysSettingsRequest{}, &httpError{status: 400, message: "Invalid request body"}
	}
	v := &validationErrors{}
	for _, message := range unknownPropertyMessages(classified.Members, openAiKeysRequestFields) {
		v.add(message)
	}
	keys, _ := parseStringArrayListField(v, classified.Members, "keys", maxOpenAiApiKeys)
	if err := v.err(); err != nil {
		return updateOpenAiKeysSettingsRequest{}, err
	}
	return updateOpenAiKeysSettingsRequest{Keys: keys}, nil
}

// reportAppliedRequest is the validated ReportLiteLlmOpenAiKeysAppliedDto.
type reportAppliedRequest struct {
	Source          appliedSource
	KeyFingerprints []string
}

// appliedRequestFields lists the DTO's declared properties.
var appliedRequestFields = []string{"source", "keyFingerprints"}

// appliedSourceValues is the @IsIn allow-list, in DTO order.
var appliedSourceValues = []string{"db", "env", "none"}

// parseReportAppliedRequest validates the route 10 body. The internal token
// guard always runs before this parser.
func parseReportAppliedRequest(body []byte) (reportAppliedRequest, error) {
	classified, err := classifyRequestBody(body)
	if err != nil {
		return reportAppliedRequest{}, &httpError{status: 400, message: "Invalid request body"}
	}
	v := &validationErrors{}
	for _, message := range unknownPropertyMessages(classified.Members, appliedRequestFields) {
		v.add(message)
	}
	// Declaration order: source, keyFingerprints.
	source, _ := parseEnumField(v, classified.Members, "source", appliedSourceValues)
	fingerprints, _ := parseStringArrayListField(v, classified.Members, "keyFingerprints", maxOpenAiApiKeys)
	if err := v.err(); err != nil {
		return reportAppliedRequest{}, err
	}
	applied, _ := validAppliedSource(source)
	return reportAppliedRequest{Source: applied, KeyFingerprints: fingerprints}, nil
}
