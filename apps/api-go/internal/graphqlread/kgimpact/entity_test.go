package kgimpact

import (
	"testing"
)

func TestParseTicker(t *testing.T) {
	cases := []struct {
		input    string
		ok       bool
		code     string
		exchange string
	}{
		{"600519", true, "600519", ""},
		{"600519.SH", true, "600519", "SH"},
		{"SH600519", true, "600519", "SH"},
		{"sz000001", true, "000001", "SZ"},
		{"AAPL", false, "", ""},
		{"", false, "", ""},
	}
	for _, testCase := range cases {
		parsed, ok := parseTicker(testCase.input)
		if ok != testCase.ok {
			t.Fatalf("parseTicker(%q) ok = %v, want %v", testCase.input, ok, testCase.ok)
		}
		if ok && (parsed.code != testCase.code || parsed.exchange != testCase.exchange) {
			t.Fatalf("parseTicker(%q) = %+v", testCase.input, parsed)
		}
	}
}

func TestBuildTickerAliases(t *testing.T) {
	got := buildTickerAliases("600519")
	want := []string{"600519", "600519.SH", "SH600519", "600519.SZ", "SZ600519", "600519.BJ", "BJ600519"}
	if len(got) != len(want) {
		t.Fatalf("aliases = %v", got)
	}
	for index, alias := range want {
		if got[index] != alias {
			t.Fatalf("aliases[%d] = %q, want %q", index, got[index], alias)
		}
	}
}

func TestBuildCompanyAliasCandidates(t *testing.T) {
	got := buildCompanyAliasCandidates("贵州茅台股份有限公司")
	if len(got) != 2 || got[0] != "贵州茅台股份有限公司" || got[1] != "贵州茅台" {
		t.Fatalf("aliases = %v", got)
	}
	withBrackets := buildCompanyAliasCandidates("贵州茅台（集团）股份有限公司")
	hasCollapsed := false
	for _, alias := range withBrackets {
		if alias == "贵州茅台 股份有限公司" {
			hasCollapsed = true
		}
	}
	if !hasCollapsed {
		t.Fatalf("bracket stripping missing: %v", withBrackets)
	}
}

func TestNormalizeSearchKeysTicker(t *testing.T) {
	keys := normalizeSearchKeys("600519.SH")
	expected := map[string]bool{"600519": true, "600519.sh": true, "sh600519": true}
	if len(keys) != len(expected) {
		t.Fatalf("keys = %v", keys)
	}
	for _, key := range keys {
		if !expected[key] {
			t.Fatalf("unexpected key %q in %v", key, keys)
		}
	}
	if normalizeSearchKeys("") != nil {
		t.Fatalf("empty input should yield no keys")
	}
}

func TestNormalizeEntityCategories(t *testing.T) {
	got := normalizeEntityCategories([]string{"stock", "person", "person", "bogus"})
	if len(got) != 2 || got[0] != "person" || got[1] != "stock" {
		t.Fatalf("categories = %v", got)
	}
	fallback := normalizeEntityCategories(nil)
	want := []string{"commodity", "organization", "person", "stock"}
	if len(fallback) != len(want) {
		t.Fatalf("fallback = %v", fallback)
	}
	for index, name := range want {
		if fallback[index] != name {
			t.Fatalf("fallback[%d] = %q, want %q", index, fallback[index], name)
		}
	}
}

func TestBuildGraphDataCoOccurrenceAndCorrelation(t *testing.T) {
	coOccurrences := []coOccurrenceRecord{
		{EntityA: "Acme", EntityB: "Beta", TypeA: "company", TypeB: "company", Count: 3},
	}
	correlations := []correlationResult{
		{entity: "Acme", entityType: "organization", instrument: "Gold", instrumentType: "commodity", correlation: 0.8, pValue: 0.01},
	}
	data := buildGraphData(coOccurrences, correlations, normalizeEntityCategories(nil), 100)

	if len(data.Nodes) != 3 {
		t.Fatalf("nodes = %+v", data.Nodes)
	}
	byID := map[string]entityNode{}
	for _, node := range data.Nodes {
		byID[node.ID] = node
	}
	if byID["Acme"].Value != 11 {
		t.Fatalf("Acme value = %v, want 11", byID["Acme"].Value)
	}
	if byID["Acme"].Category != "organization" {
		t.Fatalf("Acme category = %q", byID["Acme"].Category)
	}
	if byID["Gold"].Value != 8 || byID["Gold"].Category != "commodity" {
		t.Fatalf("Gold node = %+v", byID["Gold"])
	}
	if len(data.Links) != 2 {
		t.Fatalf("links = %+v", data.Links)
	}
	if data.Links[0].LinkType != "co-occurrence" || data.Links[0].Value != 3 {
		t.Fatalf("link[0] = %+v", data.Links[0])
	}
	if data.Links[1].LinkType != "correlation" || data.Links[1].Value != 0.8 {
		t.Fatalf("link[1] = %+v", data.Links[1])
	}
}

func TestBuildGraphDataTrimsByValue(t *testing.T) {
	coOccurrences := []coOccurrenceRecord{
		{EntityA: "A", EntityB: "B", TypeA: "company", TypeB: "company", Count: 1},
		{EntityA: "C", EntityB: "D", TypeA: "company", TypeB: "company", Count: 2},
		{EntityA: "E", EntityB: "F", TypeA: "company", TypeB: "company", Count: 3},
	}
	data := buildGraphData(coOccurrences, nil, normalizeEntityCategories(nil), 2)
	if len(data.Nodes) != 2 {
		t.Fatalf("nodes = %+v", data.Nodes)
	}
	names := map[string]bool{data.Nodes[0].ID: true, data.Nodes[1].ID: true}
	if !names["E"] || !names["F"] {
		t.Fatalf("trim kept %v", names)
	}
	if len(data.Links) != 0 {
		t.Fatalf("links should be filtered after trim: %+v", data.Links)
	}
}

func TestSettingsNormalizationEmptyStringDifference(t *testing.T) {
	kg := normalizeKnowledgeGraphSettings(map[string]any{"cacheTtlSeconds": ""}, kgFallbackSettings())
	if kg.CacheTTLSeconds != 60 {
		t.Fatalf("knowledge graph cacheTtlSeconds = %d, want 60", kg.CacheTTLSeconds)
	}
	eig := normalizeEigSettings(map[string]any{"cacheTtlSeconds": ""}, eigFallbackSettings())
	if eig.CacheTTLSeconds != 0 {
		t.Fatalf("entity impact graph cacheTtlSeconds = %d, want 0", eig.CacheTTLSeconds)
	}
}

func TestBuildImpactCacheKeyMatchesNest(t *testing.T) {
	executive := buildImpactCacheKey("org1", map[string]string{
		"scenario":      "executive_change",
		"seedName":      "acme",
		"maxCandidates": "50",
	})
	if executive != "knowledgeGraph:impact:org1:maxCandidates=50:scenario=executive_change:seedName=acme" {
		t.Fatalf("executive key = %q", executive)
	}
	policy := buildImpactCacheKey("org1", map[string]string{
		"scenario":           "policy_event",
		"seedName":           "rate cut",
		"maxCandidates":      "50",
		"includeLprSnapshot": "false",
	})
	if policy != "knowledgeGraph:impact:org1:includeLprSnapshot=false:maxCandidates=50:scenario=policy_event:seedName=rate cut" {
		t.Fatalf("policy key = %q", policy)
	}
}
