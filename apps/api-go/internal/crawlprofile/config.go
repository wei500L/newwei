package crawlprofile

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// 本文件逐段翻译 apps/api/src/modules/crawl/crawl-frontier.utils.ts 的
// normalizeCrawlSiteProfileConfig（596-752 行）与 matchHostPattern
// （780-797 行），以及它们依赖的取值助手（146-198、168-198、314-594 行）
// 和两个断言（crawl4ai-llm.guard.ts 的 assertNoCrawl4aiLlmOptions 与
// crawl-config-policy.ts 的 assertSupportedFrontierProfileConfig，与
// crawlworkflow/bridge.go 已验收的翻译一致）。

// 与 crawl-frontier.utils.ts 一致的默认值。
var defaultPriorityKeywords = []string{
	"breaking", "live", "update", "updates", "latest", "exclusive", "war",
	"conflict", "sanctions", "strike", "election", "markets", "security",
}

var defaultDenyKeywords = []string{
	"about", "contact", "privacy", "terms", "site map", "newsletter",
	"podcast", "video", "gallery", "sponsored", "community guidelines",
	"code of ethics", "download app", "rss",
}

// normalizeCrawlSiteProfileConfig 对齐同名 TS 函数：非法输入（LLM 抽取键、
// frontier 单 URL 范围违规）返回 *inputError（400），与 BadRequestException
// 文案一致。输出与原实现相同——undefined 的键不出现，null 的键保留为
// null（shadow 的 lastPublishedAt/lastSuggestedAt/lastSuggestionReason）。
func normalizeCrawlSiteProfileConfig(raw json.RawMessage) (map[string]any, error) {
	value, ok := decodeRawObject(raw)
	if !ok {
		value = map[string]json.RawMessage{}
	}
	scanned := raw
	if !ok {
		// TS：value = isPlainObject(raw) ? raw : {}，随后断言扫描 value。
		scanned = json.RawMessage(`{}`)
	}
	if err := assertNoCrawl4aiLlmOptions(scanned, "crawlSiteProfile.config"); err != nil {
		return nil, err
	}
	if err := assertSupportedFrontierProfileConfig(value, "crawlSiteProfile.config"); err != nil {
		return nil, err
	}

	out := map[string]any{}
	if list, ok := toKeywordList(value["keywords"], nil); ok {
		out["keywords"] = list
	}
	if list, ok := toKeywordList(value["priorityKeywords"], defaultPriorityKeywords); ok {
		out["priorityKeywords"] = list
	}
	if list, ok := toKeywordList(value["denyKeywords"], defaultDenyKeywords); ok {
		out["denyKeywords"] = list
	}
	if list, ok := toStringList(value["blockedDomains"], 200); ok {
		out["blockedDomains"] = list
	}
	if scope, ok := jsEnumString(value["hostScope"], "registrable_domain", "strict_hosts"); ok {
		out["hostScope"] = scope
	}
	if list, ok := toStringList(value["allowedHosts"], 100); ok {
		out["allowedHosts"] = list
	}
	if list, ok := toStringList(value["allowedDomains"], 100); ok {
		out["allowedDomains"] = list
	}
	if list, ok := toStringList(value["domLinkScopes"], 50); ok {
		out["domLinkScopes"] = list
	}
	if list, ok := toStringList(value["domLinkExcludeSelectors"], 50); ok {
		out["domLinkExcludeSelectors"] = list
	}
	if list, ok := toStringList(value["urlQueryParamAllowlist"], 50); ok {
		out["urlQueryParamAllowlist"] = list
	}
	if patterns, ok := decodeRawObject(value["urlPatterns"]); ok {
		normalized := map[string]any{}
		for _, key := range []string{"home", "category", "list", "article", "exclude"} {
			if list, ok := toStringList(patterns[key], 100); ok {
				normalized[key] = list
			}
		}
		if len(normalized) > 0 {
			out["urlPatterns"] = normalized
		}
	}
	if signals, ok := decodeRawObject(value["pageTypeSignals"]); ok {
		normalized := map[string]any{}
		for _, key := range []string{"home", "category", "list", "article", "deny"} {
			if signal, ok := toPageTypeSignalConfig(signals[key]); ok {
				normalized[key] = signal
			}
		}
		if len(normalized) > 0 {
			out["pageTypeSignals"] = normalized
		}
	}
	if rules, ok := decodeRawObject(value["freshnessRules"]); ok {
		recentHours := jsToPositiveInt(rules["recentHours"], 1, 24*30, 24)
		weekHours := jsToPositiveInt(rules["weekHours"], recentHours, 24*60, 24*7)
		monthHours := jsToPositiveInt(rules["monthHours"], weekHours, 24*365, 24*30)
		out["freshnessRules"] = map[string]any{
			"recentHours": recentHours,
			"weekHours":   weekHours,
			"monthHours":  monthHours,
		}
	}
	if scope, ok := toLocaleScope(value["localeScope"]); ok {
		out["localeScope"] = scope
	}
	if discovery, ok := toSeedDiscovery(value["seedDiscovery"]); ok {
		out["seedDiscovery"] = discovery
	}
	if assist, ok := toLlmAssistConfig(value["llmAssist"]); ok {
		out["llmAssist"] = assist
	}
	if tier, ok := jsEnumString(value["sourceTier"], "tier1", "tier2", "tier3"); ok {
		out["sourceTier"] = tier
	}
	if rules, ok := toObjectRecord(value["pageRules"]); ok {
		normalized := map[string]any{}
		for _, key := range []string{"home", "category", "list", "article"} {
			rule, exists := rules[key]
			if !exists {
				continue
			}
			if err := assertNoCrawl4aiLlmOptions(rule, "crawlSiteProfile.config.pageRules."+key); err != nil {
				return nil, err
			}
			normalized[key] = cloneRaw(rule)
		}
		if len(normalized) > 0 {
			out["pageRules"] = normalized
		}
	}
	if options, ok := decodeRawObject(value["layeredOptions"]); ok {
		out["layeredOptions"] = map[string]any{
			"maxDepth":            jsToPositiveInt(options["maxDepth"], 1, 8, 3),
			"maxPages":            jsToPositiveInt(options["maxPages"], 1, 500, 60),
			"maxChildrenPerNode":  jsToPositiveInt(options["maxChildrenPerNode"], 1, 200, 24),
			"paginationKeepCount": jsToPositiveInt(options["paginationKeepCount"], 1, 10, 3),
			"scoreThreshold":      jsToScore(options["scoreThreshold"], 0.35),
		}
	}
	if options, ok := decodeRawObject(value["nativeOptions"]); ok {
		normalized := map[string]any{
			"minAcceptedResults": jsToPositiveInt(options["minAcceptedResults"], 0, 500, 0),
			"minArticleResults":  jsToPositiveInt(options["minArticleResults"], 0, 500, 0),
		}
		for _, key := range []string{"deepCrawlStrategy", "filterChain", "urlScorer", "adaptiveCrawling"} {
			if raw, ok := rawObjectValue(options[key]); ok {
				normalized[key] = raw
			}
		}
		if enabled, ok := jsBoolStrict(options["stream"]); ok {
			normalized["stream"] = enabled
		}
		if enabled, ok := jsBoolStrict(options["fallbackToLayered"]); ok {
			normalized["fallbackToLayered"] = enabled
		}
		out["nativeOptions"] = normalized
	}
	if _, ok := decodeRawObject(value["crawlOptions"]); ok {
		if err := assertNoCrawl4aiLlmOptions(value["crawlOptions"], "crawlSiteProfile.config.crawlOptions"); err != nil {
			return nil, err
		}
		out["crawlOptions"] = cloneRaw(value["crawlOptions"])
	}
	return out, nil
}

// ---- 取值助手（逐条对齐 crawl-frontier.utils.ts） ----

// toStringList 对齐 toStringList：非数组→不产出；元素只保留字符串、
// trim 后丢弃空串、按首次出现去重；超过 max 截断。
func toStringList(raw json.RawMessage, max int) ([]string, bool) {
	if !jsonIsArrayRaw(raw) {
		return nil, false
	}
	items, ok := decodeRawArray(raw)
	if !ok {
		return nil, false
	}
	normalized := []string{}
	for _, item := range items {
		text, ok := jsString(item)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		normalized = append(normalized, text)
	}
	if len(normalized) == 0 {
		return nil, false
	}
	deduped := make([]string, 0, len(normalized))
	seen := map[string]bool{}
	for _, entry := range normalized {
		if seen[entry] {
			continue
		}
		seen[entry] = true
		deduped = append(deduped, entry)
	}
	if max > 0 && len(deduped) > max {
		deduped = deduped[:max]
	}
	return deduped, true
}

// toKeywordList 对齐 toKeywordList：字符串列表为空/缺失时回落默认值。
func toKeywordList(raw json.RawMessage, fallback []string) ([]string, bool) {
	if list, ok := toStringList(raw, 100); ok {
		return list, true
	}
	if fallback != nil {
		return append([]string{}, fallback...), true
	}
	return nil, false
}

// toObjectRecord 对齐 toObjectRecord：只保留值为普通对象的键；
// 没有命中→不产出。
func toObjectRecord(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	normalized := map[string]json.RawMessage{}
	for key, entry := range value {
		if jsonIsObjectRaw(entry) {
			normalized[key] = entry
		}
	}
	if len(normalized) == 0 {
		return nil, false
	}
	return normalized, true
}

// toPageTypeSignalConfig 对齐同名函数：数组 → {patterns}；对象 →
// {patterns, keywords}（各自可缺省）；都没有 → 不产出。
func toPageTypeSignalConfig(raw json.RawMessage) (map[string]any, bool) {
	if jsonIsArrayRaw(raw) {
		patterns, ok := toStringList(raw, 100)
		if !ok {
			return nil, false
		}
		return map[string]any{"patterns": patterns}, true
	}
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	patterns, hasPatterns := toStringList(value["patterns"], 100)
	keywords, hasKeywords := toStringList(value["keywords"], 100)
	if !hasPatterns && !hasKeywords {
		return nil, false
	}
	signal := map[string]any{}
	if hasPatterns {
		signal["patterns"] = patterns
	}
	if hasKeywords {
		signal["keywords"] = keywords
	}
	return signal, true
}

// toLocale 对齐 toLocale：字符串 trim 后非空，截断到 16 个 UTF-16 码元。
func toLocale(raw json.RawMessage) (string, bool) {
	text, ok := jsString(raw)
	if !ok {
		return "", false
	}
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return "", false
	}
	return jsSliceUTF16(normalized, 16), true
}

// jsTrimmedSliced 对齐 toTrimmedString：字符串 trim 后非空，截断到 max。
func jsTrimmedSliced(raw json.RawMessage, max int) (string, bool) {
	text, ok := jsString(raw)
	if !ok {
		return "", false
	}
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return "", false
	}
	return jsSliceUTF16(normalized, max), true
}

// toLocaleScope 对齐 toLocaleScope：四个字段全空/缺失 → 不产出；
// 否则对象里只带出现过的字段。
func toLocaleScope(raw json.RawMessage) (map[string]any, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	normalized := map[string]any{}
	if locale, ok := toLocale(value["locale"]); ok {
		normalized["locale"] = locale
	}
	if list, ok := toStringList(value["acceptLanguages"], 16); ok {
		normalized["acceptLanguages"] = list
	}
	if list, ok := toStringList(value["denyUrlPatterns"], 100); ok {
		normalized["denyUrlPatterns"] = list
	}
	if list, ok := toStringList(value["denyHostPatterns"], 50); ok {
		normalized["denyHostPatterns"] = list
	}
	if len(normalized) == 0 {
		return nil, false
	}
	return normalized, true
}

// toSeedQualityThresholds 对齐 toSeedQualityThresholds。
func toSeedQualityThresholds(raw json.RawMessage) (map[string]any, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	return map[string]any{
		"minCandidates":   jsToPositiveInt(value["minCandidates"], 1, 200, 3),
		"minArticleRatio": jsToScore(value["minArticleRatio"], 0.4),
		"maxNoiseRatio":   jsToScore(value["maxNoiseRatio"], 0.45),
		"minFreshRatio":   jsToScore(value["minFreshRatio"], 0.2),
	}, true
}

// toSeedDiscovery 对齐 toSeedDiscovery：strategy 默认 auto、mode 默认
// robots；其余字段仅在出现时转换；七个字段全缺省 → 不产出。
func toSeedDiscovery(raw json.RawMessage) (map[string]any, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	_, hasStrategy := value["strategy"]
	_, hasMode := value["mode"]
	_, hasFreshness := value["freshnessWindowHours"]
	_, hasMaxSeedURLs := value["maxSeedUrls"]
	_, hasTopologyPages := value["topologyBudgetPages"]
	_, hasTopologyDepth := value["topologyBudgetDepth"]
	_, hasQuality := value["qualityThresholds"]
	if !hasStrategy && !hasMode && !hasFreshness && !hasMaxSeedURLs && !hasTopologyPages && !hasTopologyDepth && !hasQuality {
		return nil, false
	}
	strategy := "auto"
	if text, ok := jsEnumString(value["strategy"], "auto", "seed_first", "frontier_first", "frontier_only"); ok {
		strategy = text
	}
	mode := "robots"
	if text, ok := jsEnumString(value["mode"], "robots", "common_paths", "sitemap_only", "disabled"); ok {
		mode = text
	}
	normalized := map[string]any{"strategy": strategy, "mode": mode}
	if hasFreshness {
		normalized["freshnessWindowHours"] = jsToPositiveInt(value["freshnessWindowHours"], 1, 24*365, 24*7)
	}
	if hasMaxSeedURLs {
		normalized["maxSeedUrls"] = jsToPositiveInt(value["maxSeedUrls"], 1, 500, 80)
	}
	if hasTopologyPages {
		normalized["topologyBudgetPages"] = jsToPositiveInt(value["topologyBudgetPages"], 1, 100, 12)
	}
	if hasTopologyDepth {
		normalized["topologyBudgetDepth"] = jsToPositiveInt(value["topologyBudgetDepth"], 1, 8, 2)
	}
	if quality, ok := toSeedQualityThresholds(value["qualityThresholds"]); ok {
		normalized["qualityThresholds"] = quality
	}
	return normalized, true
}

// toLlmAssistAutoPublishThresholds 对齐同名函数。
func toLlmAssistAutoPublishThresholds(raw json.RawMessage) (map[string]any, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	return map[string]any{
		"minArticleLift":     jsToScore(value["minArticleLift"], 0.15),
		"minNoiseReduction":  jsToScore(value["minNoiseReduction"], 0.2),
		"minJudgeConfidence": jsToScore(value["minJudgeConfidence"], 0.75),
	}, true
}

// setNullableTrimmed 对齐 `value.x === null ? null : toTrimmedString(value.x, max)`：
// null → 写 null；字符串 trim 后非空 → 写截断值；其余 → 键省略。
func setNullableTrimmed(target map[string]any, value map[string]json.RawMessage, key string, max int) {
	raw, exists := value[key]
	if !exists {
		return
	}
	if isJSONNull(raw) {
		target[key] = nil
		return
	}
	if text, ok := jsTrimmedSliced(raw, max); ok {
		target[key] = text
	}
}

// toLlmAssistShadowConfig 对齐 toLlmAssistShadowConfig：十二个字段全缺省
// → 不产出（显式 null 的 lastPublishedAt/lastSuggestedAt/
// lastSuggestionReason 视为「出现」）。
func toLlmAssistShadowConfig(raw json.RawMessage) (map[string]any, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	normalized := map[string]any{}
	if role, ok := jsEnumString(value["role"], "active", "shadow"); ok {
		normalized["role"] = role
	}
	if text, ok := jsTrimmedSliced(value["shadowOfProfileId"], 191); ok {
		normalized["shadowOfProfileId"] = text
	}
	if _, exists := value["originProfileVersion"]; exists {
		normalized["originProfileVersion"] = jsToPositiveInt(value["originProfileVersion"], 1, 10000, 1)
	}
	if state, ok := jsEnumString(value["state"], "candidate", "evaluating", "published"); ok {
		normalized["state"] = state
	}
	if _, exists := value["evaluationRunsCompleted"]; exists {
		normalized["evaluationRunsCompleted"] = jsToPositiveInt(value["evaluationRunsCompleted"], 0, 10000, 0)
	}
	if _, exists := value["consecutivePasses"]; exists {
		normalized["consecutivePasses"] = jsToPositiveInt(value["consecutivePasses"], 0, 10000, 0)
	}
	if text, ok := jsTrimmedSliced(value["lastOriginRunId"], 191); ok {
		normalized["lastOriginRunId"] = text
	}
	if text, ok := jsTrimmedSliced(value["lastShadowRunId"], 191); ok {
		normalized["lastShadowRunId"] = text
	}
	setNullableTrimmed(normalized, value, "lastPublishedAt", 64)
	setNullableTrimmed(normalized, value, "lastSuggestedAt", 64)
	if _, exists := value["lastSuggestionConfidence"]; exists {
		// TS：typeof value.lastSuggestionConfidence === "number"——null/字符串
		// 都不算（JSON null 不能反序列化成 number）。
		if _, isNumber := jsStrictNumber(value["lastSuggestionConfidence"]); isNumber {
			normalized["lastSuggestionConfidence"] = jsToScore(value["lastSuggestionConfidence"], 0.75)
		}
	}
	setNullableTrimmed(normalized, value, "lastSuggestionReason", 500)
	if len(normalized) == 0 {
		return nil, false
	}
	return normalized, true
}

// toLlmAssistConfig 对齐 toLlmAssistConfig：十个字段全缺省 → 不产出。
func toLlmAssistConfig(raw json.RawMessage) (map[string]any, bool) {
	value, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	candidateBudget := map[string]any{}
	if budget, ok := decodeRawObject(value["candidateBudgetByPageType"]); ok {
		for _, key := range []string{"home", "category", "list", "article"} {
			if _, exists := budget[key]; !exists {
				continue
			}
			fallback := float64(24)
			if key == "article" {
				fallback = 0
			}
			candidateBudget[key] = jsToPositiveInt(budget[key], 0, 200, fallback)
		}
	}
	enabled, hasEnabled := jsBoolStrict(value["enabled"])
	recallMode, hasRecall := jsEnumString(value["recallMode"], "high_recall", "balanced", "low_cost")
	judgeModel, hasJudge := jsTrimmedSliced(value["judgeModel"], 191)
	siteLearnerModel, hasLearner := jsTrimmedSliced(value["siteLearnerModel"], 191)
	_, hasMinJudge := value["minJudgeConfidence"]
	_, hasShadowRuns := value["shadowEvaluationRuns"]
	autoPublish, hasAutoPublish := toLlmAssistAutoPublishThresholds(value["autoPublishThresholds"])
	shadow, hasShadow := toLlmAssistShadowConfig(value["shadow"])
	if !hasEnabled && !hasRecall && !hasJudge && !hasLearner && len(candidateBudget) == 0 &&
		!hasMinJudge && !hasShadowRuns && !hasAutoPublish && !hasShadow {
		return nil, false
	}
	normalized := map[string]any{}
	if hasEnabled {
		normalized["enabled"] = enabled
	}
	if hasRecall {
		normalized["recallMode"] = recallMode
	}
	if hasJudge {
		normalized["judgeModel"] = judgeModel
	}
	if hasLearner {
		normalized["siteLearnerModel"] = siteLearnerModel
	}
	if len(candidateBudget) > 0 {
		normalized["candidateBudgetByPageType"] = candidateBudget
	}
	if hasMinJudge {
		normalized["minJudgeConfidence"] = jsToScore(value["minJudgeConfidence"], 0.75)
	}
	if hasShadowRuns {
		normalized["shadowEvaluationRuns"] = jsToPositiveInt(value["shadowEvaluationRuns"], 1, 20, 3)
	}
	if hasAutoPublish {
		normalized["autoPublishThresholds"] = autoPublish
	}
	if hasShadow {
		normalized["shadow"] = shadow
	}
	return normalized, true
}

// ---- 数值语义（与 crawlworkflow/bridge.go 已验收的翻译一致） ----

// jsNumberCoerce 近似 JavaScript 的 Number(value)：数字原样；字符串按
// 十进制解析（trim 后空串为 0）；true/false 为 1/0；null 为 0；其余 NaN。
func jsNumberCoerce(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		text, ok := jsString(raw)
		if !ok {
			return 0, false
		}
		inner := strings.TrimSpace(text)
		if inner == "" {
			return 0, true
		}
		if inner == "Infinity" || inner == "+Infinity" {
			return math.Inf(1), true
		}
		if inner == "-Infinity" {
			return math.Inf(-1), true
		}
		value, err := strconv.ParseFloat(inner, 64)
		if err != nil {
			return 0, false
		}
		return value, true
	case 't':
		return 1, trimmed == "true"
	case 'f':
		return 0, trimmed == "false"
	case 'n':
		return 0, trimmed == "null"
	default:
		value, ok := jsNumber(raw)
		return value, ok
	}
}

// jsToPositiveInt 对齐 toPositiveInt：Math.max(min, Math.min(max,
// Math.round(parsed)))，非法值回落 fallback。
func jsToPositiveInt(raw json.RawMessage, min, max, fallback float64) float64 {
	parsed, ok := jsNumberCoerce(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return math.Max(min, math.Min(max, math.Round(parsed)))
}

// jsToScore 对齐 toScore：clamp 到 [0,1]，先按 3 位小数四舍五入。
func jsToScore(raw json.RawMessage, fallback float64) float64 {
	parsed, ok := jsNumberCoerce(raw)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return jsToScoreValue(parsed)
}

func jsToScoreValue(parsed float64) float64 {
	rounded := math.Round(parsed*1000) / 1000
	return math.Max(0, math.Min(1, rounded))
}

// jsEnumString 对齐 toHostScope/toSourceTier/toSeedStrategy/
// toSeedDiscoveryMode/toRecallMode/toShadowRole/toShadowState 系列：
// 字符串 trim + lower 后命中才返回。
func jsEnumString(raw json.RawMessage, allowed ...string) (string, bool) {
	text, ok := jsString(raw)
	if !ok {
		return "", false
	}
	normalized := strings.ToLower(strings.TrimSpace(text))
	for _, candidate := range allowed {
		if normalized == candidate {
			return candidate, true
		}
	}
	return "", false
}

// jsBoolStrict 对齐 `typeof value === "boolean"`。
func jsBoolStrict(raw json.RawMessage) (bool, bool) {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// jsSliceUTF16 近似 JavaScript String.prototype.slice(0, max)：按 UTF-16
// 码元计数截断。截断掉半个代理对时以 U+FFFD 收尾（JS 会留下孤立代理，
// 其 JSON 序列化形态不同；该边界只影响孤立代理这种异常输入）。
func jsSliceUTF16(value string, max int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= max {
		return value
	}
	return string(utf16.Decode(units[:max]))
}

// ---- matchHostPattern（crawl-frontier.utils.ts 780-797 行） ----

var hostWildcardEscapePattern = regexp.MustCompile(`[|\\{}()\[\]^$+?.]`)

func escapeRegex(value string) string {
	return hostWildcardEscapePattern.ReplaceAllStringFunc(value, func(match string) string {
		return "\\" + match
	})
}

// wildcardToRegex 对齐 wildcardToRegex：trim → 转义 → * 变 .* → ^...$ 且忽略大小写。
func wildcardToRegex(pattern string) (*regexp.Regexp, error) {
	normalized := strings.TrimSpace(pattern)
	body := strings.ReplaceAll(escapeRegex(normalized), "*", ".*")
	return regexp.Compile("(?i)^" + body + "$")
}

// matchHostPattern 对齐 matchHostPattern：相等 → true；`.foo` 前缀（即
// *.foo）→ 后缀匹配；含 * → 通配正则；否则相等比较。
func matchHostPattern(pattern, host string) bool {
	normalizedPattern := strings.ToLower(strings.TrimSpace(pattern))
	normalizedHost := strings.ToLower(strings.TrimSpace(host))
	if normalizedPattern == "" || normalizedHost == "" {
		return false
	}
	if normalizedPattern == normalizedHost {
		return true
	}
	if strings.HasPrefix(normalizedPattern, "*.") {
		suffix := normalizedPattern[1:]
		return strings.HasSuffix(normalizedHost, suffix)
	}
	if strings.Contains(normalizedPattern, "*") {
		compiled, err := wildcardToRegex(normalizedPattern)
		if err != nil {
			return false
		}
		return compiled.MatchString(normalizedHost)
	}
	return normalizedHost == normalizedPattern
}

// ---- JavaScript 值语义小工具（与 crawlworkflow/definition.go 一致） ----

func decodeRawObject(raw []byte) (map[string]json.RawMessage, bool) {
	if !jsonIsObjectRaw(raw) {
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &fields); err != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

func decodeRawArray(raw []byte) ([]json.RawMessage, bool) {
	if !jsonIsArrayRaw(raw) {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &items); err != nil {
		return nil, false
	}
	return items, true
}

// jsonIsObjectRaw 判定原始 JSON 是否是对象（null/数组/标量都不是）。
func jsonIsObjectRaw(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

func jsonIsArrayRaw(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

func jsonIsNull(raw []byte) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// isJSONNull 判定 JSON 字面量 null（空值不算）。
func isJSONNull(raw json.RawMessage) bool {
	return len(raw) > 0 && jsonIsNull(raw)
}

func jsString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

func jsNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// jsStrictNumber 对齐 `typeof value === "number"`：JSON null 不算数字
// （Go 把 null 反序列化为 0 且不报错，必须显式排除）。
func jsStrictNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || jsonIsNull(raw) {
		return 0, false
	}
	return jsNumber(raw)
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	if raw == nil {
		return nil
	}
	out := make([]byte, len(raw))
	copy(out, raw)
	return out
}

func rawObjectValue(raw json.RawMessage) (json.RawMessage, bool) {
	if !jsonIsObjectRaw(raw) {
		return nil, false
	}
	return cloneRaw(raw), true
}

// ---- 断言（与 crawlworkflow/bridge.go 的翻译一致） ----

// assertNoCrawl4aiLlmOptions 镜像 crawl4ai-llm.guard.ts 的递归键扫描。
// 命中键按字典序输出（NestJS 按插入序；单一命中时两者一致）。
func assertNoCrawl4aiLlmOptions(raw json.RawMessage, label string) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	hits := findDisallowedKeys(value, "")
	if len(hits) == 0 {
		return nil
	}
	shown := hits
	suffix := ""
	if len(hits) > 5 {
		shown = hits[:5]
		suffix = " (+" + strconv.Itoa(len(hits)-5) + " more)"
	}
	return &inputError{Message: label + " contains crawl4ai LLM extraction settings (" +
		strings.Join(shown, ", ") + suffix + "). " +
		"The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead."}
}

func findDisallowedKeys(value any, prefix string) []string {
	if value == nil {
		return nil
	}
	hits := []string{}
	switch typed := value.(type) {
	case []any:
		for index, entry := range typed {
			hits = append(hits, findDisallowedKeys(entry, prefix+"["+strconv.Itoa(index)+"]")...)
		}
		return hits
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			entry := typed[key]
			normalized := normalizeDisallowedKey(key)
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			if normalized == "extractionstrategy" || normalized == "llmconfig" {
				hits = append(hits, path)
			}
			if normalized == "type" {
				if text, ok := entry.(string); ok && isDisallowedStrategyType(path, text) {
					hits = append(hits, path)
				}
			}
			hits = append(hits, findDisallowedKeys(entry, path)...)
		}
		return hits
	default:
		return nil
	}
}

func normalizeDisallowedKey(key string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(key) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func isDisallowedStrategyType(path, value string) bool {
	normalizedPath := normalizeDisallowedKey(path)
	normalizedValue := normalizeDisallowedKey(value)
	if !strings.Contains(normalizedValue, "llm") {
		return false
	}
	return strings.Contains(normalizedPath, "strategy") || strings.Contains(normalizedPath, "extraction")
}

// assertSupportedFrontierProfileConfig 镜像
// findUnsupportedFrontierNodeScopeIssues 中 crawlOptions 与 pageRules 的检查。
func assertSupportedFrontierProfileConfig(value map[string]json.RawMessage, path string) error {
	issues := []string{}
	checkScope := func(raw json.RawMessage, basePath string) {
		options, ok := decodeRawObject(raw)
		if !ok {
			return
		}
		if _, ok := options["proxyUrl"]; ok {
			issues = append(issues, basePath+".proxyUrl: custom upstream proxies are not supported")
		}
		if _, ok := options["proxyConfig"]; ok {
			issues = append(issues, basePath+".proxyConfig: custom upstream proxies are not supported")
		}
		if _, ok := options["additionalUrls"]; ok {
			issues = append(issues, basePath+".additionalUrls: frontier node crawl must target exactly one primary URL")
		}
		if _, ok := options["multiUrlConfigs"]; ok {
			issues = append(issues, basePath+".multiUrlConfigs: frontier node crawl must target exactly one primary URL")
		}
	}
	checkScope(value["crawlOptions"], path+".crawlOptions")
	if pageRules, ok := decodeRawObject(value["pageRules"]); ok {
		for _, pageType := range []string{"home", "category", "list", "article"} {
			rule := pageRules[pageType]
			if !jsonIsObjectRaw(rule) {
				continue
			}
			checkScope(rule, path+".pageRules."+pageType)
		}
	}
	if len(issues) > 0 {
		return &inputError{Message: "Unsupported crawl config: " + strings.Join(issues, "; ")}
	}
	return nil
}
