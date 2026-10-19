package crawloptions_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// validatorWithoutDNS keeps the IsSafeUrl check local and deterministic.
func validatorWithoutDNS() *crawloptions.URLValidator {
	return &crawloptions.URLValidator{}
}

func decode(t *testing.T, body string) (crawloptions.Validation, *crawloptions.Normalizer) {
	t.Helper()
	validation := crawloptions.ValidateCreateTaskREST(t.Context(), []byte(body), validatorWithoutDNS())
	return validation, crawloptions.NewNormalizer("http://crawler:11235")
}

func normalize(t *testing.T, validation crawloptions.Validation) crawloptions.Options {
	t.Helper()
	normalizer := crawloptions.NewNormalizer("http://crawler:11235")
	options := validation.Input.Options
	if options == nil {
		options = &crawloptions.OptionsInput{}
	}
	if validation.Input.Options != nil {
		options.MarkdownFilter = crawloptions.NormalizeMarkdownFilterForTask(validation.Input.Options.MarkdownFilter)
	}
	return normalizer.Normalize(options)
}

func assertJSON(t *testing.T, got any, want string) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var gotValue any
	if err := json.Unmarshal(encoded, &gotValue); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	var wantValue any
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("unmarshal want: %v", err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("normalized options mismatch\n got: %s\nwant: %s", encoded, want)
	}
}

func TestValidateCreateTaskDefaults(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com"}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	options := normalize(t, validation)
	assertJSON(t, options, `{
		"includeImages": false,
		"storeMedia": false,
		"onlyMainContent": true,
		"extractLinks": false,
		"cacheMode": "bypass",
		"prefetch": false,
		"scanFullPage": false,
		"adjustViewportToContent": false,
		"enableUndetectedBrowser": false,
		"antiBotMode": "auto",
		"enableStealthMode": false,
		"useManagedBrowser": false,
		"simulateUser": false,
		"overrideNavigator": false,
		"jsOnly": false,
		"markdownOptions": {"contentSource": "cleaned_html", "citations": true},
		"cleanMarkdown": {
			"excludedTags": ["nav", "footer", "aside", "script", "style", "noscript", "form"],
			"removeOverlayElements": true,
			"wordCountThreshold": 18
		},
		"scoreLinks": false,
		"userAgentMode": "random",
		"wordCountThreshold": 80,
		"excludeExternalLinks": true,
		"removeOverlayElements": true,
		"processIframes": true,
		"textMode": false,
		"captureScreenshot": false,
		"excludeExternalImages": true,
		"waitForImages": false,
		"removeForms": false,
		"autoExpandDetails": true,
		"qualityProfile": "quality_first"
	}`)
}

func TestNormalizeMarkdownFilterPruning(t *testing.T) {
	// The task-level filter runs on stored config on retry, so out-of-range
	// values reach the helper unvalidated and must be clamped.
	threshold := 1.5
	thresholdType := "dynamic"
	minWords := 600
	legacy := crawloptions.NormalizeMarkdownFilterForTask(&crawloptions.MarkdownFilter{
		Type:             "pruning",
		Threshold:        &threshold,
		ThresholdType:    &thresholdType,
		MinWordThreshold: &minWords,
	})
	if legacy == nil || legacy.Type != "pruning" {
		t.Fatalf("task filter = %#v", legacy)
	}
	normalizer := crawloptions.NewNormalizer("http://crawler:11235")
	normalized := normalizer.Normalize(&crawloptions.OptionsInput{MarkdownFilter: legacy})
	assertJSON(t, normalized.MarkdownFilter, `{"type":"pruning","threshold":1,"thresholdType":"dynamic","minWordThreshold":500}`)
}

func TestNormalizeMarkdownFilterBM25(t *testing.T) {
	validation, normalizer := decode(t, `{
		"url":"https://example.com",
		"options":{"markdownFilter":{"type":"bm25","userQuery":"  climate policy  ","bm25Threshold":2.3456,"language":" EN "}}
	}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	legacy := crawloptions.NormalizeMarkdownFilterForTask(validation.Input.Options.MarkdownFilter)
	options := validation.Input.Options
	options.MarkdownFilter = legacy
	normalized := normalizer.Normalize(options)
	assertJSON(t, normalized.MarkdownFilter, `{"type":"bm25","userQuery":"climate policy","bm25Threshold":2.35,"language":"EN"}`)
}

func TestNormalizeMarkdownFilterBM25WithoutQueryIsDropped(t *testing.T) {
	validation, _ := decode(t, `{
		"url":"https://example.com",
		"options":{"markdownFilter":{"type":"bm25","userQuery":"   ","language":"en"}}
	}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	if legacy := crawloptions.NormalizeMarkdownFilterForTask(validation.Input.Options.MarkdownFilter); legacy != nil {
		t.Fatalf("expected nil filter, got %#v", legacy)
	}
}

func TestNormalizeMultiURLConfigs(t *testing.T) {
	validation, normalizer := decode(t, `{
		"url":"https://example.com",
		"options":{
			"multiUrlConfigs":[
				{
					"name":"  section  ",
					"urls":[" https://example.com/a ","https://example.com/a",""],
					"matcher":{"matchMode":"glob","patterns":[" /a/* ","/a/*"]},
					"options":{"jsOnly":true,"waitForTimeoutMs":600,"scrollDelayMs":900,"scanFullPage":true}
				},
				{"name":"no urls"}
			]
		}
	}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	normalized := normalizer.Normalize(validation.Input.Options)
	assertJSON(t, normalized.MultiURLConfigs, `[
		{
			"name":"section",
			"matcher":{"matchMode":"glob","patterns":["/a/*","/a/*"]},
			"urls":["https://example.com/a"],
			"options":{"scanFullPage":true,"scrollDelayMs":900,"jsOnly":true,"waitForTimeoutMs":600}
		}
	]`)
}

func TestAssertNoUnsupportedProxy(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","options":{"proxyUrl":"http://127.0.0.1:8080"}}`)
	if len(validation.Messages) == 0 {
		t.Fatal("expected the DTO whitelist to reject proxyUrl")
	}
	err := crawloptions.AssertNoUnsupportedProxy(
		json.RawMessage(`{"proxyConfig":{"server":"http://127.0.0.1:8080"}}`), "options")
	if err == nil {
		t.Fatal("expected proxy policy rejection")
	}
	policy, ok := err.(*crawloptions.PolicyError)
	if !ok {
		t.Fatalf("error type = %T", err)
	}
	want := "Unsupported crawl config: options.proxyConfig: custom upstream proxies are not supported"
	if policy.Message != want {
		t.Fatalf("message = %q, want %q", policy.Message, want)
	}
}

func TestAssertNoCrawl4aiLlmOptions(t *testing.T) {
	err := crawloptions.AssertNoCrawl4aiLlmOptions(
		json.RawMessage(`{"tableExtraction":{"type":"llm_table_extraction"}}`), "options")
	if err == nil {
		t.Fatal("expected LLM policy rejection")
	}
	want := "options contains crawl4ai LLM extraction settings (tableExtraction.type). " +
		"The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead."
	if err.Error() != want {
		t.Fatalf("message = %q, want %q", err.Error(), want)
	}
}

func TestValidationConcurrencyCoercion(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","concurrency":"5"}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	if validation.Input.Concurrency == nil || *validation.Input.Concurrency != 5 {
		t.Fatalf("concurrency = %#v", validation.Input.Concurrency)
	}
}

func TestValidationConcurrencyRange(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","concurrency":11}`)
	want := []string{"concurrency must not be greater than 10"}
	if !reflect.DeepEqual(validation.Messages, want) {
		t.Fatalf("messages = %v, want %v", validation.Messages, want)
	}
}

func TestValidationTimeRange(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","timeRangeFrom":"not-a-date"}`)
	want := []string{"timeRangeFrom must be a valid ISO 8601 date string"}
	if !reflect.DeepEqual(validation.Messages, want) {
		t.Fatalf("messages = %v, want %v", validation.Messages, want)
	}
}

func TestValidationUnknownNestedKey(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","options":{"markdownFilter":{"bodyWidth":60}}}`)
	want := []string{"options.markdownFilter.property bodyWidth should not exist"}
	if !reflect.DeepEqual(validation.Messages, want) {
		t.Fatalf("messages = %v, want %v", validation.Messages, want)
	}
}

func TestValidationNestedRangeMessage(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","options":{"markdownOptions":{"bodyWidth":10}}}`)
	want := []string{"options.markdownOptions.bodyWidth must not be less than 40"}
	if !reflect.DeepEqual(validation.Messages, want) {
		t.Fatalf("messages = %v, want %v", validation.Messages, want)
	}
}

func TestValidationJSWhitelist(t *testing.T) {
	validation, _ := decode(t, `{"url":"https://example.com","options":{"jsCode":["fetch('https://evil')"]}}`)
	if len(validation.Messages) != 1 {
		t.Fatalf("messages = %v", validation.Messages)
	}
	if !strings.HasPrefix(validation.Messages[0], "options.jsCode contains blocked JavaScript patterns: fetch(): Network request") {
		t.Fatalf("message = %q", validation.Messages[0])
	}
}

func TestStripJSExecutionOptions(t *testing.T) {
	// The actor gate is exercised in the service; this asserts the pure
	// normalization a non-admin receives through NormalizeOptions.
	validation, normalizer := decode(t, `{
		"url":"https://example.com",
		"options":{"jsCode":["document.querySelector('#more').click()"],"jsOnly":true,
			"multiUrlConfigs":[{"urls":["https://example.com/a"],"options":{"jsOnly":true,"onlyMainContent":false}}]}
	}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	options := validation.Input.Options
	options.JSCode = nil
	options.JSOnly = nil
	options.MultiURLConfigs[0].Options.JSCode = nil
	options.MultiURLConfigs[0].Options.JSOnly = nil
	normalized := normalizer.Normalize(options)
	if normalized.JSCode != nil || normalized.JSOnly {
		t.Fatalf("js options survived stripping: %#v", normalized)
	}
	assertJSON(t, normalized.MultiURLConfigs, `[{"urls":["https://example.com/a"],"options":{"onlyMainContent":false}}]`)
}

func TestNormalizeVirtualScrollPixels(t *testing.T) {
	validation, normalizer := decode(t, `{
		"url":"https://example.com",
		"options":{"virtualScroll":{"scrollBy":"pixels","scrollByPixels":700,"scrollCount":3}}
	}`)
	if len(validation.Messages) != 0 {
		t.Fatalf("unexpected messages: %v", validation.Messages)
	}
	normalized := normalizer.Normalize(validation.Input.Options)
	if normalized.ScanFullPage {
		t.Fatal("virtual scroll must disable scanFullPage")
	}
	assertJSON(t, normalized.VirtualScroll, `{"containerSelector":"body","scrollCount":3,"scrollBy":700}`)
}

func TestNormalizeKeywords(t *testing.T) {
	got := crawloptions.NormalizeKeywords([]string{" Climate ", "climate", "", "  "})
	want := []string{"climate"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("keywords = %v, want %v", got, want)
	}
}

func TestCoerceDate(t *testing.T) {
	if got := crawloptions.CoerceDate("2026-01-02T03:04:05.000Z"); got == nil || got.UTC().Format("2006-01-02T15:04:05.000Z") != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("date = %v", got)
	}
	if got := crawloptions.CoerceDate("nope"); got != nil {
		t.Fatalf("expected nil, got %v", got)
	}
}
