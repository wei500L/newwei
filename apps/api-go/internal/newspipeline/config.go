package newspipeline

// This file ports NewsPipelineConfigService: the LiteLLM / crawl4ai / pipeline
// defaults live in config/news-pipeline.config.yaml (same file shape as the
// NestJS service) and every member can be overridden by the LITELLM_*,
// NEWS_PIPELINE_* and CRAWL4AI_* environment variables exactly like
// ConfigService/LiteLlmEnvConfig. No process environment is read here: callers
// inject getenv and the working directory, which keeps the loader testable and
// side-effect free. A missing or malformed YAML file degrades to env defaults,
// matching the NestJS warn path.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"

	"go.yaml.in/yaml/v3"
)

const (
	// defaultNewsPipelineConfigPath is the NEWS_PIPELINE_CONFIG_PATH default.
	defaultNewsPipelineConfigPath = "config/news-pipeline.config.yaml"
	// defaultNewsPipelineUserAgent is the crawler user-agent fallback.
	defaultNewsPipelineUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
)

// LoadConfig is NewsPipelineConfigService.loadFromDisk + normalizeConfig. It
// resolves NEWS_PIPELINE_CONFIG_PATH against workingDir (cwd, .., ../..), parses
// the YAML file when present and merges the environment fallbacks. The returned
// config is immutable and safe to share.
func LoadConfig(getenv func(string) string, workingDir string) NewsPipelineConfig {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	configPath := resolvePipelineConfigPath(getenv("NEWS_PIPELINE_CONFIG_PATH"), workingDir)
	fileConfig := readPipelineConfigFile(configPath)
	return NewsPipelineConfig{
		LiteLLM:  normalizeLiteLLMConfig(configFileObject(fileConfig["litellm_config"]), getenv),
		Crawl4AI: normalizeCrawl4AIConfig(configFileObject(fileConfig["crawl4ai_config"]), getenv),
		Pipeline: normalizePipelineRuntimeConfig(configFileObject(fileConfig["pipeline"]), getenv),
	}
}

// resolvePipelineConfigPath is resolveConfigPath: absolute paths win, otherwise
// the first existing candidate from workingDir, workingDir/.. and workingDir/../..
// is used and the first candidate is the default when none exists.
func resolvePipelineConfigPath(rawValue, workingDir string) string {
	raw := rawValue
	if raw == "" {
		raw = defaultNewsPipelineConfigPath
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	if workingDir == "" {
		workingDir = "."
	}
	candidates := []string{
		filepath.Join(workingDir, raw),
		filepath.Join(workingDir, "..", raw),
		filepath.Join(workingDir, "..", "..", raw),
	}
	for _, candidate := range candidates {
		if pathExists(candidate) {
			return candidate
		}
	}
	return candidates[0]
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// readPipelineConfigFile parses the YAML document into plain maps/slices. A read
// or parse failure returns an empty document so the env defaults apply.
func readPipelineConfigFile(path string) map[string]any {
	content, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	var document any
	if err := yaml.Unmarshal(content, &document); err != nil {
		return map[string]any{}
	}
	object := configFileObject(document)
	if object == nil {
		return map[string]any{}
	}
	return object
}

// --- YAML value helpers ----------------------------------------------------

func configFileObject(value any) map[string]any {
	if value == nil {
		return nil
	}
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return nil
}

// configFileLookup is JavaScript nullish member access: the first key whose value is
// present and not null wins.
func configFileLookup(object map[string]any, keys ...string) (any, bool) {
	if object == nil {
		return nil, false
	}
	for _, key := range keys {
		value, present := object[key]
		if present && value != nil {
			return value, true
		}
	}
	return nil, false
}

// configFileOr applies JS `raw?.member ?? fallback`.
func configFileOr(object map[string]any, key string, fallback any) any {
	if value, present := object[key]; present && value != nil {
		return value
	}
	return fallback
}

func configFileString(value any) (string, bool) {
	if text, ok := value.(string); ok {
		return text, true
	}
	return "", false
}

func configFileNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case int:
		return float64(typed), true
	case int8:
		return float64(typed), true
	case int16:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint8:
		return float64(typed), true
	case uint16:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case float32:
		return float64(typed), true
	case float64:
		return typed, true
	default:
		return 0, false
	}
}

func configFileBool(value any) (bool, bool) {
	if flag, ok := value.(bool); ok {
		return flag, true
	}
	return false, false
}

// configFileBoolOr is `raw.member ?? fallback` for a boolean member: a non-boolean
// YAML value falls back instead of poisoning the config document.
func configFileBoolOr(object map[string]any, key string, fallback bool) bool {
	if value, present := object[key]; present && value != nil {
		if flag, ok := configFileBool(value); ok {
			return flag
		}
	}
	return fallback
}

// ensurePositiveConfig is ensurePositive: only a finite number greater than zero
// replaces the fallback.
func ensurePositiveConfig(value any, fallback float64) float64 {
	numeric, ok := configFileNumber(value)
	if !ok || math.IsNaN(numeric) || numeric <= 0 {
		return fallback
	}
	return numeric
}

// ensurePositiveIntConfig is ensurePositiveInt: round(ensurePositive(...)).
func ensurePositiveIntConfig(value any, fallback int) int {
	return int(math.Round(ensurePositiveConfig(value, float64(fallback))))
}

// clampConfigNumber is clamp: an invalid/missing value yields the minimum, not
// the fallback, exactly like the TypeScript helper.
func clampConfigNumber(value any, minimum, maximum float64) float64 {
	numeric, ok := configFileNumber(value)
	if !ok || math.IsNaN(numeric) {
		return minimum
	}
	if numeric < minimum {
		return minimum
	}
	if numeric > maximum {
		return maximum
	}
	return numeric
}

// --- environment fallbacks -------------------------------------------------

func envString(getenv func(string) string, key, fallback string) string {
	if value := jsTrimString(getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envPositiveInt(getenv func(string) string, key string, fallback int) int {
	raw := jsTrimString(getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envFiniteFloat(getenv func(string) string, key string, fallback float64) float64 {
	raw := jsTrimString(getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return parsed
}

// envFirstValue returns the first non-blank environment value, mirroring
// `env.A ?? env.B` for the trimmed values ConfigService reads.
func envFirstValue(getenv func(string) string, keys ...string) string {
	for _, key := range keys {
		if value := jsTrimString(getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func envFallbackModels(getenv func(string) string) []string {
	raw := getenv("LITELLM_FALLBACK_MODELS")
	if raw == "" {
		return nil
	}
	out := make([]string, 0, 4)
	for _, entry := range splitCommaList(raw) {
		out = append(out, entry)
	}
	return out
}

func splitCommaList(value string) []string {
	out := make([]string, 0, 4)
	start := 0
	for index := 0; index <= len(value); index++ {
		if index != len(value) && value[index] != ',' {
			continue
		}
		entry := jsTrimString(value[start:index])
		if entry != "" {
			out = append(out, entry)
		}
		start = index + 1
	}
	return out
}

// --- LiteLLM ---------------------------------------------------------------

// normalizeLiteLlmConfig is normalizeLiteLlmConfig.
func normalizeLiteLLMConfig(raw map[string]any, getenv func(string) string) LiteLLMConfig {
	envModel := envString(getenv, "LITELLM_MODEL", "openai/gpt-4o-mini")
	envEmbeddingModel := jsTrimString(getenv("LITELLM_EMBEDDING_MODEL"))
	envTimeoutMS := envPositiveInt(getenv, "LITELLM_TIMEOUT_MS", 60_000)
	envTemperature := envFiniteFloat(getenv, "LITELLM_TEMPERATURE", 0.2)
	envTopP := envFiniteFloat(getenv, "LITELLM_TOP_P", 0.9)
	envMaxTokens := envPositiveInt(getenv, "LITELLM_MAX_TOKENS", 0)
	if envMaxTokens == 0 {
		envMaxTokens = envPositiveInt(getenv, "LITELLM_MAX_OUTPUT_TOKENS", 1_200)
	}
	envRetryAttempts := envPositiveInt(getenv, "LITELLM_RETRY_ATTEMPTS", 0)
	if envRetryAttempts == 0 {
		envRetryAttempts = envPositiveInt(getenv, "LITELLM_MAX_RETRIES", 3)
	}

	envAPIBase := envFirstValue(getenv, "LITELLM_API_URL", "LITELLM_API_BASE")
	fileAPIBase := ""
	if value, present := configFileLookup(raw, "api_url", "api_base"); present {
		if text, ok := configFileString(value); ok {
			fileAPIBase = jsTrimString(text)
		}
	}
	apiBase := envAPIBase
	if apiBase == "" {
		apiBase = fileAPIBase
	}
	if apiBase == "" {
		apiBase = "http://localhost:4001"
	}

	fallbackModels := envFallbackModels(getenv)
	if len(fallbackModels) == 0 {
		fallbackModels = configFileFallbackModels(raw)
	}

	model := envModel
	if value, present := configFileLookup(raw, "model"); present {
		if text, ok := configFileString(value); ok {
			model = text
		}
	}
	embeddingModel := envEmbeddingModel
	if value, present := configFileLookup(raw, "embedding_model"); present {
		if text, ok := configFileString(value); ok {
			embeddingModel = text
		}
	}
	apiKey := jsTrimString(getenv("LITELLM_API_KEY"))
	if apiKey == "" {
		if value, present := configFileLookup(raw, "api_key"); present {
			if text, ok := configFileString(value); ok {
				apiKey = text
			}
		}
	}

	timeoutMS := ensurePositiveConfig(configFileOr(raw, "timeout_ms", nil), float64(envTimeoutMS))
	temperature := clampConfigNumber(configFileOr(raw, "temperature", envTemperature), 0, 2)
	topP := clampConfigNumber(configFileOr(raw, "top_p", envTopP), 0, 1)
	maxTokens := ensurePositiveIntConfig(
		configFileOr(raw, "max_tokens", configFileOr(raw, "max_output_tokens", nil)),
		envMaxTokens,
	)
	retryAttempts := ensurePositiveIntConfig(
		configFileOr(raw, "retry_attempts", configFileOr(raw, "max_retries", nil)),
		envRetryAttempts,
	)
	stream := configFileBoolOr(raw, "stream", false)
	responseFormat := "json_schema"
	if value, present := configFileLookup(raw, "response_format"); present {
		if text, ok := configFileString(value); ok {
			responseFormat = text
		}
	}
	return LiteLLMConfig{
		Model:          model,
		EmbeddingModel: embeddingModel,
		// Rerank routing comes from MySQL gateway profiles, not env/file defaults.
		RerankModel:    "",
		APIURL:         apiBase,
		APIKey:         apiKey,
		TimeoutMS:      int(timeoutMS),
		Temperature:    temperature,
		TopP:           topP,
		MaxTokens:      maxTokens,
		RetryAttempts:  retryAttempts,
		FallbackModels: fallbackModels,
		Stream:         stream,
		ResponseFormat: responseFormat,
	}
}

func configFileFallbackModels(raw map[string]any) []string {
	value, present := configFileLookup(raw, "fallback_models")
	if !present {
		return []string{}
	}
	entries, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		text, ok := configFileString(entry)
		if ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}

// --- crawl4ai --------------------------------------------------------------

// normalizeCrawl4AIConfig is normalizeCrawlConfig.
func normalizeCrawl4AIConfig(raw map[string]any, getenv func(string) string) Crawl4AIConfig {
	envTimeoutMS := envPositiveInt(getenv, "CRAWL4AI_TIMEOUT_MS", 120_000)
	envMaxConcurrency := envPositiveInt(getenv, "CRAWL4AI_MAX_CONCURRENCY", 3)

	markdown := normalizeMarkdownOptions(configFileObject(configFileOr(raw, "markdown", nil)))
	cleanMarkdown := normalizeCleanMarkdownOptions(configFileObject(configFileOr(raw, "clean_markdown", nil)))
	crawlerDefaults := normalizeCrawlerDefaults(raw, markdown, cleanMarkdown)

	userAgent := defaultNewsPipelineUserAgent
	if value, present := configFileLookup(raw, "user_agent"); present {
		if text, ok := configFileString(value); ok && len(text) > 5 {
			userAgent = text
		}
	}
	return Crawl4AIConfig{
		UserAgent:             userAgent,
		MaxConcurrent:         ensurePositiveIntConfig(configFileOr(raw, "max_concurrent", nil), envMaxConcurrency),
		TimeoutMS:             int(ensurePositiveConfig(configFileOr(raw, "timeout_ms", nil), float64(envTimeoutMS))),
		KeywordMatchThreshold: clampConfigNumber(configFileOr(raw, "keyword_match_threshold", 0.55), 0, 1),
		Markdown:              configFileOptionalDocumentJSON(markdown),
		CleanMarkdown:         configFileOptionalDocumentJSON(cleanMarkdown),
		CrawlerDefaults:       configFileDocumentJSON(crawlerDefaults),
		VirtualScroll:         configFileOptionalDocumentJSON(crawlerDefaults.VirtualScroll),
	}
}

// crawlMarkdownOptions is CrawlMarkdownOptions in the NestJS spread order.
type crawlMarkdownOptions struct {
	ContentSource *string `json:"contentSource,omitempty"`
	IgnoreLinks   *bool   `json:"ignoreLinks,omitempty"`
	EscapeHTML    *bool   `json:"escapeHtml,omitempty"`
	Citations     *bool   `json:"citations,omitempty"`
	BodyWidth     *int    `json:"bodyWidth,omitempty"`
}

// normalizeMarkdownOptions is normalizeMarkdownOptions: camelCase members win
// over their snake_case aliases and only recognized enum values survive.
func normalizeMarkdownOptions(raw map[string]any) *crawlMarkdownOptions {
	if raw == nil {
		return nil
	}
	normalized := &crawlMarkdownOptions{}
	if value, present := configFileLookup(raw, "contentSource", "content_source"); present {
		if text, ok := configFileString(value); ok {
			switch text {
			case "raw_html", "cleaned_html", "fit_html":
				normalized.ContentSource = stringPointer(text)
			}
		}
	}
	if value, present := configFileLookup(raw, "ignoreLinks", "ignore_links"); present {
		if flag, ok := configFileBool(value); ok {
			normalized.IgnoreLinks = configFileBoolPointer(flag)
		}
	}
	if value, present := configFileLookup(raw, "escapeHtml", "escape_html"); present {
		if flag, ok := configFileBool(value); ok {
			normalized.EscapeHTML = configFileBoolPointer(flag)
		}
	}
	if value, present := configFileLookup(raw, "citations"); present {
		if flag, ok := configFileBool(value); ok {
			normalized.Citations = configFileBoolPointer(flag)
		}
	}
	if value, present := configFileLookup(raw, "bodyWidth", "body_width"); present {
		if numeric, ok := configFileNumber(value); ok && !math.IsNaN(numeric) {
			rounded := int(math.Round(numeric))
			if rounded < 40 {
				rounded = 40
			}
			if rounded > 200 {
				rounded = 200
			}
			normalized.BodyWidth = intPointer(rounded)
		}
	}
	if normalized.ContentSource == nil && normalized.IgnoreLinks == nil &&
		normalized.EscapeHTML == nil && normalized.Citations == nil && normalized.BodyWidth == nil {
		return nil
	}
	return normalized
}

// crawlCleanMarkdownOptions is CrawlCleanMarkdownOptions in the NestJS spread
// order.
type crawlCleanMarkdownOptions struct {
	CSSSelector           *string  `json:"cssSelector,omitempty"`
	TargetElements        []string `json:"targetElements,omitempty"`
	ExcludedTags          []string `json:"excludedTags,omitempty"`
	RemoveOverlayElements *bool    `json:"removeOverlayElements,omitempty"`
	WordCountThreshold    *int     `json:"wordCountThreshold,omitempty"`
}

// normalizeCleanMarkdownOptions is normalizeCleanMarkdownOptions.
func normalizeCleanMarkdownOptions(raw map[string]any) *crawlCleanMarkdownOptions {
	if raw == nil {
		return nil
	}
	normalized := &crawlCleanMarkdownOptions{}
	if value, present := configFileLookup(raw, "cssSelector", "css_selector"); present {
		if text, ok := configFileString(value); ok {
			trimmed := jsTrimString(text)
			if trimmed != "" {
				normalized.CSSSelector = stringPointer(trimmed)
			}
		}
	}
	if entries := coerceCleanStringArray(configFileOr(raw, "targetElements", configFileOr(raw, "target_elements", nil))); len(entries) > 0 {
		normalized.TargetElements = entries
	}
	if entries := coerceCleanStringArray(configFileOr(raw, "excludedTags", configFileOr(raw, "excluded_tags", nil))); len(entries) > 0 {
		normalized.ExcludedTags = entries
	}
	if value, present := configFileLookup(raw, "removeOverlayElements", "remove_overlay_elements"); present {
		if flag, ok := configFileBool(value); ok {
			normalized.RemoveOverlayElements = configFileBoolPointer(flag)
		}
	}
	if value, present := configFileLookup(raw, "wordCountThreshold", "word_count_threshold"); present {
		if numeric, ok := configFileNumber(value); ok && !math.IsNaN(numeric) {
			rounded := int(math.Round(numeric))
			if rounded < 0 {
				rounded = 0
			}
			if rounded > 2000 {
				rounded = 2000
			}
			normalized.WordCountThreshold = intPointer(rounded)
		}
	}
	if normalized.CSSSelector == nil && normalized.TargetElements == nil &&
		normalized.ExcludedTags == nil && normalized.RemoveOverlayElements == nil &&
		normalized.WordCountThreshold == nil {
		return nil
	}
	return normalized
}

// coerceCleanStringArray is coerceStringArray: trim, drop blanks, cap at 10 and
// dedupe in first-seen order; an empty result is undefined.
func coerceCleanStringArray(value any) []string {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	filtered := make([]string, 0, len(entries))
	for _, entry := range entries {
		text, ok := entry.(string)
		if !ok {
			text = ""
		}
		trimmed := jsTrimString(text)
		if trimmed != "" {
			filtered = append(filtered, trimmed)
		}
	}
	// TypeScript slices to the first ten entries before deduping with a Set.
	if len(filtered) > 10 {
		filtered = filtered[:10]
	}
	out := make([]string, 0, len(filtered))
	seen := make(map[string]struct{}, len(filtered))
	for _, entry := range filtered {
		if _, exists := seen[entry]; exists {
			continue
		}
		seen[entry] = struct{}{}
		out = append(out, entry)
	}
	return out
}

// configFileNumberOr applies `raw?.member ?? fallback` for a numeric member.
func configFileNumberOr(object map[string]any, key string, fallback float64) float64 {
	if value, present := object[key]; present && value != nil {
		if numeric, ok := configFileNumber(value); ok && !math.IsNaN(numeric) {
			return numeric
		}
	}
	return fallback
}

// crawlVirtualScrollOptions is CrawlVirtualScrollConfig in the NestJS object
// order.
type crawlVirtualScrollOptions struct {
	ContainerSelector string  `json:"containerSelector"`
	ScrollCount       int     `json:"scrollCount"`
	ScrollBy          any     `json:"scrollBy"`
	WaitAfterScrollMs float64 `json:"waitAfterScrollMs"`
}

// normalizeVirtualScroll is normalizeVirtualScroll: only scroll_by has a
// snake_case alias, the other members are camelCase (same quirk as the
// TypeScript service).
func normalizeVirtualScroll(raw map[string]any) *crawlVirtualScrollOptions {
	containerSelector := "body"
	if value, present := configFileLookup(raw, "containerSelector"); present {
		if text, ok := configFileString(value); ok {
			containerSelector = text
		}
	}
	var scrollBy any = "page_height"
	if value, present := configFileLookup(raw, "scroll_by", "scrollBy"); present {
		if text, ok := configFileString(value); ok {
			switch text {
			case "container_height":
				scrollBy = "container_height"
			case "page_height":
				scrollBy = "page_height"
			case "viewport":
				scrollBy = "page_height"
			default:
				scrollBy = "page_height"
			}
		} else if numeric, ok := configFileNumber(value); ok && !math.IsNaN(numeric) {
			rounded := int(math.Round(numeric))
			if rounded < 1 {
				rounded = 1
			}
			if rounded > 20000 {
				rounded = 20000
			}
			scrollBy = rounded
		}
	}
	return &crawlVirtualScrollOptions{
		ContainerSelector: containerSelector,
		ScrollCount:       ensurePositiveIntConfig(configFileOr(raw, "scrollCount", nil), 3),
		ScrollBy:          scrollBy,
		WaitAfterScrollMs: ensurePositiveConfig(configFileOr(raw, "waitAfterScrollMs", nil), 600),
	}
}

// crawlTaskOptionsDocument is the crawlerDefaults object in the NestJS insertion
// order.
type crawlTaskOptionsDocument struct {
	ScanFullPage            bool                       `json:"scanFullPage"`
	AdjustViewportToContent bool                       `json:"adjustViewportToContent"`
	WaitForImages           bool                       `json:"waitForImages"`
	ExcludeExternalLinks    bool                       `json:"excludeExternalLinks"`
	ProcessIframes          bool                       `json:"processIframes"`
	CSSSelector             *string                    `json:"cssSelector,omitempty"`
	ExcludedTags            *[]string                  `json:"excludedTags,omitempty"`
	ScoreLinks              bool                       `json:"scoreLinks"`
	WordCountThreshold      float64                    `json:"wordCountThreshold"`
	CleanMarkdown           *crawlCleanMarkdownOptions `json:"cleanMarkdown,omitempty"`
	MarkdownOptions         *crawlMarkdownOptions      `json:"markdownOptions,omitempty"`
	VirtualScroll           *crawlVirtualScrollOptions `json:"virtualScroll,omitempty"`
	CaptureScreenshot       bool                       `json:"captureScreenshot"`
	SimulateUser            bool                       `json:"simulateUser"`
	OverrideNavigator       bool                       `json:"overrideNavigator"`
}

// normalizeCrawlerDefaults is the crawlerDefaults literal of
// normalizeCrawlConfig. Note the TypeScript service reads camelCase members of
// crawler_defaults, so the snake_case YAML aliases are deliberately ignored
// (same documented quirk as the source).
func normalizeCrawlerDefaults(raw map[string]any, markdown *crawlMarkdownOptions, cleanMarkdown *crawlCleanMarkdownOptions) *crawlTaskOptionsDocument {
	defaults := configFileObject(configFileOr(raw, "crawler_defaults", nil))
	var cssSelector *string
	if value, present := configFileLookup(defaults, "cssSelector"); present {
		if text, ok := configFileString(value); ok {
			cssSelector = stringPointer(text)
		}
	}
	var excludedTags *[]string
	if value, present := configFileLookup(defaults, "excludedTags"); present {
		if entries, ok := value.([]any); ok {
			filtered := make([]string, 0, len(entries))
			for _, entry := range entries {
				if text, ok := entry.(string); ok {
					filtered = append(filtered, text)
				}
			}
			excludedTags = &filtered
		}
	}
	document := &crawlTaskOptionsDocument{
		ScanFullPage:            configFileBoolOr(defaults, "scanFullPage", true),
		AdjustViewportToContent: configFileBoolOr(defaults, "adjustViewportToContent", true),
		WaitForImages:           configFileBoolOr(defaults, "waitForImages", true),
		ExcludeExternalLinks:    configFileBoolOr(defaults, "excludeExternalLinks", true),
		ProcessIframes:          configFileBoolOr(defaults, "processIframes", true),
		CSSSelector:             cssSelector,
		ExcludedTags:            excludedTags,
		ScoreLinks:              configFileBoolOr(defaults, "scoreLinks", false),
		WordCountThreshold:      configFileNumberOr(defaults, "wordCountThreshold", 120),
		CleanMarkdown:           cleanMarkdown,
		MarkdownOptions:         markdown,
		CaptureScreenshot:       configFileBoolOr(defaults, "captureScreenshot", false),
		SimulateUser:            configFileBoolOr(defaults, "simulateUser", true),
		OverrideNavigator:       configFileBoolOr(defaults, "overrideNavigator", true),
	}
	if virtualScrollRaw := configFileObject(configFileOr(raw, "virtual_scroll", nil)); virtualScrollRaw != nil {
		if enabled, ok := configFileBool(configFileOr(virtualScrollRaw, "enabled", false)); ok && enabled {
			document.VirtualScroll = normalizeVirtualScroll(virtualScrollRaw)
		}
	}
	return document
}

// --- pipeline runtime ------------------------------------------------------

// normalizePipelineRuntimeConfig is normalizePipelineConfig.
func normalizePipelineRuntimeConfig(raw map[string]any, getenv func(string) string) RuntimeConfig {
	envCacheTTL := envPositiveInt(getenv, "NEWS_PIPELINE_CACHE_TTL_SECONDS", 3_600)
	envMaxInputChars := envPositiveInt(getenv, "NEWS_PIPELINE_MAX_INPUT_CHARS", 48_000)
	configPath := jsTrimString(getenv("NEWS_PIPELINE_CONFIG_PATH"))
	if configPath == "" {
		configPath = defaultNewsPipelineConfigPath
	}
	return RuntimeConfig{
		ConfigPath:                configPath,
		CacheTTLSeconds:           ensurePositiveIntConfig(configFileOr(raw, "cache_ttl_seconds", nil), envCacheTTL),
		MaxInputChars:             ensurePositiveIntConfig(configFileOr(raw, "max_input_characters", nil), envMaxInputChars),
		SummaryMaxTokens:          ensurePositiveIntConfig(configFileOr(raw, "summary_max_tokens", nil), 256),
		RateLimitWindowSeconds:    ensurePositiveIntConfig(configFileOr(raw, "rate_limit_window_seconds", nil), 60),
		AllowMediaEmbedding:       configFileBoolOr(raw, "allow_media_embedding", true),
		DetectLanguage:            configFileBoolOr(raw, "detect_language", true),
		SummaryDedupEnabled:       configFileBoolOr(raw, "summary_dedup_enabled", true),
		SummaryDedupThreshold:     clampConfigNumber(configFileOr(raw, "summary_dedup_threshold", 0.9), 0, 1),
		SummaryDedupLookbackHours: ensurePositiveIntConfig(configFileOr(raw, "summary_dedup_lookback_hours", nil), 48),
		SummaryDedupMaxCandidates: ensurePositiveIntConfig(configFileOr(raw, "summary_dedup_max_candidates", nil), 100),
		SummaryDedupMinChars:      ensurePositiveIntConfig(configFileOr(raw, "summary_dedup_min_chars", nil), 40),
		OutboxDeliveryConcurrency: ensurePositiveIntConfig(configFileOr(raw, "outbox_delivery_concurrency", nil), 10),
	}
}

// --- JSON document helpers -------------------------------------------------

func configFileBoolPointer(value bool) *bool {
	copy := value
	return &copy
}

func configFileDocumentJSON(value any) json.RawMessage {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return json.RawMessage(encoded)
}

func configFileOptionalDocumentJSON[T any](value *T) json.RawMessage {
	if value == nil {
		return nil
	}
	return configFileDocumentJSON(*value)
}
