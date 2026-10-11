package userdigest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

// maxJSONBodyBytes 对齐 main.ts json({ limit: "10mb" })。超限在鉴权前返回，
// 生产环境映射成 500（body-parser 413 不是 HttpException）。
const maxJSONBodyBytes = 10 << 20

const unknownValueMessage = "an unknown value was passed to the validate function"

type bodyKind int

const (
	bodyAbsent bodyKind = iota
	bodyOK
	bodyInvalidJSON
	bodyTooLarge
)

type preferencePatch struct {
	focusEntities         *[]string
	focusTopics           *[]string
	windowDays            *int
	maxEvents             *int
	includeIndicators     *bool
	maxIndicatorsPerEvent *int
}

type deliveryInput struct {
	enabled  bool
	time     string
	timezone string
}

func readBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	if len(bytes.TrimSpace(data)) == 0 || !json.Valid(bytes.TrimSpace(data)) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return mediaType == "application/json"
}

// invalidJSONMessage 对齐 Node JSON.parse 经 Nest 收成 BadRequestException 后的 message。
func invalidJSONMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if bytes.Equal(trimmed, []byte("{")) {
		return "Expected property name or '}' in JSON at position 1"
	}
	if len(body) == 0 {
		return "Unexpected end of JSON input"
	}
	token := body[0]
	snippet := body
	ellipsis := ""
	if len(snippet) > 10 {
		snippet = snippet[:10]
		ellipsis = "..."
	}
	return fmt.Sprintf("Unexpected token '%c', \"%s\"%s is not valid JSON", token, string(snippet), ellipsis)
}

func parsePreference(body []byte) (preferencePatch, string) {
	fields, order, nonObject, message := decodeObject(body)
	if message != "" {
		return preferencePatch{}, message
	}
	if nonObject {
		return preferencePatch{}, unknownValueMessage
	}
	allowed := map[string]struct{}{
		"focusEntities": {}, "focusTopics": {}, "windowDays": {},
		"maxEvents": {}, "includeIndicators": {}, "maxIndicatorsPerEvent": {},
	}
	var patch preferencePatch
	var messages []string
	if raw, ok := fields["focusEntities"]; ok {
		values, provided, fieldMessages := optionalStringList("focusEntities", raw)
		messages = append(messages, fieldMessages...)
		if provided {
			copied := cloneStrings(values)
			patch.focusEntities = &copied
		}
	}
	if raw, ok := fields["focusTopics"]; ok {
		values, provided, fieldMessages := optionalStringList("focusTopics", raw)
		messages = append(messages, fieldMessages...)
		if provided {
			copied := cloneStrings(values)
			patch.focusTopics = &copied
		}
	}
	if raw, ok := fields["windowDays"]; ok {
		value, provided, fieldMessages := optionalInt("windowDays", raw, 1, 30)
		messages = append(messages, fieldMessages...)
		if provided {
			patch.windowDays = &value
		}
	}
	if raw, ok := fields["maxEvents"]; ok {
		value, provided, fieldMessages := optionalInt("maxEvents", raw, 1, 30)
		messages = append(messages, fieldMessages...)
		if provided {
			patch.maxEvents = &value
		}
	}
	if raw, ok := fields["includeIndicators"]; ok {
		value, provided, fieldMessages := optionalBool("includeIndicators", raw)
		messages = append(messages, fieldMessages...)
		if provided {
			patch.includeIndicators = &value
		}
	}
	if raw, ok := fields["maxIndicatorsPerEvent"]; ok {
		value, provided, fieldMessages := optionalInt("maxIndicatorsPerEvent", raw, 0, 50)
		messages = append(messages, fieldMessages...)
		if provided {
			patch.maxIndicatorsPerEvent = &value
		}
	}
	messages = append(messages, unknownProperties(order, allowed)...)
	if len(messages) > 0 {
		return preferencePatch{}, strings.Join(messages, "; ")
	}
	return patch, ""
}

func parseDelivery(body []byte) (deliveryInput, string) {
	fields, order, nonObject, message := decodeObject(body)
	if message != "" {
		return deliveryInput{}, message
	}
	if nonObject {
		return deliveryInput{}, unknownValueMessage
	}
	allowed := map[string]struct{}{"enabled": {}, "time": {}, "timezone": {}}
	var input deliveryInput
	var messages []string

	raw, ok := fields["enabled"]
	enabled, enabledOK := false, false
	if ok {
		enabled, enabledOK = jsonBool(raw)
	}
	if !ok || !enabledOK {
		messages = append(messages, "enabled must be a boolean value")
	} else {
		input.enabled = enabled
	}

	raw, ok = fields["time"]
	timeValue, timeOK := "", false
	if ok {
		timeValue, timeOK = jsonString(raw)
	}
	// 装饰器自下而上登记：Matches 先于 IsString。
	if !ok || !timeOK || !timePattern.MatchString(timeValue) {
		messages = append(messages, `time must match /^\d{2}:\d{2}$/ regular expression`)
	}
	if !ok || !timeOK {
		messages = append(messages, "time must be a string")
	} else if timePattern.MatchString(timeValue) {
		input.time = timeValue
	}

	raw, ok = fields["timezone"]
	zone, zoneOK := "", false
	if ok {
		zone, zoneOK = jsonString(raw)
	}
	if !ok || !zoneOK || jsLen(zone) > 128 {
		messages = append(messages, "timezone must be shorter than or equal to 128 characters")
	}
	if !ok || !zoneOK {
		messages = append(messages, "timezone must be a string")
	} else if jsLen(zone) <= 128 {
		input.timezone = zone
	}

	messages = append(messages, unknownProperties(order, allowed)...)
	if len(messages) > 0 {
		return deliveryInput{}, strings.Join(messages, "; ")
	}
	return input, ""
}

func unknownProperties(order []string, allowed map[string]struct{}) []string {
	var messages []string
	for _, key := range order {
		if _, ok := allowed[key]; ok {
			continue
		}
		messages = append(messages, "property "+key+" should not exist")
	}
	return messages
}

// optionalStringList 对齐 @IsOptional + @IsString({each}) + @MaxLength(128, {each})。
// null / 缺省视为省略。非数组在 Nest 里 each 会直接校验整个值；短字符串能穿过
// ValidationPipe，随后 replace 对非数组 .map 会 500。这里对非数组直接 400，
// 保证 ReplaceSubscriptionsFromDigestPreference 拿到的是字符串列表。
func optionalStringList(name string, raw json.RawMessage) ([]string, bool, []string) {
	if jsonKind(raw) == "null" {
		return nil, false, nil
	}
	if jsonKind(raw) != "array" {
		var messages []string
		text, isString := jsonString(raw)
		if !isString || jsLen(text) > 128 {
			messages = append(messages, "each value in "+name+" must be shorter than or equal to 128 characters")
		}
		messages = append(messages, "each value in "+name+" must be a string")
		return nil, false, messages
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false, []string{
			"each value in " + name + " must be shorter than or equal to 128 characters",
			"each value in " + name + " must be a string",
		}
	}
	out := make([]string, 0, len(items))
	lengthBad := false
	typeBad := false
	for _, item := range items {
		text, ok := jsonString(item)
		if !ok {
			typeBad = true
			lengthBad = true
			continue
		}
		if jsLen(text) > 128 {
			lengthBad = true
		}
		out = append(out, text)
	}
	var messages []string
	if lengthBad {
		messages = append(messages, "each value in "+name+" must be shorter than or equal to 128 characters")
	}
	if typeBad {
		messages = append(messages, "each value in "+name+" must be a string")
	}
	if len(messages) > 0 {
		return nil, false, messages
	}
	return out, true, nil
}

// optionalInt 对齐 @IsOptional @Type(() => Number) @IsInt @Min @Max。
// 约束文案按装饰器自下而上：Max、Min、IsInt。null 视为省略（IsOptional）。
func optionalInt(name string, raw json.RawMessage, min, max int) (int, bool, []string) {
	if jsonKind(raw) == "null" {
		return 0, false, nil
	}
	number, ok := jsNumber(raw)
	if !ok {
		number = math.NaN()
	}
	messages := intConstraintMessages(name, number, min, max)
	if len(messages) > 0 {
		return 0, false, messages
	}
	return int(number), true, nil
}

func intConstraintMessages(name string, value float64, min, max int) []string {
	var messages []string
	if !(value <= float64(max)) {
		messages = append(messages, fmt.Sprintf("%s must not be greater than %d", name, max))
	}
	if !(value >= float64(min)) {
		messages = append(messages, fmt.Sprintf("%s must not be less than %d", name, min))
	}
	if !isJSInteger(value) {
		messages = append(messages, name+" must be an integer number")
	}
	return messages
}

func optionalBool(name string, raw json.RawMessage) (bool, bool, []string) {
	if jsonKind(raw) == "null" {
		return false, false, nil
	}
	value, ok := jsonBool(raw)
	if !ok {
		return false, false, []string{name + " must be a boolean value"}
	}
	return value, true, nil
}

func isJSInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// jsNumber 对齐 class-transformer @Type(() => Number)，也就是 JavaScript Number()。
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		text, ok := jsonString(trimmed)
		if !ok {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return math.NaN(), true
		}
		return parsed, true
	case 't':
		if bytes.Equal(trimmed, []byte("true")) {
			return 1, true
		}
	case 'f':
		if bytes.Equal(trimmed, []byte("false")) {
			return 0, true
		}
	case '{', '[':
		return math.NaN(), true
	default:
		var number float64
		if err := json.Unmarshal(trimmed, &number); err != nil {
			return math.NaN(), true
		}
		return number, true
	}
	return math.NaN(), true
}

func jsonBool(raw json.RawMessage) (bool, bool) {
	switch string(bytes.TrimSpace(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func jsonString(raw json.RawMessage) (string, bool) {
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

func jsonKind(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "invalid"
	}
	switch trimmed[0] {
	case 'n':
		return "null"
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "bool"
	default:
		return "number"
	}
}

func decodeObject(body []byte) (map[string]json.RawMessage, []string, bool, string) {
	dec := json.NewDecoder(bytes.NewReader(body))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil, nil, false, "invalid json"
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, nil, false, "invalid json"
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, nil, true, ""
	}
	fields := make(map[string]json.RawMessage)
	obj := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := obj.Token()
	if err != nil {
		return nil, nil, false, "invalid json"
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, nil, true, ""
	}
	var order []string
	seen := map[string]struct{}{}
	for obj.More() {
		keyToken, err := obj.Token()
		if err != nil {
			return nil, nil, false, "invalid json"
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, nil, false, "invalid json"
		}
		var value json.RawMessage
		if err := obj.Decode(&value); err != nil {
			return nil, nil, false, "invalid json"
		}
		fields[key] = value
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			order = append(order, key)
		}
	}
	return fields, order, false, ""
}
