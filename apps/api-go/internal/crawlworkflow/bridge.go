package crawlworkflow

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

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

// pageTypeSignal 对齐 CrawlPageTypeSignalConfig（patterns/keywords 只会
// 是非空列表或 undefined——JSON 里省略）。
type pageTypeSignal struct {
	Patterns []string `json:"patterns,omitempty"`
	Keywords []string `json:"keywords,omitempty"`
}

type freshnessRules struct {
	RecentHours float64
	WeekHours   float64
	MonthHours  float64
}

type seedDiscoveryConfig struct {
	Mode        string
	MaxSeedURLs *float64
}

type layeredOptions struct {
	MaxDepth       *float64
	MaxPages       *float64
	ScoreThreshold *float64
}

// profileBridgeConfig 只保留 buildWorkflowFromProfile 消费的字段
// （crawl-frontier.utils.ts normalizeCrawlSiteProfileConfig 的对应子集；
// 其余字段不参与 bridge 输出，本批不引入）。
type profileBridgeConfig struct {
	Keywords         []string
	PriorityKeywords []string
	DenyKeywords     []string
	BlockedDomains   []string
	HostScope        string
	AllowedHosts     []string
	URLPatterns      map[string][]string
	PageTypeSignals  map[string]pageTypeSignal
	FreshnessRules   *freshnessRules
	SeedDiscovery    *seedDiscoveryConfig
	LayeredOptions   *layeredOptions
	CrawlOptions     json.RawMessage
}

type profileBridgeInput struct {
	Name          string
	Description   *string
	ExecutionMode string
}

// normalizeProfileConfig 移植 normalizeCrawlSiteProfileConfig 中 bridge 用到的
// 部分，并按同一顺序执行其断言（整个 config 的 LLM 扫描 → frontier 范围
// 断言 → pageRules 的 LLM 扫描 → crawlOptions 的 LLM 扫描）。断言失败消息
// 与 NestJS BadRequestException 相同。
func normalizeProfileConfig(raw []byte) (*profileBridgeConfig, error) {
	value, ok := decodeRawObject(raw)
	if !ok {
		value = map[string]json.RawMessage{}
	}
	if err := assertNoCrawl4aiLlmOptions(raw, "crawlSiteProfile.config"); err != nil {
		return nil, err
	}
	if err := assertSupportedFrontierProfileConfig(value, "crawlSiteProfile.config"); err != nil {
		return nil, err
	}

	config := &profileBridgeConfig{}
	config.Keywords = jsToStringList(value["keywords"], 100)
	config.PriorityKeywords = jsToStringList(value["priorityKeywords"], 100)
	if config.PriorityKeywords == nil {
		config.PriorityKeywords = append([]string{}, defaultPriorityKeywords...)
	}
	config.DenyKeywords = jsToStringList(value["denyKeywords"], 100)
	if config.DenyKeywords == nil {
		config.DenyKeywords = append([]string{}, defaultDenyKeywords...)
	}
	config.BlockedDomains = jsToStringList(value["blockedDomains"], 200)
	if scope, ok := jsString(value["hostScope"]); ok {
		switch strings.ToLower(strings.TrimSpace(scope)) {
		case "registrable_domain":
			config.HostScope = "registrable_domain"
		case "strict_hosts":
			config.HostScope = "strict_hosts"
		}
	}
	config.AllowedHosts = jsToStringList(value["allowedHosts"], 100)

	if patterns, ok := decodeRawObject(value["urlPatterns"]); ok {
		normalized := map[string][]string{}
		for _, key := range []string{"home", "category", "list", "article", "exclude"} {
			if list := jsToStringList(patterns[key], 100); list != nil {
				normalized[key] = list
			}
		}
		if len(normalized) > 0 {
			config.URLPatterns = normalized
		}
	}
	if signals, ok := decodeRawObject(value["pageTypeSignals"]); ok {
		normalized := map[string]pageTypeSignal{}
		for _, key := range []string{"home", "category", "list", "article", "deny"} {
			if signal, ok := toPageTypeSignalConfig(signals[key]); ok {
				normalized[key] = signal
			}
		}
		if len(normalized) > 0 {
			config.PageTypeSignals = normalized
		}
	}
	if rules, ok := decodeRawObject(value["freshnessRules"]); ok {
		recentHours := jsToPositiveInt(rules["recentHours"], 1, 24*30, 24)
		weekHours := jsToPositiveInt(rules["weekHours"], recentHours, 24*60, 24*7)
		monthHours := jsToPositiveInt(rules["monthHours"], weekHours, 24*365, 24*30)
		config.FreshnessRules = &freshnessRules{
			RecentHours: recentHours,
			WeekHours:   weekHours,
			MonthHours:  monthHours,
		}
	}
	if seed, ok := decodeRawObject(value["seedDiscovery"]); ok {
		_, hasStrategy := seed["strategy"]
		_, hasMode := seed["mode"]
		_, hasFreshness := seed["freshnessWindowHours"]
		_, hasMaxSeedURLs := seed["maxSeedUrls"]
		_, hasTopologyPages := seed["topologyBudgetPages"]
		_, hasTopologyDepth := seed["topologyBudgetDepth"]
		_, hasQuality := seed["qualityThresholds"]
		if hasStrategy || hasMode || hasFreshness || hasMaxSeedURLs || hasTopologyPages || hasTopologyDepth || hasQuality {
			resolved := seedDiscoveryConfig{Mode: "robots"}
			if text, ok := jsSeedDiscoveryMode(seed["mode"]); ok {
				resolved.Mode = text
			}
			if hasMaxSeedURLs {
				value := jsToPositiveInt(seed["maxSeedUrls"], 1, 500, 80)
				resolved.MaxSeedURLs = &value
			}
			config.SeedDiscovery = &resolved
		}
	}
	// pageRules 的 LLM 扫描在对象字面量求值顺序中先于 crawlOptions。
	if rulesRaw, ok := decodeRawObject(value["pageRules"]); ok {
		for _, key := range []string{"home", "category", "list", "article"} {
			entry, exists := rulesRaw[key]
			if !exists || !jsonIsObjectRaw(entry) {
				continue
			}
			if err := assertNoCrawl4aiLlmOptions(entry, "crawlSiteProfile.config.pageRules."+key); err != nil {
				return nil, err
			}
		}
	}
	if options, ok := decodeRawObject(value["layeredOptions"]); ok {
		resolved := &layeredOptions{}
		maxDepth := jsToPositiveInt(options["maxDepth"], 1, 8, 3)
		maxPages := jsToPositiveInt(options["maxPages"], 1, 500, 60)
		scoreThreshold := jsToScore(options["scoreThreshold"], 0.35)
		resolved.MaxDepth = &maxDepth
		resolved.MaxPages = &maxPages
		resolved.ScoreThreshold = &scoreThreshold
		config.LayeredOptions = resolved
	}
	if optionsRaw, ok := decodeRawObject(value["crawlOptions"]); ok {
		if err := assertNoCrawl4aiLlmOptions(optionsRaw, "crawlSiteProfile.config.crawlOptions"); err != nil {
			return nil, err
		}
		config.CrawlOptions = cloneRaw(value["crawlOptions"])
	}
	return config, nil
}

// buildWorkflowFromProfile 镜像 crawl-strategy-legacy-bridge.service.ts 的
// buildWorkflowFromProfile。
func buildWorkflowFromProfile(profile profileBridgeInput, config *profileBridgeConfig, seedURL string) WorkflowDefinition {
	definition := createEmptyWorkflowDefinition(seedURL)
	if profile.Description != nil {
		definition.Metadata.Description = *profile.Description
	} else {
		definition.Metadata.Description = "Generated from profile " + profile.Name
	}
	definition.Metadata.Template = "legacy_profile"
	definition.Settings.ExecutionMode = profile.ExecutionMode
	if config.LayeredOptions != nil && config.LayeredOptions.MaxDepth != nil {
		definition.Settings.MaxDepth = *config.LayeredOptions.MaxDepth
	} else {
		definition.Settings.MaxDepth = 3
	}
	if config.LayeredOptions != nil && config.LayeredOptions.MaxPages != nil {
		definition.Settings.MaxPages = *config.LayeredOptions.MaxPages
	} else {
		definition.Settings.MaxPages = 60
	}
	definition.Settings.RobotsPolicy = "respect"
	if rawOfCrawlOptionFalse(config.CrawlOptions, "check_robots_txt") {
		definition.Settings.RobotsPolicy = "ignore"
	}
	if config.HostScope == "strict_hosts" {
		definition.Settings.DomainScope = "strict_hosts"
	} else {
		definition.Settings.DomainScope = "registrable_domain"
	}

	for index := range definition.Nodes {
		switch definition.Nodes[index].Type {
		case "seed-discovery":
			seedMode := "robots"
			seedMaxURLs := float64(40)
			if config.SeedDiscovery != nil {
				seedMode = config.SeedDiscovery.Mode
				if config.SeedDiscovery.MaxSeedURLs != nil {
					seedMaxURLs = *config.SeedDiscovery.MaxSeedURLs
				}
			}
			// `{...seedNode.config, mode, maxUrls}`：保留既有键后覆盖两个。
			seedConfig := map[string]any{}
			if fields, ok := decodeRawObject(definition.Nodes[index].Config); ok {
				for key, raw := range fields {
					var entry any
					if err := json.Unmarshal(raw, &entry); err == nil {
						seedConfig[key] = entry
					}
				}
			}
			seedConfig["mode"] = seedMode
			seedConfig["maxUrls"] = seedMaxURLs
			definition.Nodes[index].Config = rawOf(seedConfig)
		case "url-filter":
			definition.Nodes[index].Config = rawOf(map[string]any{
				"includePatterns": urlPatternList(config, "article"),
				"excludePatterns": urlPatternList(config, "exclude"),
				"blockedDomains":  listOrEmpty(config.BlockedDomains),
				"allowedHosts":    listOrEmpty(config.AllowedHosts),
				"denyKeywords":    listOrEmpty(config.DenyKeywords),
			})
		case "page-type-classifier":
			signals := map[string]pageTypeSignal{}
			for key, signal := range config.PageTypeSignals {
				signals[key] = signal
			}
			urlPatterns := map[string][]string{}
			for key, list := range config.URLPatterns {
				urlPatterns[key] = list
			}
			definition.Nodes[index].Config = rawOf(map[string]any{
				"urlPatterns":     urlPatterns,
				"pageTypeSignals": signals,
			})
		case "url-scorer":
			keywords := []string{}
			keywords = append(keywords, config.Keywords...)
			keywords = append(keywords, config.PriorityKeywords...)
			definition.Nodes[index].Config = rawOf(map[string]any{"keywordBoosts": keywords})
		case "freshness-scorer":
			recentHours := float64(24)
			weekHours := float64(24 * 7)
			monthHours := float64(24 * 30)
			if config.FreshnessRules != nil {
				recentHours = config.FreshnessRules.RecentHours
				weekHours = config.FreshnessRules.WeekHours
				monthHours = config.FreshnessRules.MonthHours
			}
			definition.Nodes[index].Config = rawOf(map[string]any{
				"recentHours": recentHours,
				"weekHours":   weekHours,
				"monthHours":  monthHours,
			})
		case "budget-control":
			keepTopK := float64(20)
			minScore := float64(0)
			maxPages := float64(60)
			maxDepth := float64(3)
			if config.LayeredOptions != nil {
				if config.LayeredOptions.MaxPages != nil {
					keepTopK = *config.LayeredOptions.MaxPages
					maxPages = *config.LayeredOptions.MaxPages
				}
				if config.LayeredOptions.ScoreThreshold != nil {
					minScore = *config.LayeredOptions.ScoreThreshold
				}
				if config.LayeredOptions.MaxDepth != nil {
					maxDepth = *config.LayeredOptions.MaxDepth
				}
			}
			definition.Nodes[index].Config = rawOf(map[string]any{
				"keepTopK":  keepTopK,
				"minScore":  minScore,
				"maxPages":  maxPages,
				"maxDepth":  maxDepth,
			})
		case "persist-result":
			selectTopK := float64(20)
			if config.LayeredOptions != nil && config.LayeredOptions.MaxPages != nil {
				selectTopK = *config.LayeredOptions.MaxPages
			}
			definition.Nodes[index].Config = rawOf(map[string]any{"selectTopK": selectTopK})
		}
	}
	return definition
}

// buildWorkflowFromNewsSource 镜像 buildWorkflowFromNewsSource。
// config 是 NewsSource.config（对象或 null）；crawlOptions 是模板的
// crawlOptions（isActive 且是对象时传原文，否则 nil）。
func buildWorkflowFromNewsSource(sourceURL string, configRaw json.RawMessage, crawlOptions json.RawMessage) WorkflowDefinition {
	definition := createEmptyWorkflowDefinition(sourceURL)
	definition.Metadata.Template = "legacy_news_source"
	definition.Metadata.Description = "Generated from news source " + sourceURL

	config, _ := decodeRawObject(configRaw)
	seed, seedOK := decodeRawObject(config["seed"])
	crawlOptionsRaw := json.RawMessage(nil)
	if jsonIsObjectRaw(crawlOptions) {
		crawlOptionsRaw = cloneRaw(crawlOptions)
	}
	keywords := newsSourceKeywords(config["keywords"])

	if !seedOK || !isSeedEnabled(seed) {
		return definition
	}

	modeRaw := ""
	if mode, ok := jsString(seed["mode"]); ok {
		modeRaw = strings.ToLower(strings.TrimSpace(mode))
	}
	discoveryType := "seed-discovery"
	switch modeRaw {
	case "list":
		discoveryType = "list-discovery"
	case "deep":
		discoveryType = "deep-discovery"
	}

	for index := range definition.Nodes {
		if definition.Nodes[index].ID != "seed-discovery" {
			continue
		}
		switch discoveryType {
		case "list-discovery":
			definition.Nodes[index].Type = "list-discovery"
			definition.Nodes[index].Label = "List Discovery"
			definition.Nodes[index].Config = rawOf(map[string]any{
				"listUrl":             sourceURL,
				"domain":              stringOrEmpty(seed["domain"]),
				"pattern":             stringOrEmpty(seed["pattern"]),
				"maxUrls":             seedNumberOr(seed["maxUrls"], 80),
				"listMaxPages":        seedNumberOr(seed["listMaxPages"], 6),
				"listPageConcurrency": seedNumberOr(seed["listPageConcurrency"], 2),
				"followPagination":    !isStrictFalse(seed["followPagination"]),
				"crawlOptions":        objectOrEmpty(crawlOptionsRaw),
			})
		case "deep-discovery":
			query := stringOrEmpty(seed["query"])
			if _, ok := jsString(seed["query"]); !ok {
				query = strings.Join(keywords, " ")
			}
			deep := json.RawMessage(`{}`)
			if jsonIsObjectRaw(seed["deep"]) {
				deep = cloneRaw(seed["deep"])
			}
			definition.Nodes[index].Type = "deep-discovery"
			definition.Nodes[index].Label = "Deep Discovery"
			definition.Nodes[index].Config = rawOf(map[string]any{
				"seedUrl":      sourceURL,
				"domain":       stringOrEmpty(seed["domain"]),
				"pattern":      stringOrEmpty(seed["pattern"]),
				"query":        query,
				"maxUrls":      seedNumberOr(seed["maxUrls"], 80),
				"deep":         deep,
				"crawlOptions": objectOrEmpty(crawlOptionsRaw),
			})
		default:
			mode := "sitemap"
			if modeRaw == "rss" {
				mode = "rss"
			}
			definition.Nodes[index].Type = "seed-discovery"
			definition.Nodes[index].Label = "Seed Discovery"
			definition.Nodes[index].Config = rawOf(map[string]any{
				"mode":    mode,
				"seedUrl": sourceURL,
				"domain":  stringOrEmpty(seed["domain"]),
				"pattern": stringOrEmpty(seed["pattern"]),
				"feedUrl": stringOrEmpty(seed["feedUrl"]),
				"maxUrls": seedNumberOr(seed["maxUrls"], 80),
			})
		}
	}

	for index := range definition.Nodes {
		switch definition.Nodes[index].Type {
		case "url-filter":
			definition.Nodes[index].Config = rawOf(map[string]any{
				"includePatterns": []string{},
				"excludePatterns": []string{},
				"blockedDomains":  []string{},
				"allowedHosts":    []string{},
				"denyKeywords":    []string{},
			})
		case "url-scorer":
			definition.Nodes[index].Config = rawOf(map[string]any{"keywordBoosts": keywords})
		case "budget-control":
			keepTopK := seedNumberOr(seed["maxNewUrlsPerRun"], 20)
			minScore := seedNumberOr(seed["scoreThreshold"], 0)
			maxPages := seedNumberOr(seed["maxUrls"], 60)
			maxDepth := float64(3)
			if deep, ok := decodeRawObject(seed["deep"]); ok {
				if value, ok := jsNumber(deep["maxDepth"]); ok {
					maxDepth = value
				}
			}
			definition.Nodes[index].Config = rawOf(map[string]any{
				"keepTopK": keepTopK,
				"minScore": minScore,
				"maxPages": maxPages,
				"maxDepth": maxDepth,
			})
		}
	}
	return definition
}

// ---- profile 配置的取值助手（逐条对齐 crawl-frontier.utils.ts） ----

func jsToStringList(raw json.RawMessage, max int) []string {
	if !jsonIsArrayRaw(raw) {
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
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
		return nil
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
	return deduped
}

// toPageTypeSignalConfig 对齐同名函数：数组 → {patterns}；对象 →
// {patterns, keywords}（各自可缺省）；都没有 → 不产出。
func toPageTypeSignalConfig(raw json.RawMessage) (pageTypeSignal, bool) {
	if jsonIsArrayRaw(raw) {
		patterns := jsToStringList(raw, 100)
		if patterns == nil {
			return pageTypeSignal{}, false
		}
		return pageTypeSignal{Patterns: patterns}, true
	}
	fields, ok := decodeRawObject(raw)
	if !ok {
		return pageTypeSignal{}, false
	}
	patterns := jsToStringList(fields["patterns"], 100)
	keywords := jsToStringList(fields["keywords"], 100)
	if patterns == nil && keywords == nil {
		return pageTypeSignal{}, false
	}
	return pageTypeSignal{Patterns: patterns, Keywords: keywords}, true
}

// jsNumberCoerce 近似 JavaScript 的 Number(value)：数字原样；字符串按
// 十进制解析（trim 后空串为 0）；true/false 为 1/0；null 为 0；其余 NaN。
// 十六进制/数组等罕见形态不逐位复刻（配置字段均为数值或数值字符串）。
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
	rounded := math.Round(parsed*1000) / 1000
	return math.Max(0, math.Min(1, rounded))
}

func jsSeedDiscoveryMode(raw json.RawMessage) (string, bool) {
	text, ok := jsString(raw)
	if !ok {
		return "", false
	}
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "robots":
		return "robots", true
	case "common_paths":
		return "common_paths", true
	case "sitemap_only":
		return "sitemap_only", true
	case "disabled":
		return "disabled", true
	}
	return "", false
}

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
			normalized := normalizeKey(key)
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

func normalizeKey(key string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(key) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func isDisallowedStrategyType(path, value string) bool {
	normalizedPath := normalizeKey(path)
	normalizedValue := normalizeKey(value)
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

// ---- 其余小工具 ----

func rawOf(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func listOrEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

func urlPatternList(config *profileBridgeConfig, key string) []string {
	if config.URLPatterns == nil {
		return []string{}
	}
	if list, ok := config.URLPatterns[key]; ok {
		return list
	}
	return []string{}
}

func rawOfCrawlOptionFalse(options json.RawMessage, key string) bool {
	fields, ok := decodeRawObject(options)
	if !ok {
		return false
	}
	raw, exists := fields[key]
	if !exists {
		return false
	}
	return strings.TrimSpace(string(raw)) == "false"
}

func stringOrEmpty(raw json.RawMessage) string {
	text, ok := jsString(raw)
	if !ok {
		return ""
	}
	return text
}

// seedNumberOr 镜像 `typeof seed.x === "number" && Number.isFinite(...)`。
func seedNumberOr(raw json.RawMessage, fallback float64) float64 {
	if value, ok := jsNumber(raw); ok {
		return value
	}
	return fallback
}

func isStrictFalse(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "false"
}

// isSeedEnabled 镜像 seed.enabled !== true。
func isSeedEnabled(seed map[string]json.RawMessage) bool {
	raw, ok := seed["enabled"]
	if !ok {
		return false
	}
	return strings.TrimSpace(string(raw)) == "true"
}

// newsSourceKeywords 镜像 Array.isArray(config.keywords) 的过滤：字符串
// trim 后非空（不去重）。
func newsSourceKeywords(raw json.RawMessage) []string {
	out := []string{}
	if !jsonIsArrayRaw(raw) {
		return out
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return out
	}
	for _, item := range items {
		text, ok := jsString(item)
		if !ok {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		out = append(out, text)
	}
	return out
}

// objectOrEmpty 返回对象原文，否则 {}。
func objectOrEmpty(raw json.RawMessage) json.RawMessage {
	if jsonIsObjectRaw(raw) {
		return raw
	}
	return json.RawMessage(`{}`)
}
