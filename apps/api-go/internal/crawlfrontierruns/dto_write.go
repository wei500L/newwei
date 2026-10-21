package crawlfrontierruns

// This file validates CreateCrawlFrontierRunDto
// (apps/api/src/modules/crawl/dto/crawl-frontier.dto.ts:232) for the single
// create-run route. Messages and their order reproduce class-validator plus the
// global ValidationPipe (whitelist, forbidNonWhitelisted, transform).
//
// class-validator registers one ValidationMetadata per decorator evaluated
// bottom-up, so a property's messages come out in reverse decorator order and
// the properties themselves keep class declaration order:
//
//	seedUrl        IsUrl                     -> "seedUrl must be a URL address"
//	profileId      MaxLength(191), IsString
//	executionMode  IsIn(EXECUTION_MODES), IsString
//	maxDepth       Max(8), Min(1), IsInt
//	maxPages       Max(500), Min(1), IsInt
//	keywords       IsString(each), IsArray
//
// Whitelist errors are collected first because the ValidationPipe's whitelist
// pass runs before the decorator validations, which is what validateListQuery
// and validateBulkBody already do for the other DTOs in this package.

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// createRunInput is the validated CreateCrawlFrontierRunDto. The optional
// numbers keep the @Type(() => Number) result instead of the raw JSON so the
// service can apply the same clampInt call the NestJS service makes.
//
// A field is nil when it was absent or explicitly null: @IsOptional treats both
// as "not provided", and the service distinguishes them from a present value
// because `input.maxDepth ?? layeredOptions?.maxDepth` only falls through on
// null/undefined.
type createRunInput struct {
	SeedURL       string
	ProfileID     *string
	ExecutionMode *string
	MaxDepth      *float64
	MaxPages      *float64
	Keywords      []string
}

// isCreateRunField is the CreateCrawlFrontierRunDto property set, used for the
// whitelist pass.
func isCreateRunField(name string) bool {
	switch name {
	case "seedUrl", "profileId", "executionMode", "maxDepth", "maxPages", "keywords":
		return true
	}
	return false
}

// validateCreateRunBody mirrors the ValidationPipe for CreateCrawlFrontierRunDto.
func validateCreateRunBody(fields []orderedField) (createRunInput, error) {
	messages := unknownFieldMessages(fields, isCreateRunField)
	input := createRunInput{}

	// seedUrl carries no @IsOptional, so a missing value fails @IsUrl too.
	rawSeed, hasSeed := fieldValue(fields, "seedUrl")
	seed, seedIsString := jsonStringValue(rawSeed, hasSeed)
	if !seedIsString || !crawlprofile.IsURLValid(seed) {
		messages = append(messages, "seedUrl must be a URL address")
	} else {
		input.SeedURL = seed
	}

	input.ProfileID = optionalBodyString(fields, "profileId", 191, &messages)
	input.ExecutionMode = optionalBodyEnum(fields, "executionMode", executionModeValues, &messages)
	input.MaxDepth = optionalBodyInteger(fields, "maxDepth", 8, &messages)
	input.MaxPages = optionalBodyInteger(fields, "maxPages", 500, &messages)
	input.Keywords = optionalBodyStringList(fields, "keywords", &messages)

	if len(messages) > 0 {
		return createRunInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// jsonStringValue decodes a body field as a JSON string. present is false when
// the property was absent, and ok is false for null or any non-string value.
func jsonStringValue(raw json.RawMessage, present bool) (string, bool) {
	if !present {
		return "", false
	}
	return jsString(raw)
}

// optionalBodyString mirrors @IsOptional @IsString @MaxLength(max), emitting the
// MaxLength message before the IsString one.
func optionalBodyString(fields []orderedField, name string, max int, messages *[]string) *string {
	raw, present := fieldValue(fields, name)
	if !present || isJSONNull(raw) {
		return nil
	}
	text, isString := jsString(raw)
	maxLengthOK := isString && jsMaxLengthLen(text) <= max
	if !maxLengthOK {
		*messages = append(*messages, name+" must be shorter than or equal to "+strconv.Itoa(max)+" characters")
	}
	if !isString {
		*messages = append(*messages, name+" must be a string")
		return nil
	}
	if !maxLengthOK {
		return nil
	}
	return &text
}

// optionalBodyEnum mirrors @IsOptional @IsString @IsIn(values), emitting the
// IsIn message before the IsString one.
func optionalBodyEnum(fields []orderedField, name string, allowed []string, messages *[]string) *string {
	raw, present := fieldValue(fields, name)
	if !present || isJSONNull(raw) {
		return nil
	}
	text, isString := jsString(raw)
	enumOK := false
	if isString {
		for _, candidate := range allowed {
			if text == candidate {
				enumOK = true
				break
			}
		}
	}
	if !enumOK {
		*messages = append(*messages, name+" must be one of the following values: "+strings.Join(allowed, ", "))
	}
	if !isString {
		*messages = append(*messages, name+" must be a string")
		return nil
	}
	if !enumOK {
		return nil
	}
	return &text
}

// optionalBodyInteger mirrors @IsOptional @Type(() => Number) @IsInt @Min(1)
// @Max(max). @Type runs the JavaScript Number() coercion first, so "3", " 3 "
// and "3.0" are all the integer 3 while "" becomes 0 and "abc" becomes NaN;
// every constraint then runs against that single transformed value, which is
// why NaN reports all three messages.
func optionalBodyInteger(fields []orderedField, name string, max int, messages *[]string) *float64 {
	raw, present := fieldValue(fields, name)
	if !present || isJSONNull(raw) {
		return nil
	}
	number, finite := jsNumberFromJSON(raw)
	isInteger := finite && number == jsMathRound(number)
	maxOK := finite && number <= float64(max)
	minOK := finite && number >= 1
	if !maxOK {
		*messages = append(*messages, name+" must not be greater than "+strconv.Itoa(max))
	}
	if !minOK {
		*messages = append(*messages, name+" must not be less than 1")
	}
	if !isInteger {
		*messages = append(*messages, name+" must be an integer number")
		return nil
	}
	if !maxOK || !minOK {
		return nil
	}
	value := number
	return &value
}

// optionalBodyStringList mirrors @IsOptional @IsArray @IsString({each:true}).
// With `each`, class-validator validates a non-array value directly, so a plain
// string passes IsString and only fails IsArray.
func optionalBodyStringList(fields []orderedField, name string, messages *[]string) []string {
	raw, present := fieldValue(fields, name)
	if !present || isJSONNull(raw) {
		return nil
	}
	isArray := rawIsArray(raw)
	var elements []json.RawMessage
	if isArray {
		if err := json.Unmarshal(raw, &elements); err != nil {
			isArray = false
		}
	}
	isString := false
	eachStringOK := false
	if isArray {
		eachStringOK = true
		for _, element := range elements {
			if !rawIsString(element) {
				eachStringOK = false
				break
			}
		}
		isString = true
	} else {
		_, isString = jsString(raw)
		eachStringOK = isString
	}
	if !eachStringOK {
		*messages = append(*messages, "each value in "+name+" must be a string")
	}
	if !isArray {
		*messages = append(*messages, name+" must be an array")
		return nil
	}
	if !eachStringOK {
		return nil
	}
	out := make([]string, 0, len(elements))
	for _, element := range elements {
		text, _ := jsString(element)
		out = append(out, text)
	}
	return out
}

// mergeKeywordList is Array.from(new Set([...input, ...profile])):
// first-occurrence order, exact (case-sensitive) equality, no trimming and no
// empty-string filtering.
func mergeKeywordList(input, profile []string) []string {
	seen := make(map[string]struct{}, len(input)+len(profile))
	out := make([]string, 0, len(input)+len(profile))
	for _, list := range [][]string{input, profile} {
		for _, value := range list {
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			out = append(out, value)
		}
	}
	return out
}
