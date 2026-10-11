package analysiscollab

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	checkString     = "string"
	checkMax        = "max"
	checkEnum       = "enum"
	checkBool       = "bool"
	checkInt        = "int"
	checkMin        = "min"
	checkArray      = "array"
	checkEachString = "eachString"
	checkDate       = "date"
)

type check struct {
	kind string
	n    int
	enum []string
}

// Spec 是一个 DTO 字段。Checks 的顺序是 class-validator 元数据顺序：
// 靠近属性的装饰器先登记。Optional 在 null 和缺失时跳过全部检查。
type Spec struct {
	Name     string
	Optional bool
	Checks   []check
}

// Body 是通过 ValidationPipe 之后的字段。Has 区分缺失和显式 null。
type Body struct {
	has    map[string]bool
	nulls  map[string]bool
	text   map[string]string
	flags  map[string]bool
	ints   map[string]int
	lists  map[string][]string
}

func (b Body) Has(name string) bool  { return b.has[name] }
func (b Body) Null(name string) bool { return b.nulls[name] }

func (b Body) String(name string) string {
	return b.text[name]
}

func (b Body) StringPtr(name string) *string {
	if !b.Has(name) || b.Null(name) {
		if b.Null(name) {
			return nil
		}
		return nil
	}
	value := b.text[name]
	return &value
}

func (b Body) Bool(name string) bool { return b.flags[name] }
func (b Body) Int(name string) int   { return b.ints[name] }
func (b Body) Strings(name string) []string {
	return b.lists[name]
}

// ValidateBody 复刻 whitelist、forbidNonWhitelisted 和字段约束。
// raw 为空表示 body-parser 没有 JSON，按空对象处理。
func ValidateBody(raw []byte, specs []Spec) (Body, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if raw[0] != '{' {
		return Body{}, BadRequest("an unknown value was passed to the validate function")
	}
	order, fields, err := objectFields(raw)
	if err != nil {
		return Body{}, BadRequest(invalidJSONMessage(raw))
	}
	return validateFields(order, fields, specs)
}

// ValidateRawQuery 复刻 @Query() DTO。重复键按数组处理，因此会通不过 IsString。
func ValidateRawQuery(rawQuery string, specs []Spec) (Body, error) {
	order, fields := queryFields(rawQuery)
	return validateFields(order, fields, specs)
}

func validateFields(order []string, fields map[string]json.RawMessage, specs []Spec) (Body, error) {
	body := Body{
		has:   map[string]bool{},
		nulls: map[string]bool{},
		text:  map[string]string{},
		flags: map[string]bool{},
		ints:  map[string]int{},
		lists: map[string][]string{},
	}
	var messages []string
	allowed := make(map[string]struct{}, len(specs))
	for _, spec := range specs {
		allowed[spec.Name] = struct{}{}
		raw, present := fields[spec.Name]
		if !present || isJSONNull(raw) {
			if spec.Optional {
				if present && isJSONNull(raw) {
					body.has[spec.Name] = true
					body.nulls[spec.Name] = true
				}
				continue
			}
			messages = append(messages, failedChecks(spec, nil)...)
			continue
		}
		stored, failed := applyChecks(spec, raw)
		if len(failed) > 0 {
			messages = append(messages, failed...)
			continue
		}
		body.has[spec.Name] = true
		switch value := stored.(type) {
		case string:
			body.text[spec.Name] = value
		case bool:
			body.flags[spec.Name] = value
		case int:
			body.ints[spec.Name] = value
		case []string:
			body.lists[spec.Name] = value
		}
	}
	for _, key := range order {
		if _, ok := allowed[key]; ok {
			continue
		}
		messages = append(messages, "property "+key+" should not exist")
	}
	if len(messages) > 0 {
		return Body{}, BadRequest(strings.Join(messages, "; "))
	}
	return body, nil
}

func failedChecks(spec Spec, raw json.RawMessage) []string {
	_, messages := applyChecks(spec, raw)
	return messages
}

func applyChecks(spec Spec, raw json.RawMessage) (any, []string) {
	var messages []string
	var stored any
	for _, item := range spec.Checks {
		value, message, ok := runCheck(spec.Name, item, raw)
		if !ok {
			messages = append(messages, message)
			continue
		}
		if value != nil {
			stored = value
		}
	}
	if len(messages) > 0 {
		return nil, messages
	}
	return stored, nil
}

func runCheck(name string, item check, raw json.RawMessage) (any, string, bool) {
	switch item.kind {
	case checkString:
		value, ok := jsonString(raw)
		if !ok {
			return nil, name + " must be a string", false
		}
		return value, "", true
	case checkMax:
		value, ok := jsonString(raw)
		if !ok || JSLen(value) > item.n {
			return nil, name + " must be shorter than or equal to " + strconv.Itoa(item.n) + " characters", false
		}
		return value, "", true
	case checkEnum:
		value, ok := jsonString(raw)
		if !ok || !contains(item.enum, value) {
			return nil, name + " must be one of the following values: " + strings.Join(item.enum, ", "), false
		}
		return value, "", true
	case checkBool:
		value, ok := jsonBool(raw)
		if !ok {
			return nil, name + " must be a boolean value", false
		}
		return value, "", true
	case checkInt:
		value, ok := jsonInt(raw)
		if !ok {
			return nil, name + " must be an integer number", false
		}
		return value, "", true
	case checkMin:
		number, ok := jsonFloat(raw)
		if !ok || number < float64(item.n) {
			return nil, name + " must not be less than " + strconv.Itoa(item.n), false
		}
		return nil, "", true
	case checkArray:
		if !jsonArray(raw) {
			return nil, name + " must be an array", false
		}
		return nil, "", true
	case checkEachString:
		values, ok := jsonStringArray(raw)
		if !ok {
			return nil, "each value in " + name + " must be a string", false
		}
		return values, "", true
	case checkDate:
		value, ok := jsonString(raw)
		if !ok || !isISO8601(value) {
			return nil, name + " must be a valid ISO 8601 date string", false
		}
		return value, "", true
	default:
		return nil, name + " is invalid", false
	}
}

func objectFields(raw []byte) ([]string, map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	token, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return nil, nil, errNotObject
	}
	order := make([]string, 0)
	fields := map[string]json.RawMessage{}
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, nil, errNotObject
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, nil, err
		}
		if _, exists := fields[key]; !exists {
			order = append(order, key)
		}
		fields[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	return order, fields, nil
}

func queryFields(rawQuery string) ([]string, map[string]json.RawMessage) {
	order := make([]string, 0)
	grouped := map[string][]string{}
	if rawQuery == "" {
		return order, map[string]json.RawMessage{}
	}
	for _, part := range strings.Split(rawQuery, "&") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		key = queryDecode(key)
		value = queryDecode(value)
		if _, ok := grouped[key]; !ok {
			order = append(order, key)
		}
		grouped[key] = append(grouped[key], value)
	}
	fields := make(map[string]json.RawMessage, len(grouped))
	for key, values := range grouped {
		if len(values) == 1 {
			encoded, _ := json.Marshal(values[0])
			fields[key] = encoded
			continue
		}
		encoded, _ := json.Marshal(values)
		fields[key] = encoded
	}
	return order, fields
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func jsonString(raw json.RawMessage) (string, bool) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
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

func jsonFloat(raw json.RawMessage) (float64, bool) {
	var value float64
	if err := json.Unmarshal(bytes.TrimSpace(raw), &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

func jsonInt(raw json.RawMessage) (int, bool) {
	value, ok := jsonFloat(raw)
	if !ok || value != math.Trunc(value) || math.Abs(value) > 9007199254740991 {
		return 0, false
	}
	return int(value), true
}

func jsonArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

func jsonStringArray(raw json.RawMessage) ([]string, bool) {
	if !jsonArray(raw) {
		return nil, false
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := jsonString(value)
		if !ok {
			return nil, false
		}
		out = append(out, text)
	}
	return out, true
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func isISO8601(value string) bool {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z07:00",
		"2006-01-02T15:04Z07:00",
		"2006-01-02T15:04:05.000Z",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04Z",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if _, err := time.Parse(layout, value); err == nil {
			return true
		}
	}
	return false
}

// ParseOptionalDate 是 service.normalizeOptionalDate。空白和 null 变成 nil。
func ParseOptionalDate(value *string, field string) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	if strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	parsed, ok := parseServiceDate(*value)
	if !ok {
		return nil, BadRequest(field + " must be a valid date")
	}
	return &parsed, nil
}

func parseServiceDate(value string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z07:00",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04Z07:00",
		"2006-01-02T15:04:05.000",
		"2006-01-02T15:04:05",
		"2006-01-02",
	}
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed.UTC().Truncate(time.Millisecond), true
		}
	}
	return time.Time{}, false
}

func requiredString(name string, maxLength int) Spec {
	return Spec{Name: name, Checks: []check{{kind: checkMax, n: maxLength}, {kind: checkString}}}
}

func optionalString(name string, maxLength int) Spec {
	return Spec{Name: name, Optional: true, Checks: []check{{kind: checkMax, n: maxLength}, {kind: checkString}}}
}

func requiredEnum(name string, values ...string) Spec {
	return Spec{Name: name, Checks: []check{{kind: checkEnum, enum: values}}}
}

func optionalEnum(name string, values ...string) Spec {
	return Spec{Name: name, Optional: true, Checks: []check{{kind: checkEnum, enum: values}}}
}

func optionalBool(name string) Spec {
	return Spec{Name: name, Optional: true, Checks: []check{{kind: checkBool}}}
}

func optionalDate(name string) Spec {
	return Spec{Name: name, Optional: true, Checks: []check{{kind: checkDate}}}
}

func requiredStringArray(name string) Spec {
	return Spec{Name: name, Checks: []check{{kind: checkEachString}, {kind: checkArray}}}
}

func requiredIndex(name string) Spec {
	return Spec{Name: name, Checks: []check{{kind: checkMin, n: 0}, {kind: checkInt}}}
}

func optionalPlainString(name string) Spec {
	return Spec{Name: name, Optional: true, Checks: []check{{kind: checkString}}}
}

// 下面的 Spec 顺序与 DTO 类字段顺序一致。

func ListViewSpecs() []Spec {
	return []Spec{
		optionalPlainString("scope"),
		optionalEnum("surface", SurfaceSearch, SurfaceItems, SurfaceEvents),
	}
}

func CreateViewSpecs() []Spec {
	return []Spec{
		requiredString("title", 120),
		optionalString("description", 1000),
		requiredEnum("surface", SurfaceSearch, SurfaceItems, SurfaceEvents),
		requiredString("routePath", 255),
		optionalString("queryString", 4000),
		optionalEnum("visibility", VisibilityPrivate, VisibilityOrgShared),
	}
}

func UpdateViewSpecs() []Spec {
	return []Spec{
		optionalString("title", 120),
		optionalString("description", 1000),
		optionalString("routePath", 255),
		optionalString("queryString", 4000),
		optionalEnum("visibility", VisibilityPrivate, VisibilityOrgShared),
	}
}

func UpsertThreadSpecs() []Spec {
	return []Spec{optionalString("noteMarkdown", 20000)}
}

func CreateCommentSpecs() []Spec {
	return []Spec{requiredString("bodyMarkdown", 5000)}
}

func UpdateCommentSpecs() []Spec {
	return []Spec{requiredString("bodyMarkdown", 5000)}
}

func CreateBoardSpecs() []Spec {
	return []Spec{requiredString("title", 120), optionalString("description", 1000)}
}

func UpdateBoardSpecs() []Spec {
	return []Spec{optionalString("title", 120), optionalString("description", 1000)}
}

func CreateColumnSpecs() []Spec {
	return []Spec{requiredString("title", 80), optionalString("color", 32), optionalBool("isDone")}
}

func UpdateColumnSpecs() []Spec {
	return []Spec{optionalString("title", 80), optionalString("color", 32), optionalBool("isDone")}
}

func DeleteColumnSpecs() []Spec {
	return []Spec{requiredString("moveCardsToColumnId", 191)}
}

func ReorderColumnSpecs() []Spec {
	return []Spec{requiredStringArray("columnIds")}
}

func CreateTaskSpecs() []Spec {
	return []Spec{
		requiredString("title", 160),
		optionalString("bodyMarkdown", 10000),
		optionalEnum("priority", PriorityLow, PriorityNormal, PriorityHigh, PriorityUrgent),
		optionalString("columnId", 191),
		optionalString("assigneeId", 191),
		optionalEnum("linkedSubjectType", SubjectSavedView, SubjectItem, SubjectEvent),
		optionalString("linkedSubjectId", 191),
		optionalDate("dueAt"),
	}
}

func UpdateTaskSpecs() []Spec {
	return []Spec{
		optionalString("title", 160),
		optionalString("bodyMarkdown", 10000),
		optionalEnum("priority", PriorityLow, PriorityNormal, PriorityHigh, PriorityUrgent),
		optionalString("assigneeId", 191),
		optionalEnum("linkedSubjectType", SubjectSavedView, SubjectItem, SubjectEvent),
		optionalString("linkedSubjectId", 191),
		optionalDate("dueAt"),
	}
}

func MoveTaskSpecs() []Spec {
	return []Spec{requiredString("targetColumnId", 191), requiredIndex("targetIndex")}
}
