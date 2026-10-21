package newspipeline

// This file ports news-extraction-stage.service.ts: the clean-stage LLM call and
// the three enrichment calls (entities, sentiment, knowledge graph), including
// the strict response parsing whose failures are permanent queue errors
// (QueuePermanentError / ZodError), and the zodToJsonSchema response formats the
// enrichment stages pin.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// PermanentError is QueuePermanentError: the worker maps the Name() marker to a
// permanent queue failure instead of retrying.
type PermanentError struct {
	Message string
}

// Error implements error.
func (e *PermanentError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Name returns the QueuePermanentError marker used by classifyQueueError.
func (e *PermanentError) Name() string { return "QueuePermanentError" }

// extractionEntityResponseSchema is zodToJsonSchema(EntityExtractionSchema).
const extractionEntityResponseSchema = `{"type":"object","properties":{"entities":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string","minLength":1},"type":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["name","type","confidence"],"additionalProperties":false},"default":[]}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}`

// extractionSentimentResponseSchema is
// zodToJsonSchema(SentimentExtractionSchema).
const extractionSentimentResponseSchema = `{"type":"object","properties":{"sentiment_label":{"type":"string","enum":["positive","neutral","negative"]}},"required":["sentiment_label"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}`

// extractionKGResponseSchema is zodToJsonSchema(KgRelationExtractionSchema).
const extractionKGResponseSchema = `{"type":"object","properties":{"kg_relations":{"type":"array","items":{"type":"object","properties":{"subject":{"type":"object","properties":{"name":{"type":"string","minLength":1},"type":{"type":"string","minLength":1}},"required":["name","type"],"additionalProperties":false},"predicate":{"type":"string","minLength":1},"object":{"type":"object","properties":{"name":{"type":"string","minLength":1},"type":{"type":"string","minLength":1}},"required":["name","type"],"additionalProperties":false},"confidence":{"type":"number","minimum":0,"maximum":1},"properties":{"type":"object","additionalProperties":{}},"evidence":{"type":["string","null"]}},"required":["subject","predicate","object","confidence"],"additionalProperties":false},"default":[]}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}`

// Extractor is NewsExtractionStageService.
type Extractor struct {
	models  Models
	builder *PromptBuilder
}

// NewExtractor wires the extractor.
func NewExtractor(models Models, builder *PromptBuilder) *Extractor {
	if builder == nil {
		builder = NewPromptBuilder()
	}
	return &Extractor{models: models, builder: builder}
}

// CleanWithLLM is cleanWithLlm.
func (e *Extractor) CleanWithLLM(ctx context.Context, stage StageContext, prompt PromptConfig, input CleanLLMInput) (CleanedNews, LLMMetadata, error) {
	response, err := e.complete(ctx, litellmcompat.CompletionRequest{
		OrgID: stage.OrgID,
		Messages: []litellmcompat.Message{
			{Role: "system", Content: input.SystemPrompt},
			{Role: "user", Content: input.DenoisePrompt},
			{Role: "user", Content: input.UserPrompt},
		},
		ResponseFormat: e.builder.BuildResponseFormat(),
		Metadata: litellmcompat.NewNewsPipelineMetadata(stage.OrgID, stage.JobID).
			AddText("feature", "clean"),
		Timeout: time.Duration(input.CompletionTimeoutMS) * time.Millisecond,
	})
	if err != nil {
		return CleanedNews{}, EmptyLLMMetadata(), err
	}
	raw, err := extractionParseResponse(response.Content)
	if err != nil {
		return CleanedNews{}, EmptyLLMMetadata(), err
	}
	cleaned, err := ParseCleanedNews(raw)
	if err != nil {
		return CleanedNews{}, EmptyLLMMetadata(), err
	}
	return cleaned, extractionLLMMetadata(response, prompt.Version), nil
}

// ExtractEntities is extractEntities.
func (e *Extractor) ExtractEntities(ctx context.Context, stage StageContext, prompt PromptConfig, provider string, input EnrichmentInput) ([]Entity, *LLMMetadata, error) {
	if provider != "llm" {
		return nil, nil, fmt.Errorf("Unsupported entity provider: %s", provider)
	}
	response, err := e.complete(ctx, litellmcompat.CompletionRequest{
		OrgID: stage.OrgID,
		Messages: []litellmcompat.Message{
			{Role: "system", Content: prompt.EntitySystemPromptTemplate},
			{Role: "user", Content: e.builder.BuildEntityPrompt(prompt, input)},
		},
		Temperature:    floatPointer(0),
		TopP:           floatPointer(1),
		MaxTokens:      intPointer(600),
		ResponseFormat: extractionResponseFormat("news_entity_extraction_response", extractionEntityResponseSchema),
		Metadata: litellmcompat.NewNewsPipelineMetadata(stage.OrgID, stage.JobID).
			AddText("feature", "extract_entities"),
	})
	if err != nil {
		return nil, nil, err
	}
	raw, err := extractionParseResponse(response.Content)
	if err != nil {
		return nil, nil, err
	}
	entities, err := extractionParseEntities(raw)
	if err != nil {
		return nil, nil, err
	}
	metadata := extractionLLMMetadata(response, prompt.Version)
	return entities, &metadata, nil
}

// AnalyzeSentiment is analyzeSentiment.
func (e *Extractor) AnalyzeSentiment(ctx context.Context, stage StageContext, prompt PromptConfig, provider string, input EnrichmentInput) (string, *LLMMetadata, error) {
	if provider != "llm" {
		return "", nil, fmt.Errorf("Unsupported sentiment provider: %s", provider)
	}
	response, err := e.complete(ctx, litellmcompat.CompletionRequest{
		OrgID: stage.OrgID,
		Messages: []litellmcompat.Message{
			{Role: "system", Content: prompt.SentimentSystemPromptTemplate},
			{Role: "user", Content: e.builder.BuildSentimentPrompt(prompt, input)},
		},
		Temperature:    floatPointer(0),
		TopP:           floatPointer(1),
		MaxTokens:      intPointer(180),
		ResponseFormat: extractionResponseFormat("news_sentiment_extraction_response", extractionSentimentResponseSchema),
		Metadata: litellmcompat.NewNewsPipelineMetadata(stage.OrgID, stage.JobID).
			AddText("feature", "extract_sentiment"),
	})
	if err != nil {
		return "", nil, err
	}
	raw, err := extractionParseResponse(response.Content)
	if err != nil {
		return "", nil, err
	}
	label, err := extractionParseSentiment(raw)
	if err != nil {
		return "", nil, err
	}
	metadata := extractionLLMMetadata(response, prompt.Version)
	return label, &metadata, nil
}

// ExtractKGRelations is extractKgRelations.
func (e *Extractor) ExtractKGRelations(ctx context.Context, stage StageContext, prompt PromptConfig, provider string, input EnrichmentInput) ([]KGRelation, *LLMMetadata, error) {
	if provider != "llm" {
		return nil, nil, fmt.Errorf("Unsupported knowledge graph provider: %s", provider)
	}
	response, err := e.complete(ctx, litellmcompat.CompletionRequest{
		OrgID: stage.OrgID,
		Messages: []litellmcompat.Message{
			{Role: "system", Content: prompt.KGSystemPromptTemplate},
			{Role: "user", Content: e.builder.BuildKgPrompt(prompt, input)},
		},
		Temperature:    floatPointer(0),
		TopP:           floatPointer(1),
		MaxTokens:      intPointer(900),
		ResponseFormat: extractionResponseFormat("news_kg_extraction_response", extractionKGResponseSchema),
		Metadata: litellmcompat.NewNewsPipelineMetadata(stage.OrgID, stage.JobID).
			AddText("feature", "extract_kg"),
	})
	if err != nil {
		return nil, nil, err
	}
	raw, err := extractionParseResponse(response.Content)
	if err != nil {
		return nil, nil, err
	}
	relations, err := extractionParseKGRelations(raw)
	if err != nil {
		return nil, nil, err
	}
	metadata := extractionLLMMetadata(response, prompt.Version)
	return relations, &metadata, nil
}

// complete runs one completion, guarding a missing model client.
func (e *Extractor) complete(ctx context.Context, request litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
	if e == nil || e.models == nil {
		return litellmcompat.CompletionResponse{}, errors.New("news pipeline model client is not configured")
	}
	return e.models.Completion(ctx, request)
}

// extractionResponseFormat builds one json_schema response format.
func extractionResponseFormat(name, schema string) *litellmcompat.ResponseFormat {
	return &litellmcompat.ResponseFormat{
		Type: "json_schema",
		JSONSchema: &litellmcompat.JSONSchemaFormat{
			Name:   name,
			Schema: json.RawMessage(schema),
		},
	}
}

// extractionLLMMetadata is toStageLlmMetadata without the provider member.
func extractionLLMMetadata(response litellmcompat.CompletionResponse, promptVersion string) LLMMetadata {
	metadata := EmptyLLMMetadata()
	metadata.Model = stringPointer(response.Model)
	metadata.PromptVersion = stringPointer(promptVersion)
	metadata.PromptTokens = response.Usage.PromptTokens
	metadata.CompletionTokens = response.Usage.CompletionTokens
	metadata.TotalTokens = response.Usage.TotalTokens
	metadata.CostUSD = response.Usage.CostUSD
	metadata.LatencyMS = response.LatencyMS
	return metadata
}

// extractionParseResponse is parseStageResponse's JSON extraction: empty content
// and unparseable JSON are permanent errors. ExtractFirstJSON (news-config) is
// the byte-exact port of common/llm-json.ts extractFirstJson.
func extractionParseResponse(content string) (json.RawMessage, error) {
	if content == "" {
		return nil, &PermanentError{Message: "LiteLLM returned empty content"}
	}
	jsonText := ExtractFirstJSON(content)
	if jsonText == "" {
		return nil, &PermanentError{Message: "LiteLLM return was not valid JSON"}
	}
	trimmed := bytes.TrimSpace([]byte(jsonText))
	if !json.Valid(trimmed) {
		return nil, &PermanentError{Message: "LiteLLM return was not valid JSON"}
	}
	return json.RawMessage(trimmed), nil
}

// --- zod-equivalent response validation ------------------------------------

// extractionParseEntities validates EntityExtractionSchema.
func extractionParseEntities(raw json.RawMessage) ([]Entity, error) {
	object, err := extractionRequireObject(raw, "")
	if err != nil {
		return nil, err
	}
	value, present := object["entities"]
	if !present {
		return []Entity{}, nil
	}
	if contentIsNullishJSON(value) {
		return nil, extractionTypeError("entities", "array", value)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(value, &items); err != nil {
		return nil, extractionTypeError("entities", "array", value)
	}
	entities := make([]Entity, 0, len(items))
	for index, item := range items {
		path := fmt.Sprintf("entities.%d", index)
		entry, err := extractionRequireObject(item, path)
		if err != nil {
			return nil, err
		}
		name, err := extractionRequiredString(entry, "name", path)
		if err != nil {
			return nil, err
		}
		entityType, err := extractionRequiredString(entry, "type", path)
		if err != nil {
			return nil, err
		}
		confidence, err := extractionRequiredConfidence(entry, "confidence", path)
		if err != nil {
			return nil, err
		}
		entities = append(entities, Entity{Name: *name, Type: *entityType, Confidence: *confidence})
	}
	return entities, nil
}

// extractionParseSentiment validates SentimentExtractionSchema.
func extractionParseSentiment(raw json.RawMessage) (string, error) {
	object, err := extractionRequireObject(raw, "")
	if err != nil {
		return "", err
	}
	value, present := object["sentiment_label"]
	if !present || contentIsNullishJSON(value) {
		return "", extractionRequiredError("sentiment_label")
	}
	label, err := extractionStringValue(value, "sentiment_label")
	if err != nil {
		return "", err
	}
	switch *label {
	case "positive", "neutral", "negative":
		return *label, nil
	default:
		return "", &ParseError{
			Path:    "sentiment_label",
			Message: "Invalid enum value. Expected 'positive' | 'neutral' | 'negative', received '" + *label + "'",
		}
	}
}

// extractionParseKGRelations validates KgRelationExtractionSchema.
func extractionParseKGRelations(raw json.RawMessage) ([]KGRelation, error) {
	object, err := extractionRequireObject(raw, "")
	if err != nil {
		return nil, err
	}
	value, present := object["kg_relations"]
	if !present {
		return []KGRelation{}, nil
	}
	if contentIsNullishJSON(value) {
		return nil, extractionTypeError("kg_relations", "array", value)
	}
	var items []json.RawMessage
	if err := json.Unmarshal(value, &items); err != nil {
		return nil, extractionTypeError("kg_relations", "array", value)
	}
	relations := make([]KGRelation, 0, len(items))
	for index, item := range items {
		path := fmt.Sprintf("kg_relations.%d", index)
		entry, err := extractionRequireObject(item, path)
		if err != nil {
			return nil, err
		}
		subject, err := extractionParseEntityRef(entry, "subject", path)
		if err != nil {
			return nil, err
		}
		predicate, err := extractionRequiredString(entry, "predicate", path)
		if err != nil {
			return nil, err
		}
		objectRef, err := extractionParseEntityRef(entry, "object", path)
		if err != nil {
			return nil, err
		}
		confidence, err := extractionRequiredConfidence(entry, "confidence", path)
		if err != nil {
			return nil, err
		}
		var properties json.RawMessage
		if propertiesRaw, ok := entry["properties"]; ok {
			// optionalJsonObject preprocesses every non-object (including null)
			// to undefined, so it can never reject a value.
			if !contentIsNullishJSON(propertiesRaw) && contentIsJSONObject(propertiesRaw) {
				properties = contentTrimJSON(propertiesRaw)
			}
		}
		var evidence *string
		if evidenceRaw, ok := entry["evidence"]; ok && !contentIsNullishJSON(evidenceRaw) {
			evidenceValue, err := extractionStringValue(evidenceRaw, path+".evidence")
			if err != nil {
				return nil, err
			}
			evidence = evidenceValue
		}
		relations = append(relations, KGRelation{
			Subject:    *subject,
			Predicate:  *predicate,
			Object:     *objectRef,
			Confidence: *confidence,
			Properties: properties,
			Evidence:   evidence,
		})
	}
	return relations, nil
}

// extractionParseEntityRef validates KgEntityRefSchema.
func extractionParseEntityRef(object map[string]json.RawMessage, key, path string) (*KGEntityRef, error) {
	fieldPath := path + "." + key
	value, present := object[key]
	if !present || contentIsNullishJSON(value) {
		return nil, extractionRequiredError(fieldPath)
	}
	entry, err := extractionRequireObject(value, fieldPath)
	if err != nil {
		return nil, err
	}
	name, err := extractionRequiredString(entry, "name", fieldPath)
	if err != nil {
		return nil, err
	}
	refType, err := extractionRequiredString(entry, "type", fieldPath)
	if err != nil {
		return nil, err
	}
	return &KGEntityRef{Name: *name, Type: *refType}, nil
}

// extractionRequireObject asserts a JSON object.
func extractionRequireObject(raw json.RawMessage, path string) (map[string]json.RawMessage, error) {
	trimmed := contentTrimJSON(raw)
	if len(trimmed) == 0 || !contentIsJSONObject(trimmed) {
		return nil, extractionTypeError(path, "object", raw)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil {
		return nil, extractionTypeError(path, "object", raw)
	}
	return object, nil
}

// extractionRequiredString validates a non-empty required string member.
func extractionRequiredString(object map[string]json.RawMessage, key, path string) (*string, error) {
	fieldPath := path + "." + key
	if path == "" {
		fieldPath = key
	}
	value, present := object[key]
	if !present || contentIsNullishJSON(value) {
		return nil, extractionRequiredError(fieldPath)
	}
	text, err := extractionStringValue(value, fieldPath)
	if err != nil {
		return nil, err
	}
	if *text == "" {
		return nil, &ParseError{Path: fieldPath, Message: "String must contain at least 1 character(s)"}
	}
	return text, nil
}

// extractionStringValue asserts a JSON string.
func extractionStringValue(raw json.RawMessage, path string) (*string, error) {
	trimmed := contentTrimJSON(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return nil, extractionTypeError(path, "string", raw)
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil, extractionTypeError(path, "string", raw)
	}
	return &value, nil
}

// extractionRequiredConfidence validates a required 0..1 number member.
func extractionRequiredConfidence(object map[string]json.RawMessage, key, path string) (*float64, error) {
	fieldPath := path + "." + key
	if path == "" {
		fieldPath = key
	}
	value, present := object[key]
	if !present || contentIsNullishJSON(value) {
		return nil, extractionRequiredError(fieldPath)
	}
	var number float64
	if err := json.Unmarshal(value, &number); err != nil {
		return nil, extractionTypeError(fieldPath, "number", value)
	}
	if number < 0 || number > 1 {
		return nil, &ParseError{Path: fieldPath, Message: "Number must be between 0 and 1"}
	}
	return &number, nil
}

// extractionTypeError builds the zod invalid_type error.
func extractionTypeError(path, expected string, raw json.RawMessage) error {
	return &ParseError{
		Path:    path,
		Message: "Expected " + expected + ", received " + extractionJSONType(raw),
	}
}

// extractionRequiredError builds the zod required error.
func extractionRequiredError(path string) error {
	return &ParseError{Path: path, Message: "Required"}
}

// extractionJSONType names the received JSON type like zod does.
func extractionJSONType(raw json.RawMessage) string {
	trimmed := contentTrimJSON(raw)
	if len(trimmed) == 0 {
		return "undefined"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		return "number"
	}
}
