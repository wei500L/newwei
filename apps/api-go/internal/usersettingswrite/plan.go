package usersettingswrite

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
)

// segment 是一次 PUT 里真正要 upsert 的一段。Key 只能是 usersettings
// 包的编译期常量，由本文件的端点表绑定，不从请求字段名映射成任意 key。
type segment struct {
	Key   usersettings.SettingKey
	Value []byte
}

// inputError 是 DTO 顶层校验失败（ValidationPipe + forbidNonWhitelisted）。
// Message 已经是 GlobalExceptionFilter 用 "; " 拼好的单行文案。
type inputError struct {
	Message string
}

func (e *inputError) Error() string { return e.Message }

// fieldSpec 描述一个 DTO 顶层可选字段。
type fieldSpec struct {
	name      string
	kind      string // "object" 或 "array"（显式 null 合法，类型不对才拒绝）
	key       usersettings.SettingKey
	normalize func(raw []byte) (any, error)
}

// Plan 按 NestJS DTO + service 的写入条件决定要 upsert 哪些固定 key。
//
// 五个单 key：只有 settings 出现（含显式 null）才写；字段缺失不写。
// Situation Monitor：monitors/layout/settings 各自出现才写对应固定 key，
// 三段之间没有事务。空对象 `{}` 不产生任何 segment。
//
// 顶层 JSON 不是对象（null/数组/标量）时，Nest ValidationPipe 对「全部
// 可选字段」的 DTO 不会 400，service 读到的字段都是 undefined——这里
// 同样不写。字段类型错误与未知顶层字段才是 400，且互不合并成一种情况。
func Plan(path string, body []byte) ([]segment, error) {
	fields, nonObject, err := decodeTopLevel(body)
	if err != nil {
		return nil, err
	}
	if nonObject {
		return nil, nil
	}
	specs := specsFor(path)
	if specs == nil {
		return nil, &inputError{Message: "unknown user-settings path"}
	}
	allowed := make(map[string]fieldSpec, len(specs))
	for _, spec := range specs {
		allowed[spec.name] = spec
	}

	var messages []string
	for _, spec := range specs {
		raw, ok := fields[spec.name]
		if !ok {
			continue
		}
		kind := jsonKind(raw)
		if kind == "null" {
			continue
		}
		if kind != spec.kind {
			if spec.kind == "array" {
				messages = append(messages, spec.name+" must be an array")
			} else {
				messages = append(messages, spec.name+" must be an object")
			}
		}
	}
	for _, key := range topLevelOrder(body) {
		if _, ok := allowed[key]; ok {
			continue
		}
		messages = append(messages, "property "+key+" should not exist")
	}
	if len(messages) > 0 {
		return nil, &inputError{Message: strings.Join(messages, "; ")}
	}

	var out []segment
	for _, spec := range specs {
		raw, ok := fields[spec.name]
		if !ok {
			continue
		}
		normalized, err := spec.normalize(raw)
		if err != nil {
			return nil, err
		}
		stored, err := json.Marshal(normalized)
		if err != nil {
			return nil, err
		}
		out = append(out, segment{Key: spec.key, Value: stored})
	}
	return out, nil
}

func specsFor(path string) []fieldSpec {
	switch path {
	case usersettingsread.Paths[0]:
		return []fieldSpec{settingsField(usersettings.OnboardingKey, func(raw []byte) (any, error) {
			return usersettings.NormalizeOnboarding(raw), nil
		})}
	case usersettingsread.Paths[1]:
		return []fieldSpec{settingsField(usersettings.RSSReaderKey, func(raw []byte) (any, error) {
			return usersettings.NormalizeRSSReader(raw), nil
		})}
	case usersettingsread.Paths[2]:
		return []fieldSpec{settingsField(usersettings.SpacetimeTimelineKey, func(raw []byte) (any, error) {
			return usersettings.NormalizeSpacetimeTimeline(raw), nil
		})}
	case usersettingsread.Paths[3]:
		return []fieldSpec{settingsField(usersettings.WarMapKey, func(raw []byte) (any, error) {
			return usersettings.NormalizeWarMap(raw), nil
		})}
	case usersettingsread.Paths[4]:
		return []fieldSpec{settingsField(usersettings.NewsnowKey, func(raw []byte) (any, error) {
			return usersettings.NormalizeNewsnow(raw), nil
		})}
	case usersettingsread.Paths[5]:
		return []fieldSpec{
			{
				name: "monitors",
				kind: "array",
				key:  usersettings.SituationMonitorMonitorsKey,
				normalize: func(raw []byte) (any, error) {
					return usersettings.NormalizeSituationMonitors(raw), nil
				},
			},
			{
				name: "layout",
				kind: "object",
				key:  usersettings.SituationMonitorLayoutKey,
				normalize: func(raw []byte) (any, error) {
					return usersettings.NormalizeSituationLayout(raw), nil
				},
			},
			{
				name: "settings",
				kind: "object",
				key:  usersettings.SituationMonitorSettingsKey,
				normalize: func(raw []byte) (any, error) {
					return usersettings.NormalizeSituationSettings(raw), nil
				},
			},
		}
	default:
		return nil
	}
}

func settingsField(key usersettings.SettingKey, normalize func([]byte) (any, error)) fieldSpec {
	return fieldSpec{name: "settings", kind: "object", key: key, normalize: normalize}
}

// decodeTopLevel 解析一个 JSON 值。对象返回字段表（重复 key 保留最后
// 一次的值）。null/数组/标量返回 nonObject=true。尾随多余 JSON 与
// 语法错误都是 inputError。
func decodeTopLevel(body []byte) (map[string]json.RawMessage, bool, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil, false, &inputError{Message: "invalid json"}
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, false, &inputError{Message: "invalid json"}
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, true, nil
	}
	fields := make(map[string]json.RawMessage)
	obj := json.NewDecoder(bytes.NewReader(trimmed))
	if _, err := obj.Token(); err != nil {
		return nil, false, &inputError{Message: "invalid json"}
	}
	for obj.More() {
		keyTok, err := obj.Token()
		if err != nil {
			return nil, false, &inputError{Message: "invalid json"}
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, false, &inputError{Message: "invalid json"}
		}
		var value json.RawMessage
		if err := obj.Decode(&value); err != nil {
			return nil, false, &inputError{Message: "invalid json"}
		}
		fields[key] = value
	}
	return fields, false, nil
}

// topLevelOrder 按 JSON 原文首次出现顺序给出顶层 key（未知字段报错顺序）。
func topLevelOrder(body []byte) []string {
	dec := json.NewDecoder(bytes.NewReader(body))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	obj := json.NewDecoder(bytes.NewReader(trimmed))
	if _, err := obj.Token(); err != nil {
		return nil
	}
	var order []string
	seen := map[string]bool{}
	for obj.More() {
		keyTok, err := obj.Token()
		if err != nil {
			return order
		}
		key, ok := keyTok.(string)
		if !ok {
			return order
		}
		var value json.RawMessage
		if err := obj.Decode(&value); err != nil {
			return order
		}
		if !seen[key] {
			seen[key] = true
			order = append(order, key)
		}
	}
	return order
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
	default:
		return "other"
	}
}
