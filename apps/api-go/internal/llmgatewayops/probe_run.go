package llmgatewayops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// Diagnostic defaults, copied verbatim from the NestJS test service.
const (
	// defaultPrompt is the completion probe prompt.
	defaultPrompt = `Say "OK" and nothing else.`
	// defaultEmbeddingInput is the embeddings probe input.
	defaultEmbeddingInput = "hello"
	// defaultRerankQuery is the rerank probe query.
	defaultRerankQuery = "latest US inflation outlook and Fed policy"
	// defaultTemperature is the fallback completion temperature.
	defaultTemperature = 0.2
	// defaultTopP is the fallback completion top_p.
	defaultTopP = 0.9
	// defaultMaxOutputTokens is the fallback completion token budget.
	defaultMaxOutputTokens = 1_200
	// defaultResponseFormatMode is the fallback response_format probe.
	defaultResponseFormatMode = "json_schema"
	// defaultSendMetadata is the fallback metadata probe switch.
	defaultSendMetadata = true
	// gatewayTestFeature is the feature tag of every probe log row.
	gatewayTestFeature = "gateway_test"
	// unknownOrgID is the orgId used when the actor is unknown.
	unknownOrgID = "_unknown_"
	// probeMaxOutputTokens caps a completion probe at 128 output tokens: a
	// diagnostic must never be able to spend a full production budget.
	probeMaxOutputTokens = 128
	// lbMaxTokens is the fixed LB attempt token budget.
	lbMaxTokens = 16
	// maxCallIDSamples and maxProbeErrors cap the LB response arrays.
	maxCallIDSamples = 20
	maxProbeErrors   = 10
)

// defaultRerankDocuments are the built-in rerank probe documents.
var defaultRerankDocuments = []string{
	"Federal Reserve officials signaled rates may stay higher for longer as inflation remains sticky.",
	"Quarterly earnings beat estimates as cloud revenue accelerated and margins improved.",
	"Oil prices rose after unexpected inventory draw, pressuring transportation and input costs.",
}

// probeActor is the audit/log attribution of one diagnostic request.
type probeActor struct {
	OrgID  string
	UserID string
}

// probeSettings is the resolved effective configuration of one diagnostic run.
type probeSettings struct {
	ProfileID       string
	AuthMode        string
	APIKey          string
	Model           string
	EmbeddingModel  string
	RerankModel     string
	FallbackModels  []string
	RerankFallbacks []string
	Timeout         time.Duration
	Temperature     float64
	TopP            float64
	MaxOutputTokens float64
}

// responseFormat is the response_format probe payload.
type responseFormat struct {
	Type       string               `json:"type"`
	JSONSchema *jsonSchemaContainer `json:"json_schema,omitempty"`
}

// jsonSchemaContainer is the named JSON schema of the probe.
type jsonSchemaContainer struct {
	Name   string         `json:"name"`
	Schema jsonSchemaBody `json:"schema"`
}

// jsonSchemaBody is the schema body of the probe.
type jsonSchemaBody struct {
	Type                 string                        `json:"type"`
	AdditionalProperties bool                          `json:"additionalProperties"`
	Properties           map[string]jsonSchemaProperty `json:"properties"`
	Required             []string                      `json:"required"`
}

// jsonSchemaProperty is one schema property.
type jsonSchemaProperty struct {
	Type string `json:"type"`
}

// probeRequestMetadata is the metadata probe payload.
type probeRequestMetadata struct {
	Source string `json:"source"`
}

// newProbeRequestMetadata builds the fixed metadata probe value.
func newProbeRequestMetadata() *probeRequestMetadata {
	return &probeRequestMetadata{Source: "gateway-test"}
}

// resolveResponseFormatProbe mirrors resolveResponseFormatProbe: "none" sends no
// field at all instead of an explicit null.
func resolveResponseFormatProbe(mode string) *responseFormat {
	switch mode {
	case "", "none":
		return nil
	case "json_object":
		return &responseFormat{Type: "json_object"}
	default:
		return &responseFormat{
			Type: "json_schema",
			JSONSchema: &jsonSchemaContainer{
				Name: "gateway_test_response",
				Schema: jsonSchemaBody{
					Type:                 "object",
					AdditionalProperties: false,
					Properties:           map[string]jsonSchemaProperty{"answer": {Type: "string"}},
					Required:             []string{"answer"},
				},
			},
		}
	}
}

// chatMessage is one chat message.
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chatCompletionPayload is the /v1/chat/completions body.
type chatCompletionPayload struct {
	Model          string                `json:"model"`
	Messages       []chatMessage         `json:"messages"`
	Temperature    float64               `json:"temperature"`
	TopP           float64               `json:"top_p"`
	MaxTokens      int                   `json:"max_tokens"`
	Stream         bool                  `json:"stream"`
	ResponseFormat *responseFormat       `json:"response_format,omitempty"`
	Metadata       *probeRequestMetadata `json:"metadata,omitempty"`
}

// responsesPayload is the /v1/responses body. It is a distinct type on purpose:
// a diagnostic must not silently become a chat request.
type responsesPayload struct {
	Model           string                `json:"model"`
	Input           string                `json:"input"`
	Temperature     float64               `json:"temperature"`
	TopP            float64               `json:"top_p"`
	MaxOutputTokens int                   `json:"max_output_tokens"`
	ResponseFormat  *responseFormat       `json:"response_format,omitempty"`
	Metadata        *probeRequestMetadata `json:"metadata,omitempty"`
}

// embeddingPayload is the /v1/embeddings body.
type embeddingPayload struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

// rerankPayload is the /v1/rerank body.
type rerankPayload struct {
	Model     string                `json:"model"`
	Query     string                `json:"query"`
	Documents []string              `json:"documents"`
	TopN      int                   `json:"top_n"`
	Metadata  *probeRequestMetadata `json:"metadata,omitempty"`
}

// chatCompletionBody is the tolerant decode of one chat completion response.
type chatCompletionBody struct {
	Model        json.RawMessage   `json:"model"`
	Choices      []json.RawMessage `json:"choices"`
	Usage        json.RawMessage   `json:"usage"`
	ResponseCost json.RawMessage   `json:"response_cost"`
}

// responsesBody is the tolerant decode of one Responses API response.
type responsesBody struct {
	Model        json.RawMessage       `json:"model"`
	OutputText   json.RawMessage       `json:"output_text"`
	Output       []responsesOutputItem `json:"output"`
	Usage        json.RawMessage       `json:"usage"`
	ResponseCost json.RawMessage       `json:"response_cost"`
}

// responsesOutputItem is one output item.
type responsesOutputItem struct {
	Content []responsesContentPart `json:"content"`
}

// responsesContentPart is one output text part.
type responsesContentPart struct {
	Text json.RawMessage `json:"text"`
}

// embeddingBody is the tolerant decode of one embeddings response.
type embeddingBody struct {
	Model        json.RawMessage   `json:"model"`
	Data         []json.RawMessage `json:"data"`
	Usage        json.RawMessage   `json:"usage"`
	ResponseCost json.RawMessage   `json:"response_cost"`
}

// rerankBody is the tolerant decode of one rerank response. Results and Data
// stay raw tokens because the NestJS source branches on Array.isArray, which
// distinguishes an ABSENT list from an EMPTY one.
type rerankBody struct {
	Model        json.RawMessage `json:"model"`
	Results      json.RawMessage `json:"results"`
	Data         json.RawMessage `json:"data"`
	ResponseCost json.RawMessage `json:"response_cost"`
}

// chatTestResult is one completion probe result.
type chatTestResult struct {
	Model        string          `json:"model"`
	Content      *string         `json:"content"`
	FinishReason *string         `json:"finishReason,omitempty"`
	LatencyMS    int             `json:"latencyMs"`
	Usage        json.RawMessage `json:"usage,omitempty"`
	CostUSD      *float64        `json:"costUsd,omitempty"`
	KeySpendUSD  *float64        `json:"keySpendUsd,omitempty"`
	CallID       *string         `json:"callId,omitempty"`
	ModelID      *string         `json:"modelId,omitempty"`
	ModelAPIBase *string         `json:"modelApiBase,omitempty"`
	ModelGroup   *string         `json:"modelGroup,omitempty"`
	ProxyVersion *string         `json:"proxyVersion,omitempty"`
}

// embeddingTestResult is one embeddings probe result.
type embeddingTestResult struct {
	Model        string          `json:"model"`
	Dimensions   int             `json:"dimensions"`
	LatencyMS    int             `json:"latencyMs"`
	Usage        json.RawMessage `json:"usage,omitempty"`
	CostUSD      *float64        `json:"costUsd,omitempty"`
	KeySpendUSD  *float64        `json:"keySpendUsd,omitempty"`
	CallID       *string         `json:"callId,omitempty"`
	ModelID      *string         `json:"modelId,omitempty"`
	ModelAPIBase *string         `json:"modelApiBase,omitempty"`
	ModelGroup   *string         `json:"modelGroup,omitempty"`
	ProxyVersion *string         `json:"proxyVersion,omitempty"`
}

// rerankScore is one scored rerank row.
type rerankScore struct {
	Index int     `json:"index"`
	Score float64 `json:"score"`
}

// rerankTestResult is one rerank probe result.
type rerankTestResult struct {
	Model        string        `json:"model"`
	TopN         int           `json:"topN"`
	LatencyMS    int           `json:"latencyMs"`
	Results      []rerankScore `json:"results"`
	CostUSD      *float64      `json:"costUsd,omitempty"`
	KeySpendUSD  *float64      `json:"keySpendUsd,omitempty"`
	CallID       *string       `json:"callId,omitempty"`
	ModelID      *string       `json:"modelId,omitempty"`
	ModelAPIBase *string       `json:"modelApiBase,omitempty"`
	ModelGroup   *string       `json:"modelGroup,omitempty"`
	ProxyVersion *string       `json:"proxyVersion,omitempty"`
}

// testResult is the diagnostic response.
type testResult struct {
	APIBase         string               `json:"apiBase"`
	AuthModeUsed    string               `json:"authModeUsed"`
	APISurfaceUsed  string               `json:"apiSurfaceUsed,omitempty"`
	Compatibility   *compatibilityInfo   `json:"compatibilityError,omitempty"`
	Completion      *chatTestResult      `json:"completion,omitempty"`
	CompletionError *testError           `json:"completionError,omitempty"`
	Embedding       *embeddingTestResult `json:"embedding,omitempty"`
	EmbeddingError  *testError           `json:"embeddingError,omitempty"`
	Rerank          *rerankTestResult    `json:"rerank,omitempty"`
	RerankError     *testError           `json:"rerankError,omitempty"`
}

// ---- model request helpers ----

// probeCall describes one logged model attempt.
type probeCall struct {
	Client       upstreamClient
	PrimaryPath  string
	FallbackPath string
	Body         []byte
	RequestType  llmlogs.ProbeRequestType
	APISurface   string
	Model        string
	Log          probeLogContext
	// LogSuccess controls WHEN the success row is written: immediately after a
	// 2xx for a completion, and only after the body was validated for an
	// embedding/rerank. The latter therefore passes false and records the row
	// itself, so an invalid 2xx body is logged once as an error instead of twice.
	LogSuccess bool
}

// postProbe performs one logged POST with the 404/405 short-path fallback and
// returns the response plus the measured latency.
func (s *Service) postProbe(ctx context.Context, call probeCall) (upstreamResponse, int, error) {
	startedAt := time.Now()
	response, err := call.Client.postBodyWithFallback(ctx, call.PrimaryPath, call.FallbackPath, call.Body)
	latencyMS := int(time.Since(startedAt).Milliseconds())
	if err != nil {
		s.recordProbe(ctx, call, nil, err, latencyMS)
		return upstreamResponse{}, latencyMS, err
	}
	if call.LogSuccess {
		s.recordProbe(ctx, call, &response, nil, latencyMS)
	}
	return response, latencyMS, nil
}

// recordProbe writes one llmrequestlogs row. A Mongo failure is logged and
// ignored: the diagnostic response is already computed and must still be returned.
func (s *Service) recordProbe(ctx context.Context, call probeCall, response *upstreamResponse, err error, latencyMS int) {
	if s.logs == nil {
		return
	}
	entry := llmlogs.ProbeLogEntry{
		OrgID:             call.Log.OrgID,
		RequestType:       call.RequestType,
		APISurface:        logSurface(call.APISurface),
		Model:             call.Model,
		Status:            "success",
		Latency:           time.Duration(latencyMS) * time.Millisecond,
		GatewayProfileID:  call.Log.ProfileID,
		GovernanceApplied: call.Log.AuthMode == authModeManagedKey,
		AuthMode:          call.Log.AuthMode,
		Metadata: llmlogs.ProbeMetadata{
			Source:    "gateway-test",
			Feature:   gatewayTestFeature,
			Operation: string(call.RequestType),
			Model:     call.Model,
			ProfileID: call.Log.ProfileID,
			UserID:    call.Log.UserID,
		},
		OccurredAt: s.nowUTC(),
	}
	if call.Log.AuthMode == authModeManagedKey {
		entry.GovernanceTargetProfileID = call.Log.ProfileID
	}
	if response != nil {
		entry.Usage = probeUsageOf(call.RequestType, *response)
		if model := responseModelOf(response.body); model != "" {
			// The top-level model reports what the upstream actually served;
			// metadata.model keeps the REQUESTED model so a fallback is visible.
			entry.Model = model
		}
	}
	if err != nil || response == nil {
		entry.Status = "error"
		info := toGatewayErrorInfo(err, errorContext{apiSurface: call.APISurface})
		entry.Error = info.Message
		entry.Metadata.Tags = []string{"diagnostic", "error"}
	}
	if writeErr := s.logs.WriteProbe(ctx, entry); writeErr != nil {
		// Mongo persistence is best effort: the diagnostic result is already
		// computed and a log outage must not turn it into a failed request.
		log.Printf("llmgatewayops: failed to persist one gateway probe log row: %v", writeErr)
	}
}

// ---- completion ----

// runCompletion mirrors testCompletion and testResponses: it walks the unique
// model list in order and stops at the first compatibility rejection instead of
// hiding it behind a fallback attempt.
func (s *Service) runCompletion(ctx context.Context, client upstreamClient, settings probeSettings, prompt string, modelOverride string, options completionOptions) (*chatTestResult, *testError) {
	models := uniqueModels(modelOverride, settings.Model, settings.FallbackModels)
	if len(models) == 0 {
		info := gatewayErrorInfo{Code: errorCodeModelRequired, Message: "model is not configured"}
		rendered := info.toTestError()
		return nil, &rendered
	}

	var lastErr error
	for _, model := range models {
		result, latencyMS, err := s.completionAttempt(ctx, client, settings, prompt, model, options)
		if err == nil {
			result.LatencyMS = latencyMS
			return result, nil
		}
		lastErr = err
		var compatibility *compatibilityError
		if errors.As(err, &compatibility) {
			break
		}
	}
	info := toGatewayErrorInfo(lastErr, errorContext{apiKeyConfigured: boolPointer(settings.APIKey != ""), apiSurface: options.APISurface})
	rendered := info.toTestError()
	return nil, &rendered
}

// completionOptions carries the resolved probe switches of one run.
type completionOptions struct {
	APISurface           string
	ResponseFormatMode   string
	IncludeMetadataProbe bool
	Log                  probeLogContext
}

// completionAttempt performs one model attempt.
func (s *Service) completionAttempt(ctx context.Context, client upstreamClient, settings probeSettings, prompt, model string, options completionOptions) (*chatTestResult, int, error) {
	responseFormat := resolveResponseFormatProbe(options.ResponseFormatMode)
	var metadata *probeRequestMetadata
	if options.IncludeMetadataProbe {
		metadata = newProbeRequestMetadata()
	}
	maxTokens := int(math.Min(math.Max(1, settings.MaxOutputTokens), probeMaxOutputTokens))

	primaryPath := "/v1/chat/completions"
	fallbackPath := "/chat/completions"
	var body []byte
	var marshalErr error
	if options.APISurface == surfaceResponses {
		primaryPath = "/v1/responses"
		fallbackPath = "/responses"
		body, marshalErr = json.Marshal(responsesPayload{
			Model:           model,
			Input:           prompt,
			Temperature:     settings.Temperature,
			TopP:            settings.TopP,
			MaxOutputTokens: maxTokens,
			ResponseFormat:  responseFormat,
			Metadata:        metadata,
		})
	} else {
		body, marshalErr = json.Marshal(chatCompletionPayload{
			Model:          model,
			Messages:       []chatMessage{{Role: "user", Content: prompt}},
			Temperature:    settings.Temperature,
			TopP:           settings.TopP,
			MaxTokens:      maxTokens,
			Stream:         false,
			ResponseFormat: responseFormat,
			Metadata:       metadata,
		})
	}
	if marshalErr != nil {
		return nil, 0, marshalErr
	}

	response, latencyMS, err := s.postProbe(ctx, probeCall{
		Client:       client,
		PrimaryPath:  primaryPath,
		FallbackPath: fallbackPath,
		Body:         body,
		RequestType:  llmlogs.ProbeRequestCompletion,
		APISurface:   options.APISurface,
		Model:        model,
		Log:          options.Log,
		LogSuccess:   true,
	})
	if err != nil {
		return nil, latencyMS, err
	}

	result := &chatTestResult{Model: requestedModel(response.body, model), LatencyMS: latencyMS}
	applyLiteLlmCosts(result, response)
	if options.APISurface == surfaceResponses {
		var decoded responsesBody
		if err := json.Unmarshal(response.body, &decoded); err != nil {
			// A 2xx body that is not JSON keeps content=null, exactly like the
			// source reading undefined fields on an already-parsed body.
			return result, latencyMS, nil
		}
		result.Content = extractResponsesOutputText(decoded)
		return result, latencyMS, nil
	}
	var decoded chatCompletionBody
	if err := json.Unmarshal(response.body, &decoded); err != nil {
		return result, latencyMS, nil
	}
	if len(decoded.Choices) > 0 {
		result.Content = extractOpenAITextFromChoice(decoded.Choices[0])
		result.FinishReason = choiceFinishReason(decoded.Choices[0])
	}
	if len(decoded.Usage) > 0 && string(decoded.Usage) != "null" {
		result.Usage = decoded.Usage
	}
	return result, latencyMS, nil
}

// ---- embedding ----

// runEmbedding mirrors testEmbeddings. The success row is written only after the
// vector was validated, so one attempt produces exactly one log row.
func (s *Service) runEmbedding(ctx context.Context, client upstreamClient, cfg embeddingConfig, input, modelOverride string, log probeLogContext) (*embeddingTestResult, error) {
	model := firstNonEmpty(strings.TrimSpace(modelOverride), strings.TrimSpace(cfg.EmbeddingModel), strings.TrimSpace(cfg.Model))
	if model == "" {
		return nil, codedBadRequest(errorCodeEmbeddingModelRequired, "embedding model is not configured")
	}
	body, err := json.Marshal(embeddingPayload{Model: model, Input: input})
	if err != nil {
		return nil, err
	}
	call := probeCall{
		Client:       client,
		PrimaryPath:  "/v1/embeddings",
		FallbackPath: "/embeddings",
		Body:         body,
		RequestType:  llmlogs.ProbeRequestEmbedding,
		APISurface:   surfaceEmbeddings,
		Model:        model,
		Log:          log,
		LogSuccess:   false,
	}
	response, latencyMS, err := s.postProbe(ctx, call)
	if err != nil {
		return nil, err
	}
	var decoded embeddingBody
	if unmarshalErr := json.Unmarshal(response.body, &decoded); unmarshalErr != nil {
		invalid := badGateway(errorCodeInvalidEmbeddingResponse, "Embedding response did not include an embedding vector")
		s.recordProbe(ctx, call, &response, invalid, latencyMS)
		return nil, invalid
	}
	dimensions := 0
	if len(decoded.Data) > 0 {
		dimensions = embeddingDimensions(decoded.Data[0])
	}
	if dimensions == 0 {
		invalid := badGateway(errorCodeInvalidEmbeddingResponse, "Embedding response did not include an embedding vector")
		s.recordProbe(ctx, call, &response, invalid, latencyMS)
		return nil, invalid
	}
	s.recordProbe(ctx, call, &response, nil, latencyMS)

	result := &embeddingTestResult{
		Model:      firstNonEmpty(rawString(decoded.Model), model),
		Dimensions: dimensions,
		LatencyMS:  latencyMS,
	}
	if len(decoded.Usage) > 0 && string(decoded.Usage) != "null" {
		result.Usage = decoded.Usage
	}
	applyEmbeddingLiteLlmCosts(result, response)
	return result, nil
}

// embeddingConfig is the embedding-relevant slice of the settings.
type embeddingConfig struct {
	Model          string
	EmbeddingModel string
}

// embeddingDimensions reports the vector length, or 0 when the entry is not a
// non-empty array.
func embeddingDimensions(raw json.RawMessage) int {
	var vector []json.RawMessage
	if err := json.Unmarshal(raw, &vector); err != nil {
		return 0
	}
	return len(vector)
}

// ---- rerank ----

// rerankConfig is the rerank-relevant slice of the settings.
type rerankConfig struct {
	Model     string
	Rerank    string
	Fallbacks []string
}

// runRerank mirrors testRerank. Results are sorted by index (not by score), and
// a 2xx without a valid scored row is an error rather than an empty success.
func (s *Service) runRerank(ctx context.Context, client upstreamClient, cfg rerankConfig, options rerankOptions) (*rerankTestResult, error) {
	query := strings.TrimSpace(options.Query)
	if query == "" {
		return nil, codedBadRequest(errorCodeRerankQueryRequired, "rerank query is required")
	}
	documents := normalizeDocuments(options.Documents)
	if len(documents) == 0 {
		return nil, codedBadRequest(errorCodeRerankDocumentsRequired, "rerank documents are required")
	}

	candidates := uniqueRerankModels(options.ModelOverride, cfg.Rerank, cfg.Fallbacks)
	if len(candidates) == 0 {
		return nil, codedBadRequest(errorCodeRerankModelRequired, "rerank model is not configured")
	}

	var lastErr error
	for _, model := range candidates {
		result, err := s.rerankAttempt(ctx, client, model, query, documents, options)
		if err == nil {
			return result, nil
		}
		lastErr = err
		var compatibility *compatibilityError
		if errors.As(err, &compatibility) {
			break
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, badGateway(errorCodeRerankTestFailed, "LLM gateway rerank test failed")
}

// rerankOptions carries the rerank probe inputs.
type rerankOptions struct {
	Query                string
	Documents            []string
	ModelOverride        string
	IncludeMetadataProbe bool
	Log                  probeLogContext
}

// rerankAttempt performs one rerank model attempt.
func (s *Service) rerankAttempt(ctx context.Context, client upstreamClient, model, query string, documents []string, options rerankOptions) (*rerankTestResult, error) {
	var metadata *probeRequestMetadata
	if options.IncludeMetadataProbe {
		metadata = newProbeRequestMetadata()
	}
	body, err := json.Marshal(rerankPayload{
		Model:     model,
		Query:     query,
		Documents: documents,
		TopN:      len(documents),
		Metadata:  metadata,
	})
	if err != nil {
		return nil, err
	}
	call := probeCall{
		Client:       client,
		PrimaryPath:  "/v1/rerank",
		FallbackPath: "/rerank",
		Body:         body,
		RequestType:  llmlogs.ProbeRequestRerank,
		APISurface:   surfaceRerank,
		Model:        model,
		Log:          options.Log,
		LogSuccess:   false,
	}
	response, latencyMS, err := s.postProbe(ctx, call)
	if err != nil {
		return nil, err
	}
	var decoded rerankBody
	if unmarshalErr := json.Unmarshal(response.body, &decoded); unmarshalErr != nil {
		invalid := badGateway(errorCodeInvalidRerankResponse, "Rerank response did not include scored results")
		s.recordProbe(ctx, call, &response, invalid, latencyMS)
		return nil, invalid
	}
	results := normalizeRerankResults(decoded)
	if len(results) == 0 {
		invalid := badGateway(errorCodeInvalidRerankResponse, "Rerank response did not include scored results")
		s.recordProbe(ctx, call, &response, invalid, latencyMS)
		return nil, invalid
	}
	s.recordProbe(ctx, call, &response, nil, latencyMS)

	topN := len(results)
	if len(documents) < topN {
		topN = len(documents)
	}
	result := &rerankTestResult{
		Model:     firstNonEmpty(strings.TrimSpace(rawString(decoded.Model)), model),
		TopN:      topN,
		LatencyMS: latencyMS,
		Results:   results,
	}
	applyRerankLiteLlmCosts(result, response)
	return result, nil
}

// normalizeRerankResults mirrors normalizeRerankResults: accept results or data,
// normalise the four score spellings, keep integral indexes and finite scores,
// then sort by index.
//
// The list is chosen with Array.isArray semantics: a PRESENT `results` array wins
// even when it is empty, so `{"results":[],"data":[...]}` is an empty (invalid)
// result rather than a silent fallback to `data`.
func normalizeRerankResults(payload rerankBody) []rerankScore {
	rawResults, isArray := jsonArrayItems(payload.Results)
	if !isArray {
		rawResults, _ = jsonArrayItems(payload.Data)
	}
	scored := make([]rerankScore, 0, len(rawResults))
	for _, raw := range rawResults {
		value, err := parseFlexValue(raw)
		if err != nil || value.kind != flexObject {
			continue
		}
		index, indexOK := rerankIndex(value)
		score, scoreOK := rerankScoreValue(value)
		if !indexOK || !scoreOK {
			continue
		}
		scored = append(scored, rerankScore{Index: index, Score: score})
	}
	sortScoresByIndex(scored)
	return scored
}

// jsonArrayItems decodes one raw token when it is a JSON array. isArray is true
// for an EMPTY array, which is what lets the caller reproduce the NestJS
// Array.isArray branch instead of a length check.
func jsonArrayItems(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, false
	}
	return items, true
}

// rerankIndex reads the index member as an integer.
func rerankIndex(value flexValue) (int, bool) {
	member, ok := flexMemberOf(value, "index")
	if !ok || member.kind != flexNumber {
		return 0, false
	}
	parsed, err := member.number.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	if parsed != math.Trunc(parsed) {
		return 0, false
	}
	return int(parsed), true
}

// rerankScoreValue reads the first finite score spelling. A key that is absent or
// explicitly null is skipped, because the NestJS `??` chain falls through both;
// a key present with any other non-numeric shape stops the chain and drops the
// row.
func rerankScoreValue(value flexValue) (float64, bool) {
	for _, key := range []string{"relevance_score", "relevanceScore", "score", "similarity"} {
		member, ok := flexMemberOf(value, key)
		if !ok || member.kind == flexNull {
			continue
		}
		switch member.kind {
		case flexNumber:
			parsed, err := member.number.Float64()
			if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
				return 0, false
			}
			return parsed, true
		case flexString:
			trimmed := strings.TrimSpace(member.text)
			if trimmed == "" {
				return 0, false
			}
			parsed, ok := javascriptNumberFromString(trimmed)
			if !ok {
				return 0, false
			}
			return parsed, true
		default:
			return 0, false
		}
	}
	return 0, false
}

// sortScoresByIndex orders the rows ascending by index, the order the console
// expects (NOT by score).
func sortScoresByIndex(values []rerankScore) {
	for index := 1; index < len(values); index++ {
		current := values[index]
		position := index - 1
		for position >= 0 && values[position].Index > current.Index {
			values[position+1] = values[position]
			position--
		}
		values[position+1] = current
	}
}

// normalizeDocuments trims, drops empties, de-duplicates and falls back to the
// built-in documents when nothing survives.
func normalizeDocuments(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	if len(out) == 0 {
		return append([]string{}, defaultRerankDocuments...)
	}
	return out
}

// uniqueModels builds the COMPLETION candidate list: an explicit override
// replaces the profile model entirely, otherwise the profile model plus its
// fallbacks. Order is preserved and duplicates are removed.
func uniqueModels(override, primary string, fallbacks []string) []string {
	if strings.TrimSpace(override) != "" {
		return dedupeTrimmed([]string{override})
	}
	return dedupeTrimmed(append([]string{primary}, fallbacks...))
}

// uniqueRerankModels builds the RERANK candidate list. It is deliberately not
// shared with completion: the NestJS testRerank keeps the profile's
// rerankFallbackModels behind an explicit override, while testCompletion drops
// them. Reusing the completion rule here would silently stop trying the backup
// rerank models as soon as an operator pinned rerankModel.
func uniqueRerankModels(override, primary string, fallbacks []string) []string {
	source := make([]string, 0, len(fallbacks)+1)
	if strings.TrimSpace(override) != "" {
		source = append(source, override)
	} else {
		source = append(source, primary)
	}
	return dedupeTrimmed(append(source, fallbacks...))
}

// dedupeTrimmed trims every candidate, drops the empty ones and keeps the first
// occurrence of each model, so a fallback can never repeat the primary.
func dedupeTrimmed(source []string) []string {
	out := make([]string, 0, len(source))
	seen := make(map[string]bool, len(source))
	for _, value := range source {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

// ---- response parsing ----

// extractResponsesOutputText mirrors extractResponsesOutputText.
func extractResponsesOutputText(payload responsesBody) *string {
	if text, ok := jsonStringValue(payload.OutputText); ok {
		if strings.TrimSpace(text) != "" {
			return &text
		}
		return nil
	}
	chunks := make([]string, 0, 2)
	for _, item := range payload.Output {
		for _, part := range item.Content {
			if text, ok := jsonStringValue(part.Text); ok && text != "" {
				chunks = append(chunks, text)
			}
		}
	}
	if len(chunks) == 0 {
		return nil
	}
	joined := strings.Join(chunks, "")
	return &joined
}

// extractOpenAITextFromChoice mirrors extractOpenAiTextFromChoice.
func extractOpenAITextFromChoice(choice json.RawMessage) *string {
	value, err := parseFlexValue(choice)
	if err != nil || value.kind != flexObject {
		return nil
	}
	if message, ok := flexMemberOf(value, "message"); ok {
		if message.kind == flexString {
			return extractOpenAITextFromContent(flexValue{kind: flexString, text: message.text})
		}
		if message.kind == flexObject {
			if content, ok := flexMemberOf(message, "content"); ok {
				if text := extractOpenAITextFromContent(content); text != nil {
					return text
				}
			}
			if refusal, ok := flexMemberOf(message, "refusal"); ok {
				if text := extractOpenAITextFromContent(refusal); text != nil {
					return text
				}
			}
		}
	}
	if delta, ok := flexMemberOf(value, "delta"); ok && delta.kind == flexObject {
		if content, ok := flexMemberOf(delta, "content"); ok {
			if text := extractOpenAITextFromContent(content); text != nil {
				return text
			}
		}
	}
	if text, ok := flexMemberOf(value, "text"); ok {
		return extractOpenAITextFromContent(text)
	}
	return nil
}

// extractOpenAITextFromContent mirrors extractOpenAiTextFromContent.
func extractOpenAITextFromContent(content flexValue) *string {
	if content.kind == flexString {
		return trimEndNonEmpty(content.text)
	}
	if content.kind == flexNull {
		return nil
	}
	if content.kind == flexArray {
		parts := make([]string, 0, len(content.array))
		for _, item := range content.array {
			if text := extractTextFromContentPart(item); text != nil && *text != "" {
				parts = append(parts, *text)
			}
		}
		combined := strings.Join(parts, "")
		if strings.TrimSpace(combined) == "" {
			return nil
		}
		return &combined
	}
	if content.kind == flexObject {
		return extractTextFromContentPart(content)
	}
	return nil
}

// extractTextFromContentPart mirrors extractTextFromContentPart.
func extractTextFromContentPart(part flexValue) *string {
	if part.kind == flexString {
		value := part.text
		return &value
	}
	if part.kind != flexObject {
		return nil
	}
	if text, ok := flexMemberOf(part, "text"); ok && text.kind == flexString {
		if value := trimEndNonEmpty(text.text); value != nil {
			return value
		}
	}
	if refusal, ok := flexMemberOf(part, "refusal"); ok && refusal.kind == flexString {
		if value := trimEndNonEmpty(refusal.text); value != nil {
			return value
		}
	}
	return nil
}

// choiceFinishReason reads choices[0].finish_reason.
func choiceFinishReason(choice json.RawMessage) *string {
	value, err := parseFlexValue(choice)
	if err != nil || value.kind != flexObject {
		return nil
	}
	member, ok := flexMemberOf(value, "finish_reason")
	if !ok || member.kind != flexString {
		return nil
	}
	trimmed := member.text
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// requestedModel reads the response model, falling back to the requested one.
func requestedModel(body []byte, fallback string) string {
	if model := responseModelOf(body); model != "" {
		return model
	}
	return fallback
}

// responseModelOf reads the top-level model of any diagnostic response.
func responseModelOf(body []byte) string {
	var envelope struct {
		Model json.RawMessage `json:"model"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	text, ok := jsonStringValue(envelope.Model)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// ---- cost / header extraction ----

// liteLlmCosts is the cost pair of one response.
type liteLlmCosts struct {
	costUSD     *float64
	keySpendUSD *float64
}

// extractCosts mirrors extractCosts: the header wins over the payload and an
// unknown cost stays nil instead of zero.
func extractCosts(response upstreamResponse) liteLlmCosts {
	headerCost := firstNumber(
		headerNumber(response.header, "x-litellm-response-cost"),
		headerNumber(response.header, "x-litellm-cost"),
		headerNumber(response.header, "litellm-cost"),
	)
	var envelope struct {
		ResponseCost json.RawMessage `json:"response_cost"`
	}
	payloadCost := (*float64)(nil)
	if err := json.Unmarshal(response.body, &envelope); err == nil {
		payloadCost = rawNumber(envelope.ResponseCost)
	}
	return liteLlmCosts{
		costUSD:     firstNumber(headerCost, payloadCost),
		keySpendUSD: headerNumber(response.header, "x-litellm-key-spend"),
	}
}

// applyLiteLlmCosts copies the cost pair and the LiteLLM headers onto a
// completion result.
func applyLiteLlmCosts(result *chatTestResult, response upstreamResponse) {
	costs := extractCosts(response)
	result.CostUSD = costs.costUSD
	result.KeySpendUSD = costs.keySpendUSD
	headers := extractLiteLlmHeaders(response)
	result.CallID = headers.callID
	result.ModelID = headers.modelID
	result.ModelAPIBase = headers.modelAPIBase
	result.ModelGroup = headers.modelGroup
	result.ProxyVersion = headers.proxyVersion
}

// applyEmbeddingLiteLlmCosts is applyLiteLlmCosts for embeddings.
func applyEmbeddingLiteLlmCosts(result *embeddingTestResult, response upstreamResponse) {
	costs := extractCosts(response)
	result.CostUSD = costs.costUSD
	result.KeySpendUSD = costs.keySpendUSD
	headers := extractLiteLlmHeaders(response)
	result.CallID = headers.callID
	result.ModelID = headers.modelID
	result.ModelAPIBase = headers.modelAPIBase
	result.ModelGroup = headers.modelGroup
	result.ProxyVersion = headers.proxyVersion
}

// applyRerankLiteLlmCosts is applyLiteLlmCosts for rerank.
func applyRerankLiteLlmCosts(result *rerankTestResult, response upstreamResponse) {
	costs := extractCosts(response)
	result.CostUSD = costs.costUSD
	result.KeySpendUSD = costs.keySpendUSD
	headers := extractLiteLlmHeaders(response)
	result.CallID = headers.callID
	result.ModelID = headers.modelID
	result.ModelAPIBase = headers.modelAPIBase
	result.ModelGroup = headers.modelGroup
	result.ProxyVersion = headers.proxyVersion
}

// liteLlmHeaders is the header set every result may report.
type liteLlmHeaders struct {
	callID       *string
	modelID      *string
	modelAPIBase *string
	modelGroup   *string
	proxyVersion *string
}

// extractLiteLlmHeaders mirrors extractLiteLlmHeaders.
func extractLiteLlmHeaders(response upstreamResponse) liteLlmHeaders {
	return liteLlmHeaders{
		callID:       headerText(response.header, "x-litellm-call-id"),
		modelID:      headerText(response.header, "x-litellm-model-id"),
		modelAPIBase: headerText(response.header, "x-litellm-model-api-base"),
		modelGroup:   headerText(response.header, "x-litellm-model-group"),
		proxyVersion: headerText(response.header, "x-litellm-version"),
	}
}

// headerText returns one trimmed non-empty header value.
func headerText(header http.Header, name string) *string {
	value := strings.TrimSpace(header.Get(name))
	if value == "" {
		return nil
	}
	return &value
}

// headerNumber parses one numeric header.
func headerNumber(header http.Header, name string) *float64 {
	value := strings.TrimSpace(header.Get(name))
	if value == "" {
		return nil
	}
	parsed, ok := javascriptNumberFromString(value)
	if !ok {
		return nil
	}
	return &parsed
}

// rawNumber parses one raw JSON number/string token.
func rawNumber(raw json.RawMessage) *float64 {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if trimmed[0] == '"' {
		text, ok := jsonStringValue(raw)
		if !ok {
			return nil
		}
		parsed, ok := javascriptNumberFromString(text)
		if !ok {
			return nil
		}
		return &parsed
	}
	parsed, ok := jsNumber([]byte(trimmed))
	if !ok {
		return nil
	}
	return &parsed
}

// firstNumber returns the first non-nil value.
func firstNumber(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// ---- log usage ----

// probeUsageOf extracts the token/cost columns of one log row. It takes the whole
// response because the cost must follow the same header-over-payload precedence
// as the diagnostic result: LiteLLM commonly reports the cost only in
// x-litellm-response-cost, and a log row without it would understate spend.
func probeUsageOf(requestType llmlogs.ProbeRequestType, response upstreamResponse) llmlogs.ProbeUsage {
	usage := llmlogs.ProbeUsage{}
	usage.CostUSD = extractCosts(response).costUSD
	var envelope struct {
		Usage json.RawMessage `json:"usage"`
	}
	if err := json.Unmarshal(response.body, &envelope); err != nil {
		return usage
	}
	var fields struct {
		PromptTokens     json.RawMessage `json:"prompt_tokens"`
		CompletionTokens json.RawMessage `json:"completion_tokens"`
		TotalTokens      json.RawMessage `json:"total_tokens"`
		InputTokens      json.RawMessage `json:"input_tokens"`
		OutputTokens     json.RawMessage `json:"output_tokens"`
	}
	if len(envelope.Usage) == 0 || string(envelope.Usage) == "null" {
		return usage
	}
	if err := json.Unmarshal(envelope.Usage, &fields); err != nil {
		return usage
	}
	promptTokens := rawNumber(fields.PromptTokens)
	if promptTokens == nil {
		promptTokens = rawNumber(fields.InputTokens)
	}
	var completionTokens *float64
	if requestType != llmlogs.ProbeRequestEmbedding {
		completionTokens = rawNumber(fields.CompletionTokens)
		if completionTokens == nil {
			completionTokens = rawNumber(fields.OutputTokens)
		}
	}
	totalTokens := rawNumber(fields.TotalTokens)
	if totalTokens == nil {
		if promptTokens != nil && completionTokens != nil {
			sum := *promptTokens + *completionTokens
			totalTokens = &sum
		} else {
			totalTokens = promptTokens
		}
	}
	usage.PromptTokens = promptTokens
	usage.CompletionTokens = completionTokens
	usage.TotalTokens = totalTokens
	return usage
}
