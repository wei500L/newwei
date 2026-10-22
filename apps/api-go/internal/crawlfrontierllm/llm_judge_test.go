package crawlfrontierllm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestJudgeBudgetDiagnosticsKeepConfiguredBudget pins the llmJudgeBudget value
// the judge writes into the node metadata. NestJS reports the configured budget
// (16 for a list page by default) even when the page holds fewer candidates, and
// the value is exposed through the node metadata and the run summary's
// rootDiagnosis, so clamping it to the candidate count is a contract diff.
func TestJudgeBudgetDiagnosticsKeepConfiguredBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model":   "primary",
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": `{"decisions":[]}`}}},
		})
	}))
	defer server.Close()

	input := judgeInput()
	if len(input.Candidates) >= 16 {
		t.Fatalf("fixture must hold fewer candidates than the list budget, holds %d", len(input.Candidates))
	}
	result, err := testClient(t, server).JudgeCandidates(context.Background(), input)
	if err != nil {
		t.Fatalf("JudgeCandidates error = %v", err)
	}
	budget, ok := result.Diagnostics.Number("llmJudgeBudget")
	if !ok || budget != 16 {
		t.Fatalf("llmJudgeBudget = %v (present %v), want the configured 16", budget, ok)
	}
	parsed, _ := result.Diagnostics.Bool("llmJudgeParsed")
	if !parsed {
		t.Fatal("a well-formed response must be parsed")
	}
}

// TestJudgeAcceptsEmptySelectorHints covers the Zod range of
// selectorHints: an empty array is valid (the schema only caps the length), so
// a decision carrying [] must keep the whole response instead of invalidating
// it. Only a non-string entry or more than five hints are rejected.
func TestJudgeAcceptsEmptySelectorHints(t *testing.T) {
	valid := `{"decisions":[{"url":"https://example.com/a","action":"drop","pageType":"article","confidence":0.9,"selectorHints":[]}]}`
	object, ok := ParseObject(json.RawMessage(valid))
	if !ok {
		t.Fatal("fixture must parse")
	}
	parsed, ok := validateJudgeResponse(mustJSON(object))
	if !ok || len(parsed.Decisions) != 1 {
		t.Fatalf("empty selectorHints must validate: %+v, %v", parsed, ok)
	}
	if parsed.Decisions[0].SelectorHints == nil || len(parsed.Decisions[0].SelectorHints) != 0 {
		t.Fatalf("selectorHints = %v, want the empty list", parsed.Decisions[0].SelectorHints)
	}

	tooMany := `{"decisions":[{"url":"https://example.com/a","action":"drop","pageType":"article","confidence":0.9,"selectorHints":["a","b","c","d","e","f"]}]}`
	if object, ok := ParseObject(json.RawMessage(tooMany)); !ok {
		t.Fatal("fixture must parse")
	} else if _, ok := validateJudgeResponse(mustJSON(object)); ok {
		t.Fatal("six selectorHints must invalidate the response")
	}

	emptyEntry := `{"decisions":[{"url":"https://example.com/a","action":"drop","pageType":"article","confidence":0.9,"selectorHints":[""]}]}`
	if object, ok := ParseObject(json.RawMessage(emptyEntry)); !ok {
		t.Fatal("fixture must parse")
	} else if _, ok := validateJudgeResponse(mustJSON(object)); ok {
		t.Fatal("an empty selectorHints entry must invalidate the response")
	}
}

// TestSanitizeProfilePatchKeyOrderIsDeterministic pins the serialised field
// order of the sanitised patch. The patch ends up in the profile config, so the
// order must follow the Zod schema declaration order instead of Go map
// iteration order.
func TestSanitizeProfilePatchKeyOrderIsDeterministic(t *testing.T) {
	raw := `{
		"sourceTier": "tier1",
		"denyKeywords": ["spam"],
		"priorityKeywords": ["news"],
		"domLinkExcludeSelectors": [".ads"],
		"domLinkScopes": ["main"],
		"localeScope": {"denyHostPatterns": ["ads.example.com"], "denyUrlPatterns": ["/ads/"], "acceptLanguages": ["en"], "locale": "en-US"},
		"pageTypeSignals": {"list": {"keywords": ["latest"]}},
		"urlPatterns": {"article": ["/news/"], "home": ["/"]},
		"seedDiscovery": {
			"topologyBudgetDepth": 2, "topologyBudgetPages": 20, "maxSeedUrls": 12,
			"freshnessWindowHours": 24, "mode": "robots", "strategy": "auto",
			"qualityThresholds": {"minFreshRatio": 0.2, "maxNoiseRatio": 0.5, "minArticleRatio": 0.3, "minCandidates": 4}
		}
	}`
	object, ok := ParseObject(json.RawMessage(raw))
	if !ok {
		t.Fatal("fixture must parse")
	}
	want := `{"seedDiscovery":{"strategy":"auto","mode":"robots","freshnessWindowHours":24,"maxSeedUrls":12,"topologyBudgetPages":20,"topologyBudgetDepth":2,"qualityThresholds":{"minCandidates":4,"minArticleRatio":0.3,"maxNoiseRatio":0.5,"minFreshRatio":0.2}},"urlPatterns":{"home":["/"],"article":["/news/"]},"pageTypeSignals":{"list":{"keywords":["latest"]}},"localeScope":{"locale":"en-US","acceptLanguages":["en"],"denyUrlPatterns":["/ads/"],"denyHostPatterns":["ads.example.com"]},"domLinkScopes":["main"],"domLinkExcludeSelectors":[".ads"],"priorityKeywords":["news"],"denyKeywords":["spam"],"sourceTier":"tier1"}`
	for attempt := 0; attempt < 32; attempt++ {
		first, ok := sanitizeProfilePatch(object)
		if !ok {
			t.Fatalf("sanitizeProfilePatch failed on attempt %d", attempt)
		}
		encoded, err := first.MarshalJSON()
		if err != nil {
			t.Fatalf("marshal patch: %v", err)
		}
		if string(encoded) != want {
			t.Fatalf("attempt %d encoded = %s\nwant %s", attempt, encoded, want)
		}
	}
}
