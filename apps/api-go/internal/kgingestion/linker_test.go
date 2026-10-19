package kgingestion

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseEntityMentions(t *testing.T) {
	raw := json.RawMessage(`[
		{"name":" Acme ","type":" company ","confidence":0.9},
		{"name":"","type":"company","confidence":0.9},
		{"name":"Beta","type":"company","confidence":"0.9"},
		{"name":"Gamma","type":"company","confidence":1.5},
		"not an object"
	]`)
	mentions := parseEntityMentions(raw)
	if len(mentions) != 2 {
		t.Fatalf("mentions = %+v", mentions)
	}
	if mentions[0].Name != "Acme" || mentions[0].Type != "company" || mentions[0].Confidence != 0.9 {
		t.Fatalf("first = %+v", mentions[0])
	}
	// Mention confidence is not clamped; 1.5 survives the parser.
	if mentions[1].Confidence != 1.5 {
		t.Fatalf("second = %+v", mentions[1])
	}
}

func TestParseEntityMentionsParsesStoredJSONString(t *testing.T) {
	inner := `[{"name":"Acme","type":"company","confidence":0.9}]`
	encoded, err := json.Marshal(inner)
	if err != nil {
		t.Fatal(err)
	}
	if mentions := parseEntityMentions(encoded); len(mentions) != 1 {
		t.Fatalf("mentions = %+v", mentions)
	}
}

func TestParseDisambiguationContent(t *testing.T) {
	cases := []struct {
		content string
		want    string
		ok      bool
	}{
		{`{"entityId":"e1","confidence":0.9}`, "e1", true},
		{`{"entityId":null,"confidence":0.9}`, "", true},
		{`prefix {"entityId":"e2","confidence":0} suffix`, "e2", true},
		{`{"entityId":"e1","confidence":1.4}`, "", false},
		{`{"entityId":5,"confidence":0.9}`, "", false},
		{`{"confidence":0.9}`, "", false},
		{"", "", false},
	}
	for _, test := range cases {
		got, ok := parseDisambiguationContent(test.content)
		if ok != test.ok || got != test.want {
			t.Fatalf("content %q -> %q %v", test.content, got, ok)
		}
	}
}

func TestShouldDisambiguateMention(t *testing.T) {
	settings := Settings{EntityDisambiguationEnabled: true}
	cases := []struct {
		name       string
		settings   Settings
		context    string
		confidence float64
		candidates int
		want       bool
	}{
		{"enabled", settings, "context", 0.9, 2, true},
		{"disabled", Settings{}, "context", 0.9, 2, false},
		{"empty context", settings, "   ", 0.9, 2, false},
		{"below threshold", settings, "context", 0.84, 2, false},
		{"single candidate", settings, "context", 0.9, 1, false},
	}
	for _, test := range cases {
		if got := shouldDisambiguateMention(test.settings, test.context, test.confidence, test.candidates); got != test.want {
			t.Fatalf("%s = %v", test.name, got)
		}
	}
}

func TestShouldCreateEntity(t *testing.T) {
	cases := []struct {
		name       string
		confidence float64
		entityName string
		want       bool
	}{
		{"valid", 0.85, "Acme", true},
		{"low confidence", 0.84, "Acme", false},
		{"short name", 0.9, "A", false},
		{"long name", 0.9, strings.Repeat("x", 101), false},
		{"max length", 0.9, strings.Repeat("x", 100), true},
	}
	for _, test := range cases {
		if got := shouldCreateEntity(test.confidence, test.entityName); got != test.want {
			t.Fatalf("%s = %v", test.name, got)
		}
	}
}

func TestEntityAliasKeysMatchCompanySuffixVariants(t *testing.T) {
	keys := entityAliasKeys("Acme Corp", "company")
	if !keys["acme corp"] || !keys["acme"] {
		t.Fatalf("alias keys = %v", keys)
	}
	mentionKeys := []string{"acme"}
	if !intersectsSearchKeys(mentionKeys, keys) {
		t.Fatal("company suffix variant did not match")
	}
	if intersectsSearchKeys([]string{"other"}, keys) {
		t.Fatal("unrelated name matched")
	}
}

func TestEntityAliasKeysAreTypeScoped(t *testing.T) {
	company := entityAliasKeys("600519", "company")
	instrument := entityAliasKeys("600519", "instrument")
	if company["600519.sh"] {
		t.Fatalf("company keys unexpectedly contain ticker variants: %v", company)
	}
	if !instrument["600519.sh"] || !instrument["sh600519"] {
		t.Fatalf("instrument keys = %v", instrument)
	}
}
