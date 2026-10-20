package newspipeline

// Unit tests for the news-pipeline-internal.ts helpers: hashing, date parsing,
// LLM metadata merging, markdown selection, payload metadata extraction and the
// stored-row error classifiers.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func TestHashContent(t *testing.T) {
	if got := hashContent("abc"); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("hashContent(abc) = %q", got)
	}
	if got := hashContent(""); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("hashContent(\"\") = %q", got)
	}
}

func TestParseDate(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  string
	}{
		{name: "nil", value: nil, want: ""},
		{name: "iso", value: "2024-01-02T03:04:05Z", want: "2024-01-02T03:04:05.000Z"},
		{name: "naive", value: "2024-01-02T03:04:05", want: "2024-01-02T03:04:05.000Z"},
		{name: "space separator", value: "2024-01-02 03:04:05", want: "2024-01-02T03:04:05.000Z"},
		{name: "date only", value: "2024-01-02", want: "2024-01-02T00:00:00.000Z"},
		{name: "slashes", value: "2024/01/02", want: "2024-01-02T00:00:00.000Z"},
		{name: "chinese", value: "2024年1月2日", want: "2024-01-02T00:00:00.000Z"},
		{name: "year month", value: "2024-03", want: "2024-03-01T00:00:00.000Z"},
		{name: "year", value: "2024年", want: "2024-01-01T00:00:00.000Z"},
		{name: "unix seconds", value: "1704164645", want: "2024-01-02T03:04:05.000Z"},
		{name: "unix millis", value: "1704164645000", want: "2024-01-02T03:04:05.000Z"},
		{name: "string pointer", value: stringPointer("2024-01-02"), want: "2024-01-02T00:00:00.000Z"},
		{name: "invalid", value: "not a date", want: ""},
		{name: "number", value: 42, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed := parseDate(test.value)
			if test.want == "" {
				if parsed != nil {
					t.Fatalf("want nil, got %v", parsed)
				}
				return
			}
			if parsed == nil {
				t.Fatalf("want %s, got nil", test.want)
			}
			if got := formatISOString(*parsed); got != test.want {
				t.Fatalf("parsed = %q, want %q", got, test.want)
			}
		})
	}
}

func TestEmptyLlmMetadataAndMerge(t *testing.T) {
	empty := emptyLlmMetadata()
	if empty.Model != nil || empty.PromptVersion != nil || empty.PromptTokens != nil ||
		empty.CompletionTokens != nil || empty.TotalTokens != nil || empty.CostUSD != nil || empty.LatencyMS != nil {
		t.Fatalf("emptyLlmMetadata must have every member nil")
	}
	if got := mergeLlmMetadata(empty, nil); got.Model != nil {
		t.Fatalf("nil extra must return base")
	}
	base := LLMMetadata{
		Model:        stringPointer("base-model"),
		PromptTokens: floatPointer(0.1),
		CostUSD:      floatPointer(1.0000004),
	}
	extra := &LLMMetadata{
		Model:            stringPointer("extra-model"),
		PromptTokens:     floatPointer(0.2),
		CompletionTokens: floatPointer(0),
		CostUSD:          floatPointer(0.0000004),
	}
	merged := mergeLlmMetadata(base, extra)
	if merged.Model == nil || *merged.Model != "base-model" {
		t.Fatalf("model = %v", merged.Model)
	}
	if merged.PromptTokens == nil || *merged.PromptTokens != 0.3 {
		t.Fatalf("promptTokens = %v, want 0.3", merged.PromptTokens)
	}
	if merged.CostUSD == nil || *merged.CostUSD != 1.000001 {
		t.Fatalf("costUsd = %v, want 1.000001 (6 decimal rounding)", merged.CostUSD)
	}
	if merged.CompletionTokens == nil || *merged.CompletionTokens != 0 {
		t.Fatalf("completionTokens = %v, want 0", merged.CompletionTokens)
	}
	if merged.TotalTokens != nil || merged.LatencyMS != nil {
		t.Fatalf("both-nil sums must stay nil")
	}
}

func TestWithPromptMetadataAndContentType(t *testing.T) {
	cleaned := CleanedNews{Title: stringPointer("t")}
	filled := withPromptMetadata(cleaned, stringPointer("v1"), stringPointer("m1"))
	if filled.LLMPromptVersion == nil || *filled.LLMPromptVersion != "v1" {
		t.Fatalf("prompt version = %v", filled.LLMPromptVersion)
	}
	if filled.LLMModel == nil || *filled.LLMModel != "m1" {
		t.Fatalf("model = %v", filled.LLMModel)
	}
	existing := CleanedNews{LLMModel: stringPointer("keep"), LLMPromptVersion: stringPointer("keep-v")}
	kept := withPromptMetadata(existing, stringPointer("v2"), stringPointer("m2"))
	if *kept.LLMModel != "keep" || *kept.LLMPromptVersion != "keep-v" {
		t.Fatalf("existing metadata must win")
	}

	payload := NormalizedPayload{URL: "https://example.com/opinion/story"}
	resolved := withResolvedContentType(CleanedNews{Title: stringPointer("t")}, payload, nil)
	if resolved.ContentType == nil || *resolved.ContentType != "opinion" {
		t.Fatalf("inferred content type = %v", derefOrNil(resolved.ContentType))
	}
	stored := withResolvedContentType(CleanedNews{ContentType: stringPointer("Analysis")}, payload, nil)
	if *stored.ContentType != "analysis" {
		t.Fatalf("stored content type should be normalized and kept, got %q", *stored.ContentType)
	}
	article := &CrawledArticle{SourceURL: "https://example.com/analysis/a"}
	fromArticle := withResolvedContentType(CleanedNews{}, NormalizedPayload{URL: "https://example.com/x"}, article)
	if fromArticle.ContentType == nil || *fromArticle.ContentType != "analysis" {
		t.Fatalf("article url content type = %v", derefOrNil(fromArticle.ContentType))
	}

	backfilled := resolveStoredContentTypeForBackfill(CleanedNews{}, stringPointer("https://example.com/analysis/b"), nil)
	if backfilled.ContentType == nil || *backfilled.ContentType != "analysis" {
		t.Fatalf("backfill content type = %v", derefOrNil(backfilled.ContentType))
	}
}

func TestApplyCleanedMarkdownFallback(t *testing.T) {
	aliased := applyCleanedMarkdownFallback(
		json.RawMessage(`{"cleanedMarkdown":"  body  ","contentType":"news-fact","unknown":1}`),
		"fallback",
	)
	var document map[string]any
	if err := json.Unmarshal(aliased, &document); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	if document["cleaned_markdown"] != "  body  " {
		t.Fatalf("candidate must win verbatim: %v", document["cleaned_markdown"])
	}
	if document["content_type"] != "news-fact" {
		t.Fatalf("content type alias not promoted: %v", document["content_type"])
	}
	if document["unknown"] != float64(1) {
		t.Fatalf("unknown member lost")
	}
	if _, present := document["cleaned_markdown_source"]; present {
		t.Fatalf("source must not be set when a candidate exists")
	}

	fallback := applyCleanedMarkdownFallback(json.RawMessage(`{"cleaned_markdown":"   "}`), " body ")
	var fallbackDocument map[string]any
	if err := json.Unmarshal(fallback, &fallbackDocument); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	if fallbackDocument["cleaned_markdown"] != " body " {
		t.Fatalf("fallback = %v", fallbackDocument["cleaned_markdown"])
	}
	if fallbackDocument["cleaned_markdown_source"] != "crawl_fallback" {
		t.Fatalf("source = %v", fallbackDocument["cleaned_markdown_source"])
	}

	// Existing members keep their position (JS object mutation semantics).
	if got := string(applyCleanedMarkdownFallback(json.RawMessage(`{"cleaned_markdown":"x","a":1}`), "")); got != `{"cleaned_markdown":"x","a":1}` {
		t.Fatalf("member order = %s", got)
	}
	if got := string(applyCleanedMarkdownFallback(json.RawMessage(`null`), "x")); got != "null" {
		t.Fatalf("non-object input must pass through, got %s", got)
	}
}

func TestStoredCategoryAndProcessedItemRef(t *testing.T) {
	path := normalizeStoredCategoryPath(stringPointer(" /A//B/ "))
	if path == nil || *path != "a/b" {
		t.Fatalf("category path = %v", derefOrNil(path))
	}
	if normalized := normalizeStoredCategoryPath(nil); normalized != nil {
		t.Fatalf("nil category path must stay nil")
	}
	method := normalizeStoredCategoryMethod(stringPointer("  llm  "))
	if method == nil || *method != "llm" {
		t.Fatalf("category method = %v", derefOrNil(method))
	}
	if normalized := normalizeProcessedItemRef(stringPointer("507f1f77bcf86cd799439011")); normalized == nil {
		t.Fatalf("24 hex object id should be valid")
	}
	if normalized := normalizeProcessedItemRef(stringPointer("abcdefghijkl")); normalized == nil {
		t.Fatalf("12 byte object id should be valid")
	}
	if normalized := normalizeProcessedItemRef(stringPointer("not-an-id")); normalized != nil {
		t.Fatalf("invalid ref must normalize to nil")
	}
}

func metadataPayload(raw string) NormalizedPayload {
	return NormalizedPayload{Metadata: json.RawMessage(raw)}
}

func TestExtractPayloadMetadata(t *testing.T) {
	payload := metadataPayload(`{
		"sourceId":" s ",
		"crawlResultId":" c ",
		"urlQueryParamAllowlist":["ID","bad key","id","a"],
		"newsSourceSeed":{"dedupeWindowHours":9999}
	}`)
	if value := extractSourceId(payload); value == nil || *value != "s" {
		t.Fatalf("sourceId = %v", derefOrNil(value))
	}
	if value := extractCrawlResultId(payload); value == nil || *value != "c" {
		t.Fatalf("crawlResultId = %v", derefOrNil(value))
	}
	allowlist := extractUrlQueryParamAllowlist(payload)
	if strings.Join(allowlist, ",") != "id,a" {
		t.Fatalf("allowlist = %v", allowlist)
	}
	if value := extractSeedDedupeWindowHours(payload); value == nil || *value != 720 {
		t.Fatalf("seed window = %v", derefOrNilInt(value))
	}

	defaults := extractUrlQueryParamAllowlist(metadataPayload(`{}`))
	if len(defaults) != 12 || defaults[0] != "id" || defaults[11] != "hl" {
		t.Fatalf("default allowlist = %v", defaults)
	}
	explicitEmpty := extractUrlQueryParamAllowlist(metadataPayload(`{"urlQueryParamAllowlist":[]}`))
	if explicitEmpty == nil || len(explicitEmpty) != 0 {
		t.Fatalf("explicit empty allowlist must stay empty, got %v", explicitEmpty)
	}
	stringForm := extractUrlQueryParamAllowlist(metadataPayload(`{"urlQueryParamAllowlist":"id, UTM\nfoo"}`))
	if strings.Join(stringForm, ",") != "id,utm,foo" {
		t.Fatalf("string allowlist = %v", stringForm)
	}

	newsnow := metadataPayload(`{"newsnow":{"sourceId":" nested "}}`)
	if value := extractSourceId(newsnow); value == nil || *value != "nested" {
		t.Fatalf("newsnow sourceId = %v", derefOrNil(value))
	}
	if value := extractSeedDedupeWindowHours(metadataPayload(`{"newsSourceSeed":{"dedupeWindowHours":-5}}`)); value == nil || *value != 0 {
		t.Fatalf("negative seed window should clamp to 0")
	}
	if value := extractSeedDedupeWindowHours(metadataPayload(`{"newsSourceSeed":{"dedupeWindowHours":"5"}}`)); value != nil {
		t.Fatalf("string seed window must be ignored")
	}
	if value := extractCrawlResultId(metadataPayload(`{"crawlResultId":"  "}`)); value != nil {
		t.Fatalf("blank crawlResultId must be nil")
	}
}

func derefOrNilInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func TestBuildTags(t *testing.T) {
	payload := NormalizedPayload{Tags: []string{"A", "b"}}
	cleaned := CleanedNews{Topics: []string{"A", "NEWS", "b"}}
	tags := buildTags(payload, cleaned)
	if strings.Join(tags, ",") != "A,b,a,news" {
		t.Fatalf("tags = %v", tags)
	}
	many := make([]string, 0, 25)
	for index := 0; index < 25; index++ {
		many = append(many, "tag"+string(rune('a'+index)))
	}
	if capped := buildTags(NormalizedPayload{Tags: many}, CleanedNews{}); len(capped) != 20 {
		t.Fatalf("tags capped at 20, got %d", len(capped))
	}
}

func TestColumnBounds(t *testing.T) {
	long := strings.Repeat("x", 250)
	name := toItemMetaName(long)
	if got := len(utf16.Encode([]rune(name))); got != 191 {
		t.Fatalf("item meta name length = %d, want 191", got)
	}
	if !strings.HasSuffix(name, "…") {
		t.Fatalf("item meta name should end with an ellipsis")
	}
	if got := toItemMetaName("  short  "); got != "short" {
		t.Fatalf("short name = %q", got)
	}
	urlValue := toArticleUrl(strings.Repeat("u", 600))
	if got := len(utf16.Encode([]rune(urlValue))); got != 512 {
		t.Fatalf("article url length = %d, want 512", got)
	}
	if got := toArticleUrl("  https://x  "); got != "https://x" {
		t.Fatalf("article url = %q", got)
	}
}

func TestComputeBackoffDelay(t *testing.T) {
	tests := []struct {
		name    string
		base    int
		attempt int
		max     int
		random  func() float64
		want    int
	}{
		{name: "first attempt half jitter", base: 1000, attempt: 1, max: 5, random: func() float64 { return 0 }, want: 500},
		{name: "third attempt", base: 1000, attempt: 3, max: 5, random: func() float64 { return 0.5 }, want: 4000},
		{name: "capped at max attempts", base: 100, attempt: 10, max: 3, random: func() float64 { return 0.5 }, want: 400},
		{name: "nil random defaults to 0.5", base: 1000, attempt: 2, max: 5, random: nil, want: 2000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := computeBackoffDelay(test.base, test.attempt, test.max, test.random); got != test.want {
				t.Fatalf("delay = %d, want %d", got, test.want)
			}
		})
	}
}

func TestResolveFrontierLogMetadata(t *testing.T) {
	resolved := resolveFrontierLogMetadata(json.RawMessage(`{"frontierRunId":" r ","nodeId":" n ","crawlSiteProfileId":" p "}`))
	if resolved == nil || resolved.RunID != "r" || resolved.NodeID != "n" || resolved.ProfileID != "p" {
		t.Fatalf("resolved = %#v", resolved)
	}
	if resolved := resolveFrontierLogMetadata(json.RawMessage(`{"runId":"r2","profileId":"p2"}`)); resolved == nil || resolved.RunID != "r2" || resolved.ProfileID != "p2" || resolved.NodeID != "" {
		t.Fatalf("alias members = %#v", resolved)
	}
	if resolved := resolveFrontierLogMetadata(json.RawMessage(`{}`)); resolved != nil {
		t.Fatalf("empty metadata must be nil")
	}
	if resolved := resolveFrontierLogMetadata(nil); resolved != nil {
		t.Fatalf("nil metadata must be nil")
	}
}

func TestMarkdownHelpers(t *testing.T) {
	record := map[string]json.RawMessage{
		"markdown":              json.RawMessage(`" primary "`),
		"markdownWithCitations": json.RawMessage(`null`),
		"rawMarkdown":           json.RawMessage(`123`),
	}
	if value := readMarkdownField(record, []string{"markdown"}); value == nil || *value != " primary " {
		t.Fatalf("readMarkdownField = %v", derefOrNil(value))
	}
	if value := readMarkdownField(record, []string{"markdownWithCitations", "missing"}); value != nil {
		t.Fatalf("non-string member must be skipped")
	}
	if value := normalizeMarkdownCandidate(stringPointer("   ")); value != nil {
		t.Fatalf("blank candidate must be nil")
	}
	if value := normalizeMarkdownCandidate(stringPointer("  kept  ")); value == nil || *value != "kept" {
		t.Fatalf("candidate = %v", derefOrNil(value))
	}

	if !isLikelyBotChallengeMarkdown("Please enable JavaScript to continue") {
		t.Fatalf("strong indicator not detected")
	}
	if isLikelyBotChallengeMarkdown("cloudflare") {
		t.Fatalf("one weak indicator is not enough")
	}
	if !isLikelyBotChallengeMarkdown("cloudflare captcha") {
		t.Fatalf("two weak indicators should match")
	}
	longChallenge := "cloudflare captcha " + strings.Repeat("x", 13000)
	if isLikelyBotChallengeMarkdown(longChallenge) {
		t.Fatalf("length guard should defeat weak indicators")
	}

	short := map[string]json.RawMessage{
		"markdown":    json.RawMessage(`"short"`),
		"rawMarkdown": json.RawMessage(`"` + strings.Repeat("r", 1300) + `"`),
	}
	selected := selectBestMarkdownFromContentDoc(short)
	if selected == nil || len(*selected) != 1300 {
		t.Fatalf("richer raw markdown should win")
	}
	rich := map[string]json.RawMessage{
		"markdown":              json.RawMessage(`"` + strings.Repeat("m", 100) + `"`),
		"markdownWithCitations": json.RawMessage(`"` + strings.Repeat("c", 2000) + `"`),
		"rawMarkdown":           json.RawMessage(`"` + strings.Repeat("r", 1300) + `"`),
	}
	selected = selectBestMarkdownFromContentDoc(rich)
	if selected == nil || len(*selected) != 2000 {
		t.Fatalf("longer citations markdown should win")
	}
	challenge := map[string]json.RawMessage{
		"markdown":    json.RawMessage(`"please enable javascript"`),
		"rawMarkdown": json.RawMessage(`"` + strings.Repeat("real content ", 150) + `"`),
	}
	selected = selectBestMarkdownFromContentDoc(challenge)
	if selected == nil || *selected != strings.Repeat("real content ", 150) {
		t.Fatalf("challenge primary should defer to richer raw markdown")
	}
	if selected := selectBestMarkdownFromContentDoc(map[string]json.RawMessage{}); selected != nil {
		t.Fatalf("empty document must select nothing")
	}
}

func TestToStringArrayItems(t *testing.T) {
	values := toStringArray(json.RawMessage(`[" a ",2,null,true,"",1.5]`))
	if strings.Join(values, ",") != "a,2,1.5" {
		t.Fatalf("toStringArray = %v", values)
	}
	if values := toStringArray(json.RawMessage(`{"a":1}`)); len(values) != 0 || values == nil {
		t.Fatalf("non-array = %v", values)
	}
}

func TestNormalizeEntitiesAndRelations(t *testing.T) {
	entities := normalizeEntities(json.RawMessage(`[
		{"name":"Acme","type":"company","confidence":2},
		{"name":"Ignored"},
		{"name":1,"type":"company"},
		"string"
	]`))
	if len(entities) != 1 || entities[0].Name != "Acme" || entities[0].Confidence != 1 {
		t.Fatalf("entities = %#v", entities)
	}
	relations := normalizeKgRelations(json.RawMessage(`[{
		"subject":{"name":"a","type":"t"},
		"predicate":"p",
		"object":{"name":"b","type":"t"},
		"confidence":0.5
	}]`))
	if len(relations) != 1 || relations[0].Predicate != "p" {
		t.Fatalf("relations = %#v", relations)
	}
	if invalid := normalizeKgRelations(json.RawMessage(`[{"predicate":"p"}]`)); len(invalid) != 0 {
		t.Fatalf("invalid relations must be empty, got %#v", invalid)
	}
}

func TestParseStoredCleanedNewsResult(t *testing.T) {
	valid := parseStoredCleanedNewsResult(json.RawMessage(`{"cleaned_markdown":"b"}`))
	if valid == nil || valid.CleanedMarkdown != "b" {
		t.Fatalf("valid result = %#v", valid)
	}
	if invalid := parseStoredCleanedNewsResult(json.RawMessage(`{}`)); invalid != nil {
		t.Fatalf("invalid result must be nil")
	}
}

func TestExtractFirstJSON(t *testing.T) {
	tests := []struct {
		name string
		text string
		want string
	}{
		{name: "plain", text: `{"a":1}`, want: `{"a":1}`},
		{name: "fenced", text: "```json\n{\"a\":1}\n```", want: `{"a":1}`},
		{name: "wrapped", text: `prefix {"a":{"b":2}} suffix`, want: `{"a":{"b":2}}`},
		{name: "array", text: `text [1,2] end`, want: `[1,2]`},
		{name: "none", text: `no json here`, want: ""},
		{name: "unbalanced", text: `{"a":1`, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ExtractFirstJSON(test.text); got != test.want {
				t.Fatalf("ExtractFirstJSON = %q, want %q", got, test.want)
			}
		})
	}
	if _, ok := safeJSONParseFromText("garbage"); ok {
		t.Fatalf("garbage must not parse")
	}
	if parsed, ok := safeJSONParseFromText("```\n{\"a\":1}\n```"); !ok || string(parsed) != `{"a":1}` {
		t.Fatalf("safeJSONParseFromText = %s, %v", parsed, ok)
	}
}

func TestStageMetaEntrySerialization(t *testing.T) {
	encoded, err := json.Marshal(NewStageMetaEntry("completed", nil))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(document) != 10 {
		t.Fatalf("stage meta entry should always write 10 members, got %d: %s", len(document), encoded)
	}
	if document["status"] != "completed" {
		t.Fatalf("status = %v", document["status"])
	}
	for _, key := range []string{"provider", "reason", "model", "prompt_version", "prompt_tokens",
		"completion_tokens", "total_tokens", "cost_usd", "latency_ms"} {
		value, present := document[key]
		if !present || value != nil {
			t.Fatalf("member %s = %v (present=%v), want null", key, value, present)
		}
	}
}

func TestErrorClassifiers(t *testing.T) {
	if isPrismaUniqueConstraintError(nil) {
		t.Fatalf("nil is not a unique constraint error")
	}
	if isDuplicateKeyError(nil) {
		t.Fatalf("nil is not a duplicate key error")
	}
}

func TestParseDatePreservesUTCInstant(t *testing.T) {
	parsed := parseDate("2024-01-02T03:04:05+02:00")
	if parsed == nil {
		t.Fatal("parse failed")
	}
	if got := parsed.UTC().Format(time.RFC3339); got != "2024-01-02T01:04:05Z" {
		t.Fatalf("instant = %s", got)
	}
}
