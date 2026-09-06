// Spacetime Timeline UI 设置的 normalization 契约（Go-批2B）。
//
// 契约对齐（NestJS normalizeSpacetimeTimelineSettings，
// apps/api/src/modules/user-settings/user-settings.service.ts:516-627）：
//   - 存储 key：ui:spacetime-timeline:settings:v1（SpacetimeTimelineKey，
//     repository.go）；
//   - value 不是 JSON 对象（null/数组/标量/解析失败）→ 全默认设置对象；
//   - authoritativeLock / requireCorroborated / syncStatusAutoRefresh：
//     仅布尔值有效，类型错误用各自默认值（全 true）；
//   - sourceType ∈ {all, authoritative, mixed, blog}，其余回退
//     "authoritative"；sortBy ∈ {latest, heat, credibility}，其余回退
//     "heat"；timelineGranularity ∈ {auto, day, week, month}，其余回退
//     "auto"；
//   - minHeatScore / minCredibilityScore / speed 是浮点 clamp（0..12 /
//     0..100 / 0.25..16），非数字（含 null/字符串/NaN 语义——JSON 本就
//     无法表达 NaN/Infinity）回退默认（0.7 / 48 / 2）。
//
// 数字语义：JSON 解析到 float64 与 JS number 是同一 IEEE 754 双精度，
// clamp 结果原样返回——不取整、不做精度变换；序列化双方同为最短
// round-trip 表示（0.7 → "0.7"，48 → "48"）。
package usersettings

// SpacetimeTimelineSettings 是 normalize 后的 spacetime-timeline 设置
// （对齐 NestJS SpacetimeTimelineSettings）。
type SpacetimeTimelineSettings struct {
	AuthoritativeLock     bool    `json:"authoritativeLock"`
	RequireCorroborated   bool    `json:"requireCorroborated"`
	SourceType            string  `json:"sourceType"`
	SortBy                string  `json:"sortBy"`
	MinHeatScore          float64 `json:"minHeatScore"`
	MinCredibilityScore   float64 `json:"minCredibilityScore"`
	TimelineGranularity   string  `json:"timelineGranularity"`
	Speed                 float64 `json:"speed"`
	SyncStatusAutoRefresh bool    `json:"syncStatusAutoRefresh"`
}

// SpacetimeTimelineResponse 是 GET /api/user-settings/ui/spacetime-timeline
// 的响应体。Settings 为指针：无记录时 nil → 序列化为 "settings":null；
// 无记录时 updatedAt 序列化为 "updatedAt":{}（同 onboarding.go）。
type SpacetimeTimelineResponse struct {
	Version   int `json:"version"`
	UpdatedAt struct {
		Settings string `json:"settings,omitempty"`
	} `json:"updatedAt"`
	Settings *SpacetimeTimelineSettings `json:"settings"`
}

// BuildSpacetimeTimelineResponse 输入数据库记录，输出完整响应。
func BuildSpacetimeTimelineResponse(record Record) SpacetimeTimelineResponse {
	var response SpacetimeTimelineResponse
	response.Version = 1
	if !record.Found {
		return response
	}
	response.UpdatedAt.Settings = formatJSISO(record.UpdatedAt)
	settings := NormalizeSpacetimeTimeline(record.Value)
	response.Settings = &settings
	return response
}

// NormalizeSpacetimeTimeline 复刻 NestJS normalizeSpacetimeTimelineSettings
// （user-settings.service.ts:578-627）：非对象 → 全默认；逐字段规整见
// 文件头契约清单。
func NormalizeSpacetimeTimeline(raw []byte) SpacetimeTimelineSettings {
	settings := defaultSpacetimeTimeline()

	value, ok := asJSONObject(raw)
	if !ok {
		return settings
	}

	settings.AuthoritativeLock = normalizeSpacetimeBool(value["authoritativeLock"], settings.AuthoritativeLock)
	settings.RequireCorroborated = normalizeSpacetimeBool(value["requireCorroborated"], settings.RequireCorroborated)
	settings.SourceType = oneOfString(value["sourceType"], "authoritative", "all", "mixed", "blog")
	settings.SortBy = oneOfString(value["sortBy"], "heat", "latest", "credibility")
	settings.MinHeatScore = clampFloat(value["minHeatScore"], 0, 12, settings.MinHeatScore)
	settings.MinCredibilityScore = clampFloat(value["minCredibilityScore"], 0, 100, settings.MinCredibilityScore)
	settings.TimelineGranularity = oneOfString(value["timelineGranularity"], "auto", "day", "week", "month")
	settings.Speed = clampFloat(value["speed"], 0.25, 16, settings.Speed)
	settings.SyncStatusAutoRefresh = normalizeSpacetimeBool(value["syncStatusAutoRefresh"], settings.SyncStatusAutoRefresh)
	return settings
}

// defaultSpacetimeTimeline 与 NestJS SPACETIME_TIMELINE_DEFAULT_SETTINGS 一致。
func defaultSpacetimeTimeline() SpacetimeTimelineSettings {
	return SpacetimeTimelineSettings{
		AuthoritativeLock:     true,
		RequireCorroborated:   true,
		SourceType:            "authoritative",
		SortBy:                "heat",
		MinHeatScore:          0.7,
		MinCredibilityScore:   48,
		TimelineGranularity:   "auto",
		Speed:                 2,
		SyncStatusAutoRefresh: true,
	}
}

// normalizeSpacetimeBool：仅布尔值有效，其余用 fallback（NestJS
// normalizeBoolean，user-settings.service.ts:491-493）。
func normalizeSpacetimeBool(value any, fallback bool) bool {
	if b, ok := value.(bool); ok {
		return b
	}
	return fallback
}

// oneOfString：value 是字符串且在 allowed 内则原样返回，否则 fallback
//（fallback 自身若是合法枚举值可不在 allowed 里重复列出——回退结果相同）。
func oneOfString(value any, fallback string, allowed ...string) string {
	s, ok := value.(string)
	if !ok {
		return fallback
	}
	for _, candidate := range allowed {
		if s == candidate {
			return s
		}
	}
	return fallback
}

// clampFloat 复刻 NestJS clampFloat（user-settings.service.ts:558-576）：
// 非数字类型回退 fallback；数字 clamp 到 [min, max]。float64 原样返回，
// 不取整（JSON 反序列化到 any 后所有数字都是 float64，与 JS number 同一
// 语义；JSON 无法表达 NaN/Infinity，故无需 Number.isFinite 的对应分支）。
func clampFloat(value any, min, max, fallback float64) float64 {
	f, ok := value.(float64)
	if !ok {
		return fallback
	}
	if f < min {
		return min
	}
	if f > max {
		return max
	}
	return f
}
