// Situation Monitor UI 设置的 normalization 契约（Go-批3B）。
//
// 契约对齐（NestJS getSituationMonitorUiSettings + normalizeMonitors /
// normalizeLayout / normalizeSettings，
// apps/api/src/modules/user-settings/user-settings.service.ts:970-1021 与
// 306-514）：
//   - 存储 key 三个：ui:situation-monitor:{monitors,layout,settings}:v1
//     （SituationMonitor{Monitors,Layout,Settings}Key，repository.go）；
//   - 响应聚合：version=1；updatedAt.{monitors,layout,settings} 各来自
//     对应记录，无记录时该 key 不出现在 updatedAt；monitors/layout/
//     settings 各自无记录时为 null（不是默认值）；
//   - monitors（normalizeMonitors，306-352）：数组内只保留非数组对象；
//     name（trim 后 64 截断）与 keywords（split(",")/trim/去空/去重/
//     最多 30）任一为空则整条丢弃；id 缺失时 fallback "sm-" + 前 10 字符
//     UUID（本包为确定性测试提供 rand 注入点——生产等价 randomUUID）；
//     enabled 缺省 true；color 只接受 #RGB/#RRGGBB（补 #、小写）；location
//     要求 name/lat/lng 全有效且 |lat|<=90、|lng|<=180；createdAt 非有限
//     数字时 fallback 当前时间；最多 20 条（push 后 break）；
//   - layout（normalizeLayout，407-476）：layouts 只接受 lg/md/sm/xs/xxs
//     五个断点的数组（非数组跳过；空数组不写入）；无 lg 时 legacy `layout`
//     数组回退到 lg；每断点最多 64 项；item 要求 i（trim 后 128 截断）非空，
//     x/y 非负取整（缺省 0）、w/h 最小 1 取整（缺省 1）、minW/minH 最小 1
//     取整（缺失时字段不出现）、static 仅布尔（缺失时不出现）；visibility
//     是 map，只保留布尔值项，key trim 后 128 截断且非空，最多 64 个
//     （Object.entries 顺序——见下方有序对象说明）；
//   - settings（normalizeSettings，495-514）：windowHours ∈ {6,24,72}
//     其余 24；scope 仅 "tagged" 否则 "all"；autoRefresh/resetLayoutOnPreset/
//     translateToZh 非布尔时分别回退 true/false/false。
//
// 有序对象语义（visibility）：NestJS 用 Object.entries 按插入序遍历并在
// 达到 64 项上限时停止。encoding/json 的 map 遍历是按 key 排序的，行为
// 会偏离。为此 visibility 的解码用 orderedEntries 的轻量有序读取（保留
// 原始 key 顺序），不复用 map[string]any——这是本包唯一的有序对象点，
// 不是通用 JSON 框架。
package usersettings

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"
	"time"
)

// jsonUnmarshal 与 round 声明别名以集中依赖（jsonUnmarshal = json.Unmarshal；
// round = math.Round——half-away-from-zero，与 Math.round 一致）。
func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }
func round(f float64) float64                { return math.Round(f) }

const (
	// maxSituationMonitors 与 NestJS MAX_MONITORS 一致。
	maxSituationMonitors = 20
	// maxSituationLayoutItemsPerBreakpoint 与 NestJS
	// MAX_LAYOUT_ITEMS_PER_BREAKPOINT 一致。
	maxSituationLayoutItemsPerBreakpoint = 64
	// maxSituationVisibilityKeys 与 NestJS MAX_VISIBILITY_KEYS 一致。
	maxSituationVisibilityKeys = 64
	// maxSituationKeywords 与 NestJS normalizeKeywords 的 slice(0, 30) 一致。
	maxSituationKeywords = 30
	// maxSituationMonitorNameLen 与 NestJS normalizeName 的 slice(0, 64) 一致。
	maxSituationMonitorNameLen = 64
	// maxSituationLayoutItemIDLen 与 normalizeLayoutItem 的 i 截断一致。
	maxSituationLayoutItemIDLen = 128
)

// situationLayoutBreakpoints 与 NestJS SITUATION_MONITOR_LAYOUT_BREAKPOINTS
// 一一对应（顺序也一致——legacy lg 回退检查在遍历后）。
var situationLayoutBreakpoints = [5]string{"lg", "md", "sm", "xs", "xxs"}

// SituationMonitorLocation 是自定义监控项的地点。
type SituationMonitorLocation struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
}

// SituationMonitorCustomMonitor 对齐 NestJS SituationMonitorCustomMonitor。
// Color/Location 为指针：缺失时 omitempty 不出现。
type SituationMonitorCustomMonitor struct {
	ID        string                    `json:"id"`
	Name      string                    `json:"name"`
	Keywords  []string                  `json:"keywords"`
	Enabled   bool                      `json:"enabled"`
	Color     *string                   `json:"color,omitempty"`
	Location  *SituationMonitorLocation `json:"location,omitempty"`
	CreatedAt int64                     `json:"createdAt"`
}

// SituationMonitorLayoutItem 对齐 NestJS SituationMonitorLayoutItem。
type SituationMonitorLayoutItem struct {
	I     string `json:"i"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	W     int    `json:"w"`
	H     int    `json:"h"`
	MinW  *int   `json:"minW,omitempty"`
	MinH  *int   `json:"minH,omitempty"`
	IsStatic *bool `json:"static,omitempty"`
}

// SituationMonitorLayout 对齐 NestJS SituationMonitorLayout。Layouts 是
// 指针 map：断点缺失时 key 不出现（omitempty per-entry 不行——map 整体
// 用 nil 区分空/无；这里值是 []，key 存在与否由 map entry 决定）。
type SituationMonitorLayout struct {
	Layouts    map[string][]SituationMonitorLayoutItem `json:"layouts"`
	Visibility map[string]bool                         `json:"visibility"`
}

// SituationMonitorSettings 对齐 NestJS SituationMonitorSettings。
type SituationMonitorSettings struct {
	WindowHours        int    `json:"windowHours"`
	Scope              string `json:"scope"`
	AutoRefresh        bool   `json:"autoRefresh"`
	ResetLayoutOnPreset bool  `json:"resetLayoutOnPreset"`
	TranslateToZh      bool   `json:"translateToZh"`
}

// SituationMonitorResponse 是 GET /api/user-settings/ui/situation-monitor
// 的响应体。Monitors/Layout/Settings 为指针：各自无记录时 nil → JSON null。
// UpdatedAt 三个字段分别 omitempty：无对应记录时不出现在 updatedAt。
type SituationMonitorResponse struct {
	Version int `json:"version"`
	UpdatedAt struct {
		Monitors string `json:"monitors,omitempty"`
		Layout   string `json:"layout,omitempty"`
		Settings string `json:"settings,omitempty"`
	} `json:"updatedAt"`
	Monitors []SituationMonitorCustomMonitor    `json:"monitors"`
	Layout   *SituationMonitorLayout            `json:"layout"`
	Settings *SituationMonitorSettings          `json:"settings"`
}

// BuildSituationMonitorResponse 输入三记录聚合结果，输出完整响应。
func BuildSituationMonitorResponse(records SituationMonitorRecords) SituationMonitorResponse {
	var response SituationMonitorResponse
	response.Version = 1
	if records.Monitors.Found {
		response.UpdatedAt.Monitors = formatJSISO(records.Monitors.UpdatedAt)
		response.Monitors = NormalizeSituationMonitors(records.Monitors.Value)
	} else {
		response.Monitors = nil
	}
	if records.Layout.Found {
		response.UpdatedAt.Layout = formatJSISO(records.Layout.UpdatedAt)
		response.Layout = NormalizeSituationLayout(records.Layout.Value)
	} else {
		response.Layout = nil
	}
	if records.Settings.Found {
		response.UpdatedAt.Settings = formatJSISO(records.Settings.UpdatedAt)
		settings := NormalizeSituationSettings(records.Settings.Value)
		response.Settings = &settings
	} else {
		response.Settings = nil
	}
	return response
}

// NormalizeSituationMonitors 复刻 NestJS normalizeMonitors。
func NormalizeSituationMonitors(raw []byte) []SituationMonitorCustomMonitor {
	value, ok := asJSONObjectArray(raw)
	if !ok {
		return []SituationMonitorCustomMonitor{}
	}
	out := make([]SituationMonitorCustomMonitor, 0, len(value))
	for _, record := range value {
		name := normalizeSituationName(record["name"])
		keywords := normalizeSituationKeywords(record["keywords"])
		if name == "" || len(keywords) == 0 {
			continue
		}
		id := ""
		if s, ok := record["id"].(string); ok {
			id = truncateRunes(trimSpace(s), 64)
		}
		if id == "" {
			id = "sm-" + randomID10()
		}
		monitor := SituationMonitorCustomMonitor{
			ID:        id,
			Name:      name,
			Keywords:  keywords,
			Enabled:   true,
			CreatedAt: time.Now().UnixMilli(),
		}
		if b, ok := record["enabled"].(bool); ok {
			monitor.Enabled = b
		}
		if color, ok := normalizeSituationColor(record["color"]); ok {
			monitor.Color = &color
		}
		if location, ok := normalizeSituationLocation(record["location"]); ok {
			monitor.Location = &location
		}
		if f, ok := record["createdAt"].(float64); ok {
			monitor.CreatedAt = int64(f)
		}
		out = append(out, monitor)
		if len(out) >= maxSituationMonitors {
			break
		}
	}
	return out
}

// NormalizeSituationLayout 复刻 NestJS normalizeLayout：非对象 →
// {layouts:{}, visibility:{}}。
func NormalizeSituationLayout(raw []byte) *SituationMonitorLayout {
	layout := &SituationMonitorLayout{Layouts: map[string][]SituationMonitorLayoutItem{}, Visibility: map[string]bool{}}
	value, ok := asJSONObject(raw)
	if !ok {
		return layout
	}

	rawLayouts, _ := value["layouts"].(map[string]any)
	for _, breakpoint := range situationLayoutBreakpoints {
		entries, ok := rawLayouts[breakpoint].([]any)
		if !ok {
			continue
		}
		normalized := normalizeSituationLayoutItems(entries)
		if len(normalized) > 0 {
			layout.Layouts[breakpoint] = normalized
		}
	}

	// legacy `layout` 数组回退到 lg（仅当 lg 尚无内容）。
	if _, hasLG := layout.Layouts["lg"]; !hasLG {
		if entries, ok := value["layout"].([]any); ok {
			normalized := normalizeSituationLayoutItems(entries)
			if len(normalized) > 0 {
				layout.Layouts["lg"] = normalized
			}
		}
	}

	// visibility：Object.entries 插入序 + 64 项上限——用有序解码
	//（value["visibility"] 经 asJSONObject 已是 any；这里重新从原始
	// JSON 提取 raw bytes 以保序——代价是二次解析，仅此一处语义点）。
	if rawVisibility := extractRawField(raw, "visibility"); rawVisibility != nil {
		if entries, ok := orderedEntries(rawVisibility); ok {
			for _, entry := range entries {
				var b bool
				if err := json.Unmarshal(entry.value, &b); err != nil {
					continue
				}
				key := truncateRunes(trimSpace(entry.key), maxSituationLayoutItemIDLen)
				if key == "" {
					continue
				}
				layout.Visibility[key] = b
				if len(layout.Visibility) >= maxSituationVisibilityKeys {
					break
				}
			}
		}
	}
	return layout
}

// extractRawField 用 json.Decoder 流式提取顶层对象的某个字段的原始
// JSON（不整体解析成 map——顺序无关字段之外的保序入口）。
func extractRawField(raw []byte, field string) []byte {
	if len(raw) == 0 {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	token, err := decoder.Token()
	if err != nil {
		return nil
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil
	}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}
		if key == field {
			return value
		}
	}
	return nil
}

// normalizeSituationLayoutItems 规整单个断点的 item 数组（过滤 + 64 截断）。
func normalizeSituationLayoutItems(entries []any) []SituationMonitorLayoutItem {
	out := make([]SituationMonitorLayoutItem, 0, len(entries))
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		item, ok := normalizeSituationLayoutItem(record)
		if !ok {
			continue
		}
		out = append(out, item)
		if len(out) >= maxSituationLayoutItemsPerBreakpoint {
			break
		}
	}
	return out
}

// normalizeSituationLayoutItem 复刻 NestJS normalizeLayoutItem
// （354-405）。返回 false = 丢弃（非对象或 i 为空）。
func normalizeSituationLayoutItem(record map[string]any) (SituationMonitorLayoutItem, bool) {
	var item SituationMonitorLayoutItem
	id := ""
	if s, ok := record["i"].(string); ok {
		id = truncateRunes(trimSpace(s), maxSituationLayoutItemIDLen)
	}
	if id == "" {
		return item, false
	}
	item.I = id
	item.X = nonNegativeInt(record["x"], 0)
	item.Y = nonNegativeInt(record["y"], 0)
	item.W = nonNegativeInt(record["w"], 1)
	item.H = nonNegativeInt(record["h"], 1)
	if v := positiveOptionalInt(record["minW"]); v != nil {
		item.MinW = v
	}
	if v := positiveOptionalInt(record["minH"]); v != nil {
		item.MinH = v
	}
	if b, ok := record["static"].(bool); ok {
		item.IsStatic = &b
	}
	return item, true
}

// NormalizeSituationSettings 复刻 NestJS normalizeSettings。
func NormalizeSituationSettings(raw []byte) SituationMonitorSettings {
	settings := SituationMonitorSettings{
		WindowHours:        24,
		Scope:              "all",
		AutoRefresh:        true,
		ResetLayoutOnPreset: false,
		TranslateToZh:      false,
	}
	value, ok := asJSONObject(raw)
	if !ok {
		return settings
	}
	if f, ok := value["windowHours"].(float64); ok && (f == 6 || f == 24 || f == 72) {
		settings.WindowHours = int(f)
	}
	if s, ok := value["scope"].(string); ok && s == "tagged" {
		settings.Scope = "tagged"
	}
	if b, ok := value["autoRefresh"].(bool); ok {
		settings.AutoRefresh = b
	}
	if b, ok := value["resetLayoutOnPreset"].(bool); ok {
		settings.ResetLayoutOnPreset = b
	}
	if b, ok := value["translateToZh"].(bool); ok {
		settings.TranslateToZh = b
	}
	return settings
}

// normalizeSituationName：字符串 trim 后 64 截断，其余空（NestJS
// normalizeName）。
func normalizeSituationName(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	return truncateRunes(trimSpace(s), maxSituationMonitorNameLen)
}

// normalizeSituationKeywords：数组内字符串 split(",")/trim/去空/截前 30
// 再去重（NestJS normalizeKeywords 的顺序：flatMap(split)→map(trim)→
// filter(非空)→slice(0,30)→Set——**先截断后去重**，重复项会占位）。
func normalizeSituationKeywords(value any) []string {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	collected := []string{}
	for _, entry := range entries {
		s, ok := entry.(string)
		if !ok {
			continue
		}
		for _, part := range splitString(s, ",") {
			trimmed := trimSpace(part)
			if trimmed == "" {
				continue
			}
			collected = append(collected, trimmed)
			if len(collected) >= maxSituationKeywords {
				break
			}
		}
		if len(collected) >= maxSituationKeywords {
			break
		}
	}
	// 去重保留首现（Array.from(new Set(...)) 语义——输入已按序）。
	out := make([]string, 0, len(collected))
	seen := make(map[string]struct{}, len(collected))
	for _, keyword := range collected {
		if _, duplicate := seen[keyword]; duplicate {
			continue
		}
		seen[keyword] = struct{}{}
		out = append(out, keyword)
	}
	return out
}

// normalizeSituationColor：补 # 后只接受 #RGB/#RRGGBB，小写（NestJS
// normalizeColor）。ok=false = 不出现（undefined）。
func normalizeSituationColor(value any) (string, bool) {
	s, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := trimSpace(s)
	if trimmed == "" {
		return "", false
	}
	normalized := trimmed
	if normalized[0] != '#' {
		normalized = "#" + normalized
	}
	if len(normalized) == 4 && isHexDigits(normalized[1:]) ||
		len(normalized) == 7 && isHexDigits(normalized[1:]) {
		return toLower(normalized), true
	}
	return "", false
}

// normalizeSituationLocation：name/lat/lng 全有效且范围合法才保留
//（NestJS normalizeLocation）。
func normalizeSituationLocation(value any) (SituationMonitorLocation, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return SituationMonitorLocation{}, false
	}
	name := normalizeSituationName(record["name"])
	lat, latOK := record["lat"].(float64)
	lng, lngOK := record["lng"].(float64)
	if name == "" || !latOK || !lngOK {
		return SituationMonitorLocation{}, false
	}
	if lat > 90 || lat < -90 || lng > 180 || lng < -180 {
		return SituationMonitorLocation{}, false
	}
	return SituationMonitorLocation{Name: name, Lat: lat, Lng: lng}, true
}

// nonNegativeInt：有限数字 → max(lowerBound, round)；其余 lowerBound
//（NestJS Math.max(0|1, Math.round(x)) + 非数字回退语义）。
func nonNegativeInt(value any, lowerBound int) int {
	f, ok := value.(float64)
	if !ok {
		return lowerBound
	}
	return maxInt(lowerBound, jsRound(f))
}

// positiveOptionalInt：仅有限数字时 min 1 取整并出现；缺失/非数字时
// 字段不出现（NestJS minW/minH 的 undefined 语义）。
func positiveOptionalInt(value any) *int {
	f, ok := value.(float64)
	if !ok {
		return nil
	}
	v := maxInt(1, jsRound(f))
	return &v
}

// maxInt 是两个整数的较大者（避免引入 math 依赖的单行 helper）。
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// jsRound 复刻 Math.round 的 half-away-from-zero 语义（Go math.Round 一致）。
func jsRound(f float64) int {
	return int(round(f))
}

// randomID10 生成 "xxxxxxxxxx"（10 个十六进制字符）——等价
// randomUUID().slice(0, 10)。crypto/rand；失败时以当前时间纳秒兜底
//（不 panic——normalization 失败不是 500 的理由）。
func randomID10() string {
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		now := time.Now().UnixNano()
		for i := 0; i < 5; i++ {
			buf[i] = byte(now >> (8 * i))
		}
	}
	return hex.EncodeToString(buf)[:10]
}

// asJSONObjectArray：raw 解析为 JSON 数组（元素类型不约束）；空输入、
// 解析失败、非数组返回 false（NestJS Array.isArray 判定）。
func asJSONObjectArray(raw []byte) ([]any, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var parsed any
	if err := jsonUnmarshal(raw, &parsed); err != nil {
		return nil, false
	}
	entries, ok := parsed.([]any)
	return entries, ok
}

// isHexDigits：ASCII 十六进制字符（大小写均可，NestJS [0-9a-fA-F]）。
func isHexDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return len(s) > 0
}

// toLower：ASCII 小写（color 语义只含十六进制字符，ASCII 足够）。
func toLower(s string) string {
	out := []byte(s)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + ('a' - 'A')
		}
	}
	return string(out)
}

// trimSpace 是 strings.TrimSpace 的本文件别名（保持与 NestJS trim 等价，
// 集中声明便于核对）。
func trimSpace(s string) string { return strings.TrimSpace(s) }

// splitString 是 strings.Split 的别名（keywords 的逗号拆分）。
func splitString(s, sep string) []string { return strings.Split(s, sep) }

// orderedEntry 是有序对象的一个 key/value（保留 JSON 原始出现顺序）。
type orderedEntry struct {
	key   string
	value []byte // 该 entry value 的原始 JSON（调用方按需再解码）
}

// orderedEntries 把 JSON 对象按出现顺序提取为 entries。
//
// 输入是原始 JSON 字节——encoding/json 的 map[string]any 不保序，因此
// 这里用 json.Decoder 流式按序读取。调用方（NestJS 侧对应
// Object.entries 遍历的三个语义点：situation-monitor visibility、newsnow
// columnOrders/sourceAffinity）需要「前 N 项」的确定性顺序，都必须先经
// orderedEntries，再对每个 value 自行解码。这不是通用 JSON 框架——
// 只服务三个有序对象点。
func orderedEntries(raw []byte) ([]orderedEntry, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	// 读掉 '{'。
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, false
	}
	var entries []orderedEntry
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false
		}
		entries = append(entries, orderedEntry{key: key, value: value})
	}
	return entries, true
}
