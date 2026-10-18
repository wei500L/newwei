package knowledgereview

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeRelationTypeKeepsSynonymsAndFoldsSeparators(t *testing.T) {
	cases := map[string]string{
		"belongs_to_industry": "belongs_to_industry",
		"Belong To Industry":  "belongs_to_industry",
		"belong-to-industry":  "belongs_to_industry",
		"supplier_of":         "supplies",
		"SUPPLIES":            "supplies",
		"buys_from":           "customer_of",
		"competitor of":       "competes_with",
		"employed_by":         "holds_position",
		"works-for":           "holds_position",
		"affects_industry":    "affects_industry",
		"affects company":     "affects_company",
		"upstream_of":         "upstream_of",
		"downstream_of":       "downstream_of",
		"ticker_of":           "has_ticker",
	}
	for input, want := range cases {
		got, ok := normalizeRelationType(input)
		if !ok || got != want {
			t.Fatalf("normalizeRelationType(%q) = %q,%v want %q", input, got, ok, want)
		}
	}

	for _, unknown := range []string{"", "   ", "related_to", "owns", "supplies-", "-supplies"} {
		if got, ok := normalizeRelationType(unknown); ok {
			t.Fatalf("unknown relation %q accepted as %q", unknown, got)
		}
	}
}

func TestNormalizeEntityTypeUsesContainsOrder(t *testing.T) {
	cases := map[string]string{
		"":                     "organization",
		"Person":               "person",
		"public figure/people": "person",
		"regulation":           "policy",
		"industry-sector":      "industry",
		"commodity":            "commodity",
		"stock":                "instrument",
		"ETF":                  "instrument",
		"public company":       "company",
		"institution":          "organization",
		"mystery":              "organization",
	}
	for input, want := range cases {
		if got := normalizeEntityType(input); got != want {
			t.Fatalf("normalizeEntityType(%q) = %q want %q", input, got, want)
		}
	}
}

func TestParseReviewedRelationNormalizesAndCapsAliases(t *testing.T) {
	aliases := make([]any, 0, 25)
	for i := 0; i < 25; i++ {
		aliases = append(aliases, " alias ")
	}
	aliases = append(aliases, 42)
	raw, err := json.Marshal(map[string]any{
		"subject":   map[string]any{"name": "  Acme   Corp ", "type": "Company", "aliases": aliases},
		"object":    map[string]any{"name": "Widgets", "type": "industry"},
		"predicate": " Supplier Of ",
		"properties": map[string]any{
			"note": "kept",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	relation, ok := parseReviewedRelation(raw)
	if !ok {
		t.Fatal("valid relation rejected")
	}
	if relation.Subject.Name != "Acme Corp" {
		t.Fatalf("subject name = %q", relation.Subject.Name)
	}
	if relation.Predicate != "supplies" {
		t.Fatalf("predicate = %q", relation.Predicate)
	}
	if len(relation.Subject.Aliases) != 20 {
		t.Fatalf("aliases = %d want 20", len(relation.Subject.Aliases))
	}
	if relation.Subject.Aliases[0] != "alias" {
		t.Fatalf("alias trimmed = %q", relation.Subject.Aliases[0])
	}
	properties := map[string]any{}
	if err := json.Unmarshal(relation.Properties, &properties); err != nil {
		t.Fatal(err)
	}
	if properties["note"] != "kept" {
		t.Fatalf("relation properties = %v", properties)
	}
}

func TestParseReviewedRelationRejectsInvalidShapes(t *testing.T) {
	cases := []string{
		`null`,
		`[]`,
		`"text"`,
		`{"subject":{"name":"a","type":"company"}}`,
		`{"subject":{"name":"","type":"company"},"object":{"name":"b","type":"company"},"predicate":"supplies"}`,
		`{"subject":{"name":"a"},"object":{"name":"b","type":"company"},"predicate":"supplies"}`,
		`{"subject":{"name":"a","type":"company"},"object":{"name":"b","type":"company"},"predicate":"unknown"}`,
		`{"subject":{"name":"a","type":"company"},"object":{"name":"b","type":"company"},"predicate":"supplies","properties":[1,2]}`,
	}
	for _, raw := range cases {
		if _, ok := parseReviewedRelation(json.RawMessage(raw)); ok {
			t.Fatalf("invalid relation accepted: %s", raw)
		}
	}
}

func TestParseReviewInputEnforcesWhitelistAndNoteLength(t *testing.T) {
	if _, err := parseReviewInput(map[string]any{"input": map[string]any{
		"evidenceId": "e1",
		"status":     "Approved",
	}}); err == nil || !strings.Contains(err.Error(), "status must be one of the following values") {
		t.Fatalf("status whitelist error = %v", err)
	}

	empty := ""
	noteTooLong := strings.Repeat("a", 501)
	cases := []struct {
		note    any
		wantErr bool
	}{
		{note: nil, wantErr: false},
		{note: empty, wantErr: false},
		{note: strings.Repeat("a", 500), wantErr: false},
		{note: noteTooLong, wantErr: true},
		// validator.js isLength counts an astral character as one and drops the
		// emoji variation selectors, so 251 astral runes are 251.
		{note: strings.Repeat("😀", 251), wantErr: false},
		{note: strings.Repeat("😀", 500), wantErr: false},
		{note: strings.Repeat("😀", 501), wantErr: true},
		// 501 runes with one variation selector count as 500.
		{note: strings.Repeat("a", 500) + "\uFE0F", wantErr: false},
		{note: strings.Repeat("a", 501) + "\uFE0F", wantErr: true},
	}
	for _, testCase := range cases {
		input := map[string]any{"evidenceId": "e1", "status": "approved"}
		if testCase.note != nil {
			input["note"] = testCase.note
		}
		parsed, err := parseReviewInput(map[string]any{"input": input})
		if testCase.wantErr {
			if err == nil || !strings.Contains(err.Error(), "note must be shorter than or equal to 500 characters") {
				t.Fatalf("note %v error = %v", testCase.note, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("note %v rejected: %v", testCase.note, err)
		}
		if text, ok := testCase.note.(string); ok {
			if parsed.Note == nil || *parsed.Note != text {
				t.Fatalf("note not preserved: %v", parsed.Note)
			}
		} else if parsed.Note != nil {
			t.Fatalf("absent note = %v", *parsed.Note)
		}
	}
}

func TestBuildReviewDocumentKeepsNullSiblings(t *testing.T) {
	document, err := buildReviewDocument(reviewInput{
		EvidenceID: "e1",
		Status:     reviewStatusRejected,
		Note:       nil,
	}, "user-1", "2026-10-18T12:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(document, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"status", "note", "correctedRelation", "reviewerId", "reviewedAt"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("review document misses %q: %s", key, document)
		}
	}
	if string(fields["note"]) != "null" || string(fields["correctedRelation"]) != "null" {
		t.Fatalf("absent fields must be null: %s", document)
	}
	if string(fields["reviewerId"]) != `"user-1"` {
		t.Fatalf("reviewerId = %s", fields["reviewerId"])
	}
}
