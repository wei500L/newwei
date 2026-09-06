// RSS Reader UI 设置的 normalization 契约（Go-批2B）。
//
// 契约对齐（NestJS normalizeRssReaderUiSettings，
// apps/api/src/modules/user-settings/user-settings.service.ts:898-918）：
//   - 存储 key：ui:rss-reader:settings:v1（RSSReaderKey，repository.go）；
//   - value 不是 JSON 对象（null/数组/标量/解析失败）→ 默认设置对象；
//   - selectedSourceIds：非数组 → null；数组内只保留字符串，trim 后截断
//     到 128 字符；空值删除；稳定去重（保留首次出现顺序）；最多 500 项；
//   - sourceLanguageFilters：非数组 → 空数组（非 null）；只保留字符串，
//     trim + Unicode 大写后截断到 24 字符；空值删除；稳定去重；最多 24 项；
//   - translationEnabled / showOriginalContent：仅严格 true；
//   - translationProvider：仅 "llm" 保留，其余一律 "deeplx"；
//   - targetLanguage：非字符串或 trim 后为空 → "zh-CN"；否则 trim 后最多
//     32 字符。
//
// 字符串截断策略（本包唯一约定）：按 rune 边界截断——绝不产生非法
// UTF-8。与 JS String.prototype.slice 按 UTF-16 code unit 截断（可能劈开
// 代理对）在非 BMP 字符上存在边界差异；真实数据是 ASCII 形态的 source
// id/语言码，不为该极端 Unicode 边角建兼容层。
package usersettings

import "strings"

const (
	// maxRSSReaderSourceIDs 与 NestJS MAX_RSS_READER_SOURCE_IDS 一致。
	maxRSSReaderSourceIDs = 500
	// maxRSSReaderLanguageFilters 与 NestJS MAX_RSS_READER_LANGUAGE_FILTERS 一致。
	maxRSSReaderLanguageFilters = 24
	// maxRSSReaderSourceIDLen 是单个 source id trim 后的最大长度（rune 数）。
	maxRSSReaderSourceIDLen = 128
	// maxRSSReaderLanguageLen 是单个语言过滤项 uppercase 后的最大长度（rune 数）。
	maxRSSReaderLanguageLen = 24
	// maxRSSReaderTargetLanguageLen 是 targetLanguage trim 后的最大长度（rune 数）。
	maxRSSReaderTargetLanguageLen = 32
)

// RSSReaderSettings 是 normalize 后的 rss-reader 设置（对齐 NestJS
// RssReaderUiSettings）。SelectedSourceIDs 的 nil/非 nil 区分契约语义：
// 非数组输入 → nil（序列化为 null）；数组输入（含空数组）→ 非 nil
// （空数组序列化为 []）——只能用 slice 的 nil 性承载，不能复用零值。
type RSSReaderSettings struct {
	SelectedSourceIDs     []string `json:"selectedSourceIds"`
	SourceLanguageFilters []string `json:"sourceLanguageFilters"`
	TranslationEnabled    bool     `json:"translationEnabled"`
	TranslationProvider   string   `json:"translationProvider"`
	TargetLanguage        string   `json:"targetLanguage"`
	ShowOriginalContent   bool     `json:"showOriginalContent"`
}

// RSSReaderResponse 是 GET /api/user-settings/ui/rss-reader 的响应体。
//
// Settings 为指针：无记录时 nil → 序列化为 "settings":null；UpdatedAt 为
// 嵌套结构体 + omitempty → 无记录时序列化为 "updatedAt":{}——均与
// NestJS 展开语义一致（见 onboarding.go 的 OnboardingResponse）。
type RSSReaderResponse struct {
	Version   int `json:"version"`
	UpdatedAt struct {
		Settings string `json:"settings,omitempty"`
	} `json:"updatedAt"`
	Settings *RSSReaderSettings `json:"settings"`
}

// BuildRSSReaderResponse 输入数据库记录，输出完整响应。
func BuildRSSReaderResponse(record Record) RSSReaderResponse {
	var response RSSReaderResponse
	response.Version = 1
	if !record.Found {
		return response
	}
	response.UpdatedAt.Settings = formatJSISO(record.UpdatedAt)
	settings := NormalizeRSSReader(record.Value)
	response.Settings = &settings
	return response
}

// NormalizeRSSReader 复刻 NestJS normalizeRssReaderUiSettings
// （user-settings.service.ts:898-918）：非对象 → 默认设置；逐字段规整
// 见文件头契约清单。
func NormalizeRSSReader(raw []byte) RSSReaderSettings {
	settings := defaultRSSReader()

	value, ok := asJSONObject(raw)
	if !ok {
		return settings
	}

	settings.SelectedSourceIDs = normalizeRSSReaderSourceIDs(value["selectedSourceIds"])
	settings.SourceLanguageFilters = normalizeRSSReaderLanguageFilters(value["sourceLanguageFilters"])
	settings.TranslationEnabled = value["translationEnabled"] == true
	settings.TranslationProvider = normalizeRSSReaderTranslationProvider(value["translationProvider"])
	settings.TargetLanguage = normalizeRSSReaderTargetLanguage(value["targetLanguage"])
	settings.ShowOriginalContent = value["showOriginalContent"] == true
	return settings
}

// defaultRSSReader 返回默认设置（NestJS createDefaultRssReaderUiSettings：
// selectedSourceIds 为 null，sourceLanguageFilters 为空数组）。
func defaultRSSReader() RSSReaderSettings {
	return RSSReaderSettings{
		SelectedSourceIDs:     nil,
		SourceLanguageFilters: []string{},
		TranslationEnabled:    false,
		TranslationProvider:   "deeplx",
		TargetLanguage:        "zh-CN",
		ShowOriginalContent:   false,
	}
}

// normalizeRSSReaderSourceIDs：非数组 → nil（JSON null）；数组 → 逐项
// 规整（仅字符串/trim/128 截断/去空/稳定去重），最多 500 项。与 NestJS
// 的 push-then-break 语义一致：恰好取前 500 个不重复的合法项。
func normalizeRSSReaderSourceIDs(value any) []string {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	out := []string{}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		normalized, ok := normalizeRSSReaderSourceID(entry)
		if !ok {
			continue
		}
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) >= maxRSSReaderSourceIDs {
			break
		}
	}
	return out
}

// normalizeRSSReaderSourceID：仅字符串有效；trim 后截断到 128 rune；
// 结果为空则无效（NestJS normalizeRssReaderSourceId）。
func normalizeRSSReaderSourceID(value any) (string, bool) {
	s, ok := value.(string)
	if !ok {
		return "", false
	}
	normalized := truncateRunes(strings.TrimSpace(s), maxRSSReaderSourceIDLen)
	if normalized == "" {
		return "", false
	}
	return normalized, true
}

// normalizeRSSReaderLanguageFilters：非数组 → 空数组（非 null）；数组 →
// 逐项规整（仅字符串/trim/Unicode 大写/24 截断/去空/稳定去重），最多
// 24 项（NestJS normalizeRssReaderLanguageFilters）。
func normalizeRSSReaderLanguageFilters(value any) []string {
	entries, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := []string{}
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		s, ok := entry.(string)
		if !ok {
			continue
		}
		normalized := truncateRunes(strings.ToUpper(strings.TrimSpace(s)), maxRSSReaderLanguageLen)
		if normalized == "" {
			continue
		}
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
		if len(out) >= maxRSSReaderLanguageFilters {
			break
		}
	}
	return out
}

// normalizeRSSReaderTranslationProvider：仅 "llm" 保留，其余一律 "deeplx"
// （NestJS normalizeRssReaderTranslationProvider）。
func normalizeRSSReaderTranslationProvider(value any) string {
	if s, ok := value.(string); ok && s == "llm" {
		return "llm"
	}
	return "deeplx"
}

// normalizeRSSReaderTargetLanguage：非字符串或 trim 后为空 → "zh-CN"；
// 否则 trim 后最多 32 rune（NestJS normalizeRssReaderTargetLanguage）。
func normalizeRSSReaderTargetLanguage(value any) string {
	s, ok := value.(string)
	if !ok {
		return "zh-CN"
	}
	normalized := strings.TrimSpace(s)
	if normalized == "" {
		return "zh-CN"
	}
	return truncateRunes(normalized, maxRSSReaderTargetLanguageLen)
}

// truncateRunes 把字符串截断到最多 max 个 rune（rune 边界截断——绝不
// 产生非法 UTF-8；与 JS 按 UTF-16 code unit 的 slice 在非 BMP 字符上有
// 边界差异，见文件头说明）。
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == max {
			return s[:i]
		}
		count++
	}
	return s
}
