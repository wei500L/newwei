package crawltemplate

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"strconv"
	"strings"
)

// 本文件翻译 apps/api/src/modules/crawl/dto/crawl-template.dto.ts 三个 DTO
// 的校验（class-validator + class-transformer 语义）与 ValidationPipe 的
// whitelist + forbidNonWhitelisted 行为。

// orderedField 保留顶层 JSON 对象的键序（NodeJS Object.keys 插入序）。
type orderedField struct {
	Key   string
	Value json.RawMessage
}

// parseObjectBody 解析请求体：
//   - 空 body → 无字段（等价 {}）；
//   - 合法 JSON 对象 → 按出现顺序的字段（重复键后者覆盖、首次位置保留）；
//   - 合法 JSON 但非对象 → 无字段（NestJS toEmptyIfNil/plainToInstance 后
//     所有属性都是 undefined，校验表现与 {} 相同）；
//   - 非法 JSON → 400（readJSON 已先行拦截，这里兜底）。
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

// unknownFieldMessages 对齐 whitelist + forbidNonWhitelisted：
// "property X should not exist"，按 body 出现顺序。
func unknownFieldMessages(fields []orderedField, allowed map[string]bool) []string {
	messages := []string{}
	for _, field := range fields {
		if !allowed[field.Key] {
			messages = append(messages, "property "+field.Key+" should not exist")
		}
	}
	return messages
}

// ---- 单字段检查（消息顺序 = 装饰器应用顺序，即源码声明序的倒序） ----

// checkRequiredString：@IsString @IsNotEmpty @MaxLength(max)，必填。
func checkRequiredString(fields []orderedField, key string, max int, messages *[]string) string {
	raw, present := fieldValue(fields, key)
	limit := strconv.Itoa(max)
	if !present || isJSONNull(raw) {
		*messages = append(*messages,
			key+" must be shorter than or equal to "+limit+" characters",
			key+" should not be empty",
			key+" must be a string")
		return ""
	}
	text, ok := jsString(raw)
	if !ok {
		*messages = append(*messages,
			key+" must be shorter than or equal to "+limit+" characters",
			key+" must be a string")
		return ""
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, key+" must be shorter than or equal to "+limit+" characters")
		return ""
	}
	if text == "" {
		*messages = append(*messages, key+" should not be empty")
		return ""
	}
	return text
}

// checkOptionalString：@IsOptional @IsString @MaxLength(max)。
// 返回是否出现（present）与值（null 记为 nil）。
func checkOptionalString(fields []orderedField, key string, max int, messages *[]string) (*string, bool) {
	raw, exists := fieldValue(fields, key)
	if !exists {
		return nil, false
	}
	if isJSONNull(raw) {
		return nil, true
	}
	text, ok := jsString(raw)
	if !ok {
		*messages = append(*messages,
			key+" must be shorter than or equal to "+strconv.Itoa(max)+" characters",
			key+" must be a string")
		return nil, false
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, key+" must be shorter than or equal to "+strconv.Itoa(max)+" characters")
		return nil, false
	}
	return &text, true
}

// checkOptionalNotEmptyString：@IsOptional @IsString @IsNotEmpty
// @MaxLength(max)（更新用的 name）。null 由 IsOptional 放行，语义交给
// 服务层复刻（null.trim() TypeError → 500）。
func checkOptionalNotEmptyString(fields []orderedField, key string, max int, messages *[]string) (*string, bool) {
	raw, exists := fieldValue(fields, key)
	if !exists {
		return nil, false
	}
	if isJSONNull(raw) {
		return nil, true
	}
	text, ok := jsString(raw)
	if !ok {
		*messages = append(*messages,
			key+" must be shorter than or equal to "+strconv.Itoa(max)+" characters",
			key+" must be a string")
		return nil, false
	}
	if jsMaxLengthLen(text) > max {
		*messages = append(*messages, key+" must be shorter than or equal to "+strconv.Itoa(max)+" characters")
		return nil, false
	}
	if text == "" {
		*messages = append(*messages, key+" should not be empty")
		return nil, false
	}
	return &text, true
}

// checkIsActive：@IsOptional @Type(() => Boolean) @IsBoolean。
// class-transformer 用 Boolean(value) 转换（null/undefined 原样保留），
// 转换后 @IsBoolean 永远通过——本字段不产生校验消息。
func checkIsActive(fields []orderedField, key string) (*bool, bool) {
	raw, exists := fieldValue(fields, key)
	if !exists {
		return nil, false
	}
	if isJSONNull(raw) {
		return nil, true
	}
	converted := jsBooleanCoerce(raw)
	return &converted, true
}

func jsBooleanCoerce(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return false
	}
	switch trimmed[0] {
	case 't':
		return trimmed == "true"
	case 'f':
		return trimmed == "false"
	case '"':
		text, _ := jsString(raw)
		return text != ""
	case 'n':
		return false
	default:
		number, ok := jsNumber(raw)
		if !ok {
			// 对象/数组等：Boolean(value) 为 true。
			return true
		}
		return number != 0
	}
}

// checkOptionalObject：@IsOptional @IsObject()。null 由 IsOptional 放行
// （服务层归一化为空配置）。
func checkOptionalObject(fields []orderedField, key string, messages *[]string) (json.RawMessage, bool) {
	raw, exists := fieldValue(fields, key)
	if !exists {
		return nil, false
	}
	if isJSONNull(raw) {
		return nil, true
	}
	if !jsonIsObjectRaw(raw) {
		*messages = append(*messages, key+" must be an object")
		return nil, false
	}
	return raw, true
}

// ---- 输入形状（对齐 DTO 实例经过 transform 之后的值） ----

type createInput struct {
	Name         string
	Description  *string
	IsActive     *bool
	CrawlOptions json.RawMessage
}

type updateInput struct {
	NameSet         bool
	Name            *string // nil = JSON null（服务层镜像 500）
	DescriptionSet  bool
	Description     *string
	IsActiveSet     bool
	IsActive        *bool // nil = JSON null（服务层镜像 500）
	CrawlOptionsSet bool
	CrawlOptions    json.RawMessage // nil = JSON null（写数据库 NULL）
}

var templateBodyAllowedFields = map[string]bool{
	"name": true, "description": true, "isActive": true, "crawlOptions": true,
}

// validateCreate 对齐 CreateCrawlTemplateDto（字段按声明序）。
func validateCreate(fields []orderedField) (createInput, error) {
	messages := unknownFieldMessages(fields, templateBodyAllowedFields)
	input := createInput{}
	input.Name = checkRequiredString(fields, "name", 200, &messages)
	input.Description, _ = checkOptionalString(fields, "description", 500, &messages)
	input.IsActive, _ = checkIsActive(fields, "isActive")
	input.CrawlOptions, _ = checkOptionalObject(fields, "crawlOptions", &messages)
	if len(messages) > 0 {
		return createInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// validateUpdate 对齐 UpdateCrawlTemplateDto（全部字段 IsOptional）。
func validateUpdate(fields []orderedField) (updateInput, error) {
	messages := unknownFieldMessages(fields, templateBodyAllowedFields)
	input := updateInput{}
	if name, present := checkOptionalNotEmptyString(fields, "name", 200, &messages); present {
		input.NameSet = true
		input.Name = name
	}
	if description, present := checkOptionalString(fields, "description", 500, &messages); present {
		input.DescriptionSet = true
		input.Description = description
	}
	if isActive, present := checkIsActive(fields, "isActive"); present {
		input.IsActiveSet = true
		input.IsActive = isActive
	}
	if crawlOptions, present := checkOptionalObject(fields, "crawlOptions", &messages); present {
		input.CrawlOptionsSet = true
		input.CrawlOptions = crawlOptions
	}
	if len(messages) > 0 {
		return updateInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// ---- query 校验 ----

type queryPair struct {
	key   string
	value string
}

func parseQueryPairs(rawQuery string) []queryPair {
	if rawQuery == "" {
		return nil
	}
	pairs := []queryPair{}
	for _, part := range strings.Split(rawQuery, "&") {
		if part == "" {
			continue
		}
		key, value := part, ""
		if idx := strings.Index(part, "="); idx >= 0 {
			key, value = part[:idx], part[idx+1:]
		}
		decodedKey, err := url.QueryUnescape(key)
		if err != nil {
			decodedKey = key
		}
		decodedValue, err := url.QueryUnescape(value)
		if err != nil {
			decodedValue = value
		}
		pairs = append(pairs, queryPair{key: decodedKey, value: decodedValue})
	}
	return pairs
}

func collectQueryValues(rawQuery string) (map[string][]string, []string) {
	valuesByKey := map[string][]string{}
	order := []string{}
	for _, pair := range parseQueryPairs(rawQuery) {
		if _, seen := valuesByKey[pair.key]; !seen {
			order = append(order, pair.key)
		}
		valuesByKey[pair.key] = append(valuesByKey[pair.key], pair.value)
	}
	return valuesByKey, order
}

// validateListQuery 对齐 ListCrawlTemplateDto：whitelist 先于属性校验；
// 未知参数按 URL 出现顺序报错。返回 search 原始值（服务层 trim）。
func validateListQuery(rawQuery string) (string, error) {
	messages := []string{}
	valuesByKey, order := collectQueryValues(rawQuery)
	for _, key := range order {
		if key != "search" {
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	search := ""
	if values, present := valuesByKey["search"]; present {
		switch {
		case len(values) > 1:
			// Express 的 qs 把重复参数解析成数组 → @IsString 失败。
			messages = append(messages, "search must be a string")
		case jsMaxLengthLen(values[0]) > 200:
			messages = append(messages, "search must be shorter than or equal to 200 characters")
		default:
			search = values[0]
		}
	}
	if len(messages) > 0 {
		return "", &inputError{Message: strings.Join(messages, "; ")}
	}
	return search, nil
}

// ---- JS 语义的小工具 ----

// jsMaxLengthLen 镜像 class-validator MaxLength 使用的 validator.js
// isLength：UTF-16 长度 − 代理对数量 − 变体选择符对数量。
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

func isVariationSelectorRune(value rune) bool {
	return value == 0xFE0F || value == 0xFE0E
}

func jsString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

func jsNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// jsonIsObjectRaw 判定原始 JSON 是否是对象（null/数组/标量都不是）。
func jsonIsObjectRaw(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}
