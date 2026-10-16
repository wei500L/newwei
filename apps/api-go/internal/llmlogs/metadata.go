package llmlogs

import (
	"encoding/json"
	"strings"
)

// 与 apps/api/src/modules/system-settings/llm-request-log-settings.service.ts
// 的常量逐项对齐。SETTINGS_KEY 是 MySQL SystemSetting 的 key。
const (
	llmRequestLogSettingsKey = "llm_request_log_settings"

	maxMetadataAllowedTopLevelKeys     = 100
	maxMetadataAllowedTopLevelPrefixes = 20
	maxMetadataKeyLength               = 64
	maxMetadataPrefixLength            = 24
)

// DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS（顺序即输出顺序）。
var defaultMetadataAllowedTopLevelKeys = []string{
	"attempt",
	"batchid",
	"category",
	"channel",
	"correlationid",
	"env",
	"feature",
	"flowid",
	"jobid",
	"language",
	"locale",
	"model",
	"module",
	"nodeid",
	"operation",
	"pipeline",
	"profileid",
	"profile",
	"provider",
	"requestid",
	"retry",
	"frontiernodeid",
	"frontierrunid",
	"crawlsiteprofileid",
	"runid",
	"scenario",
	"sessionid",
	"source",
	"stage",
	"tags",
	"taskid",
	"tenantid",
	"traceid",
	"userid",
	"version",
}

// REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS——必须始终合并
// 进 allowedTopLevelKeys。
var requiredMetadataAllowedTopLevelKeys = []string{
	"runid",
	"nodeid",
	"profileid",
	"frontierrunid",
	"frontiernodeid",
	"crawlsiteprofileid",
}

var defaultMetadataAllowedTopLevelPrefixes = []string{"x_", "meta_", "ctx_"}

// mergeRequiredMetadataKeys 对齐
// mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys：按首次出现顺序
// 去重，再补上缺失的必选键（必选键的顺序固定）。
func mergeRequiredMetadataKeys(keys []string) []string {
	seen := make(map[string]bool, len(keys)+len(requiredMetadataAllowedTopLevelKeys))
	out := make([]string, 0, len(keys)+len(requiredMetadataAllowedTopLevelKeys))
	for _, key := range keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
	for _, key := range requiredMetadataAllowedTopLevelKeys {
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
	return out
}

// defaultMetadataPolicySummary 对齐
// buildDefaultSettings + resolveMetadataPolicySummary 的 default 分支。
func defaultMetadataPolicySummary() metadataPolicy {
	keys := mergeRequiredMetadataKeys(defaultMetadataAllowedTopLevelKeys)
	prefixes := append([]string{}, defaultMetadataAllowedTopLevelPrefixes...)
	return metadataPolicy{
		Source:                  "default",
		AllowedTopLevelKeys:     keys,
		AllowedTopLevelPrefixes: prefixes,
		KeyCount:                len(keys),
		PrefixCount:             len(prefixes),
	}
}

// parseMetadataPolicy 对齐 loadSettingsFromDb + resolveMetadataPolicySummary：
// value 解析失败时返回 false（调用方落回 default 且 source 为 default）；
// 解析成功时 source 为 "db"，两个列表按 lenient 规则归一化（非法或缺省
// 时落回默认列表，仍合并必选键）。
func parseMetadataPolicy(raw []byte) (metadataPolicy, bool) {
	if len(raw) == 0 {
		return metadataPolicy{}, false
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return metadataPolicy{}, false
	}
	record, _ := parsed.(map[string]any)
	keys := normalizeMetadataAllowedTopLevelKeysLenient(recordField(record, "metadataAllowedTopLevelKeys"))
	prefixes := normalizeMetadataAllowedTopLevelPrefixesLenient(recordField(record, "metadataAllowedTopLevelPrefixes"))
	return metadataPolicy{
		Source:                  "db",
		AllowedTopLevelKeys:     keys,
		AllowedTopLevelPrefixes: prefixes,
		KeyCount:                len(keys),
		PrefixCount:             len(prefixes),
	}, true
}

func recordField(record map[string]any, key string) any {
	if record == nil {
		return nil
	}
	return record[key]
}

func normalizeMetadataAllowedTopLevelKeysLenient(value any) []string {
	normalized := normalizeMetadataTokenList(value, maxMetadataAllowedTopLevelKeys, maxMetadataKeyLength, false)
	if normalized == nil {
		return mergeRequiredMetadataKeys(defaultMetadataAllowedTopLevelKeys)
	}
	return mergeRequiredMetadataKeys(normalized)
}

func normalizeMetadataAllowedTopLevelPrefixesLenient(value any) []string {
	normalized := normalizeMetadataTokenList(value, maxMetadataAllowedTopLevelPrefixes, maxMetadataPrefixLength, false)
	if normalized == nil {
		return append([]string{}, defaultMetadataAllowedTopLevelPrefixes...)
	}
	return normalized
}

// normalizeMetadataTokenList 对齐 normalizeMetadataTokenList。注意
// strict=false 时「数组元素多于上限」分支不去重（与 TS 实现一致）；其余
// 分支用 Set 去重且保持首次出现顺序。
func normalizeMetadataTokenList(value any, maxItems, maxTokenLength int, strict bool) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	if len(list) > maxItems {
		if strict {
			return nil
		}
		out := make([]string, 0, maxItems)
		for _, entry := range list[:maxItems] {
			if token := normalizeMetadataToken(entry, maxTokenLength); token != "" {
				out = append(out, token)
			}
		}
		return out
	}
	out := make([]string, 0, len(list))
	for _, entry := range list {
		if token := normalizeMetadataToken(entry, maxTokenLength); token != "" {
			out = append(out, token)
		}
	}
	if strict && len(out) != len(list) {
		return nil
	}
	return dedupeStrings(out)
}

// normalizeMetadataToken 对齐 normalizeMetadataToken（token 字符集与
// feature 相同：^[a-z0-9_:\-.]+$）。
func normalizeMetadataToken(value any, maxTokenLength int) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	trimmed := strings.ToLower(strings.TrimSpace(text))
	if trimmed == "" || jsLength(trimmed) > maxTokenLength {
		return ""
	}
	if !featureTokenPattern.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
