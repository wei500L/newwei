package newsbehavior

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// eventTypes 的顺序就是 class-validator IsIn 的 $constraint1（逗号加空格）。
var eventTypes = []string{
	"view",
	"click",
	"open_event",
	"open_item",
	"bookmark",
	"share",
	"engaged_read",
	"deep_read",
	"completed_read",
	"not_interested",
	"unsubscribe",
}

var eventTypeSet = func() map[string]struct{} {
	set := make(map[string]struct{}, len(eventTypes))
	for _, eventType := range eventTypes {
		set[eventType] = struct{}{}
	}
	return set
}()

var positiveWeights = map[string]int64{
	"view":           1,
	"click":          2,
	"open_event":     3,
	"open_item":      3,
	"bookmark":       4,
	"share":          4,
	"engaged_read":   2,
	"deep_read":      3,
	"completed_read": 4,
}

var negativeWeights = map[string]int64{
	"not_interested": 4,
	"unsubscribe":    5,
}

func isMilestone(eventType string) bool {
	switch eventType {
	case "engaged_read", "deep_read", "completed_read":
		return true
	default:
		return false
	}
}

var allowedRecordFields = map[string]struct{}{
	"type":     {},
	"itemId":   {},
	"eventId":  {},
	"source":   {},
	"topics":   {},
	"entities": {},
	"url":      {},
}

// recordInput 是通过 ValidationPipe 与自定义校验之后的原始字符串。
// 服务层再做大小写、空白和长度规范化。
type recordInput struct {
	eventType string
	itemID    string
	eventID   string
	source    string
	topics    []string
	entities  []string
	url       string
}

// validateRecordBody 复刻 ValidationPipe（whitelist、forbidNonWhitelisted、
// forbidUnknownValues、transform）加上 validateRecordUserNewsBehaviorDto。
//
// 返回的 message 已经是 GlobalExceptionFilter 的形态：class-validator
// 的 message 数组用 "; " 拼成一个字符串；自定义 BadRequestException
// 本来就是一个字符串。两者都进 WriteBadRequest 的 message 字段。
func validateRecordBody(raw []byte) (recordInput, string) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return recordInput{}, isInTypeMessage()
	}
	switch raw[0] {
	case '{':
		return validateRecordObject(raw)
	case '[':
		return recordInput{}, arrayRootMessage(raw)
	default:
		// null / 布尔 / 数字 / 字符串：ValidationPipe 把实体换成只有
		// constructor 的对象，type 缺失，只报 IsIn。
		return recordInput{}, isInTypeMessage()
	}
}

func isInTypeMessage() string {
	return "type must be one of the following values: " + strings.Join(eventTypes, ", ")
}

func arrayRootMessage(raw []byte) string {
	var elems []json.RawMessage
	if err := json.Unmarshal(raw, &elems); err != nil {
		return isInTypeMessage()
	}
	msgs := make([]string, 0, len(elems)+1)
	for i := range elems {
		msgs = append(msgs, fmt.Sprintf("property %d should not exist", i))
	}
	msgs = append(msgs, isInTypeMessage())
	return strings.Join(msgs, "; ")
}

func validateRecordObject(raw []byte) (recordInput, string) {
	order, fields, err := objectFields(raw)
	if err != nil {
		return recordInput{}, isInTypeMessage()
	}

	var msgs []string
	// Object.keys 先按数组下标升序，再按其余键的插入顺序。
	for _, key := range jsEnumKeys(order) {
		if _, ok := allowedRecordFields[key]; ok {
			continue
		}
		msgs = append(msgs, "property "+key+" should not exist")
	}

	var in recordInput
	if msg, value, ok := typeFieldMessage(fields["type"]); !ok {
		msgs = append(msgs, msg)
	} else {
		in.eventType = value
	}

	if fieldMsgs, value, ok := stringFieldErrors("itemId", fields["itemId"], 128); len(fieldMsgs) > 0 {
		msgs = append(msgs, fieldMsgs...)
	} else if ok {
		in.itemID = value
	}
	if fieldMsgs, value, ok := stringFieldErrors("eventId", fields["eventId"], 128); len(fieldMsgs) > 0 {
		msgs = append(msgs, fieldMsgs...)
	} else if ok {
		in.eventID = value
	}
	if fieldMsgs, value, ok := stringFieldErrors("source", fields["source"], 160); len(fieldMsgs) > 0 {
		msgs = append(msgs, fieldMsgs...)
	} else if ok {
		in.source = value
	}
	if fieldMsgs, values := arrayFieldMessages("topics", fields["topics"]); len(fieldMsgs) > 0 {
		msgs = append(msgs, fieldMsgs...)
	} else {
		in.topics = values
	}
	if fieldMsgs, values := arrayFieldMessages("entities", fields["entities"]); len(fieldMsgs) > 0 {
		msgs = append(msgs, fieldMsgs...)
	} else {
		in.entities = values
	}
	if fieldMsgs, value, ok := stringFieldErrors("url", fields["url"], 2048); len(fieldMsgs) > 0 {
		msgs = append(msgs, fieldMsgs...)
	} else if ok {
		in.url = value
	}

	if len(msgs) > 0 {
		return recordInput{}, strings.Join(msgs, "; ")
	}
	if msg := customRecordMessage(in); msg != "" {
		return recordInput{}, msg
	}
	return in, ""
}

// objectFields 保留 JSON 键的首次出现顺序（重复键取最后一次的值）。
// stripProtoKeys 会删掉 __proto__，它不参与 whitelist。
func objectFields(raw []byte) ([]string, map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, nil, fmt.Errorf("not an object")
	}
	order := make([]string, 0)
	fields := make(map[string]json.RawMessage)
	seen := make(map[string]struct{})
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, nil, fmt.Errorf("object key")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, nil, err
		}
		if key == "__proto__" {
			continue
		}
		if _, exists := seen[key]; !exists {
			seen[key] = struct{}{}
			order = append(order, key)
		}
		fields[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	return order, fields, nil
}

func typeFieldMessage(raw json.RawMessage) (string, string, bool) {
	if len(bytes.TrimSpace(raw)) == 0 || jsonKind(raw) != "string" {
		return isInTypeMessage(), "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return isInTypeMessage(), "", false
	}
	if _, ok := eventTypeSet[value]; !ok {
		return isInTypeMessage(), "", false
	}
	return "", value, true
}

// stringFieldErrors 按装饰器自下而上的注册顺序报错：MaxLength 然后 IsString。
// null 与缺失由 IsOptional 跳过。
func stringFieldErrors(name string, raw json.RawMessage, maxLen int) ([]string, string, bool) {
	if len(bytes.TrimSpace(raw)) == 0 || jsonKind(raw) == "null" {
		return nil, "", false
	}
	if jsonKind(raw) != "string" {
		return []string{
			fmt.Sprintf("%s must be shorter than or equal to %d characters", name, maxLen),
			name + " must be a string",
		}, "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return []string{name + " must be a string"}, "", false
	}
	if codePointLen(value) > maxLen {
		return []string{
			fmt.Sprintf("%s must be shorter than or equal to %d characters", name, maxLen),
		}, "", false
	}
	return nil, value, true
}

// arrayFieldMessages 的约束顺序是 IsString({each})、ArrayMaxSize、IsArray。
// each 在值不是数组时，class-validator 对整个值跑一次 isString。
func arrayFieldMessages(name string, raw json.RawMessage) ([]string, []string) {
	if len(bytes.TrimSpace(raw)) == 0 || jsonKind(raw) == "null" {
		return nil, nil
	}
	if jsonKind(raw) != "array" {
		var msgs []string
		if jsonKind(raw) != "string" {
			msgs = append(msgs, "each value in "+name+" must be a string")
		}
		msgs = append(msgs,
			name+" must contain no more than 12 elements",
			name+" must be an array",
		)
		return msgs, nil
	}
	var elems []json.RawMessage
	if err := json.Unmarshal(raw, &elems); err != nil {
		return []string{name + " must be an array"}, nil
	}
	values := make([]string, 0, len(elems))
	allStrings := true
	for _, elem := range elems {
		if jsonKind(elem) != "string" {
			allStrings = false
			continue
		}
		var value string
		if err := json.Unmarshal(elem, &value); err != nil {
			allStrings = false
			continue
		}
		values = append(values, value)
	}
	var msgs []string
	if !allStrings {
		msgs = append(msgs, "each value in "+name+" must be a string")
		values = nil
	}
	if len(elems) > 12 {
		msgs = append(msgs, name+" must contain no more than 12 elements")
		values = nil
	}
	return msgs, values
}

// jsEnumKeys 复刻对象的 Object.keys：规范数组下标在前（升序），
// 其他键保持首次出现顺序。
func jsEnumKeys(keys []string) []string {
	indices := make([]string, 0)
	rest := make([]string, 0, len(keys))
	for _, key := range keys {
		if canonicalArrayIndex(key) {
			indices = append(indices, key)
		} else {
			rest = append(rest, key)
		}
	}
	sort.SliceStable(indices, func(i, j int) bool {
		if len(indices[i]) != len(indices[j]) {
			return len(indices[i]) < len(indices[j])
		}
		return indices[i] < indices[j]
	})
	return append(indices, rest...)
}

func canonicalArrayIndex(key string) bool {
	// 规范数组下标是 0 .. 2^32-2，不允许前导零。超过 10 位一定越界。
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return false
	}
	var n uint64
	for _, r := range key {
		if r < '0' || r > '9' {
			return false
		}
		n = n*10 + uint64(r-'0')
		if n >= 4294967295 {
			return false
		}
	}
	return true
}

func jsonKind(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "empty"
	}
	switch raw[0] {
	case '"':
		return "string"
	case '{':
		return "object"
	case '[':
		return "array"
	case 't', 'f':
		return "bool"
	case 'n':
		return "null"
	default:
		return "number"
	}
}

func customRecordMessage(in recordInput) string {
	itemID := trimJS(in.itemID)
	eventID := trimJS(in.eventID)
	source := trimJS(in.source)
	topics := trimNonEmpty(in.topics)
	entities := trimNonEmpty(in.entities)

	if isMilestone(in.eventType) && itemID == "" {
		return "itemId is required for reading milestone events"
	}
	if in.eventType == "not_interested" {
		if len(topics) > 1 || len(entities) > 1 {
			return "not_interested only supports a single topic or entity target"
		}
		families := 0
		if itemID != "" {
			families++
		}
		if eventID != "" {
			families++
		}
		if source != "" {
			families++
		}
		if len(topics) > 0 {
			families++
		}
		if len(entities) > 0 {
			families++
		}
		if families != 1 {
			return "not_interested requires exactly one target family"
		}
	}
	if in.eventType == "unsubscribe" {
		if len(topics) > 1 || len(entities) > 1 {
			return "unsubscribe only supports a single topic or entity target"
		}
		hasTopic := len(topics) > 0
		hasEntity := len(entities) > 0
		if itemID != "" || eventID != "" || source != "" || hasTopic == hasEntity {
			return "unsubscribe requires exactly one topic or one entity target"
		}
	}
	return ""
}

func trimNonEmpty(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := trimJS(value)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}
