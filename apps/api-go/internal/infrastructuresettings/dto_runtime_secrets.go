package infrastructuresettings

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Runtime secret source-id and key grammar, copied verbatim from the DTO so the
// validation messages can quote the same regular-expression literals.
const (
	sourceIDPatternText  = "/^[a-z0-9_-]+$/i"
	secretKeyPatternText = "/^[a-zA-Z0-9._:-]+$/"

	nestedUpsertsField = "upserts"
	nestedRemovesField = "removes"
)

// runtimeSecretsRequest is the PUT /api/system-settings/news-source-runtime-
// secrets body. Both members are optional arrays of nested objects.
type runtimeSecretsRequest struct {
	UpsertsRaw json.RawMessage
	RemovesRaw json.RawMessage
}

// setField records one declared member.
func (d *runtimeSecretsRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "upserts":
		d.UpsertsRaw = value
	case "removes":
		d.RemovesRaw = value
	default:
		return false
	}
	return true
}

// runtimeSecretUpsertInput is one normalized upsert.
type runtimeSecretUpsertInput struct {
	SourceID string
	Key      string
	Value    string
}

// runtimeSecretRemoveInput is one normalized remove.
type runtimeSecretRemoveInput struct {
	SourceID string
	Key      string
}

// runtimeSecretsUpdateInput is the parsed PUT body after DTO validation. The
// service layer applies the business rules (trim, lowercase, dedupe).
type runtimeSecretsUpdateInput struct {
	Upserts []runtimeSecretUpsertInput
	Removes []runtimeSecretRemoveInput
}

// runtimeSecretUpsertRequest is one nested upsert DTO.
type runtimeSecretUpsertRequest struct {
	sourceIDRaw json.RawMessage
	keyRaw      json.RawMessage
	valueRaw    json.RawMessage
}

// setField records one declared member.
func (d *runtimeSecretUpsertRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "sourceId":
		d.sourceIDRaw = value
	case "key":
		d.keyRaw = value
	case "value":
		d.valueRaw = value
	default:
		return false
	}
	return true
}

// runtimeSecretRemoveRequest is one nested remove DTO (no value member).
type runtimeSecretRemoveRequest struct {
	sourceIDRaw json.RawMessage
	keyRaw      json.RawMessage
}

// setField records one declared member.
func (d *runtimeSecretRemoveRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "sourceId":
		d.sourceIDRaw = value
	case "key":
		d.keyRaw = value
	default:
		return false
	}
	return true
}

// parseRuntimeSecretsRequest mirrors ValidationPipe for
// UpdateNewsSourceRuntimeSecretsDto, including the nested message prefixes and
// the order NestJS's flattenValidationErrors produces.
func parseRuntimeSecretsRequest(body []byte) (runtimeSecretsUpdateInput, error) {
	dto := runtimeSecretsRequest{}
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return runtimeSecretsUpdateInput{}, err
	}

	problems := validationErrors{}
	for _, name := range unknown {
		problems.add(unknownPropertyMessage(name))
	}

	parsed := runtimeSecretsUpdateInput{}
	parsed.Upserts = validateUpsertsNested(&problems, dto.UpsertsRaw)
	parsed.Removes = validateRemovesNested(&problems, dto.RemovesRaw)

	if err := problems.err(); err != nil {
		return runtimeSecretsUpdateInput{}, err
	}
	return parsed, nil
}

// validateUpsertsNested validates the `upserts` property: @ArrayMaxSize(500),
// @IsArray and @ValidateNested({each:true}) on NewsSourceRuntimeSecretUpsertDto.
func validateUpsertsNested(problems *validationErrors, raw json.RawMessage) []runtimeSecretUpsertInput {
	if skippedOptional(raw) {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if trimmed[0] != '[' {
		arrayPropertyMessages(problems, nestedUpsertsField, trimmed)
		if trimmed[0] == '{' {
			// A nested property that is an object rather than an array is
			// validated in place: its field errors are children of the property
			// error, so the prefix is the property name for both roles.
			if element, ok := validateUpsertElement(problems, trimmed,
				nestedUpsertsField+".", nestedUpsertsField+"."); ok {
				return []runtimeSecretUpsertInput{element}
			}
		}
		return nil
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(trimmed, &elements); err != nil {
		return nil
	}
	if len(elements) > runtimeSecretsMaxUpserts {
		problems.add(fmt.Sprintf("%s must contain no more than %d elements", nestedUpsertsField, runtimeSecretsMaxUpserts))
	}
	out := make([]runtimeSecretUpsertInput, 0, len(elements))
	for index, element := range elements {
		elementPrefix := fmt.Sprintf("%s.%d.", nestedUpsertsField, index)
		if parsed, ok := validateUpsertElement(problems, element, nestedUpsertsField+".", elementPrefix); ok {
			out = append(out, parsed)
		}
	}
	return out
}

// validateRemovesNested validates the `removes` property on
// NewsSourceRuntimeSecretRemoveDto.
func validateRemovesNested(problems *validationErrors, raw json.RawMessage) []runtimeSecretRemoveInput {
	if skippedOptional(raw) {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if trimmed[0] != '[' {
		arrayPropertyMessages(problems, nestedRemovesField, trimmed)
		if trimmed[0] == '{' {
			if element, ok := validateRemoveElement(problems, trimmed,
				nestedRemovesField+".", nestedRemovesField+"."); ok {
				return []runtimeSecretRemoveInput{element}
			}
		}
		return nil
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(trimmed, &elements); err != nil {
		return nil
	}
	if len(elements) > runtimeSecretsMaxUpserts {
		problems.add(fmt.Sprintf("%s must contain no more than %d elements", nestedRemovesField, runtimeSecretsMaxUpserts))
	}
	out := make([]runtimeSecretRemoveInput, 0, len(elements))
	for index, element := range elements {
		elementPrefix := fmt.Sprintf("%s.%d.", nestedRemovesField, index)
		if parsed, ok := validateRemoveElement(problems, element, nestedRemovesField+".", elementPrefix); ok {
			out = append(out, parsed)
		}
	}
	return out
}

// arrayPropertyMessages emits the two custom-constraint messages a non-array
// value produces (@ArrayMaxSize then @IsArray), and the nested-validation
// message when the value is neither an array nor an object.
func arrayPropertyMessages(problems *validationErrors, field string, trimmed json.RawMessage) {
	problems.add(fmt.Sprintf("%s must contain no more than %d elements", field, runtimeSecretsMaxUpserts))
	problems.add(field + " must be an array")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		problems.add("each value in nested property " + field + " must be either object or array")
	}
}

// validateUpsertElement validates one nested upsert.
//
// fieldPrefix is the parent property path used for the @ValidateNested message
// (NestJS attaches that constraint to the element error and prefixes it with the
// array property name, not the index). elementPrefix is the per-element path
// used for the element's own field errors.
func validateUpsertElement(problems *validationErrors, raw json.RawMessage, fieldPrefix, elementPrefix string) (runtimeSecretUpsertInput, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		problems.add(fieldPrefix + "each value in nested property " + nestedUpsertsField + " must be either object or array")
		return runtimeSecretUpsertInput{}, false
	}
	element := runtimeSecretUpsertRequest{}
	unknown, err := decodeStrictObject(trimmed, &element)
	if err != nil {
		problems.add(fieldPrefix + "each value in nested property " + nestedUpsertsField + " must be either object or array")
		return runtimeSecretUpsertInput{}, false
	}
	for _, name := range unknown {
		problems.add(elementPrefix + unknownPropertyMessage(name))
	}
	sourceID, sourceIDOK := sourceIDConstraint(problems, element.sourceIDRaw, elementPrefix)
	key, keyOK := secretKeyConstraint(problems, element.keyRaw, elementPrefix)
	value, valueOK := secretValueConstraint(problems, element.valueRaw, elementPrefix)
	if !sourceIDOK || !keyOK || !valueOK {
		return runtimeSecretUpsertInput{}, false
	}
	return runtimeSecretUpsertInput{SourceID: sourceID, Key: key, Value: value}, true
}

// validateRemoveElement validates one nested remove.
func validateRemoveElement(problems *validationErrors, raw json.RawMessage, fieldPrefix, elementPrefix string) (runtimeSecretRemoveInput, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		problems.add(fieldPrefix + "each value in nested property " + nestedRemovesField + " must be either object or array")
		return runtimeSecretRemoveInput{}, false
	}
	element := runtimeSecretRemoveRequest{}
	unknown, err := decodeStrictObject(trimmed, &element)
	if err != nil {
		problems.add(fieldPrefix + "each value in nested property " + nestedRemovesField + " must be either object or array")
		return runtimeSecretRemoveInput{}, false
	}
	for _, name := range unknown {
		problems.add(elementPrefix + unknownPropertyMessage(name))
	}
	sourceID, sourceIDOK := sourceIDConstraint(problems, element.sourceIDRaw, elementPrefix)
	key, keyOK := secretKeyConstraint(problems, element.keyRaw, elementPrefix)
	if !sourceIDOK || !keyOK {
		return runtimeSecretRemoveInput{}, false
	}
	return runtimeSecretRemoveInput{SourceID: sourceID, Key: key}, true
}

// sourceIDConstraint validates @IsString plus @Matches(/^[a-z0-9_-]+$/i). The
// decorators register bottom-up, so @Matches reports before @IsString.
func sourceIDConstraint(problems *validationErrors, raw json.RawMessage, prefix string) (string, bool) {
	text, isString := stringConstraint(&validationErrors{}, raw, "sourceId", true)
	matches := isString && sourceIDRe.MatchString(text)
	if !matches {
		problems.add(prefix + "sourceId must match " + sourceIDPatternText + " regular expression")
	}
	if !isString {
		problems.add(prefix + "sourceId must be a string")
	}
	if !matches || !isString {
		return "", false
	}
	return text, true
}

// secretKeyConstraint validates @IsString, @Matches and @MaxLength(128). The
// decorators register bottom-up, so the order is MaxLength, Matches, IsString.
func secretKeyConstraint(problems *validationErrors, raw json.RawMessage, prefix string) (string, bool) {
	text, isString := stringConstraint(&validationErrors{}, raw, "key", true)
	lengthOK := isString && len([]rune(text)) <= runtimeSecretsKeyMaxRunes
	matches := isString && secretKeyRe.MatchString(text)
	if !lengthOK {
		problems.add(fmt.Sprintf("%skey must be shorter than or equal to %d characters", prefix, runtimeSecretsKeyMaxRunes))
	}
	if !matches {
		problems.add(prefix + "key must match " + secretKeyPatternText + " regular expression")
	}
	if !isString {
		problems.add(prefix + "key must be a string")
	}
	if !lengthOK || !matches || !isString {
		return "", false
	}
	return text, true
}

// secretValueConstraint validates @IsString and @MaxLength(8192). The
// decorators register bottom-up, so the length check reports first.
func secretValueConstraint(problems *validationErrors, raw json.RawMessage, prefix string) (string, bool) {
	text, isString := stringConstraint(&validationErrors{}, raw, "value", true)
	lengthOK := isString && len([]rune(text)) <= runtimeSecretsValMaxRunes
	if !lengthOK {
		problems.add(fmt.Sprintf("%svalue must be shorter than or equal to %d characters", prefix, runtimeSecretsValMaxRunes))
	}
	if !isString {
		problems.add(prefix + "value must be a string")
	}
	if !lengthOK || !isString {
		return "", false
	}
	return text, true
}
