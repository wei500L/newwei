package processeditemoutbox

import (
	"encoding/json"
	"strings"
	"testing"
)

const validPayloadJSON = `{
  "type": "processed_item",
  "document": {
    "_id": "507f1f77bcf86cd799439011",
    "rawItemId": "507f1f77bcf86cd799439012",
    "itemMetaId": "meta-1",
    "orgId": "org-1",
    "status": "completed",
    "tags": ["tag-1"],
    "result": {
      "title": "  Example title  ",
      "published_at": "2026-01-02T03:04:05Z",
      "content_type": "news-fact",
      "sentiment": "Positive",
      "category_labels": ["Finance"],
      "topics": ["Markets"],
      "key_points": ["point"],
      "entities": [{"name":"ACME","type":"company","confidence":0.9}],
      "kg_relations": [{"subject":{"name":"ACME","type":"company"},"predicate":"owns","object":{"name":"Brand","type":"product"},"confidence":0.8,"properties":{"since":2020}}],
      "stage_meta": {"clean":{"status":"completed","provider":"crawler"}},
      "cleaned_markdown": "body"
    },
    "llm": {"model":"test-model","promptTokens":12},
    "summaryEmbedding": [0.1, 0.2],
    "summaryEmbeddingModel": "embed-v1",
    "duplicateOf": null,
    "duplicateSimilarity": null
  }
}`

func TestParsePayloadAcceptsValidEnvelope(t *testing.T) {
	payload, err := ParsePayload([]byte(validPayloadJSON))
	if err != nil {
		t.Fatalf("ParsePayload: %v", err)
	}
	doc := payload.Document
	if doc.ID != "507f1f77bcf86cd799439011" || doc.ItemMetaID != "meta-1" || doc.OrgID != "org-1" {
		t.Fatalf("identity = %+v", doc)
	}
	if doc.Result.PublishedAt == nil || *doc.Result.PublishedAt != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("published_at = %v", doc.Result.PublishedAt)
	}
	if doc.Result.ContentType == nil || *doc.Result.ContentType != "news_fact" {
		t.Fatalf("content_type = %v", doc.Result.ContentType)
	}
	if doc.Result.Sentiment == nil || *doc.Result.Sentiment != "positive" {
		t.Fatalf("sentiment = %v", doc.Result.Sentiment)
	}
	if len(doc.Result.CategoryLabels) != 1 || len(doc.Result.Topics) != 1 || len(doc.Result.Entities) != 1 {
		t.Fatalf("result arrays = %+v", doc.Result)
	}
	if len(doc.Result.KGRelations) != 1 || string(doc.Result.KGRelations[0].Properties) != `{"since":2020}` {
		t.Fatalf("kg relations = %+v", doc.Result.KGRelations)
	}
	if doc.Result.StageMeta == nil || doc.Result.StageMeta.Clean == nil || doc.Result.StageMeta.Clean.Status != "completed" {
		t.Fatalf("stage_meta = %+v", doc.Result.StageMeta)
	}
	if !doc.SummaryEmbeddingSet || len(doc.SummaryEmbedding) != 2 {
		t.Fatalf("embedding = %+v set=%v", doc.SummaryEmbedding, doc.SummaryEmbeddingSet)
	}
	if doc.SummaryEmbeddingModel == nil || *doc.SummaryEmbeddingModel != "embed-v1" {
		t.Fatalf("embedding model = %v", doc.SummaryEmbeddingModel)
	}
	if doc.LLM.Model == nil || *doc.LLM.Model != "test-model" || doc.LLM.PromptTokens == nil || *doc.LLM.PromptTokens != 12 {
		t.Fatalf("llm = %+v", doc.LLM)
	}
	if doc.LLM.CompletionTokens != nil {
		t.Fatalf("missing llm number must be null, got %v", *doc.LLM.CompletionTokens)
	}
}

func TestParsePayloadDefaultArrays(t *testing.T) {
	raw := `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{"cleaned_markdown":"x"},"llm":{}}}`
	payload, err := ParsePayload([]byte(raw))
	if err != nil {
		t.Fatalf("ParsePayload: %v", err)
	}
	if payload.Document.Result.CategoryLabels == nil || payload.Document.Result.Topics == nil ||
		payload.Document.Result.KeyPoints == nil || payload.Document.Result.Entities == nil ||
		payload.Document.Result.KGRelations == nil || payload.Document.Result.RemovedNoiseTypes == nil ||
		payload.Document.Result.CategoryCandidates == nil || payload.Document.Tags == nil {
		t.Fatalf("defaults must be empty arrays: %+v tags=%+v", payload.Document.Result, payload.Document.Tags)
	}
}

func TestParsePayloadCoercesOptionalLooseFields(t *testing.T) {
	raw := `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","sourceId":42,"summaryEmbeddingModel":false,"duplicateSimilarity":"0.5","tags":[],"result":{"cleaned_markdown":"x"},"llm":{"model":42,"promptTokens":"12"}}}`
	payload, err := ParsePayload([]byte(raw))
	if err != nil {
		t.Fatalf("ParsePayload: %v", err)
	}
	doc := payload.Document
	if doc.SourceID != nil || doc.SummaryEmbeddingModel != nil || doc.DuplicateSimilarity != nil {
		t.Fatalf("loose optional fields = %+v", doc)
	}
	if doc.LLM.Model != nil || doc.LLM.PromptTokens != nil {
		t.Fatalf("loose llm fields = %+v", doc.LLM)
	}
}

func TestParsePayloadRejectsInvalidShapes(t *testing.T) {
	cases := map[string]string{
		"missing result":   `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","llm":{}}}`,
		"wrong status":     `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"pending","result":{"cleaned_markdown":"x"},"llm":{}}}`,
		"missing markdown": `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{},"llm":{}}}`,
		"null tags":        `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","tags":null,"result":{"cleaned_markdown":"x"},"llm":{}}}`,
		"null topics":      `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{"cleaned_markdown":"x","topics":null},"llm":{}}}`,
		"bad embedding":    `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{"cleaned_markdown":"x"},"llm":{},"summaryEmbedding":[0.1,"x"]}}`,
		"bad stage status": `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{"cleaned_markdown":"x","stage_meta":{"clean":{"status":"unknown"}}},"llm":{}}}`,
		"bad entity":       `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{"cleaned_markdown":"x","entities":[{"name":"x","confidence":1.2}]},"llm":{}}}`,
		"unknown type":     `{"type":"raw_item","document":{}}`,
		"trailing garbage": validPayloadJSON + `x`,
	}
	for name, raw := range cases {
		if _, err := ParsePayload([]byte(raw)); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestParsePayloadStripsUnknownResultKeys(t *testing.T) {
	raw := `{"type":"processed_item","document":{"_id":"a","rawItemId":"b","itemMetaId":"m","orgId":"o","status":"completed","result":{"cleaned_markdown":"x","unknown":"value"},"llm":{}}}`
	payload, err := ParsePayload([]byte(raw))
	if err != nil {
		t.Fatalf("ParsePayload: %v", err)
	}
	encodedBytes, _ := json.Marshal(payload.Document.Result)
	encoded := string(encodedBytes)
	if strings.Contains(encoded, "unknown") {
		t.Fatalf("unknown result key leaked into normalized output: %s", encoded)
	}
}
