package crawlmetadata

import (
	"strconv"
	"strings"
	"testing"
)

// itoa keeps the generated-HTML tests readable.
func itoa(value int) string { return strconv.Itoa(value) }

const sampleHTML = `<html><head>
<title>  First Title  </title>
<title>Second Title</title>
<meta name="description" content="desc">
<meta property="og:title" content="OG Title">
<meta name="twitter:card" content="summary">
<meta name="keywords" content=" a, b ,, c ">
<meta name="author" content="Alice">
<meta property="author" content="Bob">
<meta name="description" content="second desc">
<meta name="empty" content="   ">
<meta property="og:image" content="https://example.com/i.png">
<script type="application/ld+json"> {"b":1,"a":[2,3]} </script>
<script type="application/ld+json">not json</script>
<script type="application/ld+json">   </script>
</head><body><meta name="description" content="body desc"><title>Body Title</title></body></html>`

func defaultParseConfig() normalizedConfig {
	return normalizedConfig{includeJSONLd: true, includeOpenGraph: true, includeMeta: true}
}

func TestParseMetadataCollectsHeadFieldsInOnePass(t *testing.T) {
	parsed := parseMetadata(sampleHTML, defaultParseConfig())
	if parsed.Title == nil || *parsed.Title != "First Title" {
		t.Fatalf("title = %v", parsed.Title)
	}
	if parsed.Description == nil || *parsed.Description != "desc" {
		t.Fatalf("description = %v", parsed.Description)
	}
	if parsed.Author == nil || *parsed.Author != "Alice" {
		t.Fatalf("author = %v", parsed.Author)
	}
	if parsed.Keywords == nil || strings.Join(*parsed.Keywords, ",") != "a,b,c" {
		t.Fatalf("keywords = %v", parsed.Keywords)
	}
	wantMeta := []Tag{
		{Name: "description", Value: "desc"},
		{Name: "keywords", Value: "a, b ,, c"},
		{Name: "author", Value: "Alice"},
		{Name: "description", Value: "second desc"},
	}
	if len(parsed.MetaTags) != len(wantMeta) {
		t.Fatalf("metaTags = %+v", parsed.MetaTags)
	}
	for index, want := range wantMeta {
		if parsed.MetaTags[index] != want {
			t.Fatalf("metaTags[%d] = %+v want %+v", index, parsed.MetaTags[index], want)
		}
	}
	wantOpenGraph := []Tag{
		{Name: "og:title", Value: "OG Title"},
		{Name: "twitter:card", Value: "summary"},
		{Name: "og:image", Value: "https://example.com/i.png"},
	}
	if len(parsed.OpenGraph) != len(wantOpenGraph) {
		t.Fatalf("openGraph = %+v", parsed.OpenGraph)
	}
	for index, want := range wantOpenGraph {
		if parsed.OpenGraph[index] != want {
			t.Fatalf("openGraph[%d] = %+v want %+v", index, parsed.OpenGraph[index], want)
		}
	}
	// Valid JSON is compacted with its insertion order; invalid JSON keeps the
	// trimmed source text; an empty script is skipped without consuming a slot.
	wantJSONLd := []string{`{"b":1,"a":[2,3]}`, "not json"}
	if len(parsed.JSONLd) != len(wantJSONLd) {
		t.Fatalf("jsonLd = %+v", parsed.JSONLd)
	}
	for index, want := range wantJSONLd {
		if parsed.JSONLd[index] != want {
			t.Fatalf("jsonLd[%d] = %q want %q", index, parsed.JSONLd[index], want)
		}
	}
}

func TestParseMetadataExtractSwitches(t *testing.T) {
	config := defaultParseConfig()
	config.includeOpenGraph = false
	parsed := parseMetadata(sampleHTML, config)
	if len(parsed.OpenGraph) != 0 {
		t.Fatalf("openGraph must stay empty: %+v", parsed.OpenGraph)
	}
	// With the OpenGraph branch off the names fall through to the standard meta
	// branch instead of being dropped.
	found := false
	for _, tag := range parsed.MetaTags {
		if tag.Name == "og:title" {
			found = true
		}
	}
	if !found {
		t.Fatalf("og:title must fall back to metaTags: %+v", parsed.MetaTags)
	}

	config = defaultParseConfig()
	config.includeMeta = false
	parsed = parseMetadata(sampleHTML, config)
	if len(parsed.MetaTags) != 0 {
		t.Fatalf("metaTags must stay empty: %+v", parsed.MetaTags)
	}
	if parsed.Description == nil || parsed.Author == nil || parsed.Keywords == nil {
		t.Fatalf("disabling standard meta must not disable the single-value fields: %+v", parsed)
	}

	config = defaultParseConfig()
	config.includeJSONLd = false
	parsed = parseMetadata(sampleHTML, config)
	if len(parsed.JSONLd) != 0 {
		t.Fatalf("jsonLd must stay empty: %+v", parsed.JSONLd)
	}
}

func TestParseMetadataTruncatesTagsButStillScansForSingleValues(t *testing.T) {
	var builder strings.Builder
	builder.WriteString("<html><head><title>T</title>")
	for index := 0; index < 30; index++ {
		builder.WriteString(`<meta name="tag`)
		builder.WriteString(itoa(index))
		builder.WriteString(`" content="v">`)
	}
	builder.WriteString(`<meta name="author" content="Late Author">`)
	for index := 0; index < 7; index++ {
		builder.WriteString(`<script type="application/ld+json">{"i":`)
		builder.WriteString(itoa(index))
		builder.WriteString(`}</script>`)
	}
	builder.WriteString("</head></html>")

	parsed := parseMetadata(builder.String(), defaultParseConfig())
	if len(parsed.MetaTags) != maxMetadataTags {
		t.Fatalf("metaTags = %d want %d", len(parsed.MetaTags), maxMetadataTags)
	}
	if parsed.Author == nil || *parsed.Author != "Late Author" {
		t.Fatalf("the scan must continue past the tag cap: %v", parsed.Author)
	}
	if len(parsed.JSONLd) != maxJSONLdScripts {
		t.Fatalf("jsonLd = %d want %d", len(parsed.JSONLd), maxJSONLdScripts)
	}
}

func TestParseMetadataUsesOnlyTheFirstTitleAndIgnoresBody(t *testing.T) {
	parsed := parseMetadata("<html><head></head><body><title>Body</title><meta name=\"description\" content=\"d\"></body></html>", defaultParseConfig())
	if parsed.Title != nil {
		t.Fatalf("title = %v", parsed.Title)
	}
	if parsed.Description != nil {
		t.Fatalf("description = %v", parsed.Description)
	}
	empty := parseMetadata("<html><head><title>   </title></head></html>", defaultParseConfig())
	if empty.Title != nil {
		t.Fatalf("an empty title must stay undefined: %v", empty.Title)
	}
}

func TestParseMetadataKeywordsAreTrimmedAndCappedWithoutDedupe(t *testing.T) {
	var builder strings.Builder
	builder.WriteString(`<html><head><meta name="keywords" content="`)
	for index := 0; index < 20; index++ {
		if index > 0 {
			builder.WriteString(",")
		}
		builder.WriteString(" k")
		builder.WriteString(itoa(index % 2))
	}
	builder.WriteString(`"></head></html>`)
	parsed := parseMetadata(builder.String(), defaultParseConfig())
	if parsed.Keywords == nil || len(*parsed.Keywords) != maxKeywords {
		t.Fatalf("keywords = %v", parsed.Keywords)
	}
	if (*parsed.Keywords)[0] != "k0" || (*parsed.Keywords)[1] != "k1" {
		t.Fatalf("keywords = %v", *parsed.Keywords)
	}
}

func TestParseMetadataMetaNameBeatsPropertyAndSkipsEmptyContent(t *testing.T) {
	html := `<html><head>
<meta property="og:title" name="og:title" content="both">
<meta name="" property="fallback" content="from property">
<meta name="nolabel" content="">
<meta name="blank" content="   ">
</head></html>`
	parsed := parseMetadata(html, defaultParseConfig())
	if len(parsed.OpenGraph) != 1 || parsed.OpenGraph[0].Value != "both" {
		t.Fatalf("openGraph = %+v", parsed.OpenGraph)
	}
	if len(parsed.MetaTags) != 1 || parsed.MetaTags[0].Name != "fallback" {
		t.Fatalf("metaTags = %+v", parsed.MetaTags)
	}
}

func TestStringifyCompactJSONMatchesJavaScript(t *testing.T) {
	cases := map[string]string{
		`{ "a" : 1 , "b" : [ true , null ] }`:  `{"a":1,"b":[true,null]}`,
		`{"z":1,"a":2}`:                        `{"z":1,"a":2}`,
		`{"s":"<a>&\u00e9"}`:                   `{"s":"<a>&é"}`,
		`{"n":1.0}`:                            `{"n":1}`,
		`{"n":1e21}`:                           `{"n":1e+21}`,
		`{"n":0.0000001}`:                      `{"n":1e-7}`,
		`{"n":-0}`:                             `{"n":0}`,
		`{"n":123456789012345678901234567890}`: `{"n":1.2345678901234568e+29}`,
	}
	for input, want := range cases {
		got, ok := stringifyCompactJSON(input)
		if !ok || got != want {
			t.Fatalf("stringifyCompactJSON(%q) = %q,%v want %q", input, got, ok, want)
		}
	}
	for _, invalid := range []string{"not json", `{"a":1} trailing`, ""} {
		if got, ok := stringifyCompactJSON(invalid); ok {
			t.Fatalf("stringifyCompactJSON(%q) = %q want failure", invalid, got)
		}
	}
}
