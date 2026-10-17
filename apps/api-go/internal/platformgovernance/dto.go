package platformgovernance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// This file holds the request DTOs and the class-validator equivalent for the
// five write routes.
//
// Every DTO field is decoded as json.RawMessage so that one wrong type never
// aborts the whole decode: the per-field validators below reproduce the exact
// class-validator default messages and the order in which NestJS's
// ValidationPipe collects them (declaration order, top-down, joined with "; ").
//
// The validators never use untyped containers: each helper takes a concrete
// json.RawMessage and returns a concrete Go type.

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
	return badRequest(strings.Join(v.messages, "; "))
}

// securityUpdateFields holds the raw PUT /api/system-settings/security body.
type securityUpdateFields struct {
	SecretEncryptionEnabled json.RawMessage `json:"secretEncryptionEnabled"`
	MfaPolicy               json.RawMessage `json:"mfaPolicy"`
}

// quotaUpdateFields holds the raw PUT /api/system-settings/assistant-quota body.
type quotaUpdateFields struct {
	Enabled            json.RawMessage `json:"enabled"`
	SubmitLimitPerHour json.RawMessage `json:"submitLimitPerHour"`
	MaxInFlightPerOrg  json.RawMessage `json:"maxInFlightPerOrg"`
	MonthlyTokenBudget json.RawMessage `json:"monthlyTokenBudget"`
}

// safetyUpdateFields holds the raw PUT /api/system-settings/assistant-safety
// body.
type safetyUpdateFields struct {
	Enabled                 json.RawMessage `json:"enabled"`
	OutputModerationEnabled json.RawMessage `json:"outputModerationEnabled"`
}

// taskLogUpdateFields holds the raw PUT /api/system-settings/task-logs body.
type taskLogUpdateFields struct {
	RetentionDays json.RawMessage `json:"retentionDays"`
}

// llmLogUpdateFields holds the raw PUT /api/system-settings/llm-request-logs
// body. Every field is @IsOptional, so null and absent both skip the DTO
// constraints and are resolved by the service instead.
type llmLogUpdateFields struct {
	RetentionDays                   json.RawMessage `json:"retentionDays"`
	MetadataAllowedTopLevelKeys     json.RawMessage `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes json.RawMessage `json:"metadataAllowedTopLevelPrefixes"`
	BriefErrorRateThreshold         json.RawMessage `json:"briefErrorRateThreshold"`
	BriefInvalidJsonRatioThreshold  json.RawMessage `json:"briefInvalidJsonRatioThreshold"`
	BriefConsecutiveDaysThreshold   json.RawMessage `json:"briefConsecutiveDaysThreshold"`
}

// securityUpdateInput is the validated PUT /security body.
type securityUpdateInput struct {
	SecretEncryptionEnabled bool
	MfaPolicy               MfaPolicy
}

// quotaUpdateInput is the validated PUT /assistant-quota body. The numbers are
// the @Type(() => Number) converted values the service persists.
type quotaUpdateInput struct {
	Enabled            bool
	SubmitLimitPerHour int64
	MaxInFlightPerOrg  int64
	MonthlyTokenBudget int64
}

// safetyUpdateInput is the validated PUT /assistant-safety body.
type safetyUpdateInput struct {
	Enabled                 bool
	OutputModerationEnabled bool
}

// taskLogUpdateInput is the validated PUT /task-logs body.
type taskLogUpdateInput struct {
	RetentionDays int
}

// llmLogUpdateInput is the validated PUT /llm-request-logs body. The raw bytes
// are kept so the service can reproduce NestJS's null-vs-undefined rules.
type llmLogUpdateInput struct {
	RetentionDays                   json.RawMessage
	MetadataAllowedTopLevelKeys     json.RawMessage
	MetadataAllowedTopLevelPrefixes json.RawMessage
	BriefErrorRateThreshold         json.RawMessage
	BriefInvalidJsonRatioThreshold  json.RawMessage
	BriefConsecutiveDaysThreshold   json.RawMessage
}

// mfaPolicyValues is the @IsIn allow-list of the system security DTO.
var mfaPolicyValues = []string{string(MfaPolicyOff), string(MfaPolicyAdminsOnly), string(MfaPolicyAllUsers)}

// strictDecoder builds a decoder that rejects unknown properties, which is how
// the global ValidationPipe is configured (whitelist +
// forbidNonWhitelisted).
func strictDecoder(body []byte) *json.Decoder {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	return decoder
}

// decodeBodyError maps a json.Decoder failure onto the ValidationPipe contract.
// An unknown property becomes the exact NestJS message
// "property <name> should not exist"; every other decode failure becomes a
// generic 400 (the concrete field is validated afterwards by the typed helpers,
// which emit class-validator's own wording).
func decodeBodyError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if strings.HasPrefix(message, "json: unknown field ") {
		name := strings.Trim(strings.TrimPrefix(message, "json: unknown field "), "\"")
		return badRequest("property " + name + " should not exist")
	}
	return badRequest("Invalid request body")
}

// requiredBoolField validates a required @IsBoolean property: only the two JSON
// literals pass, so null, a number and the string "true" all fail.
func requiredBoolField(v *validationErrors, raw json.RawMessage, field string) bool {
	trimmed := bytes.TrimSpace(raw)
	switch string(trimmed) {
	case "true":
		return true
	case "false":
		return false
	}
	v.add(field + " must be a boolean value")
	return false
}

// requiredEnumField validates a required @IsIn property. It always emits exactly
// one message, because the property carries no other decorator.
func requiredEnumField(v *validationErrors, raw json.RawMessage, field string, allowed []string) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err == nil {
			for _, candidate := range allowed {
				if text == candidate {
					return text
				}
			}
		}
	}
	v.add(fmt.Sprintf("%s must be one of the following values: %s", field, strings.Join(allowed, ", ")))
	return ""
}

// addIntegerMessages appends the three messages an integer property produces
// when its value is absent, null or not a number.
func addIntegerMessages(v *validationErrors, field string, min, max int64) {
	v.add(field + " must be an integer number")
	v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
}

// integerMessages evaluates @IsInt/@Min/@Max independently, exactly like
// class-validator does, on an already coerced numeric value.
func integerMessages(v *validationErrors, value float64, field string, min, max int64) (int64, bool) {
	isNumber := !math.IsNaN(value)
	integerOK := jsIsInteger(value)
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
	return int64(value), true
}

// coercedIntegerField validates @Type(() => Number) + @IsInt/@Min/@Max.
//
// The @Type decorator runs Number() on the plain value before validation, so
// null becomes 0, "" becomes 0, true becomes 1 and an absent key stays
// undefined. An array is mapped element-wise and therefore remains an array,
// which fails all three constraints.
func coercedIntegerField(v *validationErrors, raw json.RawMessage, field string, min, max int64) (int64, bool) {
	if !hasValue(raw) {
		addIntegerMessages(v, field, min, max)
		return 0, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		addIntegerMessages(v, field, min, max)
		return 0, false
	}
	return integerMessages(v, jsNumberFromJSON(trimmed), field, min, max)
}

// plainIntegerField validates @IsInt/@Min/@Max on a property with no @Type, so
// only a JSON number token is considered and a numeric string fails.
func plainIntegerField(v *validationErrors, raw json.RawMessage, field string, min, max int64) (int64, bool) {
	if !hasValue(raw) {
		addIntegerMessages(v, field, min, max)
		return 0, false
	}
	return integerMessages(v, jsonNumberTokenValue(raw), field, min, max)
}

// plainNumberField validates @IsNumber({maxDecimalPlaces})/@Min/@Max on a
// property with no @Type.
func plainNumberField(v *validationErrors, raw json.RawMessage, field string, min, max float64, maxDecimals int) (float64, bool) {
	value := jsonNumberTokenValue(raw)
	numberOK := !math.IsNaN(value) && !math.IsInf(value, 0) && hasAtMostDecimals(value, maxDecimals)
	if !numberOK {
		v.add(field + " must be a number conforming to the specified constraints")
	}
	minOK := !math.IsNaN(value) && value >= min
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, int64(min)))
	}
	maxOK := !math.IsNaN(value) && value <= max
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, int64(max)))
	}
	if !numberOK || !minOK || !maxOK {
		return 0, false
	}
	return value, true
}

// jsonNumberTokenValue parses a raw JSON number token, or NaN when the token is
// not a JSON number (a string, boolean, null, array or object).
func jsonNumberTokenValue(raw json.RawMessage) float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return math.NaN()
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return math.NaN()
	}
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		return math.NaN()
	}
	return value
}

// hasAtMostDecimals reports whether the value needs no more than maxDecimals
// decimal places, matching class-validator's maxDecimalPlaces check.
func hasAtMostDecimals(value float64, maxDecimals int) bool {
	scaled := value * math.Pow(10, float64(maxDecimals))
	return math.Abs(scaled-math.Round(scaled)) < 1e-9
}

// stringArrayField validates @IsArray/@ArrayMaxSize/@IsString(each) and reports
// every message in declaration order.
//
// A non-array value fails @IsArray and @ArrayMaxSize; @IsString({each:true})
// then validates the value itself, so a JSON string passes that one constraint.
func stringArrayField(v *validationErrors, raw json.RawMessage, field string, maxItems int) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		v.add(field + " must be an array")
		v.add(fmt.Sprintf("%s must contain not more than %d elements", field, maxItems))
		if !isJSONStringToken(trimmed) {
			v.add("each value in " + field + " must be a string")
		}
		return
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		v.add(field + " must be an array")
		return
	}
	if len(items) > maxItems {
		v.add(fmt.Sprintf("%s must contain not more than %d elements", field, maxItems))
	}
	for _, item := range items {
		if !isJSONStringToken(bytes.TrimSpace(item)) {
			// class-validator emits one message per failing element.
			v.add("each value in " + field + " must be a string")
		}
	}
}

// isJSONStringToken reports whether the token is a JSON string literal.
func isJSONStringToken(trimmed []byte) bool {
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return false
	}
	var text string
	return json.Unmarshal(trimmed, &text) == nil
}

// parseUpdateSecurity validates the PUT /api/system-settings/security body.
func parseUpdateSecurity(body []byte) (securityUpdateInput, error) {
	var fields securityUpdateFields
	var input securityUpdateInput
	if err := strictDecoder(body).Decode(&fields); err != nil {
		return input, decodeBodyError(err)
	}
	var v validationErrors
	input.SecretEncryptionEnabled = requiredBoolField(&v, fields.SecretEncryptionEnabled, "secretEncryptionEnabled")
	input.MfaPolicy = MfaPolicy(requiredEnumField(&v, fields.MfaPolicy, "mfaPolicy", mfaPolicyValues))
	if err := v.err(); err != nil {
		return securityUpdateInput{}, err
	}
	return input, nil
}

// parseUpdateQuota validates the PUT /api/system-settings/assistant-quota body.
func parseUpdateQuota(body []byte) (quotaUpdateInput, error) {
	var fields quotaUpdateFields
	var input quotaUpdateInput
	if err := strictDecoder(body).Decode(&fields); err != nil {
		return input, decodeBodyError(err)
	}
	var v validationErrors
	input.Enabled = requiredBoolField(&v, fields.Enabled, "enabled")
	input.SubmitLimitPerHour, _ = coercedIntegerField(&v, fields.SubmitLimitPerHour, "submitLimitPerHour", 0, 10_000)
	input.MaxInFlightPerOrg, _ = coercedIntegerField(&v, fields.MaxInFlightPerOrg, "maxInFlightPerOrg", 0, 100)
	input.MonthlyTokenBudget, _ = coercedIntegerField(&v, fields.MonthlyTokenBudget, "monthlyTokenBudget", 0, 1_000_000_000_000)
	if err := v.err(); err != nil {
		return quotaUpdateInput{}, err
	}
	return input, nil
}

// parseUpdateSafety validates the PUT /api/system-settings/assistant-safety
// body.
func parseUpdateSafety(body []byte) (safetyUpdateInput, error) {
	var fields safetyUpdateFields
	var input safetyUpdateInput
	if err := strictDecoder(body).Decode(&fields); err != nil {
		return input, decodeBodyError(err)
	}
	var v validationErrors
	input.Enabled = requiredBoolField(&v, fields.Enabled, "enabled")
	input.OutputModerationEnabled = requiredBoolField(&v, fields.OutputModerationEnabled, "outputModerationEnabled")
	if err := v.err(); err != nil {
		return safetyUpdateInput{}, err
	}
	return input, nil
}

// parseUpdateTaskLog validates the PUT /api/system-settings/task-logs body. The
// DTO carries no @Type, so the numeric string "30" is a 400.
func parseUpdateTaskLog(body []byte) (taskLogUpdateInput, error) {
	var fields taskLogUpdateFields
	var input taskLogUpdateInput
	if err := strictDecoder(body).Decode(&fields); err != nil {
		return input, decodeBodyError(err)
	}
	var v validationErrors
	days, _ := plainIntegerField(&v, fields.RetentionDays, "retentionDays", minTaskLogRetentionDays, maxTaskLogRetentionDays)
	if err := v.err(); err != nil {
		return taskLogUpdateInput{}, err
	}
	input.RetentionDays = int(days)
	return input, nil
}

// parseUpdateLlmLog validates the PUT /api/system-settings/llm-request-logs
// body. Every property is @IsOptional, so null and absent skip the constraints
// and the service applies its own null semantics.
func parseUpdateLlmLog(body []byte) (llmLogUpdateInput, error) {
	var fields llmLogUpdateFields
	var input llmLogUpdateInput
	if err := strictDecoder(body).Decode(&fields); err != nil {
		return input, decodeBodyError(err)
	}
	var v validationErrors
	if hasValue(fields.RetentionDays) && !isNullValue(fields.RetentionDays) {
		plainIntegerField(&v, fields.RetentionDays, "retentionDays", minLlmRequestLogRetentionDays, maxLlmRequestLogRetentionDays)
	}
	if hasValue(fields.MetadataAllowedTopLevelKeys) && !isNullValue(fields.MetadataAllowedTopLevelKeys) {
		stringArrayField(&v, fields.MetadataAllowedTopLevelKeys, "metadataAllowedTopLevelKeys", maxLlmLogMetadataKeys)
	}
	if hasValue(fields.MetadataAllowedTopLevelPrefixes) && !isNullValue(fields.MetadataAllowedTopLevelPrefixes) {
		stringArrayField(&v, fields.MetadataAllowedTopLevelPrefixes, "metadataAllowedTopLevelPrefixes", maxLlmLogMetadataPrefixes)
	}
	if hasValue(fields.BriefErrorRateThreshold) && !isNullValue(fields.BriefErrorRateThreshold) {
		plainNumberField(&v, fields.BriefErrorRateThreshold, "briefErrorRateThreshold", 0, 1, 4)
	}
	if hasValue(fields.BriefInvalidJsonRatioThreshold) && !isNullValue(fields.BriefInvalidJsonRatioThreshold) {
		plainNumberField(&v, fields.BriefInvalidJsonRatioThreshold, "briefInvalidJsonRatioThreshold", 0, 1, 4)
	}
	if hasValue(fields.BriefConsecutiveDaysThreshold) && !isNullValue(fields.BriefConsecutiveDaysThreshold) {
		plainIntegerField(&v, fields.BriefConsecutiveDaysThreshold, "briefConsecutiveDaysThreshold", 1, 30)
	}
	if err := v.err(); err != nil {
		return llmLogUpdateInput{}, err
	}
	input.RetentionDays = fields.RetentionDays
	input.MetadataAllowedTopLevelKeys = fields.MetadataAllowedTopLevelKeys
	input.MetadataAllowedTopLevelPrefixes = fields.MetadataAllowedTopLevelPrefixes
	input.BriefErrorRateThreshold = fields.BriefErrorRateThreshold
	input.BriefInvalidJsonRatioThreshold = fields.BriefInvalidJsonRatioThreshold
	input.BriefConsecutiveDaysThreshold = fields.BriefConsecutiveDaysThreshold
	return input, nil
}
