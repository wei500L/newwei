package crawlprofile

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// 本文件翻译 apps/api/src/modules/crawl/dto/crawl-frontier.dto.ts 里
// List/Create/Update/Match/Preview 五个画像 DTO 的校验（class-validator
// + class-transformer 语义），以及控制器的 Number.parseInt(version, 10)。
// Run/Bulk 的 DTO 不在本批。

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
// @MaxLength(max)（更新用的 name/matchHost）。null 由 IsOptional 放行，
// 语义交给服务层复刻（null.trim() TypeError → 500）。
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

// checkIsIn：@IsOptional @IsString @IsIn(values)。
func checkIsIn(fields []orderedField, key string, values []string, messages *[]string) (*string, bool) {
	raw, exists := fieldValue(fields, key)
	if !exists {
		return nil, false
	}
	if isJSONNull(raw) {
		return nil, true
	}
	enumMessage := key + " must be one of the following values: " + strings.Join(values, ", ")
	text, ok := jsString(raw)
	if !ok {
		*messages = append(*messages, enumMessage, key+" must be a string")
		return nil, false
	}
	for _, candidate := range values {
		if text == candidate {
			return &text, true
		}
	}
	*messages = append(*messages, enumMessage)
	return nil, false
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

// checkRequiredObject：@IsObject()（必填；仅一个约束，消息固定）。
func checkRequiredObject(fields []orderedField, key string, messages *[]string) json.RawMessage {
	raw, present := fieldValue(fields, key)
	if !present || !jsonIsObjectRaw(raw) {
		*messages = append(*messages, key+" must be an object")
		return nil
	}
	return raw
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

// checkURL：@IsUrl({ require_tld: false, require_protocol: true })。
// 仅一个约束，消息固定 "url must be a URL address"。
func checkURL(fields []orderedField, key string, messages *[]string) string {
	raw, present := fieldValue(fields, key)
	if present {
		if text, ok := jsString(raw); ok && validatorIsURL(text) {
			return text
		}
	}
	*messages = append(*messages, key+" must be a URL address")
	return ""
}

// ---- 输入形状（对齐 DTO 实例经过 transform 之后的值） ----

type createInput struct {
	Name                string
	Description         *string
	MatchHost           string
	IsActive            *bool
	ExecutionMode       *string
	WorkflowID          *string
	WorkflowVersionID   *string
	WorkflowBindingMode *string
	Config              json.RawMessage
}

type updateInput struct {
	NameSet                bool
	Name                   *string // nil = JSON null（服务层镜像 500）
	DescriptionSet         bool
	Description            *string
	MatchHostSet           bool
	MatchHost              *string // nil = JSON null（服务层镜像 500）
	IsActiveSet            bool
	IsActive               *bool // nil = JSON null（服务层镜像 500）
	ExecutionModeSet       bool
	ExecutionMode          *string // nil = JSON null（服务层镜像 500）
	WorkflowIDSet          bool
	WorkflowID             *string // nil = JSON null（清空，允许）
	WorkflowVersionIDSet   bool
	WorkflowVersionID      *string
	WorkflowBindingModeSet bool
	WorkflowBindingMode    *string // nil = JSON null（服务层镜像 500）
	ConfigSet              bool
	Config                 json.RawMessage // nil = JSON null（服务层归一化为空配置）
}

type previewInput struct {
	URL                 string
	MatchHost           string
	NameSet             bool
	Name                *string
	IsActive            *bool
	ExecutionMode       *string
	WorkflowID          *string
	WorkflowVersionID   *string
	WorkflowBindingMode *string
	Config              json.RawMessage
}

var profileBodyAllowedFields = map[string]bool{
	"name": true, "description": true, "matchHost": true, "isActive": true,
	"executionMode": true, "workflowId": true, "workflowVersionId": true,
	"workflowBindingMode": true, "config": true,
}

var executionModeValues = []string{"layered", "native", "hybrid"}
var workflowBindingModeValues = []string{"published", "pinned"}

// validateCreate 对齐 CreateCrawlSiteProfileDto（字段按声明序）。
func validateCreate(fields []orderedField) (createInput, error) {
	messages := unknownFieldMessages(fields, profileBodyAllowedFields)
	input := createInput{}
	input.Name = checkRequiredString(fields, "name", 200, &messages)
	input.Description, _ = checkOptionalString(fields, "description", 500, &messages)
	input.MatchHost = checkRequiredString(fields, "matchHost", 200, &messages)
	input.IsActive, _ = checkIsActive(fields, "isActive")
	input.ExecutionMode, _ = checkIsIn(fields, "executionMode", executionModeValues, &messages)
	input.WorkflowID, _ = checkOptionalString(fields, "workflowId", 191, &messages)
	input.WorkflowVersionID, _ = checkOptionalString(fields, "workflowVersionId", 191, &messages)
	input.WorkflowBindingMode, _ = checkIsIn(fields, "workflowBindingMode", workflowBindingModeValues, &messages)
	input.Config = checkRequiredObject(fields, "config", &messages)
	if len(messages) > 0 {
		return createInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

// validateUpdate 对齐 UpdateCrawlSiteProfileDto（全部字段 IsOptional）。
func validateUpdate(fields []orderedField) (updateInput, error) {
	messages := unknownFieldMessages(fields, profileBodyAllowedFields)
	input := updateInput{}
	if name, present := checkOptionalNotEmptyString(fields, "name", 200, &messages); present {
		input.NameSet = true
		input.Name = name
	}
	if description, present := checkOptionalString(fields, "description", 500, &messages); present {
		input.DescriptionSet = true
		input.Description = description
	}
	if matchHost, present := checkOptionalNotEmptyString(fields, "matchHost", 200, &messages); present {
		input.MatchHostSet = true
		input.MatchHost = matchHost
	}
	if isActive, present := checkIsActive(fields, "isActive"); present {
		input.IsActiveSet = true
		input.IsActive = isActive
	}
	if executionMode, present := checkIsIn(fields, "executionMode", executionModeValues, &messages); present {
		input.ExecutionModeSet = true
		input.ExecutionMode = executionMode
	}
	if workflowID, present := checkOptionalString(fields, "workflowId", 191, &messages); present {
		input.WorkflowIDSet = true
		input.WorkflowID = workflowID
	}
	if workflowVersionID, present := checkOptionalString(fields, "workflowVersionId", 191, &messages); present {
		input.WorkflowVersionIDSet = true
		input.WorkflowVersionID = workflowVersionID
	}
	if bindingMode, present := checkIsIn(fields, "workflowBindingMode", workflowBindingModeValues, &messages); present {
		input.WorkflowBindingModeSet = true
		input.WorkflowBindingMode = bindingMode
	}
	if config, present := checkOptionalObject(fields, "config", &messages); present {
		input.ConfigSet = true
		input.Config = config
	}
	if len(messages) > 0 {
		return updateInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

var previewBodyAllowedFields = map[string]bool{
	"url": true, "matchHost": true, "name": true, "isActive": true,
	"executionMode": true, "workflowId": true, "workflowVersionId": true,
	"workflowBindingMode": true, "config": true,
}

// validatePreview 对齐 PreviewCrawlSiteProfileDto（字段按声明序）。
func validatePreview(fields []orderedField) (previewInput, error) {
	messages := unknownFieldMessages(fields, previewBodyAllowedFields)
	input := previewInput{}
	input.URL = checkURL(fields, "url", &messages)
	input.MatchHost = checkRequiredString(fields, "matchHost", 200, &messages)
	if name, present := checkOptionalString(fields, "name", 200, &messages); present {
		input.NameSet = true
		input.Name = name
	}
	input.IsActive, _ = checkIsActive(fields, "isActive")
	input.ExecutionMode, _ = checkIsIn(fields, "executionMode", executionModeValues, &messages)
	input.WorkflowID, _ = checkOptionalString(fields, "workflowId", 191, &messages)
	input.WorkflowVersionID, _ = checkOptionalString(fields, "workflowVersionId", 191, &messages)
	input.WorkflowBindingMode, _ = checkIsIn(fields, "workflowBindingMode", workflowBindingModeValues, &messages)
	input.Config = checkRequiredObject(fields, "config", &messages)
	if len(messages) > 0 {
		return previewInput{}, &inputError{Message: strings.Join(messages, "; ")}
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

// validateListQuery 对齐 ListCrawlSiteProfileDto：whitelist 先于属性校验；
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

// validateMatchQuery 对齐 MatchCrawlSiteProfileDto：url 必填且是 URL。
func validateMatchQuery(rawQuery string) (string, error) {
	messages := []string{}
	valuesByKey, order := collectQueryValues(rawQuery)
	for _, key := range order {
		if key != "url" {
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	urlValue := ""
	if values, present := valuesByKey["url"]; present {
		if len(values) > 1 || !validatorIsURL(values[0]) {
			messages = append(messages, "url must be a URL address")
		} else {
			urlValue = values[0]
		}
	} else {
		messages = append(messages, "url must be a URL address")
	}
	if len(messages) > 0 {
		return "", &inputError{Message: strings.Join(messages, "; ")}
	}
	return urlValue, nil
}

// ---- 长度与 parseInt 的 JS 语义 ----

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

// jsLengthUTF16 是 JavaScript String.length（UTF-16 码元数）。
func jsLengthUTF16(text string) int {
	return len(utf16.Encode([]rune(text)))
}

// jsParseInt 复刻控制器里的 Number.parseInt(version, 10)：跳过前导空白
// 与可选符号，连续读取十进制数字（"10abc" → 10；"1e3" → 1；"+2" → 2）；
// 没有数字（"abc"）→ !ok（按「找不到版本」处理）。超长溢出同样 !ok
// （对应版本号不可能存在）。
func jsParseInt(value string) (int, bool) {
	text := strings.TrimLeft(value, " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	index := 0
	if index < len(text) && (text[index] == '+' || text[index] == '-') {
		index++
	}
	start := index
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
	}
	if index == start {
		return 0, false
	}
	parsed, err := strconv.Atoi(text[:index])
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// ---- validator.js isURL（@IsUrl 的 require_tld:false + require_protocol:true） ----

// 复刻 validator.js 13.15.23 的 isURL（node_modules 内源码逐行核对）。
// class-validator 的 @IsUrl 先做 typeof string 判定——非字符串返回 false
// 且不抛错；这里只接收字符串。固定选项：require_tld=false、
// require_protocol=true，其余为库默认（protocols = http/https/ftp、
// require_host=true、require_valid_protocol=true、allow_fragments/
// allow_query_components=true、validate_length=true、max_allowed_length=2084）。

var urlProtocolPattern = regexp.MustCompile(`(?i)^([a-z][a-z0-9+\-.]*):`)
var urlValidAuthPattern = regexp.MustCompile(`^[a-zA-Z0-9\-_.%:]*$`)
var urlWrappedIPv6Pattern = regexp.MustCompile(`^\[([^\]]+)\](?::([0-9]+))?$`)
var urlIPv4Segment = `(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])`
var urlIPv4Address = `(?:` + urlIPv4Segment + `\.){3}` + urlIPv4Segment
var urlIPv6Segment = `(?:[0-9a-fA-F]{1,4})`
var urlIPv4Pattern = regexp.MustCompile(`^` + urlIPv4Address + `$`)
var urlIPv6Pattern = regexp.MustCompile(`^(` +
	`(?:` + urlIPv6Segment + `:){7}(?:` + urlIPv6Segment + `|:)|` +
	`(?:` + urlIPv6Segment + `:){6}(?:` + urlIPv4Address + `|:` + urlIPv6Segment + `|:)|` +
	`(?:` + urlIPv6Segment + `:){5}(?::` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,2}|:)|` +
	`(?:` + urlIPv6Segment + `:){4}(?:(:` + urlIPv6Segment + `){0,1}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,3}|:)|` +
	`(?:` + urlIPv6Segment + `:){3}(?:(:` + urlIPv6Segment + `){0,2}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,4}|:)|` +
	`(?:` + urlIPv6Segment + `:){2}(?:(:` + urlIPv6Segment + `){0,3}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,5}|:)|` +
	`(?:` + urlIPv6Segment + `:){1}(?:(:` + urlIPv6Segment + `){0,4}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,6}|:)|` +
	`(?::((?::` + urlIPv6Segment + `){0,5}:` + urlIPv4Address + `|(?::` + urlIPv6Segment + `){1,7}|:))` +
	`)(%[0-9a-zA-Z.]{1,})?$`)

// JS \s 集合 + <>（isURL 的首个拒绝条件）。
var urlWhitespaceOrAnglePattern = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}<>]`)

// isFQDN 片段正则（require_tld:false、allow_underscores:false、
// allow_numeric_tld:false、ignore_max_length:false 的选项组合）。
var fqdnPartPattern = regexp.MustCompile(`(?i)^[a-z_\x{00a1}-\x{ffff}\x{10000}-\x{10ffff}0-9-]+$`)
var fqdnFullWidthPattern = regexp.MustCompile(`[\x{ff01}-\x{ff5e}]`)
var fqdnNumericTLDPattern = regexp.MustCompile(`^\d+$`)
var fqdnHyphenEdgePattern = regexp.MustCompile(`^-|-$`)
var urlPortPattern = regexp.MustCompile(`^[0-9]+$`)

func validatorIsURL(value string) bool {
	if value == "" || urlWhitespaceOrAnglePattern.MatchString(value) {
		return false
	}
	if strings.HasPrefix(value, "mailto:") {
		return false
	}
	if jsLengthUTF16(value) > 2084 {
		return false
	}
	// fragment / query 剥离（allow_fragments/allow_query_components 默认 true）。
	trimmed := value
	if idx := strings.Index(trimmed, "#"); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	if idx := strings.Index(trimmed, "?"); idx >= 0 {
		trimmed = trimmed[:idx]
	}

	match := urlProtocolPattern.FindStringSubmatch(trimmed)
	if match == nil {
		return false // require_protocol
	}
	potentialProtocol := match[1]
	afterColon := trimmed[len(match[0]):]
	startsWithSlashes := strings.HasPrefix(afterColon, "//")
	if !startsWithSlashes {
		firstSlash := strings.Index(afterColon, "/")
		beforeSlash := afterColon
		if firstSlash >= 0 {
			beforeSlash = afterColon[:firstSlash]
		}
		if atPosition := strings.Index(beforeSlash, "@"); atPosition >= 0 {
			if urlValidAuthPattern.MatchString(beforeSlash[:atPosition]) {
				return false // 认证段（user:password@host）：require_protocol
			}
			// 形如 javascript:alert();@host 的伪协议：按协议剥离并校验名单。
			trimmed = trimmed[len(match[0]):]
			if !urlAllowedProtocol(potentialProtocol) {
				return false
			}
		} else if len(afterColon) > 0 && afterColon[0] >= '0' && afterColon[0] <= '9' {
			return false // host:port 形态：require_protocol
		} else {
			trimmed = trimmed[len(match[0]):]
			if !urlAllowedProtocol(potentialProtocol) {
				return false
			}
		}
	} else {
		trimmed = trimmed[len(match[0]):]
		if !urlAllowedProtocol(potentialProtocol) {
			return false
		}
	}

	if strings.HasPrefix(trimmed, "//") {
		trimmed = trimmed[2:]
	}
	if trimmed == "" {
		return false
	}
	if idx := strings.Index(trimmed, "/"); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	if idx := strings.Index(trimmed, "@"); idx >= 0 {
		auth := trimmed[:idx]
		if auth == "" {
			return false
		}
		if strings.Contains(auth, ":") && strings.Count(auth, ":")+1 > 2 {
			return false
		}
		user, password := auth, ""
		if colon := strings.Index(auth, ":"); colon >= 0 {
			user, password = auth[:colon], auth[colon+1:]
		}
		if user == "" && password == "" {
			return false
		}
		trimmed = trimmed[idx+1:]
	}

	hostname := trimmed
	portStr := ""
	ipv6 := ""
	if wrapped := urlWrappedIPv6Pattern.FindStringSubmatch(hostname); wrapped != nil {
		ipv6 = wrapped[1]
		if wrapped[2] != "" {
			portStr = wrapped[2]
		}
		hostname = ""
	} else if idx := strings.LastIndex(hostname, ":"); idx >= 0 {
		hostname, portStr = hostname[:idx], hostname[idx+1:]
	}
	if portStr != "" {
		port, err := strconv.Atoi(portStr)
		if !urlPortPattern.MatchString(portStr) || err != nil || port <= 0 || port > 65535 {
			return false
		}
	}
	if hostname == "" {
		return ipv6 != "" && urlIPv6Pattern.MatchString(ipv6)
	}
	if urlIPv4Pattern.MatchString(hostname) || isFQDN(hostname) {
		return true
	}
	return ipv6 != "" && urlIPv6Pattern.MatchString(ipv6)
}

func urlAllowedProtocol(candidate string) bool {
	switch strings.ToLower(candidate) {
	case "http", "https", "ftp":
		return true
	}
	return false
}

// isFQDN 复刻 validator.js isFQDN（require_tld:false 选项组合）。
func isFQDN(value string) bool {
	parts := strings.Split(value, ".")
	tld := parts[len(parts)-1]
	// require_tld=false：跳过 TLD 长度/字符集/空白检查。
	if fqdnNumericTLDPattern.MatchString(tld) {
		return false // 数字 TLD
	}
	for _, part := range parts {
		if jsLengthUTF16(part) > 63 {
			return false
		}
		if !fqdnPartPattern.MatchString(part) {
			return false
		}
		if fqdnFullWidthPattern.MatchString(part) {
			return false
		}
		if fqdnHyphenEdgePattern.MatchString(part) {
			return false
		}
		if strings.Contains(part, "_") {
			return false // allow_underscores: false
		}
	}
	return true
}
