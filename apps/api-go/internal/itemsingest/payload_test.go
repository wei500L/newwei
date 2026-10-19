package itemsingest

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeNewsPayloadDefaultsAndTruthiness(t *testing.T) {
	payload, err := NormalizeNewsPayload([]byte(`{
		"url": "  https://example.com/a  ",
		"language": "  ",
		"keywords": "not-an-array",
		"metadata": [1,2],
		"forceRefresh": "false",
		"unknown": true
	}`))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if payload.URL != "https://example.com/a" {
		t.Fatalf("url = %q", payload.URL)
	}
	if payload.Language != nil {
		t.Fatalf("blank language should be omitted")
	}
	if len(payload.Keywords) != 0 || len(payload.Tags) != 0 || len(payload.SummaryHints) != 0 {
		t.Fatalf("non-array lists should normalize to []: %+v", payload)
	}
	if string(payload.Metadata) != `{}` {
		t.Fatalf("non-object metadata = %s", payload.Metadata)
	}
	if !payload.ForceRefresh {
		t.Fatalf("forceRefresh string is truthy in JavaScript")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "unknown") {
		t.Fatalf("unknown root key leaked: %s", encoded)
	}
}

func TestNormalizeNewsPayloadFailures(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		message string
	}{
		{"null", `null`, "Expected object, received null"},
		{"array", `[]`, "Expected object, received array"},
		{"missing-url", `{}`, "Required"},
		{"blank-url", `{"url":"  "}`, "url is required"},
		{"non-string-element", `{"url":"https://x.test","tags":[1]}`, "Expected string, received number"},
		{"language-null", `{"url":"https://x.test","language":null}`, "Expected string, received null"},
		{"prefetched-null", `{"url":"https://x.test","prefetchedArticle":null}`, "Expected object, received null"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := NormalizeNewsPayload([]byte(test.raw))
			if err == nil || !strings.Contains(err.Error(), "Invalid payload: "+test.message) {
				t.Fatalf("err = %v, want Invalid payload: %s", err, test.message)
			}
		})
	}
}

func TestNormalizeNewsPayloadPreservesNullableSourceNameAndPrefetched(t *testing.T) {
	payload, err := NormalizeNewsPayload([]byte(`{
		"url":"https://example.com",
		"sourceName":null,
		"crawlOptions":{"depth":3},
		"prefetchedArticle":{"title":"  T  ","publishedAt":"2026-01-02T03:04:05Z"}
	}`))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if !payload.SourceNameIsNull || payload.SourceName != nil {
		t.Fatalf("sourceName null was not preserved")
	}
	encoded, _ := json.Marshal(payload)
	if !strings.Contains(string(encoded), `"sourceName":null`) {
		t.Fatalf("sourceName null missing from outbox JSON: %s", encoded)
	}
	if payload.Prefetched == nil || payload.Prefetched.Title == nil || *payload.Prefetched.Title != "T" {
		t.Fatalf("prefetched title = %+v", payload.Prefetched)
	}
	if payload.Prefetched.PublishedAt == nil || *payload.Prefetched.PublishedAt != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("publishedAt = %+v", payload.Prefetched.PublishedAt)
	}
}

func TestIsTruthyJSONMatchesUpdateBranch(t *testing.T) {
	for _, raw := range []string{`null`, `false`, `0`, `""`, ``} {
		if isTruthyJSON([]byte(raw)) {
			t.Fatalf("%q must be falsy", raw)
		}
	}
	for _, raw := range []string{`{}`, `[]`, `"x"`, `1`, `true`} {
		if !isTruthyJSON([]byte(raw)) {
			t.Fatalf("%q must be truthy", raw)
		}
	}
}

func TestDecodePayloadStringRejectsTrailingTokens(t *testing.T) {
	if _, err := DecodePayloadString(`1 2`); err == nil {
		t.Fatalf("trailing token was accepted")
	}
	encoded, err := DecodePayloadString(`{"a":1}`)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(encoded) != `{"a":1}` {
		t.Fatalf("encoded = %s", encoded)
	}
}

func TestComparableURLVariants(t *testing.T) {
	variants := buildComparableURLVariants("https://Example.com:443/a/?q=1#frag")
	if variants == nil {
		t.Fatalf("expected variants")
	}
	if variants.Full != "https://example.com/a?q=1" {
		t.Fatalf("full = %q", variants.Full)
	}
	if variants.Base != "https://example.com/a" {
		t.Fatalf("base = %q", variants.Base)
	}
	if len(variants.FullHash) != 64 {
		t.Fatalf("hash = %q", variants.FullHash)
	}
	if buildComparableURLVariants("mailto:x@example.com") != nil {
		t.Fatalf("non-http URL should be null")
	}
	if buildComparableURLVariants("not a url") != nil {
		t.Fatalf("invalid URL should be null")
	}
}
