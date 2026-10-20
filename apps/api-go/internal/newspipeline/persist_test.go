package newspipeline

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/processeditemoutbox"
)

func TestBuildProcessedItemOutboxPayloadMatchesSchema(t *testing.T) {
	duplicateOf := "507f1f77bcf86cd799439012"
	input := processedItemOutboxInput{
		ProcessedItemID: "507f1f77bcf86cd799439011",
		Raw:             pipelineTestRaw(),
		OrgID:           "org-1",
		SourceID:        stringPointer("source-1"),
		Payload: NormalizedPayload{
			URL:        "https://example.com/a",
			SourceName: stringPointer("Example"),
			Tags:       []string{"news"},
		},
		Cleaned:               pipelineTestCleaned(),
		LLM:                   pipelineTestLLM(),
		SummaryEmbedding:      []float64{0.1, 0.2},
		SummaryEmbeddingModel: stringPointer("embedding-model"),
		DuplicateOf:           &duplicateOf,
		DuplicateSimilarity:   floatPointer(0.91),
	}
	encoded, err := json.Marshal(buildProcessedItemOutboxPayload(input))
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	// The delivery owner's schema is the source of truth: a payload it cannot
	// parse is a persist bug.
	parsed, err := processeditemoutbox.ParsePayload(encoded)
	if err != nil {
		t.Fatalf("outbox payload does not validate: %v\n%s", err, encoded)
	}
	if parsed.Type != "processed_item" {
		t.Fatalf("type = %q", parsed.Type)
	}
	document := parsed.Document
	if document.ID != "507f1f77bcf86cd799439011" || document.RawItemID != "raw-1" || document.ItemMetaID != "meta-1" || document.OrgID != "org-1" {
		t.Fatalf("unexpected document identity: %+v", document)
	}
	if document.SourceID == nil || *document.SourceID != "source-1" {
		t.Fatalf("sourceId = %v", document.SourceID)
	}
	if document.Status != "completed" {
		t.Fatalf("status = %q", document.Status)
	}
	if len(document.Tags) != 2 || document.Tags[0] != "news" || document.Tags[1] != "markets" {
		t.Fatalf("tags = %v", document.Tags)
	}
	if document.Result.Title == nil || *document.Result.Title != "Title" {
		t.Fatalf("result.title = %v", document.Result.Title)
	}
	if document.LLM.Model == nil || *document.LLM.Model != "model-x" {
		t.Fatalf("llm.model = %v", document.LLM.Model)
	}
	if !document.SummaryEmbeddingSet || len(document.SummaryEmbedding) != 2 {
		t.Fatalf("summaryEmbedding = %v (set=%v)", document.SummaryEmbedding, document.SummaryEmbeddingSet)
	}
	if document.SummaryEmbeddingModel == nil || *document.SummaryEmbeddingModel != "embedding-model" {
		t.Fatalf("summaryEmbeddingModel = %v", document.SummaryEmbeddingModel)
	}
	if document.DuplicateOf == nil || *document.DuplicateOf != duplicateOf {
		t.Fatalf("duplicateOf = %v", document.DuplicateOf)
	}
	if document.DuplicateSimilarity == nil || *document.DuplicateSimilarity != 0.91 {
		t.Fatalf("duplicateSimilarity = %v", document.DuplicateSimilarity)
	}

	var raw map[string]any
	if err := json.Unmarshal(encoded, &raw); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	rawDocument := raw["document"].(map[string]any)
	if _, present := rawDocument["error"]; present {
		t.Fatal("the payload must not carry an error member")
	}
}

func TestBuildProcessedItemOutboxPayloadOmitsUndefinedOptionals(t *testing.T) {
	input := processedItemOutboxInput{
		ProcessedItemID: "507f1f77bcf86cd799439011",
		Raw:             pipelineTestRaw(),
		OrgID:           "org-1",
		Payload:         NormalizedPayload{URL: "https://example.com/a"},
		Cleaned:         pipelineTestCleaned(),
		LLM:             pipelineTestLLM(),
	}
	encoded, err := json.Marshal(buildProcessedItemOutboxPayload(input))
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	text := string(encoded)
	for _, absent := range []string{"summaryEmbedding", "summaryEmbeddingModel", "duplicateOf", "duplicateSimilarity"} {
		if strings.Contains(text, `"`+absent+`"`) {
			t.Fatalf("%s must be absent when undefined: %s", absent, text)
		}
	}
	if !strings.Contains(text, `"sourceId":null`) {
		t.Fatalf("sourceId must be written as null: %s", text)
	}
	if _, err := processeditemoutbox.ParsePayload(encoded); err != nil {
		t.Fatalf("outbox payload does not validate: %v", err)
	}
}

func TestBuildProcessedItemOutboxPayloadEmptyEmbeddingIsPresent(t *testing.T) {
	input := processedItemOutboxInput{
		ProcessedItemID:  "507f1f77bcf86cd799439011",
		Raw:              pipelineTestRaw(),
		OrgID:            "org-1",
		Payload:          NormalizedPayload{URL: "https://example.com/a"},
		Cleaned:          pipelineTestCleaned(),
		LLM:              pipelineTestLLM(),
		SummaryEmbedding: []float64{},
	}
	encoded, err := json.Marshal(buildProcessedItemOutboxPayload(input))
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	// `?? undefined` keeps an empty array: only null/undefined drops the member.
	if !strings.Contains(string(encoded), `"summaryEmbedding":[]`) {
		t.Fatalf("an empty summary embedding must stay present: %s", encoded)
	}
}

func TestPipelineBuildArticleMetadata(t *testing.T) {
	allowlist := extractUrlQueryParamAllowlist(NormalizedPayload{
		URL:      "https://example.com/a",
		Metadata: json.RawMessage(`{"urlQueryParamAllowlist":["id","page"]}`),
	})
	canonicalURL, fingerprint, ok := pipelineBuildCanonicalURLFingerprint("https://example.com/a?id=5&utm_source=x", allowlist)
	if !ok {
		t.Fatal("expected a canonical URL")
	}
	metadata, err := pipelineBuildArticleMetadata(
		json.RawMessage(`{"title":"Example article","sourceId":"s1"}`),
		json.RawMessage(`{"llmRepair":{"applied":true}}`),
		"https://example.com/a?id=5&utm_source=x",
		canonicalURL,
		canonicalURL,
		fingerprint,
		true,
		allowlist,
	)
	if err != nil {
		t.Fatalf("metadata build failed: %v", err)
	}
	var merged map[string]any
	if err := json.Unmarshal(metadata, &merged); err != nil {
		t.Fatalf("invalid metadata JSON: %v", err)
	}
	if merged["title"] != "Example article" || merged["sourceId"] != "s1" {
		t.Fatalf("article metadata was not preserved: %v", merged)
	}
	repair, ok := merged["llmRepair"].(map[string]any)
	if !ok || repair["applied"] != true {
		t.Fatalf("article metadata patch was not merged: %v", merged)
	}
	if merged["originalUrl"] != "https://example.com/a?id=5&utm_source=x" {
		t.Fatalf("originalUrl = %v", merged["originalUrl"])
	}
	if merged["canonicalUrl"] != canonicalURL || merged["urlFingerprint"] != fingerprint {
		t.Fatalf("canonical members = %v / %v", merged["canonicalUrl"], merged["urlFingerprint"])
	}
	allow, ok := merged["urlQueryParamAllowlist"].([]any)
	if !ok || len(allow) != 2 || allow[0] != "id" || allow[1] != "page" {
		t.Fatalf("urlQueryParamAllowlist = %v", merged["urlQueryParamAllowlist"])
	}
}

func TestPipelineBuildArticleMetadataWithoutCanonicalURL(t *testing.T) {
	metadata, err := pipelineBuildArticleMetadata(
		json.RawMessage(`null`),
		nil,
		"",
		"",
		"",
		"",
		false,
		nil,
	)
	if err != nil {
		t.Fatalf("metadata build failed: %v", err)
	}
	if string(metadata) != "{}" {
		t.Fatalf("metadata = %s, want {}", metadata)
	}
}

func TestPipelineCanonicalURLFingerprint(t *testing.T) {
	allowlist := pipelineTestDefaultAllowlist()
	canonical, fingerprint, ok := pipelineBuildCanonicalURLFingerprint("HTTPS://Example.com:443//a//b/?id=5&utm_source=x&b=2#frag", allowlist)
	if !ok {
		t.Fatal("expected a canonical URL")
	}
	if canonical != "https://example.com/a/b?id=5" {
		t.Fatalf("canonical = %q", canonical)
	}
	if fingerprint != hashContent(canonical) || len(fingerprint) != 64 {
		t.Fatalf("fingerprint = %q", fingerprint)
	}

	sorted, _, ok := pipelineBuildCanonicalURLFingerprint("https://example.com/x?page=2&id=10", []string{"id", "page"})
	if !ok || sorted != "https://example.com/x?id=10&page=2" {
		t.Fatalf("query pairs must be sorted by key: %q", sorted)
	}

	emptyAllowlist, _, ok := pipelineBuildCanonicalURLFingerprint("https://example.com/x?id=10", []string{})
	if !ok || emptyAllowlist != "https://example.com/x" {
		t.Fatalf("an explicit empty allowlist must strip the query: %q", emptyAllowlist)
	}

	if _, _, ok := pipelineBuildCanonicalURLFingerprint("   ", allowlist); ok {
		t.Fatal("an empty URL must not canonicalize")
	}
	if _, _, ok := pipelineBuildCanonicalURLFingerprint("ftp://example.com/x", allowlist); ok {
		t.Fatal("a non-http(s) URL must not canonicalize")
	}
}

func TestPipelineResolveProcessedItemID(t *testing.T) {
	if got := pipelineResolveProcessedItemID("507f1f77bcf86cd799439011"); got != "507f1f77bcf86cd799439011" {
		t.Fatalf("a valid ObjectId must be kept, got %q", got)
	}
	for _, invalid := range []string{"", "c00000000000000000000000zz", "not-an-object-id"} {
		got := pipelineResolveProcessedItemID(invalid)
		if len(got) != 24 || !pipelineObjectIDIsValid(got) {
			t.Fatalf("invalid id %q must be replaced by an ObjectId hex, got %q", invalid, got)
		}
	}
}

func TestBuildPipelineJobStageMetadataUpdate(t *testing.T) {
	entry := NewStageMetaEntry("completed", stringPointer("rules"))
	query, args, ok := buildPipelineJobStageMetadataUpdate("clean", entry, pipelineTestNow, "pipeline-1", "org-1")
	if !ok {
		t.Fatal("expected a metadata update")
	}
	for _, fragment := range []string{
		"UPDATE `PipelineJob`",
		"JSON_SET(",
		"JSON_TYPE(`metadata`) = 'OBJECT'",
		"JSON_TYPE(JSON_EXTRACT(`metadata`, '$.extraction')) = 'OBJECT'",
		"JSON_TYPE(JSON_EXTRACT(`metadata`, '$.extraction.stages')) = 'OBJECT'",
		"'$.extraction'",
		"'$.stages'",
		"CAST(? AS JSON)",
		"'$.updatedAt'",
		"WHERE `id` = ? AND `orgId` = ?",
	} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("metadata SQL is missing %q:\n%s", fragment, query)
		}
	}
	if len(args) != 5 {
		t.Fatalf("args = %v", args)
	}
	if args[1] != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("updatedAt ISO = %v", args[1])
	}
	if args[3] != "pipeline-1" || args[4] != "org-1" {
		t.Fatalf("where args = %v / %v", args[3], args[4])
	}
	if !strings.Contains(query, "'$.clean'") {
		t.Fatalf("metadata SQL must write the validated stage path: %s", query)
	}
	var entryJSON map[string]any
	if err := json.Unmarshal([]byte(args[0].(string)), &entryJSON); err != nil {
		t.Fatalf("stage entry is not JSON: %v", err)
	}
	if len(entryJSON) != 10 || entryJSON["status"] != "completed" || entryJSON["provider"] != "rules" {
		t.Fatalf("stage entry = %v", entryJSON)
	}

	if _, _, ok := buildPipelineJobStageMetadataUpdate("bad stage", entry, pipelineTestNow, "pipeline-1", "org-1"); ok {
		t.Fatal("an unsafe stage name must be rejected")
	}
	if _, _, ok := buildPipelineJobStageMetadataUpdate("clean", entry, pipelineTestNow, "", "org-1"); ok {
		t.Fatal("an empty pipeline job id must be rejected")
	}
}

func TestPipelineExtractionPatch(t *testing.T) {
	patch, err := pipelineExtractionPatch(PipelineModeStaged, true, stringPointer("preflight_rejected"), floatPointer(0.12))
	if err != nil {
		t.Fatalf("patch build failed: %v", err)
	}
	decoded := pipelineTestDecodeJSONMap(t, patch)
	extraction := decoded["extraction"].(map[string]any)
	if extraction["mode"] != "staged" || extraction["gateRejected"] != true ||
		extraction["gateReason"] != "preflight_rejected" || extraction["preflightQualityScore"] != 0.12 {
		t.Fatalf("extraction = %v", extraction)
	}

	merged, err := pipelineExtractionPatchWithBase(
		json.RawMessage(`{"llmRepair":{"applied":true}}`),
		PipelineModeStaged,
		false,
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("patch merge failed: %v", err)
	}
	decoded = pipelineTestDecodeJSONMap(t, merged)
	if decoded["llmRepair"] == nil {
		t.Fatal("the clean-stage article metadata patch must be preserved")
	}
	extraction = decoded["extraction"].(map[string]any)
	if extraction["gateRejected"] != false {
		t.Fatalf("gateRejected = %v", extraction["gateRejected"])
	}
	if _, present := extraction["gateReason"]; present {
		t.Fatal("gateReason must be omitted when absent")
	}
	if score, present := extraction["preflightQualityScore"]; !present || score != nil {
		t.Fatalf("preflightQualityScore must be written as null: %v", extraction)
	}
}

func TestBuildMongoOutboxInsertQuery(t *testing.T) {
	payload := []byte(`{"type":"processed_item","document":{}}`)
	query, args := buildMongoOutboxInsertQuery("outbox-1", "org-1", payload, pipelineTestNow)
	for _, column := range []string{"`id`", "`orgId`", "`type`", "`payload`", "`status`", "`attempts`", "`lastError`", "`availableAt`", "`lockedAt`", "`createdAt`", "`updatedAt`"} {
		if !strings.Contains(query, column) {
			t.Fatalf("insert is missing %s: %s", column, query)
		}
	}
	if len(args) != 11 {
		t.Fatalf("args = %v", args)
	}
	if args[0] != "outbox-1" || args[1] != "org-1" || args[2] != "processed_item" || args[3] != string(payload) {
		t.Fatalf("unexpected insert args: %v", args)
	}
	if args[4] != "pending" || args[5] != 0 || args[6] != nil || args[8] != nil {
		t.Fatalf("unexpected pending row args: %v", args)
	}
}

func TestPipelinePendingProcessedItemDocument(t *testing.T) {
	document := pipelinePendingProcessedItemDocument("507f1f77bcf86cd799439011")
	decoded := pipelineTestDecodeJSONMap(t, document)
	if decoded["_id"] != "507f1f77bcf86cd799439011" || decoded["id"] != "507f1f77bcf86cd799439011" {
		t.Fatalf("pending document = %s", document)
	}
}

func TestPipelineExtractProcessedArticleTerms(t *testing.T) {
	terms := pipelineExtractProcessedArticleTerms(
		stringPointer("Breaking Markets Update"),
		stringPointer("The quick brown fox jumps over"),
		[]string{"Market Analysis", "live"},
	)
	expected := []string{"breaking", "markets", "update", "quick", "brown", "jumps", "over", "market", "analysis", "live"}
	if !pipelineTestEqualStrings(terms, expected) {
		t.Fatalf("terms = %v, want %v", terms, expected)
	}
	if terms := pipelineExtractProcessedArticleTerms(nil, nil, nil); terms == nil || len(terms) != 0 {
		t.Fatalf("empty terms = %#v", terms)
	}
}

func TestPipelineNormalizeProcessedArticleHelpers(t *testing.T) {
	if got := pipelineNormalizeProcessedArticleSource(nil); got != "unknown" {
		t.Fatalf("source = %q", got)
	}
	if got := pipelineNormalizeProcessedArticleSource(stringPointer("  Example  ")); got != "example" {
		t.Fatalf("source = %q", got)
	}
	if got := pipelineNormalizeProcessedArticleLocation(stringPointer("   ")); got != nil {
		t.Fatalf("location = %v", got)
	}
	if got := pipelineNormalizeProcessedArticleLocation(stringPointer(" Berlin ")); got == nil || *got != "Berlin" {
		t.Fatalf("location = %v", got)
	}
	bucket := pipelineAlignUTCHourStart(pipelineTestNow)
	if bucket.Minute() != 0 || bucket.Second() != 0 || bucket.Location().String() != "UTC" {
		t.Fatalf("bucket = %v", bucket)
	}
	empty, err := pipelineJSONArray[string](nil)
	if err != nil || string(empty) != "[]" {
		t.Fatalf("nil array = %s, err=%v", empty, err)
	}
}

func pipelineTestDefaultAllowlist() []string {
	return []string{"id", "story", "article", "post", "item", "p", "page", "v", "ver", "lang", "locale", "hl"}
}
