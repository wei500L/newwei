package crawlmetadata

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// This file translates CrawlMetadataRequestDto validation: the class-validator
// semantics (conditionals, `each`, message wording and message order) plus the
// ValidationPipe's whitelist + forbidNonWhitelisted behavior. The GraphQL input
// is validated by the schema and never passes through here.
//
// Message order matters: class-validator inserts a property's constraints in
// the order the decorators were applied, which is the reverse of the DTO's
// source declaration order. Only IsSafeUrl is asynchronous, so its message is
// inserted after the synchronous constraints of the same property.

// orderedField preserves the top-level JSON key order (Node's Object.keys
// insertion order), which decides the order of the unknown-property messages.
type orderedField struct {
	Key   string
	Value json.RawMessage
}

// parseObjectBody decodes the request body. An empty body and a non-object
// value behave like `{}`: ValidationPipe.toEmptyIfNil plus plainToInstance leave
// every DTO property undefined in that case.
func parseObjectBody(body []byte) ([]orderedField, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	first, err := decoder.Token()
	if err != nil {
		return nil, &InputError{Message: invalidJSONMessage}
	}
	if delim, ok := first.(json.Delim); !ok || delim != '{' {
		if !json.Valid(trimmed) {
			return nil, &InputError{Message: invalidJSONMessage}
		}
		return nil, nil
	}
	fields := []orderedField{}
	index := map[string]int{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, &InputError{Message: invalidJSONMessage}
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, &InputError{Message: invalidJSONMessage}
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, &InputError{Message: invalidJSONMessage}
		}
		if position, exists := index[key]; exists {
			fields[position].Value = raw
			continue
		}
		index[key] = len(fields)
		fields = append(fields, orderedField{Key: key, Value: raw})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, &InputError{Message: invalidJSONMessage}
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, &InputError{Message: invalidJSONMessage}
	}
	return fields, nil
}

// invalidJSONMessage matches the body-parser failure Express raises for a
// malformed JSON body.
const invalidJSONMessage = "Expected property name or '}' in JSON at position 1"

func fieldValue(fields []orderedField, key string) (json.RawMessage, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field.Value, true
		}
	}
	return nil, false
}

func isJSONNull(raw json.RawMessage) bool {
	return len(raw) > 0 && strings.TrimSpace(string(raw)) == "null"
}

// allowedRequestFields is the whitelist derived from the DTO decorators.
var allowedRequestFields = map[string]bool{
	"source": true, "domain": true, "urls": true, "pattern": true,
	"maxUrls": true, "query": true, "scoreThreshold": true,
	"extractJsonLd": true, "extractOpenGraph": true, "extractStandardMeta": true,
	"concurrency": true,
}

// validateRequest reproduces the ValidationPipe outcome for the metadata POST
// and returns the service input. Every rejection is a 400 whose message is the
// class-validator message list joined by "; ", exactly how the global exception
// filter renders a BadRequestException.
func validateRequest(ctx context.Context, body []byte) (ExtractionInput, error) {
	fields, err := parseObjectBody(body)
	if err != nil {
		return ExtractionInput{}, err
	}

	// whitelist + forbidNonWhitelisted runs first, in body key order.
	messages := []string{}
	for _, field := range fields {
		if !allowedRequestFields[field.Key] {
			messages = append(messages, "property "+field.Key+" should not exist")
		}
	}

	// The two @ValidateIf conditions read the raw DTO value: only the string
	// "urls" selects the URL-list branch.
	sourceIsURLs := false
	sourceValue := ""
	if rawSource, present := fieldValue(fields, "source"); present && !isJSONNull(rawSource) {
		if text, ok := jsString(rawSource); ok {
			sourceValue = text
			sourceIsURLs = text == "urls"
		}
	}

	checkOptionalEnum(fields, "source", []string{"sitemap", "urls"}, &messages)
	domain := checkDomain(fields, !sourceIsURLs, &messages)
	urls := checkURLArray(ctx, fields, sourceIsURLs, &messages)
	pattern := checkOptionalString(fields, "pattern", 255, &messages)
	maxURLs := checkOptionalIntRange(fields, "maxUrls", 1, 200, &messages)
	query := checkOptionalString(fields, "query", 160, &messages)
	scoreThreshold := checkOptionalScore(fields, "scoreThreshold", &messages)
	extractJSONLd := checkOptionalBoolean(fields, "extractJsonLd", &messages)
	extractOpenGraph := checkOptionalBoolean(fields, "extractOpenGraph", &messages)
	extractStandardMeta := checkOptionalBoolean(fields, "extractStandardMeta", &messages)
	concurrency := checkOptionalIntRange(fields, "concurrency", 1, 10, &messages)

	if len(messages) > 0 {
		return ExtractionInput{}, &InputError{Message: strings.Join(messages, "; ")}
	}

	input := ExtractionInput{
		Source:              sourceValue,
		MaxURLs:             maxURLs,
		Concurrency:         concurrency,
		ScoreThreshold:      scoreThreshold,
		ExtractJSONLd:       extractJSONLd,
		ExtractOpenGraph:    extractOpenGraph,
		ExtractStandardMeta: extractStandardMeta,
		URLs:                urls,
	}
	if domain != nil {
		input.Domain = *domain
	}
	if pattern != nil {
		input.Pattern = *pattern
	}
	if query != nil {
		input.Query = *query
	}
	if sourceIsURLs {
		input.Source = "urls"
	}
	return input, nil
}

// checkOptionalEnum is @IsOptional @IsIn(values).
func checkOptionalEnum(fields []orderedField, key string, values []string, messages *[]string) {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return
	}
	text, ok := jsString(raw)
	if ok {
		for _, value := range values {
			if text == value {
				return
			}
		}
	}
	*messages = append(*messages, key+" must be one of the following values: "+strings.Join(values, ", "))
}

// checkDomain is @ValidateIf(source !== "urls") @IsString @MaxLength(255)
// @Matches(hostname). Class-validator inserts the constraints in reverse
// declaration order: Matches, MaxLength, IsString.
func checkDomain(fields []orderedField, enabled bool, messages *[]string) *string {
	if !enabled {
		return nil
	}
	raw, present := fieldValue(fields, "domain")
	text, isString := "", false
	if present && !isJSONNull(raw) {
		text, isString = jsString(raw)
	}
	if isString && !isRESTHostname(text) {
		*messages = append(*messages, "domain must be a public hostname (no IPs, localhost, or private TLDs)")
	} else if !isString {
		*messages = append(*messages, "domain must be a public hostname (no IPs, localhost, or private TLDs)")
	}
	if !isString || jsLen(text) > 255 {
		*messages = append(*messages, "domain must be shorter than or equal to 255 characters")
	}
	if !isString {
		*messages = append(*messages, "domain must be a string")
		return nil
	}
	return &text
}

// checkURLArray is @ValidateIf(source === "urls") @IsArray @ArrayMinSize(1)
// @ArrayMaxSize(200) @Matches(scheme, {each}) @IsSafeUrl({each}). The async
// IsSafeUrl constraint is inserted last; the synchronous constraints keep the
// reverse declaration order: Matches, ArrayMaxSize, ArrayMinSize, IsArray.
func checkURLArray(ctx context.Context, fields []orderedField, enabled bool, messages *[]string) []string {
	if !enabled {
		return nil
	}
	raw, present := fieldValue(fields, "urls")
	isArray := false
	items := []json.RawMessage{}
	if present && !isJSONNull(raw) {
		if err := json.Unmarshal(raw, &items); err == nil {
			isArray = true
		}
	}

	values := []string{}
	if isArray {
		for _, item := range items {
			text, _ := jsString(item)
			values = append(values, text)
		}
	}

	// Matches(/^https?:\/\//i, { each: true })
	matches := true
	if isArray {
		for index, item := range items {
			if _, ok := jsString(item); !ok || !hasHTTPScheme(values[index]) {
				matches = false
				break
			}
		}
	} else {
		value, ok := jsString(raw)
		matches = ok && hasHTTPScheme(value)
	}
	if !matches {
		*messages = append(*messages, "each url must include http/https scheme")
	}

	// ArrayMaxSize(200) / ArrayMinSize(1) / IsArray.
	if !isArray || len(items) > 200 {
		*messages = append(*messages, "urls must contain no more than 200 elements")
	}
	if !isArray || len(items) < 1 {
		*messages = append(*messages, "urls must contain at least 1 elements")
	}
	if !isArray {
		*messages = append(*messages, "urls must be an array")
	}

	// IsSafeUrl({ each: true }) — asynchronous, so its message is inserted last.
	lastUnsafeReason := ""
	if isArray {
		for _, item := range items {
			if reason, ok := safeURLReason(ctx, item); !ok {
				lastUnsafeReason = reason
			}
		}
	} else if reason, ok := safeURLReason(ctx, raw); !ok {
		lastUnsafeReason = reason
	}
	if lastUnsafeReason != "" {
		*messages = append(*messages, lastUnsafeReason)
	}

	if !isArray {
		return nil
	}
	return values
}

// safeURLReason runs the IsSafeUrl constraint for one value: a non-string fails
// with "URL must be a string", otherwise the synchronous SSRF rules run first
// and the DNS-backed check second, both with the source wording. A passing
// value never clears a previous failure, matching the constraint's lastError.
func safeURLReason(ctx context.Context, raw json.RawMessage) (string, bool) {
	text, ok := jsString(raw)
	if !ok {
		return "URL must be a string", false
	}
	reason, valid := validateSafeURL(ctx, text)
	if !valid {
		return reason, false
	}
	return "", true
}

// checkOptionalString is @IsOptional @IsString @MaxLength(max).
func checkOptionalString(fields []orderedField, key string, max int, messages *[]string) *string {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	text, ok := jsString(raw)
	if !ok {
		*messages = append(*messages,
			maxLengthMessage(key, max),
			key+" must be a string")
		return nil
	}
	if jsLen(text) > max {
		*messages = append(*messages, maxLengthMessage(key, max))
		return nil
	}
	return &text
}

// checkOptionalIntRange is @IsOptional @IsInt @Min(min) @Max(max): Max, Min,
// IsInt in insertion order.
func checkOptionalIntRange(fields []orderedField, key string, min, max int, messages *[]string) *int {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	number, isNumber := jsNumber(raw)
	integer := isNumber && number == math.Trunc(number) && number >= math.MinInt32 && number <= math.MaxInt32
	if !isNumber || number > float64(max) {
		*messages = append(*messages, key+" must not be greater than "+strconv.Itoa(max))
	}
	if !isNumber || number < float64(min) {
		*messages = append(*messages, key+" must not be less than "+strconv.Itoa(min))
	}
	if !integer {
		*messages = append(*messages, key+" must be an integer number")
		return nil
	}
	value := int(number)
	return &value
}

// checkOptionalScore is @IsOptional @IsNumber(message) @Min(0) @Max(1): Max,
// Min, IsNumber in insertion order.
func checkOptionalScore(fields []orderedField, key string, messages *[]string) *float64 {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	number, isNumber := jsNumber(raw)
	if !isNumber || number > 1 {
		*messages = append(*messages, key+" must not be greater than 1")
	}
	if !isNumber || number < 0 {
		*messages = append(*messages, key+" must not be less than 0")
	}
	if !isNumber {
		*messages = append(*messages, key+" must be a number")
		return nil
	}
	return &number
}

// checkOptionalBoolean is @IsOptional @IsBoolean.
func checkOptionalBoolean(fields []orderedField, key string, messages *[]string) *bool {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		return nil
	}
	value, ok := jsBoolean(raw)
	if !ok {
		*messages = append(*messages, key+" must be a boolean value")
		return nil
	}
	return &value
}

func maxLengthMessage(key string, max int) string {
	return key + " must be shorter than or equal to " + strconv.Itoa(max) + " characters"
}

// restHostnamePattern / numericHostPattern reproduce the DTO's @Matches
// hostname guard. Go's RE2 has no negative lookahead, so the three rejected
// shapes are checked separately before the label pattern.
var (
	restHostnamePattern = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`)
	numericHostPattern  = regexp.MustCompile(`^[\d.:\[\]]+$`)
)

// isRESTHostname rejects bare IPs/localhost and the private suffixes, so a
// scheme or path string cannot pass as a REST domain.
func isRESTHostname(value string) bool {
	if numericHostPattern.MatchString(value) {
		return false
	}
	if value == "localhost" {
		return false
	}
	for _, suffix := range []string{".local", ".internal", ".lan"} {
		if strings.HasSuffix(value, suffix) {
			return false
		}
	}
	return restHostnamePattern.MatchString(value)
}
