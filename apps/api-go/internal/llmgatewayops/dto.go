package llmgatewayops

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
)

// This file reproduces the NestJS ValidationPipe behaviour for the six request
// DTOs of this batch: whitelist + forbidNonWhitelisted + transform. Every
// optional field is decoded from a raw JSON token so one wrong type never aborts
// the whole body, and each constraint emits the exact class-validator message in
// the order the library produces.
//
// Ordering rules verified against class-validator 0.14.2:
//   - the whitelist pass runs before the property loop, so unknown-property
//     messages come first, in body key order;
//   - properties are visited in class-body declaration order;
//   - decorators apply bottom-up, so the LAST declared decorator produces the
//     FIRST message. For @IsInt/@Min/@Max that gives max, min, isInt.

// DTO limits, mirroring the NestJS DTO files.
const (
	maxModelLength        = 256
	maxInputLength        = 4_000
	maxRerankDocuments    = 20
	maxModelListSize      = 20
	minTimeoutMs          = 1_000
	maxTimeoutMs          = 900_000
	minTemperature        = 0
	maxTemperatureValue   = 2
	minTopP               = 0
	maxTopPValue          = 1
	minOutputTokens       = 1
	maxOutputTokensValue  = 1_000_000
	minLBAttempts         = 1
	maxLBAttempts         = 50
	minLBConcurrency      = 1
	maxLBConcurrency      = 10
	maxBudgetRequestValue = 1_000_000
	minBudgetRequestValue = 0
	minParallelRequest    = 1
	maxParallelRequest    = 1_024
)

// errNotJSONObject reports a body that is not a JSON object.
var errNotJSONObject = errors.New("llmgatewayops: body is not a JSON object")

// authModeValues is the @IsIn allowlist for authMode.
var authModeValues = []string{"profile_key", "managed_runtime_key"}

// apiSurfaceValues is the @IsIn allowlist for apiSurface.
var apiSurfaceValues = []string{"chat_completions", "responses"}

// responseFormatModeValues is the @IsIn allowlist for responseFormatMode.
var responseFormatModeValues = []string{"none", "json_object", "json_schema"}

// objectField is one top-level body key in document order.
type objectField struct {
	Key   string
	Value json.RawMessage
}

// decodeObjectFields decodes one JSON object preserving key order and collapsing
// duplicate keys the way a JavaScript object literal does (first position kept,
// last value wins).
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
	fields := make([]objectField, 0, 8)
	positions := make(map[string]int, 8)
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

// err turns the collected messages into the 400 the client sees;
// GlobalExceptionFilter joins the array with "; ".
func (v *validationErrors) err() error {
	if len(v.messages) == 0 {
		return nil
	}
	return badRequest(strings.Join(v.messages, "; "))
}

// rejectUnknownKeys runs the forbidNonWhitelisted pass in body order.
func rejectUnknownKeys(problems *validationErrors, fields []objectField, allowed []string) {
	for _, field := range fields {
		known := false
		for _, name := range allowed {
			if field.Key == name {
				known = true
				break
			}
		}
		if !known {
			problems.add("property " + field.Key + " should not exist")
		}
	}
}

// present reports whether the key carried a token at all.
func present(raw json.RawMessage) bool { return len(raw) > 0 }

// isJSONNull reports an explicit JSON null.
func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// jsString decodes one token when it is a JSON string.
func jsString(raw json.RawMessage) (string, bool) {
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

// jsBool decodes one token when it is a JSON boolean.
func jsBool(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// formatConstraint renders a numeric constraint the way class-validator prints
// it (no trailing zeros).
func formatConstraint(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// validateStringField mirrors @IsString plus an optional @MaxLength. The messages
// are emitted maxLength-first because that decorator is declared last.
func validateStringField(problems *validationErrors, raw json.RawMessage, field string, required bool, maxLength int) *string {
	if !present(raw) {
		if required {
			problems.add(field + " must be a string")
		}
		return nil
	}
	if isJSONNull(raw) {
		if required {
			problems.add(field + " must be a string")
		}
		return nil
	}
	value, ok := jsString(raw)
	if !ok {
		if maxLength > 0 {
			problems.add(field + " must be shorter than or equal to " + strconv.Itoa(maxLength) + " characters")
		}
		problems.add(field + " must be a string")
		return nil
	}
	if maxLength > 0 && jsLength(value) > maxLength {
		problems.add(field + " must be shorter than or equal to " + strconv.Itoa(maxLength) + " characters")
		return nil
	}
	return &value
}

// validateBooleanField mirrors @IsBoolean.
func validateBooleanField(problems *validationErrors, raw json.RawMessage, field string) *bool {
	if !present(raw) || isJSONNull(raw) {
		return nil
	}
	value, ok := jsBool(raw)
	if !ok {
		problems.add(field + " must be a boolean value")
		return nil
	}
	return &value
}

// validateEnumField mirrors @IsIn for an optional string property.
func validateEnumField(problems *validationErrors, raw json.RawMessage, field string, allowed []string) *string {
	if !present(raw) || isJSONNull(raw) {
		return nil
	}
	value, ok := jsString(raw)
	if !ok {
		problems.add(field + " must be one of the following values: " + strings.Join(allowed, ", "))
		return nil
	}
	for _, candidate := range allowed {
		if candidate == value {
			return &value
		}
	}
	problems.add(field + " must be one of the following values: " + strings.Join(allowed, ", "))
	return nil
}

// validateURLFieldRequired mirrors @IsUrl({require_protocol:true,
// require_tld:false}) on a required property.
func validateURLFieldRequired(problems *validationErrors, raw json.RawMessage, field string) *string {
	if isJSONNull(raw) {
		problems.add(field + " must be a URL address")
		return nil
	}
	value, ok := jsString(raw)
	if !ok || !llmgatewayprofiles.ValidateAPIBaseURL(value) {
		problems.add(field + " must be a URL address")
		return nil
	}
	return &value
}

// validateStringArrayField mirrors @IsArray + @ArrayMaxSize + @IsString({each})
// + @MaxLength({each}). Message order is each, arrayMaxSize, isArray.
func validateStringArrayField(problems *validationErrors, raw json.RawMessage, field string, maxSize, maxItemLength int) []string {
	if !present(raw) || isJSONNull(raw) {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		problems.add(field + " must be an array")
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		problems.add(field + " must be an array")
		return nil
	}
	allStrings := true
	lengthOK := true
	decoded := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := jsString(item)
		if !ok {
			allStrings = false
			continue
		}
		if maxItemLength > 0 && jsLength(text) > maxItemLength {
			lengthOK = false
		}
		decoded = append(decoded, text)
	}
	// Decorators apply bottom-up, so @MaxLength({each}) is registered before
	// @IsString({each}) and its message comes first.
	if !lengthOK && maxItemLength > 0 {
		problems.add("each value in " + field + " must be shorter than or equal to " + strconv.Itoa(maxItemLength) + " characters")
	}
	if !allStrings {
		problems.add("each value in " + field + " must be a string")
	}
	if len(items) > maxSize {
		problems.add(field + " must contain no more than " + strconv.Itoa(maxSize) + " elements")
	}
	if !allStrings || !lengthOK {
		return nil
	}
	return decoded
}

// numberInput is one numeric DTO property.
type numberInput struct {
	Present bool
	Null    bool
	Value   float64
	finite  bool
}

// validateNumberField mirrors @Type(() => Number) plus @Min/@Max and an optional
// @IsInt. coerce reports whether the @Type transform runs (it does not for the
// integer fields of these DTOs, where a JSON string is a validation error).
func validateNumberField(problems *validationErrors, raw json.RawMessage, field string, min, max float64, integer, coerce bool) numberInput {
	if !present(raw) {
		return numberInput{}
	}
	if isJSONNull(raw) {
		// @IsOptional skips every constraint for an explicit null, so the
		// service receives Number(null) === 0 and applies its own clamp.
		return numberInput{Present: true, Null: true, finite: true}
	}
	value, ok := jsNumberStrict(raw, coerce)
	if !ok {
		// Number.isInteger(NaN) is false and both comparisons fail, so all three
		// messages are produced, max first.
		problems.add(field + " must not be greater than " + formatConstraint(max))
		problems.add(field + " must not be less than " + formatConstraint(min))
		if integer {
			problems.add(field + " must be an integer number")
		}
		return numberInput{Present: true}
	}
	valid := true
	if !(value <= max) {
		problems.add(field + " must not be greater than " + formatConstraint(max))
		valid = false
	}
	if !(value >= min) {
		problems.add(field + " must not be less than " + formatConstraint(min))
		valid = false
	}
	if integer && value != float64(int64(value)) {
		problems.add(field + " must be an integer number")
		valid = false
	}
	return numberInput{Present: true, Value: value, finite: valid}
}

// jsNumberStrict decodes one numeric token. When coerce is false only a JSON
// number passes; when it is true the @Type(() => Number) conversion runs.
func jsNumberStrict(raw json.RawMessage, coerce bool) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if !coerce {
		if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
			return 0, false
		}
		value, ok := jsNumber(trimmed)
		return value, ok
	}
	return jsNumber(trimmed)
}

// ---- request documents ----

// testInput is POST /:id/test after validation.
type testInput struct {
	AuthMode             *string
	IncludeCompletion    *bool
	Model                *string
	Prompt               *string
	IncludeEmbeddings    *bool
	EmbeddingModel       *string
	EmbeddingInput       *string
	IncludeRerank        *bool
	RerankModel          *string
	RerankQuery          *string
	RerankDocuments      []string
	APISurface           *string
	ResponseFormatMode   *string
	IncludeMetadataProbe *bool
}

// testInputFieldOrder is the DTO declaration order of LlmGatewayTestDto.
var testInputFieldOrder = []string{
	"authMode",
	"includeCompletion",
	"model",
	"prompt",
	"includeEmbeddings",
	"embeddingModel",
	"embeddingInput",
	"includeRerank",
	"rerankModel",
	"rerankQuery",
	"rerankDocuments",
	"apiSurface",
	"responseFormatMode",
	"includeMetadataProbe",
}

// parseTestInput validates one LlmGatewayTestDto.
func parseTestInput(body []byte) (testInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return testInput{}, unknownValueError()
	}
	var problems validationErrors
	rejectUnknownKeys(&problems, fields, testInputFieldOrder)
	var input testInput
	input.AuthMode = enumField(&problems, fields, "authMode", authModeValues)
	input.IncludeCompletion = boolField(&problems, fields, "includeCompletion")
	input.Model = stringField(&problems, fields, "model", maxModelLength)
	input.Prompt = stringField(&problems, fields, "prompt", maxInputLength)
	input.IncludeEmbeddings = boolField(&problems, fields, "includeEmbeddings")
	input.EmbeddingModel = stringField(&problems, fields, "embeddingModel", maxModelLength)
	input.EmbeddingInput = stringField(&problems, fields, "embeddingInput", maxInputLength)
	input.IncludeRerank = boolField(&problems, fields, "includeRerank")
	input.RerankModel = stringField(&problems, fields, "rerankModel", maxModelLength)
	input.RerankQuery = stringField(&problems, fields, "rerankQuery", maxInputLength)
	input.RerankDocuments = arrayField(&problems, fields, "rerankDocuments", maxRerankDocuments, maxInputLength)
	input.APISurface = enumField(&problems, fields, "apiSurface", apiSurfaceValues)
	input.ResponseFormatMode = enumField(&problems, fields, "responseFormatMode", responseFormatModeValues)
	input.IncludeMetadataProbe = boolField(&problems, fields, "includeMetadataProbe")
	if err := problems.err(); err != nil {
		return testInput{}, err
	}
	return input, nil
}

// modelsConfigInput is POST /models-config after validation.
type modelsConfigInput struct {
	ProfileID *string
	APIBase   string
	APIKeySet bool
	APIKey    string
	TimeoutMS *int
}

// modelsConfigFieldOrder is the DTO declaration order shared by
// LlmGatewayModelsConfigDto and its test-config subclass.
var modelsConfigFieldOrder = []string{"profileId", "apiBase", "apiKey", "timeoutMs"}

// parseModelsConfigInput validates one LlmGatewayModelsConfigDto.
func parseModelsConfigInput(body []byte) (modelsConfigInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return modelsConfigInput{}, unknownValueError()
	}
	var problems validationErrors
	rejectUnknownKeys(&problems, fields, modelsConfigFieldOrder)
	var input modelsConfigInput
	input.ProfileID = stringField(&problems, fields, "profileId", 0)
	apiBase := requiredURLField(&problems, fields, "apiBase")
	keySet, normalizedKey := apiKeyField(&problems, fields)
	input.APIKeySet = keySet
	input.APIKey = normalizedKey
	input.TimeoutMS = timeoutField(&problems, fields, "timeoutMs")
	if err := problems.err(); err != nil {
		return modelsConfigInput{}, err
	}
	if apiBase != nil {
		input.APIBase = *apiBase
	}
	return input, nil
}

// testConfigInput is POST /test-config after validation.
type testConfigInput struct {
	modelsConfigInput
	AuthMode             *string
	Model                *string
	IncludeCompletion    *bool
	EmbeddingModel       *string
	RerankModel          *string
	RerankFallbackModels []string
	Temperature          *float64
	TopP                 *float64
	MaxOutputTokens      *int
	FallbackModels       []string
	Prompt               *string
	IncludeEmbeddings    *bool
	EmbeddingInput       *string
	IncludeRerank        *bool
	RerankQuery          *string
	RerankDocuments      []string
	APISurface           *string
	ResponseFormatMode   *string
	IncludeMetadataProbe *bool
}

// testConfigFieldOrder is the DTO declaration order of LlmGatewayTestConfigDto.
var testConfigFieldOrder = []string{
	"profileId",
	"apiBase",
	"apiKey",
	"timeoutMs",
	"authMode",
	"model",
	"includeCompletion",
	"embeddingModel",
	"rerankModel",
	"rerankFallbackModels",
	"temperature",
	"topP",
	"maxOutputTokens",
	"fallbackModels",
	"prompt",
	"includeEmbeddings",
	"embeddingInput",
	"includeRerank",
	"rerankQuery",
	"rerankDocuments",
	"apiSurface",
	"responseFormatMode",
	"includeMetadataProbe",
}

// parseTestConfigInput validates one LlmGatewayTestConfigDto.
func parseTestConfigInput(body []byte) (testConfigInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return testConfigInput{}, unknownValueError()
	}
	var problems validationErrors
	rejectUnknownKeys(&problems, fields, testConfigFieldOrder)
	var input testConfigInput
	input.ProfileID = stringField(&problems, fields, "profileId", 0)
	apiBase := requiredURLField(&problems, fields, "apiBase")
	keySet, normalizedKey := apiKeyField(&problems, fields)
	input.APIKeySet = keySet
	input.APIKey = normalizedKey
	input.TimeoutMS = timeoutField(&problems, fields, "timeoutMs")
	input.AuthMode = enumField(&problems, fields, "authMode", authModeValues)
	// The test-config model/prompt/embeddingInput fields have no @MaxLength:
	// their saved-test counterparts cap at 4000 and unifying them would reject
	// bodies the source accepts.
	input.Model = stringField(&problems, fields, "model", 0)
	input.IncludeCompletion = boolField(&problems, fields, "includeCompletion")
	input.EmbeddingModel = stringField(&problems, fields, "embeddingModel", 0)
	input.RerankModel = stringField(&problems, fields, "rerankModel", 0)
	input.RerankFallbackModels = arrayField(&problems, fields, "rerankFallbackModels", maxModelListSize, 0)
	input.Temperature = floatField(&problems, fields, "temperature", minTemperature, maxTemperatureValue)
	input.TopP = floatField(&problems, fields, "topP", minTopP, maxTopPValue)
	input.MaxOutputTokens = intField(&problems, fields, "maxOutputTokens", minOutputTokens, maxOutputTokensValue)
	input.FallbackModels = arrayField(&problems, fields, "fallbackModels", maxModelListSize, 0)
	input.Prompt = stringField(&problems, fields, "prompt", 0)
	input.IncludeEmbeddings = boolField(&problems, fields, "includeEmbeddings")
	input.EmbeddingInput = stringField(&problems, fields, "embeddingInput", 0)
	input.IncludeRerank = boolField(&problems, fields, "includeRerank")
	input.RerankQuery = stringField(&problems, fields, "rerankQuery", maxInputLength)
	input.RerankDocuments = arrayField(&problems, fields, "rerankDocuments", maxRerankDocuments, maxInputLength)
	input.APISurface = enumField(&problems, fields, "apiSurface", apiSurfaceValues)
	input.ResponseFormatMode = enumField(&problems, fields, "responseFormatMode", responseFormatModeValues)
	input.IncludeMetadataProbe = boolField(&problems, fields, "includeMetadataProbe")
	if err := problems.err(); err != nil {
		return testConfigInput{}, err
	}
	if apiBase != nil {
		input.APIBase = *apiBase
	}
	return input, nil
}

// lbTestInput is POST /:id/proxy-lb-test after validation.
type lbTestInput struct {
	Model       *string
	Attempts    optionalNumber
	Concurrency optionalNumber
	Prompt      *string
}

// lbTestFieldOrder is the DTO declaration order of
// LlmGatewayProxyLoadBalancingTestDto.
var lbTestFieldOrder = []string{"model", "attempts", "concurrency", "prompt"}

// parseLBTestInput validates one LlmGatewayProxyLoadBalancingTestDto.
func parseLBTestInput(body []byte) (lbTestInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return lbTestInput{}, unknownValueError()
	}
	var problems validationErrors
	rejectUnknownKeys(&problems, fields, lbTestFieldOrder)
	var input lbTestInput
	input.Model = stringField(&problems, fields, "model", maxModelLength)
	input.Attempts = optionalNumberField(&problems, fields, "attempts", minLBAttempts, maxLBAttempts, false)
	input.Concurrency = optionalNumberField(&problems, fields, "concurrency", minLBConcurrency, maxLBConcurrency, false)
	input.Prompt = stringField(&problems, fields, "prompt", maxInputLength)
	if err := problems.err(); err != nil {
		return lbTestInput{}, err
	}
	return input, nil
}

// governanceUpdateFieldOrder is the DTO declaration order of
// UpdateLlmGatewayProxyGovernanceDto.
var governanceUpdateFieldOrder = []string{
	"targetProfileId",
	"enabled",
	"dailyBudgetUsd",
	"monthlyBudgetUsd",
	"maxParallelRequests",
}

// parseGovernanceUpdateInput validates one governance PUT body.
func parseGovernanceUpdateInput(body []byte) (governanceUpdateInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return governanceUpdateInput{}, unknownValueError()
	}
	var problems validationErrors
	rejectUnknownKeys(&problems, fields, governanceUpdateFieldOrder)
	var input governanceUpdateInput
	rawTarget, targetPresent := fieldValue(fields, "targetProfileId")
	if targetPresent {
		input.TargetProfileIDPresent = true
		// @IsOptional @IsString accepts null; a non-string is a validation
		// error, and a blank string is normalized to null by the service.
		input.TargetProfileID = nullableStringField(&problems, rawTarget, "targetProfileId")
	}
	rawEnabled, enabledPresent := fieldValue(fields, "enabled")
	if enabledPresent {
		input.EnabledPresent = true
		if isJSONNull(rawEnabled) {
			input.EnabledNull = true
		} else if value, ok := jsBool(rawEnabled); ok {
			input.Enabled = value
		} else {
			problems.add("enabled must be a boolean value")
		}
	}
	input.DailyBudgetUSD = budgetField(&problems, fields, "dailyBudgetUsd")
	input.MonthlyBudgetUSD = budgetField(&problems, fields, "monthlyBudgetUsd")
	input.MaxParallelRequests = optionalNumberField(&problems, fields, "maxParallelRequests", minParallelRequest, maxParallelRequest, true)
	if err := problems.err(); err != nil {
		return governanceUpdateInput{}, err
	}
	return input, nil
}

// governancePreflightInputFields is the DTO shape of the preflight body.
var governancePreflightInputFields = []string{"targetProfileId"}

// parseGovernancePreflightInput validates one preflight body.
func parseGovernancePreflightInput(body []byte) (governancePreflightInput, error) {
	fields, err := decodeObjectFields(body)
	if err != nil {
		return governancePreflightInput{}, unknownValueError()
	}
	var problems validationErrors
	rejectUnknownKeys(&problems, fields, governancePreflightInputFields)
	var input governancePreflightInput
	if raw, ok := fieldValue(fields, "targetProfileId"); ok {
		input.TargetProfileIDPresent = true
		input.TargetProfileID = nullableStringField(&problems, raw, "targetProfileId")
	}
	if err := problems.err(); err != nil {
		return governancePreflightInput{}, err
	}
	return input, nil
}

// ---- small field helpers ----

// unknownValueError is the 400 forbidUnknownValues produces for a non-object
// body.
func unknownValueError() error {
	return badRequest("an unknown value was passed to the validate function")
}

// stringField reads one optional string field.
func stringField(problems *validationErrors, fields []objectField, name string, maxLength int) *string {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return nil
	}
	return validateStringField(problems, raw, name, false, maxLength)
}

// nullableStringField reads an optional string that accepts null, then applies the
// service normalization `normalizeOptionalString(value) ?? null`: the value is
// trimmed and a blank one collapses to null. Without the trim a padded profile id
// would be looked up literally and a blank one would be persisted as "" instead of
// null.
func nullableStringField(problems *validationErrors, raw json.RawMessage, name string) *string {
	value := validateStringField(problems, raw, name, false, 0)
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// boolField reads one optional boolean field.
func boolField(problems *validationErrors, fields []objectField, name string) *bool {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return nil
	}
	return validateBooleanField(problems, raw, name)
}

// enumField reads one optional enum field.
func enumField(problems *validationErrors, fields []objectField, name string, allowed []string) *string {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return nil
	}
	return validateEnumField(problems, raw, name, allowed)
}

// arrayField reads one optional string array field.
func arrayField(problems *validationErrors, fields []objectField, name string, maxSize, maxItemLength int) []string {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return nil
	}
	return validateStringArrayField(problems, raw, name, maxSize, maxItemLength)
}

// requiredURLField reads the required apiBase field.
func requiredURLField(problems *validationErrors, fields []objectField, name string) *string {
	raw, ok := fieldValue(fields, name)
	if !ok {
		problems.add(name + " must be a URL address")
		return nil
	}
	return validateURLFieldRequired(problems, raw, name)
}

// apiKeyField reads the optional apiKey field, preserving "omitted or null"
// versus "explicit string".
func apiKeyField(problems *validationErrors, fields []objectField) (bool, string) {
	raw, ok := fieldValue(fields, "apiKey")
	if !ok {
		return false, ""
	}
	if isJSONNull(raw) {
		// @IsOptional accepts null and the service reuses the stored key.
		return false, ""
	}
	value, isString := jsString(raw)
	if !isString {
		problems.add("apiKey must be a string")
		return false, ""
	}
	return true, normalizeAPIKey(value)
}

// timeoutField reads the optional timeoutMs integer.
func timeoutField(problems *validationErrors, fields []objectField, name string) *int {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return nil
	}
	value := validateNumberField(problems, raw, name, minTimeoutMs, maxTimeoutMs, true, false)
	if !value.Present || value.Null || !value.finite {
		return nil
	}
	timeout := int(value.Value)
	return &timeout
}

// budgetField reads one @Type(() => Number) budget field.
func budgetField(problems *validationErrors, fields []objectField, name string) optionalNumber {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return optionalNumber{}
	}
	value := validateNumberField(problems, raw, name, minBudgetRequestValue, maxBudgetRequestValue, false, true)
	return optionalNumber{Present: value.Present, Null: value.Null, Value: value.Value}
}

// optionalNumberField reads one integer field. coerce reports whether the DTO has
// @Type(() => Number): governance maxParallelRequests does, the LB attempts /
// concurrency fields do NOT, so a JSON string is a validation error there.
func optionalNumberField(problems *validationErrors, fields []objectField, name string, min, max float64, coerce bool) optionalNumber {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return optionalNumber{}
	}
	value := validateNumberField(problems, raw, name, min, max, true, coerce)
	return optionalNumber{Present: value.Present, Null: value.Null, Value: value.Value}
}

// numberField reads one integer field without @Type conversion.
func numberField(problems *validationErrors, fields []objectField, name string, min, max float64, integer bool) numberInput {
	raw, ok := fieldValue(fields, name)
	if !ok {
		return numberInput{}
	}
	return validateNumberField(problems, raw, name, min, max, integer, false)
}

// floatField reads one optional float field without @Type conversion and returns
// it only when it validated.
func floatField(problems *validationErrors, fields []objectField, name string, min, max float64) *float64 {
	value := numberField(problems, fields, name, min, max, false)
	if !value.Present || value.Null || !value.finite {
		return nil
	}
	result := value.Value
	return &result
}

// intField reads one optional integer field and returns it only when it
// validated.
func intField(problems *validationErrors, fields []objectField, name string, min, max float64) *int {
	value := numberField(problems, fields, name, min, max, true)
	if !value.Present || value.Null || !value.finite {
		return nil
	}
	result := int(value.Value)
	return &result
}

// normalizeAPIKey mirrors normalizeOpenAiApiKey: trim, drop a leading "Bearer ",
// and collapse an empty result to "".
func normalizeAPIKey(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	return normalizeSecret(trimmed)
}

// normalizeOptionalText mirrors the service normalizeOptionalString used by the
// probe defaults: a trimmed non-empty string or nil.
func normalizeOptionalText(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
