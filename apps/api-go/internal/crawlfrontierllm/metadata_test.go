package crawlfrontierllm

import (
	"context"
	"errors"
	"testing"
)

func TestMergeObjectsOrderOverrideAndNull(t *testing.T) {
	base, ok := ParseObject([]byte(`{"a":1,"b":2,"c":{"x":true}}`))
	if !ok {
		t.Fatal("base object")
	}
	patch, ok := ParseObject([]byte(`{"b":3,"d":null,"c":{"y":2}}`))
	if !ok {
		t.Fatal("patch object")
	}
	merged := mergeObjects(base, patch)
	if merged == nil {
		t.Fatal("merged is nil")
	}
	keys := merged.Keys()
	want := []string{"a", "b", "c", "d"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
	if value, _ := merged.Number("b"); value != 3 {
		t.Fatalf("b = %v, want 3", value)
	}
	if raw, ok := merged.Raw("d"); !ok || string(raw) != "null" {
		t.Fatalf("d = %s, want null", raw)
	}
	if nested, ok := merged.Object("c"); !ok || nested.Len() != 1 || !nested.Has("y") {
		raw, _ := merged.Raw("c")
		t.Fatalf("c = %s, want {y:2}", raw)
	}
	if empty := mergeObjects(nil, nil); empty != nil {
		t.Fatalf("empty merge = %v, want nil", empty)
	}
}

func TestCollectNodeWarningFlagsOrderAndDedupe(t *testing.T) {
	metadata, ok := ParseObject([]byte(`{"warningFlags":["b","a","b"],"llmJudgeEnabled":true,"llmJudgeAttempted":true,"llmJudgeParsed":false,"llmJudgeError":"boom","failureKind":"challenge_detected"}`))
	if !ok {
		t.Fatal("metadata")
	}
	flags := CollectNodeWarningFlags(metadata, nil)
	want := []string{"b", "a", "llm_judge_parse_failed", "llm_judge_failed", "challenge_detected"}
	if len(flags) != len(want) {
		t.Fatalf("flags = %v, want %v", flags, want)
	}
	for index := range want {
		if flags[index] != want[index] {
			t.Fatalf("flags = %v, want %v", flags, want)
		}
	}
	// A classified lastError contributes its kind when metadata has none.
	lastError := "Access denied by Cloudflare"
	if got := CollectNodeWarningFlags(NewObject(), &lastError); len(got) != 1 || got[0] != "challenge_detected" {
		t.Fatalf("classified flags = %v", got)
	}
}

func TestResolvePendingLlmJudgeJobs(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{`{"pendingLlmJudgeJobs":3}`, 3},
		{`{"pendingLlmJudgeJobs":"2"}`, 2},
		{`{"pendingLlmJudgeJobs":-1}`, 0},
		{`{"pendingLlmJudgeJobs":1.6}`, 2},
		{`{}`, 0},
	}
	for _, tc := range cases {
		metadata, ok := ParseObject([]byte(tc.raw))
		if !ok {
			t.Fatalf("parse %s", tc.raw)
		}
		if got := ResolvePendingLlmJudgeJobs(metadata); got != tc.want {
			t.Errorf("ResolvePendingLlmJudgeJobs(%s) = %d, want %d", tc.raw, got, tc.want)
		}
	}
}

func TestPageTypeBudgetsAndQueueClass(t *testing.T) {
	budgets := ComputeFrontierPageTypeBudgets(3, 10)
	if budgets.Home != 1 || budgets.Category != 3 || budgets.List != 3 || budgets.Article != 3 {
		t.Fatalf("budgets = %+v", budgets)
	}
	if got := ResolveNodeQueueClass("list"); got != "hot" {
		t.Fatalf("list queue class = %s", got)
	}
	if got := ResolveNodeQueueClass("article"); got != "normal" {
		t.Fatalf("article queue class = %s", got)
	}
}

func TestCanonicalURLFingerprint(t *testing.T) {
	canonical := BuildCanonicalURLFingerprint("HTTPS://Example.com:443/a//b/?b=2&a=1&utm=x#f", nil)
	if canonical == nil {
		t.Fatal("canonical is nil")
	}
	if canonical.CanonicalURL != "https://example.com/a/b" {
		t.Fatalf("canonical = %q", canonical.CanonicalURL)
	}
	if got := BuildCanonicalURLFingerprint("not a url", nil); got != nil {
		t.Fatalf("invalid url = %+v", got)
	}
}

func TestLearnHandledKeyAndShadowComparison(t *testing.T) {
	run := LearnRun{Status: "completed", ArticleCount: 3, PageCount: 5, FailedCount: 1, DuplicateCount: 0}
	if got := learnHandledKey(run); got != "completed:3:5:1:0" {
		t.Fatalf("learnHandledKey = %q", got)
	}
	origin := &RunRecord{ArticleCount: 10, PageCount: 20, NodeCount: 20, FailedCount: 1}
	shadow := LearnRun{ArticleCount: 12, PageCount: 20, NodeCount: 20, FailedCount: 0}
	metadata, _ := ParseObject([]byte(`{"judgeSummary":{"averageConfidence":0.8}}`))
	comparison := compareShadowRunAgainstOrigin(origin, shadow, metadata, nil)
	passed, _ := comparison.Bool("passed")
	if !passed {
		t.Fatalf("comparison = %s", mustJSON(comparison))
	}
	thresholds, _ := comparison.Object("thresholds")
	if value, _ := thresholds.Number("minArticleLift"); value != 0.15 {
		t.Fatalf("default minArticleLift = %v", value)
	}
}

func TestTopCountKeyTieBreak(t *testing.T) {
	counts, _ := ParseObject([]byte(`{"b":2,"a":2,"c":1}`))
	if got := topCountKey(counts); got != "a" {
		t.Fatalf("topCountKey = %q, want a", got)
	}
}

func TestAggregateRefreshNodes(t *testing.T) {
	rootMetadata, _ := ParseObject([]byte(`{"candidateStats":{"scanned":5,"selected":2},"rejectionCounts":{"duplicate":1},"warningFlags":["a"],"judgeMethod":"llm","judgeConfidence":0.8,"pendingLlmJudgeJobs":1}`))
	lastError := "Access denied by Cloudflare"
	nodes := []refreshNode{
		{Status: "completed", PageType: "home", Depth: 0, Metadata: rootMetadata},
		{Status: "completed", PageType: "article", Depth: 1, RejectionReason: stringPointer("duplicate"), LastError: &lastError},
		{Status: "queued", PageType: "list", Depth: 1},
	}
	aggregate := aggregateRefreshNodes(nodes)
	if aggregate.NodeCount != 3 || aggregate.PageCount != 2 || aggregate.ArticleCount != 1 ||
		aggregate.DuplicateCount != 1 || aggregate.ActiveNodeCount != 1 || aggregate.PendingLlmJudgeJobs != 1 {
		t.Fatalf("aggregate = %+v", aggregate)
	}
	if value, _ := aggregate.CoverageByPageType.Number("home"); value != 1 {
		t.Fatalf("home coverage = %v", value)
	}
	if value, _ := aggregate.CoverageByDepth.Number("1"); value != 2 {
		t.Fatalf("depth 1 coverage = %v", value)
	}
	if value, _ := aggregate.CandidateStats.Number("scanned"); value != 5 {
		t.Fatalf("candidateStats.scanned = %v", value)
	}
	if value, _ := aggregate.RejectionCounts.Number("duplicate"); value != 2 {
		t.Fatalf("rejectionCounts.duplicate = %v", value)
	}
	// The child has no metadata object, and refreshRunStatus only classifies a
	// node's lastError inside the isPlainObject(metadata) branch.
	if aggregate.FailureKindCounts.Len() != 0 {
		t.Fatalf("failureKindCounts = %s", mustJSON(aggregate.FailureKindCounts))
	}
	if value, _ := aggregate.JudgeMethodCounts.Number("llm"); value != 1 {
		t.Fatalf("judgeMethodCounts = %s", mustJSON(aggregate.JudgeMethodCounts))
	}
	if aggregate.JudgeConfidenceCount != 1 || aggregate.JudgeConfidenceTotal != 0.8 {
		t.Fatalf("judge confidence = %v/%v", aggregate.JudgeConfidenceTotal, aggregate.JudgeConfidenceCount)
	}
	if aggregate.RootDiagnosis == nil {
		t.Fatal("rootDiagnosis missing")
	}
	if value, _ := aggregate.RootDiagnosis.Number("pendingLlmJudgeJobs"); value != 1 {
		t.Fatalf("root pending = %v", value)
	}
	if raw, _ := aggregate.RootDiagnosis.Raw("failureKind"); string(raw) != "null" {
		t.Fatalf("root failureKind = %s", raw)
	}
	flags := aggregate.WarningFlags
	if len(flags) != 1 || flags[0] != "a" {
		t.Fatalf("warning flags = %v", flags)
	}
}

type failingFrontierLLM struct{}

func (failingFrontierLLM) JudgeCandidates(context.Context, JudgeInput) (JudgeResult, error) {
	return JudgeResult{}, errors.New("judge boom")
}

func (failingFrontierLLM) LearnShadowProfile(context.Context, LearnInput) (*LearningSuggestion, error) {
	return nil, errors.New("learn boom")
}

func TestApplyLlmCandidateAssistanceFallbackDiagnostics(t *testing.T) {
	config, _ := ParseObject([]byte(`{"llmAssist":{"enabled":true}}`))
	service := &Service{llm: failingFrontierLLM{}}
	node := &NodeRecord{ID: "node-1", OrgID: "org-1", URL: "https://example.com", PageType: "list", Depth: 0}
	run := &RunRecord{ID: "run-1"}
	profile := &ProfileRecord{ID: "profile-1", Config: config}
	candidates := []Candidate{{URL: "https://example.com/a", PageType: "article", Metadata: []byte(`{}`)}}
	assisted, err := service.applyLlmCandidateAssistance(context.Background(), node, run, profile, candidates)
	if err != nil {
		t.Fatalf("fallback must not propagate: %v", err)
	}
	if len(assisted.candidates) != 1 || assisted.candidates[0].URL != "https://example.com/a" {
		t.Fatalf("candidates = %v", assisted.candidates)
	}
	if assisted.diagnostics == nil {
		t.Fatal("diagnostics missing")
	}
	message, _ := assisted.diagnostics.String("llmJudgeError")
	if message != "judge boom" {
		t.Fatalf("llmJudgeError = %q", message)
	}
	flags, _ := assisted.diagnostics.Strings("warningFlags")
	if len(flags) != 1 || flags[0] != "llm_judge_failed" {
		t.Fatalf("warningFlags = %v", flags)
	}
}

func TestRefreshRunStatusMatchesFullMetadata(t *testing.T) {
	fullRaw := `{
		"candidateStats":{"scanned":9,"selected":4},
		"rejectionCounts":{"duplicate":2,"page_type_budget":1},
		"warningFlags":["seed_low_quality","challenge_detected"],
		"failureKind":"challenge_detected",
		"judgeMethod":"llm",
		"judgeConfidence":0.75,
		"pendingLlmJudgeJobs":2,
		"seedStrategy":"auto",
		"seedOrigin":"sitemap",
		"seedMethod":"robots",
		"seedDiscoveryMode":"robots",
		"fallbackStage":"frontier",
		"seedYield":{"discovered":9,"selected":4},
		"seedQuality":{"passed":false},
		"seedDiagnostics":{"discoveryMode":"robots"},
		"nativeStrategyType":"bfs",
		"linkPreviewMode":"head",
		"unknownLargePayload":{"ignored":true}
	}`
	extractedRaw := `{
		"candidateStats":{"scanned":9,"selected":4},
		"rejectionCounts":{"duplicate":2,"page_type_budget":1},
		"warningFlags":["seed_low_quality","challenge_detected"],
		"failureKind":"challenge_detected",
		"judgeMethod":"llm",
		"judgeConfidence":0.75,
		"pendingLlmJudgeJobs":2,
		"seedStrategy":"auto",
		"seedOrigin":"sitemap",
		"seedMethod":"robots",
		"seedDiscoveryMode":"robots",
		"fallbackStage":"frontier",
		"seedYield":{"discovered":9,"selected":4},
		"seedQuality":{"passed":false},
		"seedDiagnostics":{"discoveryMode":"robots"},
		"nativeStrategyType":"bfs",
		"linkPreviewMode":"head"
	}`
	full, _ := ParseObject([]byte(fullRaw))
	extracted, _ := ParseObject([]byte(extractedRaw))
	fullAggregate := aggregateRefreshNodes([]refreshNode{{Status: "completed", PageType: "home", Depth: 0, Metadata: full}})
	extractedAggregate := aggregateRefreshNodes([]refreshNode{{Status: "completed", PageType: "home", Depth: 0, Metadata: extracted}})
	if fullAggregate.NodeCount != extractedAggregate.NodeCount ||
		fullAggregate.PageCount != extractedAggregate.PageCount ||
		fullAggregate.PendingLlmJudgeJobs != extractedAggregate.PendingLlmJudgeJobs ||
		fullAggregate.JudgeConfidenceCount != extractedAggregate.JudgeConfidenceCount {
		t.Fatalf("counts differ: %+v vs %+v", fullAggregate, extractedAggregate)
	}
	for _, pair := range [][2]*Object{
		{fullAggregate.CandidateStats, extractedAggregate.CandidateStats},
		{fullAggregate.RejectionCounts, extractedAggregate.RejectionCounts},
		{fullAggregate.FailureKindCounts, extractedAggregate.FailureKindCounts},
		{fullAggregate.JudgeMethodCounts, extractedAggregate.JudgeMethodCounts},
		{fullAggregate.RootDiagnosis, extractedAggregate.RootDiagnosis},
	} {
		if string(mustJSON(pair[0])) != string(mustJSON(pair[1])) {
			t.Fatalf("aggregation differs:\n full=%s\n extracted=%s", mustJSON(pair[0]), mustJSON(pair[1]))
		}
	}
	if len(fullAggregate.WarningFlags) != len(extractedAggregate.WarningFlags) {
		t.Fatalf("warning flags differ: %v vs %v", fullAggregate.WarningFlags, extractedAggregate.WarningFlags)
	}
}
