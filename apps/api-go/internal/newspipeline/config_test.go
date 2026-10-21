package newspipeline

// Tests for LoadConfig: the NestJS defaults, environment fallbacks, the YAML
// file merge (same file shape as config/news-pipeline.config.yaml) and the
// config path resolution relative to the working directory.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func writeConfigFile(t *testing.T, workingDir, content string) {
	t.Helper()
	configDir := filepath.Join(workingDir, "config")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "news-pipeline.config.yaml"), []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
}

const defaultCrawlerDefaultsJSON = `{"scanFullPage":true,"adjustViewportToContent":true,"waitForImages":true,"excludeExternalLinks":true,"processIframes":true,"scoreLinks":false,"wordCountThreshold":120,"captureScreenshot":false,"simulateUser":true,"overrideNavigator":true}`

func TestLoadConfigDefaultsWithoutFile(t *testing.T) {
	config := LoadConfig(envFrom(nil), t.TempDir())

	if config.LiteLLM.Model != "openai/gpt-4o-mini" {
		t.Fatalf("model = %q", config.LiteLLM.Model)
	}
	if config.LiteLLM.EmbeddingModel != "" || config.LiteLLM.RerankModel != "" {
		t.Fatalf("embedding/rerank model = %q/%q", config.LiteLLM.EmbeddingModel, config.LiteLLM.RerankModel)
	}
	if config.LiteLLM.APIURL != "http://localhost:4001" {
		t.Fatalf("api url = %q", config.LiteLLM.APIURL)
	}
	if config.LiteLLM.APIKey != "" || config.LiteLLM.Stream || config.LiteLLM.ResponseFormat != "json_schema" {
		t.Fatalf("api key/stream/response format = %#v", config.LiteLLM)
	}
	if config.LiteLLM.TimeoutMS != 60_000 || config.LiteLLM.Temperature != 0.2 || config.LiteLLM.TopP != 0.9 {
		t.Fatalf("litellm defaults = %#v", config.LiteLLM)
	}
	if config.LiteLLM.MaxTokens != 1_200 || config.LiteLLM.RetryAttempts != 3 {
		t.Fatalf("max tokens/retries = %d/%d", config.LiteLLM.MaxTokens, config.LiteLLM.RetryAttempts)
	}
	if config.LiteLLM.FallbackModels == nil || len(config.LiteLLM.FallbackModels) != 0 {
		t.Fatalf("fallback models = %v", config.LiteLLM.FallbackModels)
	}

	if config.Crawl4AI.UserAgent != defaultNewsPipelineUserAgent {
		t.Fatalf("user agent = %q", config.Crawl4AI.UserAgent)
	}
	if config.Crawl4AI.MaxConcurrent != 3 || config.Crawl4AI.TimeoutMS != 120_000 || config.Crawl4AI.KeywordMatchThreshold != 0.55 {
		t.Fatalf("crawl defaults = %#v", config.Crawl4AI)
	}
	if config.Crawl4AI.Markdown != nil || config.Crawl4AI.CleanMarkdown != nil || config.Crawl4AI.VirtualScroll != nil {
		t.Fatalf("optional crawl documents must be nil")
	}
	if got := string(config.Crawl4AI.CrawlerDefaults); got != defaultCrawlerDefaultsJSON {
		t.Fatalf("crawler defaults = %s", got)
	}

	if config.Pipeline.ConfigPath != defaultNewsPipelineConfigPath {
		t.Fatalf("config path = %q", config.Pipeline.ConfigPath)
	}
	if config.Pipeline.CacheTTLSeconds != 3_600 || config.Pipeline.MaxInputChars != 48_000 {
		t.Fatalf("pipeline env defaults = %#v", config.Pipeline)
	}
	if config.Pipeline.SummaryMaxTokens != 256 || config.Pipeline.RateLimitWindowSeconds != 60 {
		t.Fatalf("pipeline token/window defaults = %#v", config.Pipeline)
	}
	if !config.Pipeline.AllowMediaEmbedding || !config.Pipeline.DetectLanguage || !config.Pipeline.SummaryDedupEnabled {
		t.Fatalf("pipeline booleans = %#v", config.Pipeline)
	}
	if config.Pipeline.SummaryDedupThreshold != 0.9 || config.Pipeline.SummaryDedupLookbackHours != 48 ||
		config.Pipeline.SummaryDedupMaxCandidates != 100 || config.Pipeline.SummaryDedupMinChars != 40 {
		t.Fatalf("summary dedupe defaults = %#v", config.Pipeline)
	}
	if config.Pipeline.OutboxDeliveryConcurrency != 10 {
		t.Fatalf("outbox concurrency = %d", config.Pipeline.OutboxDeliveryConcurrency)
	}
}

func TestLoadConfigMergesYAML(t *testing.T) {
	workingDir := t.TempDir()
	writeConfigFile(t, workingDir, `
litellm_config:
  model: file-model
  api_url: http://file:4001
  api_key: file-key
  timeout_ms: 1111
  temperature: 1.0
  top_p: 0.7
  max_tokens: 500
  retry_attempts: 2
  fallback_models:
    - f1
    - ""
  stream: true
  response_format: text
crawl4ai_config:
  user_agent: "Mozilla/5.0 Test Agent"
  max_concurrent: 4
  timeout_ms: 9000
  keyword_match_threshold: 1.5
  markdown:
    content_source: raw_html
    body_width: 10
    escape_html: false
  clean_markdown:
    css_selector: " article,main "
    excluded_tags: [nav, footer, nav, ""]
    remove_overlay_elements: true
    word_count_threshold: 5000
  crawler_defaults:
    scanFullPage: false
    cssSelector: ".x"
    excludedTags: [nav]
    wordCountThreshold: 0
  virtual_scroll:
    enabled: true
    containerSelector: "#main"
    scroll_count: 4
    scrollCount: 9
    scroll_by: viewport
    waitAfterScrollMs: 300
pipeline:
  cache_ttl_seconds: 7200
  max_input_characters: 1000
  summary_max_tokens: 128
  rate_limit_window_seconds: 30
  allow_media_embedding: false
  detect_language: false
  summary_dedup_enabled: false
  summary_dedup_threshold: 2
  summary_dedup_lookback_hours: 12
  summary_dedup_max_candidates: 50
  summary_dedup_min_chars: 20
  outbox_delivery_concurrency: 5
`)
	config := LoadConfig(envFrom(nil), workingDir)

	if config.LiteLLM.Model != "file-model" || config.LiteLLM.APIURL != "http://file:4001" ||
		config.LiteLLM.APIKey != "file-key" {
		t.Fatalf("file litellm connection = %#v", config.LiteLLM)
	}
	if config.LiteLLM.TimeoutMS != 1111 || config.LiteLLM.Temperature != 1 ||
		config.LiteLLM.TopP != 0.7 || config.LiteLLM.MaxTokens != 500 || config.LiteLLM.RetryAttempts != 2 {
		t.Fatalf("file litellm numbers = %#v", config.LiteLLM)
	}
	if !config.LiteLLM.Stream || config.LiteLLM.ResponseFormat != "text" {
		t.Fatalf("file litellm stream/format = %#v", config.LiteLLM)
	}
	if strings.Join(config.LiteLLM.FallbackModels, ",") != "f1" {
		t.Fatalf("file fallback models = %v", config.LiteLLM.FallbackModels)
	}

	if config.Crawl4AI.UserAgent != "Mozilla/5.0 Test Agent" {
		t.Fatalf("user agent = %q", config.Crawl4AI.UserAgent)
	}
	if config.Crawl4AI.MaxConcurrent != 4 || config.Crawl4AI.TimeoutMS != 9000 || config.Crawl4AI.KeywordMatchThreshold != 1 {
		t.Fatalf("file crawl numbers = %#v", config.Crawl4AI)
	}
	if got := string(config.Crawl4AI.Markdown); got != `{"contentSource":"raw_html","escapeHtml":false,"bodyWidth":40}` {
		t.Fatalf("markdown options = %s", got)
	}
	if got := string(config.Crawl4AI.CleanMarkdown); got != `{"cssSelector":"article,main","excludedTags":["nav","footer"],"removeOverlayElements":true,"wordCountThreshold":2000}` {
		t.Fatalf("clean markdown options = %s", got)
	}
	wantCrawlerDefaults := `{"scanFullPage":false,"adjustViewportToContent":true,"waitForImages":true,"excludeExternalLinks":true,"processIframes":true,"cssSelector":".x","excludedTags":["nav"],"scoreLinks":false,"wordCountThreshold":0,"cleanMarkdown":{"cssSelector":"article,main","excludedTags":["nav","footer"],"removeOverlayElements":true,"wordCountThreshold":2000},"markdownOptions":{"contentSource":"raw_html","escapeHtml":false,"bodyWidth":40},"virtualScroll":{"containerSelector":"#main","scrollCount":9,"scrollBy":"page_height","waitAfterScrollMs":300},"captureScreenshot":false,"simulateUser":true,"overrideNavigator":true}`
	if got := string(config.Crawl4AI.CrawlerDefaults); got != wantCrawlerDefaults {
		t.Fatalf("crawler defaults = %s", got)
	}
	if got := string(config.Crawl4AI.VirtualScroll); got != `{"containerSelector":"#main","scrollCount":9,"scrollBy":"page_height","waitAfterScrollMs":300}` {
		t.Fatalf("virtual scroll = %s", got)
	}

	if config.Pipeline.CacheTTLSeconds != 7200 || config.Pipeline.MaxInputChars != 1000 ||
		config.Pipeline.SummaryMaxTokens != 128 || config.Pipeline.RateLimitWindowSeconds != 30 {
		t.Fatalf("file pipeline numbers = %#v", config.Pipeline)
	}
	if config.Pipeline.AllowMediaEmbedding || config.Pipeline.DetectLanguage || config.Pipeline.SummaryDedupEnabled {
		t.Fatalf("file pipeline booleans = %#v", config.Pipeline)
	}
	if config.Pipeline.SummaryDedupThreshold != 1 || config.Pipeline.SummaryDedupLookbackHours != 12 ||
		config.Pipeline.SummaryDedupMaxCandidates != 50 || config.Pipeline.SummaryDedupMinChars != 20 ||
		config.Pipeline.OutboxDeliveryConcurrency != 5 {
		t.Fatalf("file summary dedupe = %#v", config.Pipeline)
	}
}

func TestLoadConfigEnvFallbacks(t *testing.T) {
	config := LoadConfig(envFrom(map[string]string{
		"LITELLM_MODEL":                   "env-model",
		"LITELLM_EMBEDDING_MODEL":         "env-embedding",
		"LITELLM_API_URL":                 "http://env:4000",
		"LITELLM_API_KEY":                 "env-key",
		"LITELLM_TIMEOUT_MS":              "1234",
		"LITELLM_TEMPERATURE":             "1.5",
		"LITELLM_TOP_P":                   "0.5",
		"LITELLM_MAX_TOKENS":              "999",
		"LITELLM_RETRY_ATTEMPTS":          "5",
		"LITELLM_FALLBACK_MODELS":         "a, b ,,c",
		"CRAWL4AI_TIMEOUT_MS":             "5000",
		"CRAWL4AI_MAX_CONCURRENCY":        "7",
		"NEWS_PIPELINE_CACHE_TTL_SECONDS": "99",
		"NEWS_PIPELINE_MAX_INPUT_CHARS":   "123",
	}), t.TempDir())

	if config.LiteLLM.Model != "env-model" || config.LiteLLM.EmbeddingModel != "env-embedding" ||
		config.LiteLLM.APIURL != "http://env:4000" || config.LiteLLM.APIKey != "env-key" {
		t.Fatalf("env litellm = %#v", config.LiteLLM)
	}
	if config.LiteLLM.TimeoutMS != 1234 || config.LiteLLM.Temperature != 1.5 || config.LiteLLM.TopP != 0.5 {
		t.Fatalf("env litellm numbers = %#v", config.LiteLLM)
	}
	if config.LiteLLM.MaxTokens != 999 || config.LiteLLM.RetryAttempts != 5 {
		t.Fatalf("env tokens/retries = %d/%d", config.LiteLLM.MaxTokens, config.LiteLLM.RetryAttempts)
	}
	if strings.Join(config.LiteLLM.FallbackModels, ",") != "a,b,c" {
		t.Fatalf("env fallback models = %v", config.LiteLLM.FallbackModels)
	}
	if config.Crawl4AI.TimeoutMS != 5000 || config.Crawl4AI.MaxConcurrent != 7 {
		t.Fatalf("env crawl = %#v", config.Crawl4AI)
	}
	if config.Pipeline.CacheTTLSeconds != 99 || config.Pipeline.MaxInputChars != 123 {
		t.Fatalf("env pipeline = %#v", config.Pipeline)
	}
}

func TestLoadConfigEnvWinsWhereNestPrefersEnv(t *testing.T) {
	workingDir := t.TempDir()
	writeConfigFile(t, workingDir, `
litellm_config:
  model: file-model
  api_url: http://file:4001
  api_key: file-key
  fallback_models:
    - file-fallback
pipeline:
  summary_dedup_threshold: 0.42
`)
	config := LoadConfig(envFrom(map[string]string{
		"LITELLM_MODEL":           "env-model",
		"LITELLM_API_URL":         "http://env:4000",
		"LITELLM_API_KEY":         "env-key",
		"LITELLM_FALLBACK_MODELS": "env-fallback",
	}), workingDir)

	// model/file members: raw ?? env => the file wins for model.
	if config.LiteLLM.Model != "file-model" {
		t.Fatalf("model = %q, want file value", config.LiteLLM.Model)
	}
	// api base/key/fallbacks prefer the environment, then the file.
	if config.LiteLLM.APIURL != "http://env:4000" || config.LiteLLM.APIKey != "env-key" {
		t.Fatalf("env-preferred members = %#v", config.LiteLLM)
	}
	if strings.Join(config.LiteLLM.FallbackModels, ",") != "env-fallback" {
		t.Fatalf("fallback models = %v", config.LiteLLM.FallbackModels)
	}
	if config.Pipeline.SummaryDedupThreshold != 0.42 {
		t.Fatalf("file threshold = %v", config.Pipeline.SummaryDedupThreshold)
	}
}

func TestLoadConfigMalformedYAMLFallsBackToDefaults(t *testing.T) {
	workingDir := t.TempDir()
	writeConfigFile(t, workingDir, "litellm_config: [unclosed")
	config := LoadConfig(envFrom(nil), workingDir)
	if config.LiteLLM.Model != "openai/gpt-4o-mini" {
		t.Fatalf("malformed yaml should degrade to defaults, model = %q", config.LiteLLM.Model)
	}
	if config.Pipeline.SummaryDedupThreshold != 0.9 {
		t.Fatalf("threshold = %v", config.Pipeline.SummaryDedupThreshold)
	}
}

func TestLoadConfigResolvesRelativeConfigPath(t *testing.T) {
	root := t.TempDir()
	workingDir := filepath.Join(root, "apps", "api")
	if err := os.MkdirAll(workingDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	customPath := filepath.Join(root, "custom-news.yaml")
	if err := os.WriteFile(customPath, []byte("pipeline:\n  summary_dedup_threshold: 0.42\n"), 0o644); err != nil {
		t.Fatalf("write custom config: %v", err)
	}
	// NEWS_PIPELINE_CONFIG_PATH=custom-news.yaml must be found two levels up.
	config := LoadConfig(envFrom(map[string]string{
		"NEWS_PIPELINE_CONFIG_PATH": "custom-news.yaml",
	}), workingDir)
	if config.Pipeline.SummaryDedupThreshold != 0.42 {
		t.Fatalf("resolved config threshold = %v, want 0.42", config.Pipeline.SummaryDedupThreshold)
	}
	if config.Pipeline.ConfigPath != "custom-news.yaml" {
		t.Fatalf("config path member should keep the raw env value, got %q", config.Pipeline.ConfigPath)
	}

	// An absolute path wins directly.
	config = LoadConfig(envFrom(map[string]string{
		"NEWS_PIPELINE_CONFIG_PATH": customPath,
	}), t.TempDir())
	if config.Pipeline.SummaryDedupThreshold != 0.42 {
		t.Fatalf("absolute config threshold = %v", config.Pipeline.SummaryDedupThreshold)
	}
}

func TestLoadConfigYAMLTopLevelNotObject(t *testing.T) {
	workingDir := t.TempDir()
	writeConfigFile(t, workingDir, "- just\n- a\n- list\n")
	config := LoadConfig(envFrom(nil), workingDir)
	if config.LiteLLM.Model != "openai/gpt-4o-mini" {
		t.Fatalf("non-object yaml should degrade to defaults, got %q", config.LiteLLM.Model)
	}
}

func TestCrawlerDefaultsJSONDecodes(t *testing.T) {
	config := LoadConfig(envFrom(nil), t.TempDir())
	var document map[string]json.RawMessage
	if err := json.Unmarshal(config.Crawl4AI.CrawlerDefaults, &document); err != nil {
		t.Fatalf("crawler defaults is not JSON: %v", err)
	}
	if _, present := document["virtualScroll"]; present {
		t.Fatalf("disabled virtual scroll must be omitted")
	}
}
