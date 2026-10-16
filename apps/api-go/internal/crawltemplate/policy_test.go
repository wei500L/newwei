package crawltemplate

import (
	"encoding/json"
	"strings"
	"testing"
)

// 两个守卫的表驱动测试：不需要数据库，随普通 CI 的 `go test ./...` 运行。

func TestAssertNoUnsupportedProxy(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string // 期望错误文本；空串表示通过（nil）
	}{
		{
			name: "proxyUrl",
			raw:  `{"proxyUrl":"http://127.0.0.1:8080"}`,
			want: "Unsupported crawl config: crawlOptions.proxyUrl: custom upstream proxies are not supported",
		},
		{
			name: "proxyConfig",
			raw:  `{"proxyConfig":{"host":"x"}}`,
			want: "Unsupported crawl config: crawlOptions.proxyConfig: custom upstream proxies are not supported",
		},
		{
			name: "both-in-order",
			raw:  `{"proxyConfig":{},"proxyUrl":"x"}`,
			want: "Unsupported crawl config: crawlOptions.proxyUrl: custom upstream proxies are not supported; crawlOptions.proxyConfig: custom upstream proxies are not supported",
		},
		{
			// 只检查顶层：嵌套的 proxyUrl 不归这个守卫。
			name: "nested-not-scanned",
			raw:  `{"config":{"proxyUrl":"x"}}`,
			want: "",
		},
		{
			name: "plain-options",
			raw:  `{"markdown":true,"check_robots_txt":false}`,
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := assertNoUnsupportedProxy(json.RawMessage(tc.raw), "crawlOptions")
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

const llmTail = "). The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead."

func llmWant(keys string) string {
	return "crawlOptions contains crawl4ai LLM extraction settings (" + keys + llmTail
}

func TestAssertNoCrawl4aiLlmOptions(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string // 期望完整错误文本；空串表示通过（nil）
	}{
		// 禁止键（规范化后等于 extractionstrategy / llmconfig）。
		{name: "llmConfig", raw: `{"llmConfig":{"model":"x"}}`, want: llmWant("llmConfig")},
		{name: "extractionStrategy", raw: `{"extractionStrategy":"x"}`, want: llmWant("extractionStrategy")},
		{name: "normalized-key", raw: `{"extraction_strategy":true}`, want: llmWant("extraction_strategy")},
		// 递归进嵌套对象与数组。
		{name: "nested-object", raw: `{"fetch":{"llmConfig":true}}`, want: llmWant("fetch.llmConfig")},
		{name: "nested-array", raw: `{"steps":[{"a":1},{"LLM-CONFIG":true}]}`, want: llmWant("steps[1].LLM-CONFIG")},
		// type 里带 llm，且路径含 strategy / extraction。
		{name: "type-under-extraction", raw: `{"extraction":{"type":"llm"}}`, want: llmWant("extraction.type")},
		{name: "type-under-strategy", raw: `{"strategy":{"type":"LLM extraction"}}`, want: llmWant("strategy.type")},
		// type 带 llm 但路径不含 strategy/extraction：不拦。
		{name: "type-without-path", raw: `{"type":"llm"}`, want: ""},
		{name: "type-null", raw: `{"strategy":{"type":null}}`, want: ""},
		// 普通 markdown 选项通过。
		{name: "markdown-options", raw: `{"markdown":true,"check_robots_txt":false,"wait_for":"networkidle"}`, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := assertNoCrawl4aiLlmOptions(json.RawMessage(tc.raw), "crawlOptions")
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || err.Error() != tc.want {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

// 超过 5 个命中键：只列前 5 个，其余用 " (+N more)"（英文句子原样）。
func TestAssertNoCrawl4aiLlmOptionsTruncatesAfterFive(t *testing.T) {
	raw := json.RawMessage(`{
		"llmConfig": 1,
		"llm_config": 2,
		"llm-config": 3,
		"llm config": 4,
		"llmconfig": 5,
		"extractionStrategy": 6
	}`)
	err := assertNoCrawl4aiLlmOptions(raw, "crawlOptions")
	if err == nil {
		t.Fatal("expected error")
	}
	message := err.Error()
	if !strings.HasPrefix(message, "crawlOptions contains crawl4ai LLM extraction settings (") {
		t.Fatalf("prefix mismatch: %q", message)
	}
	if !strings.HasSuffix(message, llmTail) {
		t.Fatalf("suffix mismatch: %q", message)
	}
	if !strings.Contains(message, "(+1 more)") {
		t.Fatalf("missing (+1 more): %q", message)
	}
	// 恰好列出 5 个键（4 个分隔逗号）。句子本身没有逗号。
	if got := strings.Count(strings.Split(message, " (+")[0], ","); got != 4 {
		t.Fatalf("listed keys comma count = %d, want 4: %q", got, message)
	}
}

// 环检测：自引用对象/数组不得无限递归（JS Set 语义的镜像）。
func TestFindDisallowedKeysTerminatesOnCycles(t *testing.T) {
	cyclicObject := map[string]any{"llmConfig": true}
	cyclicObject["self"] = cyclicObject
	hits := findDisallowedKeys(cyclicObject, "", map[uintptr]bool{})
	if len(hits) != 1 || hits[0] != "llmConfig" {
		t.Fatalf("cyclic object hits = %v, want [llmConfig]", hits)
	}

	cyclicArray := []any{nil}
	cyclicArray[0] = cyclicArray
	if hits := findDisallowedKeys(cyclicArray, "", map[uintptr]bool{}); len(hits) != 0 {
		t.Fatalf("cyclic array hits = %v, want none", hits)
	}
}
