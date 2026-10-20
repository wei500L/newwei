package crawlstrategyruns

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// This file ports the DTO validation of TrialRunCrawlStrategyWorkflowDto and
// ReplayCrawlStrategyWorkflowRunDto (apps/api/src/modules/crawl/dto/crawl-strategy.dto.ts)
// with the global ValidationPipe settings (whitelist + forbidNonWhitelisted,
// transform: true). The message text and order follow class-validator.

const invalidJSONMessage = "Expected property name or '}' in JSON at position 1"

var trialRunRunKinds = []string{"trial", "profile_preview", "news_source_preview", "frontier_compile"}

type orderedField struct {
	Key   string
	Value json.RawMessage
}

func parseObjectBody(body []byte) ([]orderedField, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	first, err := decoder.Token()
	if err != nil {
		return nil, &inputError{Message: invalidJSONMessage}
	}
	if delim, ok := first.(json.Delim); !ok || delim != '{' {
		if !json.Valid(trimmed) {
			return nil, &inputError{Message: invalidJSONMessage}
		}
		return nil, nil
	}
	fields := []orderedField{}
	index := map[string]int{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, &inputError{Message: invalidJSONMessage}
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, &inputError{Message: invalidJSONMessage}
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, &inputError{Message: invalidJSONMessage}
		}
		if position, exists := index[key]; exists {
			fields[position].Value = raw
			continue
		}
		index[key] = len(fields)
		fields = append(fields, orderedField{Key: key, Value: raw})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, &inputError{Message: invalidJSONMessage}
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, &inputError{Message: invalidJSONMessage}
	}
	return fields, nil
}

func fieldValue(fields []orderedField, key string) (json.RawMessage, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field.Value, true
		}
	}
	return nil, false
}

func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

func unknownFieldMessages(fields []orderedField, allowed map[string]bool) []string {
	messages := []string{}
	for _, field := range fields {
		if !allowed[field.Key] {
			messages = append(messages, "property "+field.Key+" should not exist")
		}
	}
	return messages
}

// validateTrialRun ports TrialRunCrawlStrategyWorkflowDto.
func validateTrialRun(body []byte) (TrialRunInput, error) {
	fields, err := parseObjectBody(body)
	if err != nil {
		return TrialRunInput{}, err
	}
	allowed := map[string]bool{
		"workflowVersionId": true, "profileId": true, "newsSourceId": true,
		"seedUrl": true, "runKind": true, "maxCandidates": true, "runtimeOverrides": true,
	}
	messages := unknownFieldMessages(fields, allowed)
	input := TrialRunInput{}
	input.WorkflowVersionID = optionalString(fields, "workflowVersionId", 191, &messages)
	input.ProfileID = optionalString(fields, "profileId", 191, &messages)
	input.NewsSourceID = optionalString(fields, "newsSourceId", 191, &messages)
	input.SeedURL = optionalURL(fields, "seedUrl", &messages)
	input.RunKind = optionalEnum(fields, "runKind", trialRunRunKinds, &messages)
	input.MaxCandidates = optionalIntRange(fields, "maxCandidates", 1, 500, &messages)
	if raw, present := fieldValue(fields, "runtimeOverrides"); present && !isJSONNull(raw) {
		if _, ok := objectOf(raw); !ok {
			messages = append(messages, "runtimeOverrides must be an object")
		} else {
			input.RuntimeOverrides = raw
		}
	}
	if len(messages) > 0 {
		return TrialRunInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// validateReplay ports ReplayCrawlStrategyWorkflowRunDto.
func validateReplay(body []byte) (ReplayInput, error) {
	fields, err := parseObjectBody(body)
	if err != nil {
		return ReplayInput{}, err
	}
	allowed := map[string]bool{"seedUrl": true, "profileId": true, "newsSourceId": true, "maxCandidates": true}
	messages := unknownFieldMessages(fields, allowed)
	input := ReplayInput{}
	input.SeedURL = optionalURL(fields, "seedUrl", &messages)
	input.ProfileID = optionalString(fields, "profileId", 191, &messages)
	input.NewsSourceID = optionalString(fields, "newsSourceId", 191, &messages)
	input.MaxCandidates = optionalIntRange(fields, "maxCandidates", 1, 500, &messages)
	if len(messages) > 0 {
		return ReplayInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// optionalString ports @IsOptional @IsString @MaxLength(max). The message order
// is the decorator application order (bottom-up): MaxLength, then IsString.
func optionalString(fields []orderedField, key string, max int, messages *[]string) *string {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	limit := strconv.Itoa(max)
	text, ok := jsStringValueStrict(raw)
	if !ok {
		*messages = append(*messages,
			key+" must be shorter than or equal to "+limit+" characters",
			key+" must be a string")
		return nil
	}
	if jsLength(text) > max {
		*messages = append(*messages, key+" must be shorter than or equal to "+limit+" characters")
		return nil
	}
	return &text
}

// optionalURL ports @IsOptional @IsUrl({require_tld:false, require_protocol:true}).
func optionalURL(fields []orderedField, key string, messages *[]string) *string {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	text, ok := jsStringValueStrict(raw)
	if !ok || !crawlprofile.IsURLValid(text) {
		*messages = append(*messages, key+" must be a URL address")
		return nil
	}
	return &text
}

// optionalEnum ports @IsOptional @IsString @IsIn(values): IsIn then IsString.
func optionalEnum(fields []orderedField, key string, values []string, messages *[]string) *string {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	text, ok := jsStringValueStrict(raw)
	if !ok {
		*messages = append(*messages,
			key+" must be one of the following values: "+strings.Join(values, ", "),
			key+" must be a string")
		return nil
	}
	for _, value := range values {
		if text == value {
			return &text
		}
	}
	*messages = append(*messages, key+" must be one of the following values: "+strings.Join(values, ", "))
	return nil
}

// optionalIntRange ports @IsOptional @Type(()=>Number) @IsInt @Min @Max: the
// decorator application order is Max, Min, IsInt.
func optionalIntRange(fields []orderedField, key string, min, max int, messages *[]string) *int {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	transformed, ok := transformNumber(raw)
	if !ok {
		*messages = append(*messages,
			key+" must not be greater than "+strconv.Itoa(max),
			key+" must not be less than "+strconv.Itoa(min),
			key+" must be an integer number")
		return nil
	}
	before := len(*messages)
	if transformed > float64(max) {
		*messages = append(*messages, key+" must not be greater than "+strconv.Itoa(max))
	}
	if transformed < float64(min) {
		*messages = append(*messages, key+" must not be less than "+strconv.Itoa(min))
	}
	if transformed != float64(int(transformed)) {
		*messages = append(*messages, key+" must be an integer number")
	}
	if len(*messages) > before {
		return nil
	}
	value := int(transformed)
	return &value
}

// transformNumber mirrors class-transformer's @Type(() => Number) coercion.
func transformNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal([]byte(trimmed), &text); err != nil {
			return 0, false
		}
		if strings.TrimSpace(text) == "" {
			return 0, true
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return 0, false
		}
		return value, true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case '[':
		return 0, true
	case '{':
		return 0, false
	}
	value, ok := numberValue(raw)
	if !ok {
		return 0, false
	}
	return value, true
}

func jsStringValueStrict(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal([]byte(trimmed), &text); err != nil {
		return "", false
	}
	return text, true
}

// jsLength is the UTF-16 length MaxLength measures.
func jsLength(text string) int {
	length := 0
	for _, char := range text {
		if char > 0xFFFF {
			length += 2
			continue
		}
		length++
	}
	return length
}
