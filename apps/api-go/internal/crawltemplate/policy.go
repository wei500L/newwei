package crawltemplate

import (
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// 本文件逐段翻译 apps/api/src/modules/crawl/crawl-config-policy.ts 的
// assertNoUnsupportedProxy（含 findUnsupportedProxyIssues / formatIssues）
// 与 apps/api/src/modules/crawl/crawl4ai-llm.guard.ts 的
// assertNoCrawl4aiLlmOptions（含递归、环检测、前 5 个键与 (+N more)）。
// 两者都在采集模板的 crawlOptions 归一化时生效，不放松任何校验。

// ---- 守卫 1：assertNoUnsupportedProxy ----

// proxyIssue 对齐 TS 的 CrawlConfigPolicyIssue。
type proxyIssue struct {
	Path    string
	Message string
}

// findUnsupportedProxyIssues 对齐 findUnsupportedProxyIssues：只检查顶层
// proxyUrl / proxyConfig（不递归）。非普通对象返回空。
func findUnsupportedProxyIssues(value any, path string) []proxyIssue {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	issues := []proxyIssue{}
	if _, exists := record["proxyUrl"]; exists {
		issues = append(issues, proxyIssue{
			Path:    path + ".proxyUrl",
			Message: "custom upstream proxies are not supported",
		})
	}
	if _, exists := record["proxyConfig"]; exists {
		issues = append(issues, proxyIssue{
			Path:    path + ".proxyConfig",
			Message: "custom upstream proxies are not supported",
		})
	}
	return issues
}

// formatIssues 对齐 formatIssues：`path: message` 以 "; " 连接。
func formatIssues(issues []proxyIssue) string {
	parts := make([]string, 0, len(issues))
	for _, issue := range issues {
		parts = append(parts, issue.Path+": "+issue.Message)
	}
	return strings.Join(parts, "; ")
}

// assertNoUnsupportedProxy 对齐 assertNoUnsupportedProxy：命中即 400
// `Unsupported crawl config: ...`；无命中返回 nil。
func assertNoUnsupportedProxy(raw json.RawMessage, path string) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	issues := findUnsupportedProxyIssues(value, path)
	if len(issues) == 0 {
		return nil
	}
	return &inputError{Message: "Unsupported crawl config: " + formatIssues(issues)}
}

// ---- 守卫 2：assertNoCrawl4aiLlmOptions ----

// disallowedNormalizedKeys 对齐 DISALLOWED_NORMALIZED_KEYS。
var disallowedNormalizedKeys = map[string]bool{
	"extractionstrategy": true,
	"llmconfig":          true,
}

// normalizeGuardKey 对齐 normalizeKey：小写后删除全部非 [a-z0-9]。
func normalizeGuardKey(key string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(key) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

// isDisallowedStrategyType 对齐 isDisallowedStrategyType：规范化后的值必须
// 含 "llm"，且规范化后的路径含 "strategy" 或 "extraction"。
func isDisallowedStrategyType(path, value string) bool {
	normalizedPath := normalizeGuardKey(path)
	normalizedValue := normalizeGuardKey(value)
	if !strings.Contains(normalizedValue, "llm") {
		return false
	}
	return strings.Contains(normalizedPath, "strategy") || strings.Contains(normalizedPath, "extraction")
}

// assertNoCrawl4aiLlmOptions 整段翻译 assertNoCrawl4aiLlmOptions：
//   - 递归扫描对象与数组；
//   - 环检测（JS 的 Set 用容器指针身份镜像）；
//   - 最多列前 5 个命中键，其余用 " (+N more)"；
//   - 英文句子原样保留。
func assertNoCrawl4aiLlmOptions(options json.RawMessage, label string) error {
	var value any
	if err := json.Unmarshal(options, &value); err != nil {
		return nil
	}
	blocked := findDisallowedKeys(value, "", map[uintptr]bool{})
	if len(blocked) == 0 {
		return nil
	}
	keys := blocked
	suffix := ""
	if len(blocked) > 5 {
		keys = blocked[:5]
		suffix = " (+" + strconv.Itoa(len(blocked)-5) + " more)"
	}
	return &inputError{Message: label + " contains crawl4ai LLM extraction settings (" +
		strings.Join(keys, ", ") + suffix + "). " +
		"The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead."}
}

// findDisallowedKeys 翻译 findDisallowedKeys：
//   - 非对象/数组（含 null）返回空；
//   - seen 防止环（对象/数组按指针身份去重，等价 JS 的 Set）；
//   - 键按字典序输出（NestJS Object.entries 按插入序；单一命中时两者一致，
//     与 crawlprofile/config.go、crawlworkflow/bridge.go 的既有翻译相同）。
func findDisallowedKeys(value any, prefix string, seen map[uintptr]bool) []string {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case []any:
		if id, ok := containerIdentity(value); ok {
			if seen[id] {
				return nil
			}
			seen[id] = true
		}
		hits := []string{}
		for index, entry := range typed {
			hits = append(hits, findDisallowedKeys(entry, prefix+"["+strconv.Itoa(index)+"]", seen)...)
		}
		return hits
	case map[string]any:
		if id, ok := containerIdentity(value); ok {
			if seen[id] {
				return nil
			}
			seen[id] = true
		}
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		hits := []string{}
		for _, key := range keys {
			entry := typed[key]
			normalized := normalizeGuardKey(key)
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			if disallowedNormalizedKeys[normalized] {
				hits = append(hits, path)
			}
			if normalized == "type" {
				if text, ok := entry.(string); ok && isDisallowedStrategyType(path, text) {
					hits = append(hits, path)
				}
			}
			if isContainer(entry) {
				hits = append(hits, findDisallowedKeys(entry, path, seen)...)
			}
		}
		return hits
	default:
		return nil
	}
}

func isContainer(value any) bool {
	switch value.(type) {
	case []any, map[string]any:
		return true
	}
	return false
}

// containerIdentity 返回 map/slice 的指针身份（JS Set 的对象身份镜像）。
// 标量与 nil 没有身份。
func containerIdentity(value any) (uintptr, bool) {
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Map, reflect.Slice:
		if rv.IsNil() {
			return 0, false
		}
		return rv.Pointer(), true
	}
	return 0, false
}
