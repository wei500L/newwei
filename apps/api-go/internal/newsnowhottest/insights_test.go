package newsnowhottest

import (
	"strings"
	"testing"
)

func TestParseClusterInsightDefaults(t *testing.T) {
	insights, ok := parseClusterInsightResponse(`{"clusters":[{"clusterId":"c1","theme":"主题","label":"标签"}]}`)
	if !ok {
		t.Fatal("parse failed")
	}
	if len(insights) != 1 {
		t.Fatalf("insights = %d", len(insights))
	}
	insight := insights[0]
	if insight.Topics == nil || len(insight.Topics) != 0 {
		t.Fatalf("topics default = %v", insight.Topics)
	}
	if insight.Entities == nil || len(insight.Entities) != 0 {
		t.Fatalf("entities default = %v", insight.Entities)
	}
	if insight.ContentKind != ContentUnknown || insight.BridgeEligibleSuggestion || insight.Confidence != 0.5 {
		t.Fatalf("defaults = %+v", insight)
	}
	if insight.Summary.Valid || insight.Reason.Valid {
		t.Fatalf("optional nulls = %+v %+v", insight.Summary, insight.Reason)
	}
}

func TestParseClusterInsightValuesAndFence(t *testing.T) {
	content := "这里是结果：\n```json\n" +
		`{"clusters":[{"clusterId":"c1","theme":"主题","label":"标签","summary":"摘要","reason":"","topics":["a"],"entities":[{"name":"实体","type":"person"},{"name":"组织"}],"contentKind":"discussion","bridgeEligibleSuggestion":true,"confidence":0.8}]}` +
		"\n```\n希望有帮助"
	insights, ok := parseClusterInsightResponse(content)
	if !ok || len(insights) != 1 {
		t.Fatalf("parse = %v %v", insights, ok)
	}
	insight := insights[0]
	if insight.Summary.Value != "摘要" || !insight.Reason.Valid || insight.Reason.Value != "" {
		t.Fatalf("summary/reason = %+v %+v", insight.Summary, insight.Reason)
	}
	if len(insight.Entities) != 2 || insight.Entities[1].Type.Valid {
		t.Fatalf("entities = %+v", insight.Entities)
	}
	if insight.ContentKind != ContentDiscussion || !insight.BridgeEligibleSuggestion || insight.Confidence != 0.8 {
		t.Fatalf("values = %+v", insight)
	}
}

func TestParseClusterInsightRejectsInvalid(t *testing.T) {
	base := `{"clusterId":"c1","theme":"主题","label":"标签"`
	cases := map[string]string{
		"null confidence":       `{"clusters":[` + base + `,"confidence":null}]}`,
		"unknown content kind":  `{"clusters":[` + base + `,"contentKind":"meme"}]}`,
		"too many topics":       `{"clusters":[` + base + `,"topics":["a","b","c","d","e","f","g","h","i"]}]}`,
		"empty cluster id":      `{"clusters":[{"clusterId":"","theme":"t","label":"l"}]}`,
		"too long theme":        `{"clusters":[{"clusterId":"c","theme":"` + strings.Repeat("a", 81) + `","label":"l"}]}`,
		"topics null":           `{"clusters":[` + base + `,"topics":null}]}`,
		"clusters null":         `{"clusters":null}`,
		"clusters not array":    `{"clusters":{}}`,
		"invalid confidence":    `{"clusters":[` + base + `,"confidence":1.2}]}`,
		"invalid entity object": `{"clusters":[` + base + `,"entities":[{"type":"x"}]}]}`,
	}
	for name, content := range cases {
		if _, ok := parseClusterInsightResponse(content); ok {
			t.Fatalf("%s: expected rejection", name)
		}
	}
	tooMany := make([]string, 0, 17)
	for index := 0; index < 17; index++ {
		tooMany = append(tooMany, `{"clusterId":"c`+string(rune('a'+index))+`","theme":"t","label":"l"}`)
	}
	if _, ok := parseClusterInsightResponse(`{"clusters":[` + strings.Join(tooMany, ",") + `]}`); ok {
		t.Fatal("17 clusters must be rejected")
	}
	if insights, ok := parseClusterInsightResponse(`{"clusters":[]}`); !ok || len(insights) != 0 {
		t.Fatalf("empty clusters = %v %v", insights, ok)
	}
	if _, ok := parseClusterInsightResponse("not json"); ok {
		t.Fatal("plain text must be rejected")
	}
}

func TestParseClusterInsightDeduplicates(t *testing.T) {
	content := `{"clusters":[` +
		`{"clusterId":"c1","theme":"first","label":"first"},` +
		`{"clusterId":"c2","theme":"other","label":"other"},` +
		`{"clusterId":"c1","theme":"last","label":"last"}]}`
	insights, ok := parseClusterInsightResponse(content)
	if !ok {
		t.Fatal("parse failed")
	}
	if len(insights) != 2 {
		t.Fatalf("insights = %d", len(insights))
	}
	if insights[0].ClusterID != "c1" || insights[0].Theme != "last" {
		t.Fatalf("dedupe = %+v", insights)
	}
	if insights[1].ClusterID != "c2" {
		t.Fatalf("order = %+v", insights)
	}
}

func TestExtractFirstJSONHandlesStringsAndEscapes(t *testing.T) {
	value, ok := extractFirstJSON(`prefix {"a":"} not the end","b":{"c":1}} suffix`)
	if !ok {
		t.Fatal("extract failed")
	}
	if value != `{"a":"} not the end","b":{"c":1}}` {
		t.Fatalf("extracted = %q", value)
	}
	if _, ok := extractFirstJSON("no json here"); ok {
		t.Fatal("plain text must not extract")
	}
}
