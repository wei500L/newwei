package crawlstrategyruns

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// These tests exercise the graph semantics and the node executors that do not
// need MySQL or crawl4ai: ordering, input de-duplication, filters, scorers, the
// branch/budget/persist trio and the fallback activation switch. The DB writes
// and the preview merge are covered by the integration test.

func node(id, nodeType, label string, config string) crawlworkflow.WorkflowNode {
	return crawlworkflow.WorkflowNode{ID: id, Type: nodeType, Label: label, Config: json.RawMessage(config)}
}

func candidate(url string) *Candidate {
	return &Candidate{ID: "candidate:" + url, URL: url, Status: CandidateStatusActive, Metadata: json.RawMessage("{}"), Trace: []Trace{}}
}

func TestTopologicalSortFollowsDefinitionOrderAndFallsBackOnCycle(t *testing.T) {
	definition := crawlworkflow.WorkflowDefinition{
		Nodes: []crawlworkflow.WorkflowNode{
			node("seed", NodeTypeSeedDiscovery, "Seed", `{}`),
			node("filter", NodeTypeURLFilter, "Filter", `{}`),
			node("persist", NodeTypePersistResult, "Persist", `{}`),
		},
		Edges: []crawlworkflow.WorkflowEdge{
			{ID: "e1", Source: "seed", Target: "filter"},
			{ID: "e2", Source: "filter", Target: "persist"},
		},
	}
	order := topologicalSort(definition)
	if strings.Join(order, ",") != "seed,filter,persist" {
		t.Fatalf("order = %v", order)
	}

	cyclic := crawlworkflow.WorkflowDefinition{
		Nodes: []crawlworkflow.WorkflowNode{
			node("a", NodeTypeURLFilter, "A", `{}`),
			node("b", NodeTypeURLFilter, "B", `{}`),
		},
		Edges: []crawlworkflow.WorkflowEdge{
			{ID: "e1", Source: "a", Target: "b"},
			{ID: "e2", Source: "b", Target: "a"},
		},
	}
	if got := strings.Join(topologicalSort(cyclic), ","); got != "a,b" {
		t.Fatalf("cycle fallback = %q", got)
	}
}

func TestCollectInputCandidatesUsesHandleThenDefaultAndDedupes(t *testing.T) {
	one := candidate("https://a.example.com/1")
	two := candidate("https://a.example.com/2")
	three := candidate("https://a.example.com/3")

	outputs := map[string]nodeOutputs{}
	branch := newNodeOutputs()
	branch.set("pass", []*Candidate{one})
	branch.set("fail", []*Candidate{two})
	outputs["branch"] = branch

	handle := "fail"
	edges := []crawlworkflow.WorkflowEdge{
		{ID: "e1", Source: "branch", Target: "next", SourceHandle: &handle},
		{ID: "e2", Source: "branch", Target: "next"},
		{ID: "e3", Source: "missing", Target: "next"},
	}
	collected := collectInputCandidates(edges, outputs)
	// The fail handle matches one edge; the second edge falls back to default
	// (absent on the branch output) and the third source has no output at all,
	// so the de-duplicated result holds exactly the one candidate.
	if len(collected) != 1 {
		t.Fatalf("collected = %d (%+v)", len(collected), collected)
	}
	if collected[0].URL != two.URL {
		t.Fatalf("collected = %+v", collected)
	}

	// A handle that is absent falls back to default.
	other := newNodeOutputs()
	other.set("default", []*Candidate{three})
	outputs["other"] = other
	wrong := "pass"
	fallback := collectInputCandidates([]crawlworkflow.WorkflowEdge{
		{ID: "e4", Source: "other", Target: "next", SourceHandle: &wrong},
	}, outputs)
	if len(fallback) != 1 || fallback[0].URL != three.URL {
		t.Fatalf("fallback = %+v", fallback)
	}
}

func TestDedupeCandidatesKeepsFirstPositionAndLastValue(t *testing.T) {
	first := candidate("https://a.example.com/1")
	first.Score = floatPointer(0.1)
	second := candidate("https://a.example.com/2")
	firstAgain := candidate("https://a.example.com/1")
	firstAgain.Score = floatPointer(0.9)

	deduped := dedupeCandidates([]*Candidate{first, second, firstAgain})
	if len(deduped) != 2 {
		t.Fatalf("deduped = %d", len(deduped))
	}
	if deduped[0].URL != first.URL || deduped[1].URL != second.URL {
		t.Fatalf("order = %+v", deduped)
	}
	if deduped[0].Score == nil || *deduped[0].Score != 0.9 {
		t.Fatalf("last value wins: %v", deduped[0].Score)
	}
}

func TestExecuteURLFilterReasons(t *testing.T) {
	config := `{
	  "includePatterns": ["*2026*"],
	  "excludePatterns": ["*/excluded/*"],
	  "blockedDomains": ["blocked.example.com"],
	  "allowedHosts": ["a.example.com"],
	  "denyKeywords": ["podcast"]
	}`
	n := node("url-filter", NodeTypeURLFilter, "URL Filter", config)
	keep := candidate("https://a.example.com/2026/10/19/story")
	excluded := candidate("https://a.example.com/excluded/x")
	blocked := candidate("https://blocked.example.com/x")
	outOfScope := candidate("https://b.example.com/x")
	denied := candidate("https://a.example.com/podcast/x")
	includeMiss := candidate("https://a.example.com/other")

	result := executeURLFilter(n, mustRawObject(config), []*Candidate{keep, excluded, blocked, outOfScope, denied, includeMiss})
	accepted, _ := result.outputs.get("default")
	if len(accepted) != 1 || accepted[0].URL != keep.URL {
		t.Fatalf("accepted = %+v", accepted)
	}
	wantReasons := map[string]string{
		excluded.URL:    "exclude_pattern",
		blocked.URL:     "blocked_domain",
		outOfScope.URL:  "host_out_of_scope",
		denied.URL:      "deny_keyword",
		includeMiss.URL: "include_miss",
	}
	rejected, _ := result.outputs.get("rejected")
	if len(rejected) != len(wantReasons) {
		t.Fatalf("rejected = %d", len(rejected))
	}
	for _, entry := range rejected {
		if entry.RejectedReason == nil || *entry.RejectedReason != wantReasons[entry.URL] {
			t.Errorf("%s rejected as %v, want %q", entry.URL, entry.RejectedReason, wantReasons[entry.URL])
		}
		if entry.RejectedByNodeID == nil || *entry.RejectedByNodeID != "url-filter" {
			t.Errorf("%s rejectedBy = %v", entry.URL, entry.RejectedByNodeID)
		}
		if len(entry.Trace) != 1 || entry.Trace[0].Action != TraceActionFiltered {
			t.Errorf("%s trace = %+v", entry.URL, entry.Trace)
		}
	}
}

func TestExecuteBudgetControlTrimsAndRejectsLowScores(t *testing.T) {
	config := `{"keepTopK": 2, "minScore": 0.5}`
	n := node("budget", NodeTypeBudgetControl, "Budget", config)
	high := candidate("https://a.example.com/1")
	high.Score = floatPointer(1.2)
	middle := candidate("https://a.example.com/2")
	middle.Score = floatPointer(0.8)
	low := candidate("https://a.example.com/3")
	low.Score = floatPointer(0.1)

	result := executeBudgetControl(n, mustRawObject(config), []*Candidate{low, middle, high})
	accepted, _ := result.outputs.get("default")
	if len(accepted) != 2 {
		t.Fatalf("accepted = %d", len(accepted))
	}
	if accepted[0].URL != high.URL || accepted[1].URL != middle.URL {
		t.Fatalf("accepted order = %+v", accepted)
	}
	if low.RejectedReason == nil || *low.RejectedReason != "min_score" {
		t.Fatalf("low reason = %v", low.RejectedReason)
	}

	budgetOnly := `{"keepTopK": 1, "minScore": 0}`
	over := candidate("https://a.example.com/9")
	over.Score = floatPointer(0.9)
	under := candidate("https://a.example.com/8")
	under.Score = floatPointer(0.8)
	result = executeBudgetControl(n, mustRawObject(budgetOnly), []*Candidate{over, under})
	accepted, _ = result.outputs.get("default")
	if len(accepted) != 1 || accepted[0].URL != over.URL {
		t.Fatalf("budget accepted = %+v", accepted)
	}
	if under.RejectedReason == nil || *under.RejectedReason != "budget_trim" {
		t.Fatalf("under reason = %v", under.RejectedReason)
	}
}

func TestExecutePersistResultSelectsTopKAndTrims(t *testing.T) {
	config := `{"selectTopK": 2}`
	n := node("persist", NodeTypePersistResult, "Persist", config)
	first := candidate("https://a.example.com/1")
	first.Score = floatPointer(1)
	second := candidate("https://a.example.com/2")
	second.Score = floatPointer(0.5)
	third := candidate("https://a.example.com/3")
	third.Score = floatPointer(0.1)

	result := executePersistResult(n, mustRawObject(config), []*Candidate{third, first, second})
	selected, _ := result.outputs.get("default")
	if len(selected) != 2 {
		t.Fatalf("selected = %d", len(selected))
	}
	if selected[0].URL != first.URL || selected[1].URL != second.URL {
		t.Fatalf("selected order = %+v", selected)
	}
	if selected[0].Status != CandidateStatusSelected {
		t.Errorf("status = %q", selected[0].Status)
	}
	if third.Status != CandidateStatusRejected || third.RejectedReason == nil || *third.RejectedReason != "persist_trim" {
		t.Fatalf("third = %+v", third)
	}
	if third.RejectedByNodeID == nil || *third.RejectedByNodeID != "persist" {
		t.Errorf("rejectedBy = %v", third.RejectedByNodeID)
	}
}

func TestExecuteBranchOperators(t *testing.T) {
	article := candidate("https://a.example.com/article/1")
	article.PageType = stringPointer(PageTypeArticle)
	list := candidate("https://a.example.com/list")
	list.PageType = stringPointer(PageTypeList)

	config := `{"field":"pageType","operator":"equals","value":"article"}`
	result := executeBranch(node("branch", NodeTypeBranch, "Branch", config), mustRawObject(config), []*Candidate{article, list})
	pass, _ := result.outputs.get("pass")
	fail, _ := result.outputs.get("fail")
	if len(pass) != 1 || pass[0] != article || len(fail) != 1 || fail[0] != list {
		t.Fatalf("pass=%d fail=%d", len(pass), len(fail))
	}

	scored := candidate("https://a.example.com/x")
	scored.Score = floatPointer(0.6)
	gte := `{"field":"score","operator":"gte","value":0.5}`
	result = executeBranch(node("branch", NodeTypeBranch, "Branch", gte), mustRawObject(gte), []*Candidate{scored})
	pass, _ = result.outputs.get("pass")
	if len(pass) != 1 {
		t.Fatalf("gte pass = %d", len(pass))
	}

	contains := `{"field":"url","operator":"contains","value":"/x"}`
	result = executeBranch(node("branch", NodeTypeBranch, "Branch", contains), mustRawObject(contains), []*Candidate{scored})
	pass, _ = result.outputs.get("pass")
	if len(pass) != 1 {
		t.Fatalf("contains pass = %d", len(pass))
	}

	// A missing field compares as "" against the value; a numeric operator on a
	// missing field uses the -Infinity / +Infinity fallback.
	missing := `{"field":"pageType","operator":"equals","value":"article"}`
	result = executeBranch(node("branch", NodeTypeBranch, "Branch", missing), mustRawObject(missing), []*Candidate{candidate("https://a.example.com/none")})
	fail, _ = result.outputs.get("fail")
	if len(fail) != 1 {
		t.Fatalf("missing field must miss the branch")
	}
}

func TestExecutePageTypeClassifierScorerAndFreshness(t *testing.T) {
	run := &runtimeContext{config: EffectiveProfileConfig{}}
	recentPath := time.Now().UTC().Format("2006/01/02")
	dated := candidate("https://a.example.com/" + recentPath + "/some-long-article-slug")
	dated.PublishedAt = stringPointer("2026-10-19T08:00:00.000Z")
	hub := candidate("https://a.example.com/section/world")

	classifier := node("page-type-classifier", NodeTypePageTypeClassifier, "Page Type", `{}`)
	result := executePageTypeClassifier(run, classifier, map[string]json.RawMessage{}, []*Candidate{dated, hub})
	out, _ := result.outputs.get("default")
	if len(out) != 2 {
		t.Fatalf("out = %d", len(out))
	}
	if out[0].PageType == nil || *out[0].PageType != PageTypeArticle {
		t.Errorf("dated pageType = %v", out[0].PageType)
	}
	if out[1].PageType == nil || *out[1].PageType == PageTypeArticle {
		t.Errorf("hub pageType = %v", out[1].PageType)
	}
	if len(out[0].Trace) != 1 || out[0].Trace[0].Action != TraceActionClassified {
		t.Fatalf("trace = %+v", out[0].Trace)
	}

	scorer := node("url-scorer", NodeTypeURLScorer, "URL Score", `{"keywordBoosts":["world"]}`)
	result = executeURLScorer(run, scorer, mustRawObject(`{"keywordBoosts":["world"]}`), []*Candidate{hub})
	scored, _ := result.outputs.get("default")
	if scored[0].Score == nil || *scored[0].Score <= 0 {
		t.Fatalf("score = %v", scored[0].Score)
	}
	if len(scored[0].Trace) != 2 || scored[0].Trace[1].Action != TraceActionScored {
		t.Fatalf("trace = %+v", scored[0].Trace)
	}

	freshness := node("freshness-scorer", NodeTypeFreshnessScorer, "Freshness", `{"recentHours":24,"weekHours":168,"monthHours":720}`)
	result = executeFreshnessScorer(run, freshness, mustRawObject(`{"recentHours":24,"weekHours":168,"monthHours":720}`), []*Candidate{dated})
	scored, _ = result.outputs.get("default")
	if scored[0].FreshnessScore == nil || *scored[0].FreshnessScore != 1 {
		t.Fatalf("freshness = %v", scored[0].FreshnessScore)
	}
}

func TestExecuteFallbackStrategySkipsWhenInputPresent(t *testing.T) {
	run := &runtimeContext{seedURL: "https://a.example.com/"}
	config := `{"activateWhen":"empty","mode":"list"}`
	n := node("fallback", NodeTypeFallbackStrategy, "Fallback", config)
	input := []*Candidate{candidate("https://a.example.com/1")}
	result, err := (&Service{}).executeFallbackStrategy(nil, run, n, mustRawObject(config), input, map[string]*Candidate{}, &[]string{})
	if err != nil {
		t.Fatalf("executeFallbackStrategy: %v", err)
	}
	out, _ := result.outputs.get("default")
	if len(out) != 1 || out[0] != input[0] {
		t.Fatalf("out = %+v", out)
	}
	if len(run.systemEvents) != 0 {
		t.Fatalf("system events = %+v", run.systemEvents)
	}
}

func TestInferPageTypeScoreAndFreshnessHeuristics(t *testing.T) {
	config := EffectiveProfileConfig{
		URLPatterns: map[string][]string{
			"article": {"*/article/*"},
			"exclude": {"*/about*"},
		},
		PriorityKeywords: []string{"breaking"},
		DenyKeywords:     []string{"podcast"},
	}
	cases := []struct {
		url      string
		expected string
	}{
		{"https://a.example.com/article/one", PageTypeArticle},
		{"https://a.example.com/2026/10/19/slug", PageTypeArticle},
		{"https://a.example.com/section/world", PageTypeCategory},
		{"https://a.example.com/page/2", PageTypeCategory},
	}
	for _, entry := range cases {
		if got := inferPageType(entry.url, PageTypeHome, config, nil); got != entry.expected {
			t.Errorf("inferPageType(%s) = %s, want %s", entry.url, got, entry.expected)
		}
	}

	score := scoreCandidate("https://a.example.com/article/one", PageTypeArticle, config, nil, nil)
	if score <= 0.35 {
		t.Errorf("score = %v (a configured article pattern must add the scope bonus)", score)
	}
	if excluded := scoreCandidate("https://a.example.com/about", PageTypeArticle, config, nil, nil); excluded >= score {
		t.Errorf("excluded score = %v, article score = %v", excluded, score)
	}
	recentURL := "https://a.example.com/" + time.Now().UTC().Format("2006/01/02") + "/x"
	if fresh := estimateFreshness(recentURL, nil); fresh != 1 {
		t.Errorf("fresh = %v", fresh)
	}
	if stale := estimateFreshness("https://a.example.com/2001/01/01/x", nil); stale != 0.1 {
		t.Errorf("stale = %v", stale)
	}
	if none := estimateFreshness("https://a.example.com/x", nil); none != 0 {
		t.Errorf("no-date freshness = %v", none)
	}
}

func TestCandidateKeyAndSnapshotContracts(t *testing.T) {
	plain := candidate("https://a.example.com/1")
	key := candidateKeyOf(*plain)
	if len(key) != 64 {
		t.Fatalf("sha256 key = %q", key)
	}
	withKey := candidate("https://a.example.com/2")
	withKey.Metadata = json.RawMessage(`{"candidateKey":"  custom-key  "}`)
	if got := candidateKeyOf(*withKey); got != "custom-key" {
		t.Fatalf("custom key = %q", got)
	}
	longKey := candidate("https://a.example.com/3")
	longKey.Metadata = json.RawMessage(`{"candidateKey":"` + strings.Repeat("x", 250) + `"}`)
	if got := candidateKeyOf(*longKey); len(got) != 191 {
		t.Fatalf("long key length = %d", len(got))
	}

	plain.PageType = stringPointer("article")
	plain.Score = floatPointer(0.5)
	snapshot := string(snapshotOf(plain))
	for _, expected := range []string{`"url":"https://a.example.com/1"`, `"pageType":"article"`, `"score":0.5`, `"status":"active"`} {
		if !strings.Contains(snapshot, expected) {
			t.Errorf("snapshot %s missing %s", snapshot, expected)
		}
	}
	if !strings.Contains(snapshot, `"freshnessScore":null`) || !strings.Contains(snapshot, `"rejectedReason":null`) {
		t.Errorf("snapshot must keep the null fields: %s", snapshot)
	}
}

func TestTraceDetailsMergeRejectedReason(t *testing.T) {
	reason := "min_score"
	details := traceDetails(Trace{Details: json.RawMessage(`{"rank":1}`), RejectedReason: &reason})
	decoded := map[string]any{}
	if err := json.Unmarshal(details, &decoded); err != nil {
		t.Fatalf("details: %v", err)
	}
	if decoded["rejectedReason"] != "min_score" {
		t.Errorf("rejectedReason = %v", decoded["rejectedReason"])
	}
	if decoded["rank"] != float64(1) {
		t.Errorf("rank = %v", decoded["rank"])
	}
	if got := string(traceDetails(Trace{})); got != "{}" {
		t.Errorf("empty details = %s", got)
	}
}

func mustRawObject(config string) map[string]json.RawMessage {
	fields, ok := rawObject(json.RawMessage(config))
	if !ok {
		panic("invalid raw object in test: " + config)
	}
	return fields
}

func floatPointer(value float64) *float64 { return &value }
