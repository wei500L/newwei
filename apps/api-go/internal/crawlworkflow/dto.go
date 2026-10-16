package crawlworkflow

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"strings"
)

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
	return strings.TrimSpace(string(raw)) == "null"
}

type compareInput struct {
	LeftVersionID  string
	RightVersionID string
}

// validateCompare 对齐 CompareCrawlStrategyWorkflowVersionsDto。
func validateCompare(fields []orderedField) (compareInput, error) {
	messages := unknownFieldMessages(fields, map[string]bool{
		"leftVersionId": true, "rightVersionId": true,
	})
	input := compareInput{}
	input.LeftVersionID = checkVersionID(fields, "leftVersionId", &messages)
	input.RightVersionID = checkVersionID(fields, "rightVersionId", &messages)
	if len(messages) > 0 {
		return compareInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// validateListQuery 对齐 ListCrawlStrategyWorkflowDto 的查询校验：
// whitelist 先于属性校验；未知参数按 URL 出现顺序报错。
func validateListQuery(rawQuery string) (string, error) {
	messages := []string{}
	pairs := parseQueryPairs(rawQuery)
	valuesByKey := map[string][]string{}
	order := []string{}
	for _, pair := range pairs {
		if _, seen := valuesByKey[pair.key]; !seen {
			order = append(order, pair.key)
		}
		valuesByKey[pair.key] = append(valuesByKey[pair.key], pair.value)
	}
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

// ---- 单字段检查（消息顺序 = 装饰器应用顺序，即源码声明序的倒序） ----

func unknownFieldMessages(fields []orderedField, allowed map[string]bool) []string {
	messages := []string{}
	for _, field := range fields {
		if !allowed[field.Key] {
			messages = append(messages, "property "+field.Key+" should not exist")
		}
	}
	return messages
}

// checkVersionID：@IsString @IsNotEmpty @MaxLength(191)。
func checkVersionID(fields []orderedField, key string, messages *[]string) string {
	raw, present := fieldValue(fields, key)
	if !present || isJSONNull(raw) {
		*messages = append(*messages,
			key+" must be shorter than or equal to 191 characters",
			key+" should not be empty",
			key+" must be a string")
		return ""
	}
	text, ok := jsString(raw)
	if !ok {
		*messages = append(*messages,
			key+" must be shorter than or equal to 191 characters",
			key+" must be a string")
		return ""
	}
	if jsMaxLengthLen(text) > 191 {
		*messages = append(*messages, key+" must be shorter than or equal to 191 characters")
		return ""
	}
	if text == "" {
		*messages = append(*messages, key+" should not be empty")
		return ""
	}
	return text
}

// jsMaxLengthLen 镜像 class-validator MaxLength 使用的 validator.js
// isLength：UTF-16 长度 − 代理对数量 − 变体选择符对数量（≈ 码点数减去
// 变体选择符组合）。
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
