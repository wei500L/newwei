package llmgatewayprofiles

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// This file reproduces the NestJS ValidationPipe behaviour for the LLM gateway
// DTOs: whitelist + forbidNonWhitelisted + transform without implicit
// conversion. Every optional field is decoded from a raw JSON token so one wrong
// type never aborts the whole body, and each constraint emits the exact
// class-validator message in the exact order the library produces.
//
// Ordering rules verified against class-validator 0.14.2 sources:
//   - the whitelist pass runs before the property loop, so unknown-property
//     messages come first, in body key order;
//   - properties are visited in class-body declaration order;
//   - for one property the constraints are registered bottom-up (TypeScript
//     applies decorators from the property upwards), so the LAST declared
//     decorator produces the FIRST message. For @IsInt/@Min/@Max that gives
//     max, min, isInt; for @IsArray/@ArrayMaxSize/@IsString({each}) it gives
//     each, arrayMaxSize, isArray; for @IsString/@IsIn it gives isIn, isString.

// DTO constraints, mirroring apps/api/src/modules/system-settings/dto/llm-gateway.dto.ts.
const (
	maxModelListSize  = 20
	minTimeoutMs      = 1_000
	maxTimeoutMs      = 900_000
	maxTemperature    = 2
	maxTopP           = 1
	minOutputTokens   = 1
	maxOutputTokens   = 1_000_000
	minRetries        = 1
	maxRetries        = 20
	minPositiveNumber = 0
)

// profileFieldOrder is the DTO declaration order shared by the create and the
// update DTO.
var profileFieldOrder = []string{
	"name",
	"apiBase",
	"apiKey",
	"model",
	"embeddingModel",
	"rerankModel",
	"rerankFallbackModels",
	"assistantModel",
	"assistantWebSearchEnabled",
	"apiSurface",
	"timeoutMs",
	"temperature",
	"topP",
	"maxOutputTokens",
	"maxRetries",
	"fallbackModels",
	"sendMetadata",
	"responseFormatMode",
	"enabled",
}

// apiSurfaceValues is the @IsIn allowlist for apiSurface.
var apiSurfaceValues = []string{string(APISurfaceChatCompletions), string(APISurfaceResponses)}

// responseFormatModeValues is the @IsIn allowlist for responseFormatMode.
var responseFormatModeValues = []string{
	string(ResponseFormatJSONSchema),
	string(ResponseFormatJSONObject),
	string(ResponseFormatNone),
}

// activationModeValues is the @IsIn allowlist shared by the embedding and rerank
// activation DTOs.
var activationModeValues = []string{
	string(EmbeddingModeFollowCompletion),
	string(EmbeddingModeUseDefault),
}

// errUnknownValue is what class-validator reports when the validated target
// carries no metadata at all (a non-object body).
var errUnknownValue = badRequest("an unknown value was passed to the validate function")

// errNotJSONObject reports a body that is not a JSON object.
var errNotJSONObject = errors.New("llmgatewayprofiles: body is not a JSON object")

// objectField is one top-level body key in document order.
type objectField struct {
	Key   string
	Value json.RawMessage
}

// decodeObjectFields decodes one JSON object preserving key order and collapsing
// duplicate keys the way a JavaScript object literal does (first position kept,
// last value wins). The decoder token is narrowed to a concrete json.Delim
// immediately; no weak container escapes this function.
func decodeObjectFields(raw json.RawMessage) ([]objectField, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errNotJSONObject
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, errNotJSONObject
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, errNotJSONObject
	}
	fields := make([]objectField, 0, len(profileFieldOrder))
	positions := make(map[string]int, len(profileFieldOrder))
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errNotJSONObject
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errNotJSONObject
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errNotJSONObject
		}
		if index, seen := positions[key]; seen {
			fields[index].Value = value
			continue
		}
		positions[key] = len(fields)
		fields = append(fields, objectField{Key: key, Value: value})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errNotJSONObject
	}
	return fields, nil
}

// fieldValue returns one field token by key.
func fieldValue(fields []objectField, key string) (json.RawMessage, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field.Value, true
		}
	}
	return nil, false
}

// validationErrors accumulates class-validator style messages.
type validationErrors struct {
	messages []string
}

// add appends one message.
func (v *validationErrors) add(message string) {
	v.messages = append(v.messages, message)
}

// empty reports whether nothing was collected.
func (v *validationErrors) empty() bool { return len(v.messages) == 0 }

// err turns the collected messages into the 400 the client sees;
// GlobalExceptionFilter joins the array with "; ".
func (v *validationErrors) err() error {
	if v.empty() {
		return nil
	}
	return badRequest(strings.Join(v.messages, "; "))
}

// isJSONNumberToken reports whether the raw token is a JSON number. Neither
// @IsInt nor @Min/@Max coerce strings, so the distinction is load-bearing.
func isJSONNumberToken(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	return trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9')
}

// stringInList reports membership in one allowlist.
func stringInList(value string, allowed []string) bool {
	for _, candidate := range allowed {
		if candidate == value {
			return true
		}
	}
	return false
}

// validateStringField mirrors @IsString for an optional or required property.
// It returns the string value (nil when absent/null/invalid) and whether the key
// was present at all.
func validateStringField(problems *validationErrors, raw json.RawMessage, field string, required bool) (*string, bool) {
	if !present(raw) {
		if required {
			problems.add(field + " must be a string")
		}
		return nil, false
	}
	if isJSONNull(raw) {
		if required {
			problems.add(field + " must be a string")
		}
		return nil, true
	}
	value, ok := jsString(raw)
	if !ok {
		problems.add(field + " must be a string")
		return nil, true
	}
	return &value, true
}

// validateURLField mirrors @IsUrl({require_protocol:true, require_tld:false}).
func validateURLField(problems *validationErrors, raw json.RawMessage, field string, required bool) (*string, bool) {
	if !present(raw) {
		if required {
			problems.add(field + " must be a URL address")
		}
		return nil, false
	}
	if isJSONNull(raw) {
		if required {
			problems.add(field + " must be a URL address")
		}
		return nil, true
	}
	value, ok := jsString(raw)
	if !ok || !validatorIsURL(value) {
		problems.add(field + " must be a URL address")
		return nil, true
	}
	return &value, true
}

// validateBooleanField mirrors @IsBoolean. An explicit null is left to the
// service layer (the historical nullable-boolean behaviour).
func validateBooleanField(problems *validationErrors, raw json.RawMessage, field string) (*bool, bool) {
	if !present(raw) {
		return nil, false
	}
	if isJSONNull(raw) {
		return nil, true
	}
	value, ok := jsBool(raw)
	if !ok {
		problems.add(field + " must be a boolean value")
		return nil, true
	}
	return &value, true
}

// validateEnumField mirrors @IsIn.
func validateEnumField(problems *validationErrors, raw json.RawMessage, field string, allowed []string) (*string, bool) {
	if !present(raw) || isJSONNull(raw) {
		return nil, present(raw)
	}
	value, ok := jsString(raw)
	if !ok || !stringInList(value, allowed) {
		problems.add(field + " must be one of the following values: " + strings.Join(allowed, ", "))
		return nil, true
	}
	return &value, true
}

// validateActivationModeField mirrors the embedding/rerank mode property, whose
// @IsIn was declared after @IsString, so the enum message comes first.
func validateActivationModeField(problems *validationErrors, raw json.RawMessage, field string) (*string, bool) {
	if !present(raw) || isJSONNull(raw) {
		return nil, present(raw)
	}
	value, isString := jsString(raw)
	valid := isString && stringInList(value, activationModeValues)
	if !valid {
		problems.add(field + " must be one of the following values: " + strings.Join(activationModeValues, ", "))
	}
	if !isString {
		problems.add(field + " must be a string")
	}
	if !valid {
		return nil, true
	}
	return &value, true
}

// validateStringArrayField mirrors @IsArray + @ArrayMaxSize + @IsString({each}).
// It returns the decoded items (nil when the token is not an array) and whether
// the key was present.
func validateStringArrayField(problems *validationErrors, raw json.RawMessage, field string, maxSize int) ([]string, bool) {
	if !present(raw) || isJSONNull(raw) {
		return nil, present(raw)
	}
	isArray := false
	allStrings := false
	sizeOK := false
	var items []json.RawMessage
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &items); err == nil {
			isArray = true
			allStrings = true
			for _, item := range items {
				if _, ok := jsString(item); !ok {
					allStrings = false
					break
				}
			}
			sizeOK = len(items) <= maxSize
		}
	}
	if !isArray {
		// @IsString({each:true}) validates a non-array value as a single item.
		_, allStrings = jsString(raw)
	}
	if !allStrings {
		problems.add("each value in " + field + " must be a string")
	}
	if !sizeOK {
		problems.add(field + " must contain no more than " + strconv.Itoa(maxSize) + " elements")
	}
	if !isArray {
		problems.add(field + " must be an array")
	}
	if !isArray {
		return nil, true
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		value, _ := jsString(item)
		out = append(out, value)
	}
	return out, true
}

// validateIntField mirrors @IsInt + @Min + @Max and preserves the constraint
// order class-validator uses: max, min, isInt.
func validateIntField(problems *validationErrors, raw json.RawMessage, field string, min, max int) (jsNumber, bool) {
	if !present(raw) {
		return jsNumber{kind: jsNumberAbsent}, false
	}
	if isJSONNull(raw) {
		// Number(null) === 0: the service layer receives a real zero, which
		// asPositiveInt then maps back to the per-operation fallback.
		return numberJSNumber(0), true
	}
	number := parseJSNumber(raw)
	isNumber := isJSONNumberToken(raw)
	value := math.NaN()
	if isNumber && number.kind == jsNumberValue {
		value = number.value
	}
	maxOK := isNumber && value <= float64(max)
	minOK := isNumber && value >= float64(min)
	isInt := isNumber && !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value
	if !maxOK {
		problems.add(fmt.Sprintf("%s must not be greater than %d", field, max))
	}
	if !minOK {
		problems.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	if !isInt {
		problems.add(field + " must be an integer number")
	}
	return number, true
}

// validateNumberField mirrors @Min + @Max without @IsInt, preserving the
// constraint order max then min.
func validateNumberField(problems *validationErrors, raw json.RawMessage, field string, min, max float64) (jsNumber, bool) {
	if !present(raw) {
		return jsNumber{kind: jsNumberAbsent}, false
	}
	if isJSONNull(raw) {
		// Number(null) === 0 and temperature/topP are clamped, not treated as
		// absent: an explicit null therefore stores 0, exactly like NestJS.
		return numberJSNumber(0), true
	}
	number := parseJSNumber(raw)
	isNumber := isJSONNumberToken(raw)
	value := math.NaN()
	if isNumber && number.kind == jsNumberValue {
		value = number.value
	}
	maxOK := isNumber && value <= max
	minOK := isNumber && value >= min
	if !maxOK {
		problems.add(fmt.Sprintf("%s must not be greater than %s", field, formatJSNumber(max)))
	}
	if !minOK {
		problems.add(fmt.Sprintf("%s must not be less than %s", field, formatJSNumber(min)))
	}
	return number, true
}

// formatJSNumber renders a constraint bound the way the DTO message shows it
// (2, 1, 0 — never 2.0).
func formatJSNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// profileKnownFields is the whitelist used by forbidNonWhitelisted.
func profileKnownFields() map[string]bool {
	known := make(map[string]bool, len(profileFieldOrder))
	for _, name := range profileFieldOrder {
		known[name] = true
	}
	return known
}

// parseProfileInput validates one create/update body. create selects the two
// required properties (name, apiBase); every other property is optional in both
// DTOs.
func parseProfileInput(body json.RawMessage, create bool) (profileInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return profileInput{}, errUnknownValue
	}
	problems := validationErrors{}
	known := profileKnownFields()
	for _, field := range fields {
		if !known[field.Key] {
			problems.add("property " + field.Key + " should not exist")
		}
	}

	var input profileInput
	for _, name := range profileFieldOrder {
		raw, ok := fieldValue(fields, name)
		if !ok {
			raw = nil
		}
		required := create && (name == "name" || name == "apiBase")
		switch name {
		case "name":
			input.Name, _ = validateStringField(&problems, raw, name, required)
		case "apiBase":
			input.APIBase, _ = validateURLField(&problems, raw, name, required)
		case "apiKey":
			input.APIKey, input.APIKeySet = validateStringField(&problems, raw, name, false)
		case "model":
			input.Model, _ = validateStringField(&problems, raw, name, false)
		case "embeddingModel":
			input.EmbeddingModel, input.EmbeddingModelSet = validateStringField(&problems, raw, name, false)
		case "rerankModel":
			input.RerankModel, input.RerankModelSet = validateStringField(&problems, raw, name, false)
		case "rerankFallbackModels":
			input.RerankFallbackModels, input.RerankFallbackModelsSet = validateStringArrayField(&problems, raw, name, maxModelListSize)
		case "assistantModel":
			input.AssistantModel, input.AssistantModelSet = validateStringField(&problems, raw, name, false)
		case "assistantWebSearchEnabled":
			input.AssistantWebSearchEnabled, input.AssistantWebSearchEnabledSet = validateBooleanField(&problems, raw, name)
		case "apiSurface":
			value, set := validateEnumField(&problems, raw, name, apiSurfaceValues)
			input.APISurfaceSet = set
			if value != nil {
				input.APISurface = APISurface(*value)
			}
		case "timeoutMs":
			input.TimeoutMs, input.TimeoutMsSet = validateIntField(&problems, raw, name, minTimeoutMs, maxTimeoutMs)
		case "temperature":
			input.Temperature, input.TemperatureSet = validateNumberField(&problems, raw, name, minPositiveNumber, maxTemperature)
		case "topP":
			input.TopP, input.TopPSet = validateNumberField(&problems, raw, name, minPositiveNumber, maxTopP)
		case "maxOutputTokens":
			input.MaxOutputTokens, input.MaxOutputTokensSet = validateIntField(&problems, raw, name, minOutputTokens, maxOutputTokens)
		case "maxRetries":
			input.MaxRetries, input.MaxRetriesSet = validateIntField(&problems, raw, name, minRetries, maxRetries)
		case "fallbackModels":
			input.FallbackModels, input.FallbackModelsSet = validateStringArrayField(&problems, raw, name, maxModelListSize)
		case "sendMetadata":
			input.SendMetadata, input.SendMetadataSet = validateBooleanField(&problems, raw, name)
		case "responseFormatMode":
			value, set := validateEnumField(&problems, raw, name, responseFormatModeValues)
			input.ResponseFormatModeSet = set
			if value != nil {
				input.ResponseFormatMode = ResponseFormatMode(*value)
			}
		case "enabled":
			input.Enabled, input.EnabledSet = validateBooleanField(&problems, raw, name)
		}
	}
	if err := problems.err(); err != nil {
		return profileInput{}, err
	}
	return input, nil
}

// activeSelectionInput is the validated body of the three activation routes.
type activeSelectionInput struct {
	ActiveID *string
	Mode     *string
	ModeSet  bool
}

// activeSelectionKnownFields is the whitelist of one activation DTO.
func activeSelectionKnownFields(withMode bool) map[string]bool {
	known := map[string]bool{"activeId": true}
	if withMode {
		known["mode"] = true
	}
	return known
}

// parseActiveSelection validates one activation body. withMode selects the
// embedding/rerank DTOs, which declare the mode property.
func parseActiveSelection(body json.RawMessage, withMode bool) (activeSelectionInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return activeSelectionInput{}, errUnknownValue
	}
	problems := validationErrors{}
	known := activeSelectionKnownFields(withMode)
	for _, field := range fields {
		if !known[field.Key] {
			problems.add("property " + field.Key + " should not exist")
		}
	}

	var input activeSelectionInput
	if raw, ok := fieldValue(fields, "activeId"); ok {
		input.ActiveID, _ = validateStringField(&problems, raw, "activeId", false)
	}
	if withMode {
		if raw, ok := fieldValue(fields, "mode"); ok {
			input.Mode, input.ModeSet = validateActivationModeField(&problems, raw, "mode")
		}
	}
	if err := problems.err(); err != nil {
		return activeSelectionInput{}, err
	}
	return input, nil
}
