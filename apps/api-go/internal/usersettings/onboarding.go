// Package usersettings 是第二个真实业务迁移单元（Go-批2A）：
// GET /api/user-settings/ui/onboarding 的 MySQL 只读查询与 normalization。
//
// 契约对齐（NestJS UserSettingsService.getOnboardingUiSettings，
// apps/api/src/modules/user-settings/user-settings.service.ts:1251-1273）：
//   - 表：UserSetting（orgId+userId+key 联合唯一，value JSON，updatedAt DATETIME(3)）。
//   - 存储 key：ui:onboarding:settings:v1。
//   - 无记录 → settings 为 null（不能返回默认对象）。
//   - 有记录但 value 不是 JSON 对象 → 返回默认 settings 对象（NestJS
//     normalizeOnboardingUiSettings 对非对象输入返回默认值）。
//   - updatedAt.settings 与 JavaScript Date.toISOString() 的毫秒 UTC 语义
//     一致（DATETIME(3) 毫秒精度 → 固定毫秒位数的 UTC 格式）。
//
// 信任边界：本包不做鉴权——orgId/userId 由调用方（legacy-approved
// shadow identity 门禁，见 cmd/api 的 onboarding shadow 接线）传入，
// 且只用于本次只读查询。
//
// 回滚：路由表单条规则改回 ModeLegacy，无数据迁移耦合。
package usersettings

import (
	"encoding/json"
	"time"
)

// OnboardingKey 是 onboarding 设置在 UserSetting 表中的固定存储 key。
const OnboardingKey = "ui:onboarding:settings:v1"

// onboardingStepKeys 与 NestJS ONBOARDING_STEP_KEYS 一一对应。
var onboardingStepKeys = [4]string{"today", "events", "map", "finance"}

// Record 是一次 onboarding 查询结果（无记录时 Found=false）。
type Record struct {
	Found     bool
	Value     []byte    // 数据库 value 列原文（JSON）
	UpdatedAt time.Time // 数据库 updatedAt（DATETIME(3) 无时区——按 UTC 解释）
}

// OnboardingChecklist 是四个引导步骤的完成状态。
type OnboardingChecklist struct {
	Today   bool `json:"today"`
	Events  bool `json:"events"`
	Map     bool `json:"map"`
	Finance bool `json:"finance"`
}

// OnboardingSettings 是 normalize 后的 onboarding 设置（对齐 NestJS
// OnboardingUiSettings）。
type OnboardingSettings struct {
	Completed      bool                `json:"completed"`
	Dismissed      bool                `json:"dismissed"`
	Checklist      OnboardingChecklist `json:"checklist"`
	CompletedTours map[string]bool     `json:"completedTours"`
}

// OnboardingResponse 是 GET /api/user-settings/ui/onboarding 的响应体。
//
// Settings 为指针：无记录时 nil → 序列化为 "settings":null；UpdatedAt 为
// 嵌套结构体 + omitempty → 无记录时序列化为 "updatedAt":{}——两者均与
// NestJS 展开语义一致。
type OnboardingResponse struct {
	Version   int `json:"version"`
	UpdatedAt struct {
		Settings string `json:"settings,omitempty"`
	} `json:"updatedAt"`
	Settings *OnboardingSettings `json:"settings"`
}

// BuildOnboardingResponse 输入数据库记录，输出完整响应。
func BuildOnboardingResponse(record Record) OnboardingResponse {
	var response OnboardingResponse
	response.Version = 1
	if !record.Found {
		return response
	}
	response.UpdatedAt.Settings = formatJSISO(record.UpdatedAt)
	settings := NormalizeOnboarding(record.Value)
	response.Settings = &settings
	return response
}

// NormalizeOnboarding 复刻 NestJS normalizeOnboardingUiSettings
// （user-settings.service.ts:920-964）：
//   - value 不是 JSON 对象（null/数组/标量/解析失败）→ 默认设置对象；
//   - checklist 四个固定 key，只有存储值严格为 true 才为 true（缺失、
//     false、字符串 "true"、数字等均按 false）；checklist 本身缺失或不是
//     非数组对象 → 全 false；
//   - completed 只有存储值严格为 true，或四个 checklist 全部为 true 时
//     才为 true；
//   - dismissed 只有严格为 true 才为 true；
//   - completedTours 只保留四个合法 key 中值严格为 true 的项，未知 key
//     丢弃。
func NormalizeOnboarding(raw []byte) OnboardingSettings {
	settings := defaultOnboarding()

	value, ok := asJSONObject(raw)
	if !ok {
		return settings
	}

	rawChecklist, _ := asJSONObject(mustJSONRaw(value["checklist"]))
	for _, key := range onboardingStepKeys {
		settings.Checklist.set(key, rawChecklist[key] == true)
	}

	rawTours, _ := asJSONObject(mustJSONRaw(value["completedTours"]))
	for _, key := range onboardingStepKeys {
		if rawTours[key] == true {
			settings.CompletedTours[key] = true
		}
	}

	allChecklistComplete := settings.Checklist.Today && settings.Checklist.Events &&
		settings.Checklist.Map && settings.Checklist.Finance

	settings.Completed = value["completed"] == true || allChecklistComplete
	settings.Dismissed = value["dismissed"] == true
	return settings
}

// defaultOnboarding 返回全 false 的默认设置（NestJS createDefaultOnboardingUiSettings）。
func defaultOnboarding() OnboardingSettings {
	return OnboardingSettings{
		Completed:      false,
		Dismissed:      false,
		Checklist:      OnboardingChecklist{},
		CompletedTours: map[string]bool{},
	}
}

// formatJSISO 把数据库时间序列化为 JavaScript Date.toISOString() 等价
// 格式（固定毫秒位的 UTC，如 2026-09-03T00:00:00.000Z）。
func formatJSISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// set 按步骤 key 写 checklist 字段。
func (c *OnboardingChecklist) set(key string, value bool) {
	switch key {
	case "today":
		c.Today = value
	case "events":
		c.Events = value
	case "map":
		c.Map = value
	case "finance":
		c.Finance = value
	}
}

// asJSONObject 把 raw 解析为 JSON 对象；空输入、解析失败、数组或标量
// 都返回 ok=false（对齐 NestJS 「!value || typeof !== object || Array.isArray」）。
func asJSONObject(raw []byte) (map[string]any, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil, false
	}
	return obj, true
}

// mustJSONRaw 把已解析的 JSON 值重新编码为字节（子对象二次解析用）。
func mustJSONRaw(value any) []byte {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}
