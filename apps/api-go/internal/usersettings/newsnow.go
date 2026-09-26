// NewsNow UI 设置的 normalization 契约（Go-批3B）。
//
// 契约对齐（NestJS normalizeNewsnowUiSettings 及其内部函数，
// apps/api/src/modules/user-settings/user-settings.service.ts:629-820）：
//   - 存储 key：ui:newsnow:settings:v1（NewsnowKey，repository.go）；
//   - value 不是 JSON 对象（null/数组/标量/解析失败）→ 默认设置对象；
//   - focusSources：数组内字符串 trim 后须匹配 ^[a-z0-9_-]{1,64}$（i——
//     大小写不敏感的 ASCII），稳定去重（保留首现），最多 200 项
//     （push 后 break——恰取前 200 个合法不重复项）；
//   - columnOrders：对象 → Object.entries 插入序遍历；列 key 同样过
//     source id pattern；value 是数组则按 focusSources 同款规整（上限
//     200）；空列表的列丢弃；最多 32 个列（上限达到即停止——「前 N
//     项」依赖 key 出现顺序，必须有序解码，见 orderedEntries）；
//   - hideCrossSourceDuplicates：Boolean(record.hideCrossSourceDuplicates)
//     的 JavaScript 真值语义——非空字符串/非零数字/true 都是真；
//   - sortMode：仅 "smart"/"personalized" → "personalized"，其余
//     （含缺失）→ "manual"；
//   - densityMode：仅 "comfortable" 保留，其余 "compact"；
//   - sourceAffinity：对象 → Object.entries 插入序遍历；source id 过
//     pattern；value 必须是非数组对象，否则丢弃；字段 clamp：score 浮点
//     [0,100]（不取整）；openOriginalCount/openEventCount/openItemCount/
//     refreshCount/focusCount 整数 [0,1e6]；accumulatedDwellMs [0,
//     365*24*60*60*1000]；lastInteractedAt [0,9_999_999_999_999]；全部
//     round；最多 300 个 entry（上限即停止）。
//
// 有序对象（columnOrders/sourceAffinity）：NestJS 的 Object.entries 顺序
// = JSON 解析后的插入序。Go 的 map[string]any 不保序——用 orderedEntries
// （situationmonitor.go）按出现顺序流式读取，仅覆盖这两个「前 N 项」
// 语义点，不扩展成通用框架。
package usersettings

import "encoding/json"

const (
	// maxNewsnowSourceIDs 与 NestJS MAX_NEWSNOW_SOURCE_IDS 一致。
	maxNewsnowSourceIDs = 200
	// maxNewsnowColumns 与 NestJS MAX_NEWSNOW_COLUMNS 一致。
	maxNewsnowColumns = 32
	// maxNewsnowAffinities 与 NestJS MAX_NEWSNOW_AFFINITIES 一致。
	maxNewsnowAffinities = 300
	// maxNewsnowDwellMs 与 accumulatedDwellMs 上限一致（365 天毫秒）。
	maxNewsnowDwellMs = 365 * 24 * 60 * 60 * 1000
	// maxNewsnowLastInteractedAt 与 lastInteractedAt 上限一致。
	maxNewsnowLastInteractedAt = 9_999_999_999_999
	// maxNewsnowIntCount 与各 count 字段上限一致。
	maxNewsnowIntCount = 1_000_000
)

// NewsnowSourceAffinity 对齐 NestJS NewsnowSourceAffinitySettings。
type NewsnowSourceAffinity struct {
	Score             float64 `json:"score"`
	OpenOriginalCount int     `json:"openOriginalCount"`
	OpenEventCount    int     `json:"openEventCount"`
	OpenItemCount     int     `json:"openItemCount"`
	RefreshCount      int     `json:"refreshCount"`
	FocusCount        int     `json:"focusCount"`
	AccumulatedDwellMs int    `json:"accumulatedDwellMs"`
	LastInteractedAt  int     `json:"lastInteractedAt"`
}

// NewsnowSettings 对齐 NestJS NewsnowUiSettings。ColumnOrders 与
// SourceAffinity 承载 JSON 对象（Object.entries 顺序保留——见
// newsnowColumnPair/newsnowAffinityPair 的有序 pairs + 自定义 MarshalJSON：
// 空对象 {}，非空按出现顺序展开）。这里自定义整个结构体的 MarshalJSON
// 以保持字段顺序与对象形态。
type NewsnowSettings struct {
	FocusSources               []string              `json:"focusSources"`
	ColumnOrders               []newsnowColumnPair   `json:"columnOrders"`
	HideCrossSourceDuplicates  bool                  `json:"hideCrossSourceDuplicates"`
	SortMode                   string                `json:"sortMode"`
	DensityMode                string                `json:"densityMode"`
	SourceAffinity             []newsnowAffinityPair `json:"sourceAffinity"`
}

// MarshalJSON 固定字段顺序 + columnOrders/sourceAffinity 序列化为
//（有序）JSON 对象。
func (n NewsnowSettings) MarshalJSON() ([]byte, error) {
	columns, err := n.marshalColumnOrders()
	if err != nil {
		return nil, err
	}
	affinities, err := n.marshalSourceAffinity()
	if err != nil {
		return nil, err
	}
	focus, err := json.Marshal(n.FocusSources)
	if err != nil {
		return nil, err
	}
	hide, err := json.Marshal(n.HideCrossSourceDuplicates)
	if err != nil {
		return nil, err
	}
	sortMode, err := json.Marshal(n.SortMode)
	if err != nil {
		return nil, err
	}
	density, err := json.Marshal(n.DensityMode)
	if err != nil {
		return nil, err
	}
	return []byte(`{"focusSources":` + string(focus) +
		`,"columnOrders":` + string(columns) +
		`,"hideCrossSourceDuplicates":` + string(hide) +
		`,"sortMode":` + string(sortMode) +
		`,"densityMode":` + string(density) +
		`,"sourceAffinity":` + string(affinities) + `}`), nil
}

// newsnowColumnPair 是 columnOrders 的一个有序 entry（key → 有序列表；
// Go 值列表本身有序，无需特殊处理）。
type newsnowColumnPair struct {
	Key    string   `json:"k"`
	Values []string `json:"v"`
}

// newsnowAffinityPair 是 sourceAffinity 的一个有序 entry。
type newsnowAffinityPair struct {
	Key      string                `json:"k"`
	Affinity NewsnowSourceAffinity `json:"v"`
}

// NewsnowResponse 是 GET /api/user-settings/ui/newsnow 的响应体。
type NewsnowResponse struct {
	Version   int `json:"version"`
	UpdatedAt struct {
		Settings string `json:"settings,omitempty"`
	} `json:"updatedAt"`
	Settings *NewsnowSettings `json:"settings"`
}

// BuildNewsnowResponse 输入数据库记录，输出完整响应。
func BuildNewsnowResponse(record Record) NewsnowResponse {
	var response NewsnowResponse
	response.Version = 1
	if !record.Found {
		return response
	}
	response.UpdatedAt.Settings = formatJSISO(record.UpdatedAt)
	settings := NormalizeNewsnow(record.Value)
	response.Settings = &settings
	return response
}

// NormalizeNewsnow 复刻 normalizeNewsnowUiSettings
//（user-settings.service.ts:803-820）。
func NormalizeNewsnow(raw []byte) NewsnowSettings {
	settings := defaultNewsnow()

	value, ok := asJSONObject(raw)
	if !ok {
		return settings
	}

	settings.FocusSources = normalizeNewsnowSourceList(value["focusSources"], maxNewsnowSourceIDs)
	settings.ColumnOrders = normalizeNewsnowColumnOrders(extractRawField(raw, "columnOrders"))
	settings.HideCrossSourceDuplicates = jsTruthy(value["hideCrossSourceDuplicates"])
	settings.SortMode = normalizeNewsnowSortMode(value["sortMode"])
	settings.DensityMode = normalizeNewsnowDensityMode(value["densityMode"])
	settings.SourceAffinity = normalizeNewsnowSourceAffinity(extractRawField(raw, "sourceAffinity"))
	return settings
}

// defaultNewsnow 与 createDefaultNewsnowUiSettings 一致（columnOrders 与
// sourceAffinity 为空对象——经自定义 MarshalJSON 序列化为 {}，非数组）。
func defaultNewsnow() NewsnowSettings {
	return NewsnowSettings{
		FocusSources: []string{},
		ColumnOrders: []newsnowColumnPair{},
		SortMode:     "manual",
		DensityMode:  "compact",
		SourceAffinity: []newsnowAffinityPair{},
	}
}

// marshalOrderedPairs 把有序 pairs 序列化为 JSON 对象（保持顺序；空 → {}）。
func marshalOrderedPairs[T any](pairs []pair[T]) ([]byte, error) {
	var buf []byte
	buf = append(buf, '{')
	for i, entry := range pairs {
		if i > 0 {
			buf = append(buf, ',')
		}
		// key 用 json.Marshal 的字符串转义（与 encoding/json 转义规则一致）。
		key, err := json.Marshal(entry.key)
		if err != nil {
			return nil, err
		}
		buf = append(buf, key...)
		buf = append(buf, ':')
		value, err := json.Marshal(entry.value)
		if err != nil {
			return nil, err
		}
		buf = append(buf, value...)
	}
	buf = append(buf, '}')
	return buf, nil
}

// pair 是有序 entry 的泛型形态（marshalOrderedPairs 的输入）。
type pair[T any] struct {
	key   string
	value T
}

func (n NewsnowSettings) marshalColumnOrders() ([]byte, error) {
	pairs := make([]pair[any], 0, len(n.ColumnOrders))
	for _, entry := range n.ColumnOrders {
		pairs = append(pairs, pair[any]{key: entry.Key, value: entry.Values})
	}
	return marshalOrderedPairs(pairs)
}

func (n NewsnowSettings) marshalSourceAffinity() ([]byte, error) {
	pairs := make([]pair[any], 0, len(n.SourceAffinity))
	for _, entry := range n.SourceAffinity {
		pairs = append(pairs, pair[any]{key: entry.Key, value: entry.Affinity})
	}
	return marshalOrderedPairs(pairs)
}

// normalizeNewsnowSourceId：字符串 trim 后非空且匹配
// ^[a-z0-9_-]{1,64}$/i（NestJS normalizeNewsnowSourceId——注意 trim 后
// 不再截断：pattern 限长 64）。
func normalizeNewsnowSourceID(value any) (string, bool) {
	s, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := trimSpace(s)
	if trimmed == "" || len(trimmed) > 64 {
		return "", false
	}
	for i := 0; i < len(trimmed); i++ {
		c := trimmed[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return "", false
		}
	}
	return trimmed, true
}

// normalizeNewsnowSourceList：数组 → 逐项 normalize + 稳定去重 + 上限
//（NestJS normalizeNewsnowSourceList——push 后 break）。
func normalizeNewsnowSourceList(value any, maxCount int) []string {
	entries, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := []string{}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		normalized, ok := normalizeNewsnowSourceID(entry)
		if !ok {
			continue
		}
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) >= maxCount {
			break
		}
	}
	return out
}

// normalizeNewsnowColumnOrders：对象 → 有序 entries，每列 key 过 pattern、
// value 列表规整（空列表丢弃），最多 32 列（Object.entries 顺序 + 上限
// 即停止）。raw 是该字段的原始 JSON 字节（extractRawField 提取——
// map 解码不保序，「前 N 列」语义必须按出现顺序）。
func normalizeNewsnowColumnOrders(raw []byte) []newsnowColumnPair {
	entries, ok := orderedEntries(raw)
	if !ok {
		return []newsnowColumnPair{}
	}
	out := []newsnowColumnPair{}
	for _, entry := range entries {
		if len(out) >= maxNewsnowColumns {
			break
		}
		column, ok := normalizeNewsnowSourceID(entry.key)
		if !ok {
			continue
		}
		var rawList any
		if err := json.Unmarshal(entry.value, &rawList); err != nil {
			continue
		}
		values := normalizeNewsnowSourceList(rawList, maxNewsnowSourceIDs)
		if len(values) == 0 {
			continue
		}
		out = append(out, newsnowColumnPair{Key: column, Values: values})
	}
	return out
}

// normalizeNewsnowSourceAffinity：对象 → 有序 entries，source id 过
// pattern、value 非数组对象才保留，最多 300 个（同上——顺序语义）。
func normalizeNewsnowSourceAffinity(raw []byte) []newsnowAffinityPair {
	entries, ok := orderedEntries(raw)
	if !ok {
		return []newsnowAffinityPair{}
	}
	out := []newsnowAffinityPair{}
	for _, entry := range entries {
		if len(out) >= maxNewsnowAffinities {
			break
		}
		sourceID, ok := normalizeNewsnowSourceID(entry.key)
		if !ok {
			continue
		}
		var rawAffinity any
		if err := json.Unmarshal(entry.value, &rawAffinity); err != nil {
			continue
		}
		affinity, ok := normalizeNewsnowAffinity(rawAffinity)
		if !ok {
			continue
		}
		out = append(out, newsnowAffinityPair{Key: sourceID, Affinity: affinity})
	}
	return out
}

// normalizeNewsnowAffinity 单个 source 的亲和统计（NestJS 内联对象）。
func normalizeNewsnowAffinity(value any) (NewsnowSourceAffinity, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return NewsnowSourceAffinity{}, false
	}
	return NewsnowSourceAffinity{
		Score:              clampNewsnowFloat(record["score"], 0, 100),
		OpenOriginalCount:  clampNewsnowInt(record["openOriginalCount"], 0, maxNewsnowIntCount),
		OpenEventCount:     clampNewsnowInt(record["openEventCount"], 0, maxNewsnowIntCount),
		OpenItemCount:      clampNewsnowInt(record["openItemCount"], 0, maxNewsnowIntCount),
		RefreshCount:       clampNewsnowInt(record["refreshCount"], 0, maxNewsnowIntCount),
		FocusCount:         clampNewsnowInt(record["focusCount"], 0, maxNewsnowIntCount),
		AccumulatedDwellMs: clampNewsnowInt(record["accumulatedDwellMs"], 0, maxNewsnowDwellMs),
		LastInteractedAt:   clampNewsnowInt(record["lastInteractedAt"], 0, maxNewsnowLastInteractedAt),
	}, true
}

// clampNewsnowInt 复刻 clampNewsnowInt（640-658）：非数字/非有限 → 0
//（fallback 默认）；clamp 后 round 取整。
func clampNewsnowInt(value any, min, max int64) int {
	f, ok := value.(float64)
	if !ok {
		return 0
	}
	if f < float64(min) {
		return int(min)
	}
	if f > float64(max) {
		return int(max)
	}
	return int(jsRound(f))
}

// clampNewsnowFloat 复刻 clampNewsnowFloat（660-678）：非数字 → 0；
// clamp 不取整。
func clampNewsnowFloat(value any, min, max float64) float64 {
	f, ok := value.(float64)
	if !ok {
		return 0
	}
	return clampFloatValue(f, min, max)
}

// normalizeNewsnowSortMode 复刻 normalizeNewsnowSortMode（793-797）：
// "smart"/"personalized" → "personalized"（smart 归一），其余 → "manual"。
func normalizeNewsnowSortMode(value any) string {
	if s, ok := value.(string); ok && (s == "smart" || s == "personalized") {
		return "personalized"
	}
	return "manual"
}

// normalizeNewsnowDensityMode 复刻 normalizeNewsnowDensityMode（799-801）：
// 仅 "comfortable" 保留，其余 "compact"。
func normalizeNewsnowDensityMode(value any) string {
	if s, ok := value.(string); ok && s == "comfortable" {
		return "comfortable"
	}
	return "compact"
}

// jsTruthy 复刻 JavaScript Boolean() 真值：false/""/0/NaN/null/undefined
// 为假，其余为真。JSON 反序列化后 any 的零值形态：nil（null）、bool、
// float64（0 为假）、string（空为假）。JSON 无法表达 undefined/NaN。
func jsTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}
