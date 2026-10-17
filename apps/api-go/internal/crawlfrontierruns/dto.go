package crawlfrontierruns

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf16"
)

// listQuery is the validated ListCrawlFrontierRunDto. Empty optional strings
// are normalized to nil because NestJS uses truthiness checks before applying
// a filter.
type listQuery struct {
	Search        *string
	ProfileID     *string
	Status        *string
	ExecutionMode *string
	RunRole       *string
	FailureKind   *string
	WarningFlag   *string
	SeedStrategy  *string
}

// queryValue is one parsed query property. nested marks bracket notation
// (`search[]=x`), which Express parses as an object/array rather than a string.
type queryValue struct {
	values []string
	nested bool
}

// isListQueryField reports whether name is a ListCrawlFrontierRunDto property.
func isListQueryField(name string) bool {
	switch name {
	case "search", "profileId", "status", "executionMode", "runRole", "failureKind", "warningFlag", "seedStrategy":
		return true
	}
	return false
}

var runStatusValues = []string{"pending", "queued", "running", "completed", "failed", "canceled"}
var executionModeValues = []string{"layered", "native", "hybrid"}
var seedStrategyValues = []string{"auto", "seed_first", "frontier_first", "frontier_only"}

// queryValueEntry is one parsed query property in first-occurrence order.
type queryValueEntry struct {
	key   string
	value *queryValue
}

// lookupQuery returns the parsed value of a query property.
func lookupQuery(entries []queryValueEntry, key string) *queryValue {
	for index := range entries {
		if entries[index].key == key {
			return entries[index].value
		}
	}
	return nil
}

// parseQueryValues keeps the first-occurrence order of the base property names
// and collects their values. Duplicate plain parameters become an array in
// Express; bracket notation becomes an object/array.
func parseQueryValues(rawQuery string) []queryValueEntry {
	entries := make([]queryValueEntry, 0)
	if rawQuery == "" {
		return entries
	}
	for _, part := range strings.Split(rawQuery, "&") {
		if part == "" {
			continue
		}
		key, value := part, ""
		if index := strings.Index(part, "="); index >= 0 {
			key, value = part[:index], part[index+1:]
		}
		decodedKey, err := url.QueryUnescape(key)
		if err != nil {
			decodedKey = key
		}
		decodedValue, err := url.QueryUnescape(value)
		if err != nil {
			decodedValue = value
		}
		base := decodedKey
		nested := false
		if index := strings.IndexByte(decodedKey, '['); index >= 0 {
			base = decodedKey[:index]
			nested = true
		}
		entry := lookupQuery(entries, base)
		if entry == nil {
			entry = &queryValue{}
			entries = append(entries, queryValueEntry{key: base, value: entry})
		}
		entry.values = append(entry.values, decodedValue)
		entry.nested = entry.nested || nested
	}
	return entries
}

// validateListQuery mirrors ListCrawlFrontierRunDto: whitelist errors first,
// then the optional string/enum constraints in DTO declaration order, with the
// class-validator message order (MaxLength before IsString, IsIn before
// IsString).
func validateListQuery(rawQuery string) (listQuery, error) {
	entries := parseQueryValues(rawQuery)
	messages := make([]string, 0)
	for _, entry := range entries {
		if !isListQueryField(entry.key) {
			messages = append(messages, "property "+entry.key+" should not exist")
		}
	}
	query := listQuery{}
	query.Search = optionalStringQuery("search", 200, lookupQuery(entries, "search"), &messages)
	query.ProfileID = optionalStringQuery("profileId", 191, lookupQuery(entries, "profileId"), &messages)
	query.Status = optionalEnumQuery("status", runStatusValues, lookupQuery(entries, "status"), &messages)
	query.ExecutionMode = optionalEnumQuery("executionMode", executionModeValues, lookupQuery(entries, "executionMode"), &messages)
	query.RunRole = optionalStringQuery("runRole", 64, lookupQuery(entries, "runRole"), &messages)
	query.FailureKind = optionalStringQuery("failureKind", 64, lookupQuery(entries, "failureKind"), &messages)
	query.WarningFlag = optionalStringQuery("warningFlag", 64, lookupQuery(entries, "warningFlag"), &messages)
	query.SeedStrategy = optionalEnumQuery("seedStrategy", seedStrategyValues, lookupQuery(entries, "seedStrategy"), &messages)
	if len(messages) > 0 {
		return listQuery{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return query, nil
}

// optionalStringQuery mirrors @IsOptional @IsString @MaxLength(max). Values
// parsed as arrays/objects fail both constraints, matching class-validator's
// typeof string requirement.
func optionalStringQuery(name string, max int, value *queryValue, messages *[]string) *string {
	if value == nil {
		return nil
	}
	maxMessage := name + " must be shorter than or equal to " + strconv.Itoa(max) + " characters"
	if value.nested || len(value.values) > 1 {
		*messages = append(*messages, maxMessage, name+" must be a string")
		return nil
	}
	text := value.values[0]
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, maxMessage)
		return nil
	}
	if text == "" {
		return nil
	}
	return &text
}

// optionalEnumQuery mirrors @IsOptional @IsString @IsIn(values).
func optionalEnumQuery(name string, allowed []string, value *queryValue, messages *[]string) *string {
	if value == nil {
		return nil
	}
	enumMessage := name + " must be one of the following values: " + strings.Join(allowed, ", ")
	if value.nested || len(value.values) > 1 {
		*messages = append(*messages, enumMessage, name+" must be a string")
		return nil
	}
	text := value.values[0]
	for _, candidate := range allowed {
		if text == candidate {
			return &text
		}
	}
	*messages = append(*messages, enumMessage)
	return nil
}

// orderedField preserves the top-level JSON object key order.
type orderedField struct {
	Key   string
	Value json.RawMessage
}

// parseObjectBody parses a request body:
//   - empty body -> no fields (equivalent to {});
//   - a JSON object -> fields in first-occurrence order (duplicate keys keep
//     the first position and the last value);
//   - valid JSON that is not an object -> no fields (plainToInstance leaves all
//     DTO properties undefined, which validates exactly like {});
//   - invalid JSON -> 400.
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
		position := -1
		for index := range fields {
			if fields[index].Key == key {
				position = index
				break
			}
		}
		if position >= 0 {
			fields[position].Value = raw
			continue
		}
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

// invalidJSONMessage mirrors the Node 20 JSON.parse message used by the
// existing crawl migrations for malformed request bodies.
const invalidJSONMessage = "Expected property name or '}' in JSON at position 1"

// fieldValue returns the raw value of a body field.
func fieldValue(fields []orderedField, key string) (json.RawMessage, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field.Value, true
		}
	}
	return nil, false
}

// unknownFieldMessages mirrors whitelist + forbidNonWhitelisted.
func unknownFieldMessages(fields []orderedField, allowed func(string) bool) []string {
	messages := []string{}
	for _, field := range fields {
		if !allowed(field.Key) {
			messages = append(messages, "property "+field.Key+" should not exist")
		}
	}
	return messages
}

// validateBulkBody mirrors BulkCrawlFrontierIdsDto. The decorators are applied
// bottom-up, so the emitted message order is MaxLength(each), IsString(each),
// ArrayMaxSize, ArrayNotEmpty, IsArray.
func validateBulkBody(fields []orderedField) ([]string, error) {
	messages := unknownFieldMessages(fields, func(key string) bool { return key == "ids" })
	raw, present := fieldValue(fields, "ids")
	isArray := present && rawIsArray(raw)

	var elements []json.RawMessage
	if isArray {
		_ = json.Unmarshal(raw, &elements)
	}

	// MaxLength(191, {each: true}) requires every element to be a JSON string
	// no longer than 191 characters. For a non-array value class-validator
	// validates the value itself, so a plain string can still pass.
	maxLengthOK := false
	if isArray {
		maxLengthOK = true
		for _, element := range elements {
			var text string
			if json.Unmarshal(element, &text) != nil || jsMaxLengthLen(text) > 191 {
				maxLengthOK = false
				break
			}
		}
	} else if present && rawIsString(raw) {
		var text string
		_ = json.Unmarshal(raw, &text)
		maxLengthOK = jsMaxLengthLen(text) <= 191
	}

	// IsString({each: true}).
	isStringOK := false
	if isArray {
		isStringOK = true
		for _, element := range elements {
			if !rawIsString(element) {
				isStringOK = false
				break
			}
		}
	} else {
		isStringOK = present && rawIsString(raw)
	}

	arrayMaxSizeOK := isArray && len(elements) <= 200
	arrayNotEmptyOK := isArray && len(elements) > 0

	if !maxLengthOK {
		messages = append(messages, "each value in ids must be shorter than or equal to 191 characters")
	}
	if !isStringOK {
		messages = append(messages, "each value in ids must be a string")
	}
	if !arrayMaxSizeOK {
		messages = append(messages, "ids must contain no more than 200 elements")
	}
	if !arrayNotEmptyOK {
		messages = append(messages, "ids should not be empty")
	}
	if !isArray {
		messages = append(messages, "ids must be an array")
	}
	if len(messages) > 0 {
		return nil, &inputError{Message: strings.Join(messages, "; ")}
	}
	ids := make([]string, 0, len(elements))
	for _, element := range elements {
		var text string
		if err := json.Unmarshal(element, &text); err != nil {
			continue
		}
		ids = append(ids, text)
	}
	return ids, nil
}

// jsString decodes a JSON string value.
func jsString(raw json.RawMessage) (string, bool) {
	if !rawIsString(raw) {
		return "", false
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	return text, true
}

// isJSONNull reports whether a raw JSON value is null.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// jsMaxLengthLen mirrors validator.js isLength: UTF-16 length minus surrogate
// pairs minus presentation sequences (a non-variation-selector rune followed by
// a variation selector).
func jsMaxLengthLen(text string) int {
	runes := []rune(text)
	count := len(runes)
	for index := 0; index < len(runes); index++ {
		if isVariationSelectorRune(runes[index]) {
			continue
		}
		if index+1 < len(runes) && isVariationSelectorRune(runes[index+1]) {
			count--
			index++
		}
	}
	return count
}

// isVariationSelectorRune reports U+FE0E / U+FE0F.
func isVariationSelectorRune(value rune) bool {
	return value == 0xFE0F || value == 0xFE0E
}

// jsLengthUTF16 is JavaScript String.length.
func jsLengthUTF16(text string) int {
	return len(utf16.Encode([]rune(text)))
}
