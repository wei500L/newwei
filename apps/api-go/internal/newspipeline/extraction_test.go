package newspipeline

// Unit tests for the extraction stage: request shapes, zod-equivalent response
// validation and the permanent classification of empty/invalid LLM output.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

func extractionTestStage() StageContext {
	return StageContext{OrgID: "org-1", JobID: "job-1"}
}

func extractionTestPrompt() PromptConfig {
	return PromptConfig{
		Version:                       "prompt-v1",
		SystemPromptTemplate:          "system {{language_hint}}",
		DenoisePromptTemplate:         "denoise {{noise_type_list}}",
		UserPromptTemplate:            "user {{url}} {{markdown}}",
		EntitySystemPromptTemplate:    "entity-system",
		EntityUserPromptTemplate:      "entity {{title}} {{markdown}}",
		SentimentSystemPromptTemplate: "sentiment-system",
		SentimentUserPromptTemplate:   "sentiment {{summary}} {{markdown}}",
		KGSystemPromptTemplate:        "kg-system",
		KGUserPromptTemplate:          "kg {{title}} {{markdown}}",
	}
}

func extractionTestMetadataFeature(t *testing.T, request litellmcompat.CompletionRequest) string {
	t.Helper()
	metadata, ok := request.Metadata.(litellmcompat.NewsPipelineMetadata)
	if !ok {
		t.Fatalf("metadata type = %T", request.Metadata)
	}
	return metadata.Feature()
}

func TestCleanWithLLMReturnsParsedNewsAndMetadata(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{
		Content:   `{"title":"T","cleaned_markdown":"# T\n\nBody","topics":["ai"]}`,
		Model:     "gpt-clean",
		Usage:     litellmcompat.Usage{PromptTokens: floatPointer(10), CompletionTokens: floatPointer(20), TotalTokens: floatPointer(30), CostUSD: floatPointer(0.5)},
		LatencyMS: floatPointer(1234),
	}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	cleaned, llm, err := extractor.CleanWithLLM(context.Background(), extractionTestStage(), extractionTestPrompt(), CleanLLMInput{
		SystemPrompt:        "system",
		DenoisePrompt:       "denoise",
		UserPrompt:          "user",
		CompletionTimeoutMS: 180000,
	})
	if err != nil {
		t.Fatalf("CleanWithLLM: %v", err)
	}
	if cleaned.Title == nil || *cleaned.Title != "T" || cleaned.CleanedMarkdown != "# T\n\nBody" {
		t.Fatalf("cleaned = %+v", cleaned)
	}
	if len(cleaned.Topics) != 1 || cleaned.Topics[0] != "ai" {
		t.Fatalf("topics = %v", cleaned.Topics)
	}
	if llm.Model == nil || *llm.Model != "gpt-clean" {
		t.Fatalf("llm model = %v", llm.Model)
	}
	if llm.PromptVersion == nil || *llm.PromptVersion != "prompt-v1" {
		t.Fatalf("prompt version = %v", llm.PromptVersion)
	}
	if llm.TotalTokens == nil || *llm.TotalTokens != 30 {
		t.Fatalf("total tokens = %v", llm.TotalTokens)
	}
	if llm.LatencyMS == nil || *llm.LatencyMS != 1234 {
		t.Fatalf("latency = %v", llm.LatencyMS)
	}

	request := models.requests[0]
	if request.OrgID != "org-1" || len(request.Messages) != 3 {
		t.Fatalf("request = %+v", request)
	}
	if request.Messages[0].Role != "system" || request.Messages[1].Role != "user" || request.Messages[2].Role != "user" {
		t.Fatalf("messages = %+v", request.Messages)
	}
	if request.ResponseFormat == nil || request.ResponseFormat.JSONSchema == nil || request.ResponseFormat.JSONSchema.Name != "clean_news_payload" {
		t.Fatalf("response format = %+v", request.ResponseFormat)
	}
	if feature := extractionTestMetadataFeature(t, request); feature != "clean" {
		t.Fatalf("metadata feature = %q", feature)
	}
	if request.Timeout == 0 {
		t.Fatalf("completion timeout was not forwarded")
	}
}

func TestCleanWithLLMPermanentErrors(t *testing.T) {
	cases := []struct {
		name    string
		content string
		message string
	}{
		{name: "empty", content: "", message: "LiteLLM returned empty content"},
		{name: "no json", content: "plain text without json", message: "LiteLLM return was not valid JSON"},
		{name: "unbalanced", content: `{"cleaned_markdown":`, message: "LiteLLM return was not valid JSON"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{Content: testCase.content}}}}
			extractor := NewExtractor(models, NewPromptBuilder())
			_, _, err := extractor.CleanWithLLM(context.Background(), extractionTestStage(), extractionTestPrompt(), CleanLLMInput{})
			if err == nil {
				t.Fatalf("expected an error")
			}
			var permanent *PermanentError
			if !errors.As(err, &permanent) {
				t.Fatalf("error type = %T", err)
			}
			if permanent.Name() != "QueuePermanentError" || permanent.Message != testCase.message {
				t.Fatalf("permanent = %+v", permanent)
			}
		})
	}
}

func TestCleanWithLLMSchemaErrorIsZodError(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{Content: `{"title":"T"}`}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	_, _, err := extractor.CleanWithLLM(context.Background(), extractionTestStage(), extractionTestPrompt(), CleanLLMInput{})
	if err == nil {
		t.Fatalf("expected a schema error")
	}
	var parseError *ParseError
	if !errors.As(err, &parseError) {
		t.Fatalf("error type = %T: %v", err, err)
	}
	if parseError.Name() != "ZodError" {
		t.Fatalf("parse error name = %q", parseError.Name())
	}
}

func TestExtractEntities(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{
		Content: `{"entities":[{"name":"Acme","type":"company","confidence":0.9}]}`,
		Model:   "gpt-entities",
	}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	entities, llm, err := extractor.ExtractEntities(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{Markdown: "article"})
	if err != nil {
		t.Fatalf("ExtractEntities: %v", err)
	}
	if len(entities) != 1 || entities[0].Name != "Acme" || entities[0].Type != "company" || entities[0].Confidence != 0.9 {
		t.Fatalf("entities = %+v", entities)
	}
	if llm == nil || llm.Model == nil || *llm.Model != "gpt-entities" {
		t.Fatalf("llm = %+v", llm)
	}
	request := models.requests[0]
	if request.ResponseFormat.JSONSchema.Name != "news_entity_extraction_response" {
		t.Fatalf("response format name = %q", request.ResponseFormat.JSONSchema.Name)
	}
	if request.Temperature == nil || *request.Temperature != 0 || request.TopP == nil || *request.TopP != 1 {
		t.Fatalf("temperature/top_p = %v/%v", request.Temperature, request.TopP)
	}
	if request.MaxTokens == nil || *request.MaxTokens != 600 {
		t.Fatalf("max tokens = %v", request.MaxTokens)
	}
	if feature := extractionTestMetadataFeature(t, request); feature != "extract_entities" {
		t.Fatalf("metadata feature = %q", feature)
	}
}

func TestExtractEntitiesDefaultsEmptyArray(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{Content: `{}`}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	entities, _, err := extractor.ExtractEntities(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{})
	if err != nil {
		t.Fatalf("ExtractEntities: %v", err)
	}
	if entities == nil || len(entities) != 0 {
		t.Fatalf("entities = %#v", entities)
	}
}

func TestExtractEntitiesRejectsOutOfRangeConfidence(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{
		Content: `{"entities":[{"name":"Acme","type":"company","confidence":2}]}`,
	}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	_, _, err := extractor.ExtractEntities(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{})
	var parseError *ParseError
	if !errors.As(err, &parseError) {
		t.Fatalf("error = %v", err)
	}
	if parseError.Name() != "ZodError" {
		t.Fatalf("error name = %q", parseError.Name())
	}
}

func TestExtractEntitiesRejectsUnsupportedProvider(t *testing.T) {
	extractor := NewExtractor(&contentTestModels{}, NewPromptBuilder())
	if _, _, err := extractor.ExtractEntities(context.Background(), extractionTestStage(), extractionTestPrompt(), "rules", EnrichmentInput{}); err == nil || !strings.Contains(err.Error(), "Unsupported entity provider") {
		t.Fatalf("error = %v", err)
	}
}

func TestAnalyzeSentiment(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{
		Content: `{"sentiment_label":"negative"}`,
		Model:   "gpt-sentiment",
	}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	label, llm, err := extractor.AnalyzeSentiment(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{})
	if err != nil {
		t.Fatalf("AnalyzeSentiment: %v", err)
	}
	if label != "negative" {
		t.Fatalf("label = %q", label)
	}
	if llm == nil {
		t.Fatalf("llm metadata is nil")
	}
	if request := models.requests[0]; request.ResponseFormat.JSONSchema.Name != "news_sentiment_extraction_response" || request.MaxTokens == nil || *request.MaxTokens != 180 {
		t.Fatalf("request = %+v", request)
	}

	invalid := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{Content: `{"sentiment_label":"angry"}`}}}}
	_, _, err = NewExtractor(invalid, NewPromptBuilder()).AnalyzeSentiment(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{})
	var parseError *ParseError
	if !errors.As(err, &parseError) || parseError.Name() != "ZodError" {
		t.Fatalf("invalid enum error = %v", err)
	}
}

func TestExtractKGRelations(t *testing.T) {
	models := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{
		Content: `{"kg_relations":[{"subject":{"name":"Acme","type":"company"},"predicate":"supplies","object":{"name":"Beta","type":"company"},"confidence":0.8,"properties":{"role":"vendor"},"evidence":"Acme supplies Beta"}]}`,
		Model:   "gpt-kg",
	}}}}
	extractor := NewExtractor(models, NewPromptBuilder())
	relations, llm, err := extractor.ExtractKGRelations(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{})
	if err != nil {
		t.Fatalf("ExtractKGRelations: %v", err)
	}
	if len(relations) != 1 {
		t.Fatalf("relations = %+v", relations)
	}
	relation := relations[0]
	if relation.Subject.Name != "Acme" || relation.Predicate != "supplies" || relation.Object.Name != "Beta" || relation.Confidence != 0.8 {
		t.Fatalf("relation = %+v", relation)
	}
	if string(relation.Properties) != `{"role":"vendor"}` {
		t.Fatalf("properties = %s", relation.Properties)
	}
	if relation.Evidence == nil || *relation.Evidence != "Acme supplies Beta" {
		t.Fatalf("evidence = %v", relation.Evidence)
	}
	if llm == nil || llm.Model == nil || *llm.Model != "gpt-kg" {
		t.Fatalf("llm = %+v", llm)
	}
	if request := models.requests[0]; request.ResponseFormat.JSONSchema.Name != "news_kg_extraction_response" || request.MaxTokens == nil || *request.MaxTokens != 900 {
		t.Fatalf("request = %+v", request)
	}

	empty := &contentTestModels{completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{Content: `{}`}}}}
	emptyRelations, _, err := NewExtractor(empty, NewPromptBuilder()).ExtractKGRelations(context.Background(), extractionTestStage(), extractionTestPrompt(), "llm", EnrichmentInput{})
	if err != nil {
		t.Fatalf("empty KG relations: %v", err)
	}
	if emptyRelations == nil || len(emptyRelations) != 0 {
		t.Fatalf("empty relations = %#v", emptyRelations)
	}
}

func TestExtractKGRelationsRejectsUnsupportedProvider(t *testing.T) {
	extractor := NewExtractor(&contentTestModels{}, NewPromptBuilder())
	if _, _, err := extractor.ExtractKGRelations(context.Background(), extractionTestStage(), extractionTestPrompt(), "rules", EnrichmentInput{}); err == nil || !strings.Contains(err.Error(), "Unsupported knowledge graph provider") {
		t.Fatalf("error = %v", err)
	}
}

func TestExtractionStageResponseSchemaNames(t *testing.T) {
	schemas := map[string]string{
		"news_entity_extraction_response":    extractionEntityResponseSchema,
		"news_sentiment_extraction_response": extractionSentimentResponseSchema,
		"news_kg_extraction_response":        extractionKGResponseSchema,
	}
	for name, schema := range schemas {
		var document map[string]any
		if err := json.Unmarshal([]byte(schema), &document); err != nil {
			t.Fatalf("%s: invalid JSON: %v", name, err)
		}
		if document["type"] != "object" {
			t.Fatalf("%s: type = %v", name, document["type"])
		}
		if document["additionalProperties"] != false {
			t.Fatalf("%s: additionalProperties = %v", name, document["additionalProperties"])
		}
	}
}
