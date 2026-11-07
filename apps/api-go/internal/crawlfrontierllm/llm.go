package crawlfrontierllm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// llm.go is the LiteLLM gateway client for the two Frontier LLM chains. It
// ports LiteLlmService.acompletion and rerank for the shapes these two callers
// use: chat_completions and responses surfaces, per-model fallbacks, the
// retryable-status retry loop, the guardrail refusal short circuit, the
// per-attempt LLM request log and the profile/managed-governance resolution.
//
// Guardrails: the judge/learn metadata never matches
// UNTRUSTED_CONTENT_FEATURE_TOKENS, so resolveRequestGuardrails returns
// undefined for both callers and the payload carries no guardrails field. The
// client therefore omits it, exactly like Nest.

const (
	circuitFailureThreshold = 3
	circuitCooldown         = 5 * time.Minute
	maxResponseBytes        = 8 << 20
)

// RequestLogEntry is one real model attempt.
type RequestLogEntry struct {
	OrgID                     string
	RequestType               string
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     ModelUsage
	Feature                   string
	GatewayProfileID          string
	GovernanceApplied         *bool
	AuthMode                  string
	GovernanceTargetProfileID string
	APISurface                string
	Metadata                  *Object
	OccurredAt                time.Time
}

// ModelUsage is the token/cost snapshot; unreported values stay nil.
type ModelUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// RequestLogSink receives every attempt. Implementations must be best effort.
type RequestLogSink interface {
	WriteFrontierLog(ctx context.Context, entry RequestLogEntry) error
}

// LLMClientOptions wires the client.
type LLMClientOptions struct {
	DB   *sql.DB
	Env  LLMGatewayEnv
	Sink RequestLogSink
	Now  func() time.Time
	HTTP *http.Client
	// ResolveProfile overrides the SystemSetting profile read; tests only.
	ResolveProfile func(ctx context.Context, kind string) (gatewayProfile, error)
}

// LLMClient calls the active gateway profile.
type LLMClient struct {
	db      *sql.DB
	env     LLMGatewayEnv
	sink    RequestLogSink
	now     func() time.Time
	http    *http.Client
	resolve func(ctx context.Context, kind string) (gatewayProfile, error)

	mu      sync.Mutex
	circuit map[string]*circuitState
}

type circuitState struct {
	consecutiveFailures int
	openUntil           time.Time
}

// NewLLMClient builds the client. Configuration is resolved per call, so no
// model is probed at startup.
func NewLLMClient(options LLMClientOptions) *LLMClient {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	httpClient := options.HTTP
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	client := &LLMClient{
		db:      options.DB,
		env:     options.Env,
		sink:    options.Sink,
		now:     now,
		http:    httpClient,
		circuit: map[string]*circuitState{},
	}
	client.resolve = options.ResolveProfile
	if client.resolve == nil {
		client.resolve = func(ctx context.Context, kind string) (gatewayProfile, error) {
			return resolveGatewayProfile(ctx, client.db, client.env, kind)
		}
	}
	return client
}

func (c *LLMClient) isCircuitOpen(purpose string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.circuit[purpose]
	if state == nil {
		return false
	}
	return state.openUntil.After(c.now())
}

func (c *LLMClient) recordCircuitSuccess(purpose string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.circuit[purpose] = &circuitState{}
}

func (c *LLMClient) recordCircuitFailure(purpose string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.circuit[purpose]
	if state == nil {
		state = &circuitState{}
	}
	state.consecutiveFailures++
	state.openUntil = time.Time{}
	if state.consecutiveFailures >= circuitFailureThreshold {
		state.openUntil = c.now().Add(circuitCooldown)
	}
	c.circuit[purpose] = state
}

// chatMessage is one completion message.
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// completionRequest is the narrow acompletion input.
type completionRequest struct {
	OrgID          string
	Model          *string
	Temperature    float64
	MaxTokens      int
	ResponseFormat json.RawMessage
	Metadata       *Object
	Messages       []chatMessage
}

// completionChoice is one normalized choice.
type completionChoice struct {
	Message struct {
		Content string
	}
}

// completionResult is the normalized completion response.
type completionResult struct {
	Choices []completionChoice
	Model   string
	Usage   ModelUsage
}

// complete ports acompletion: it resolves the profile through the shared
// resolver and delegates the primary+fallback retry chain, transport and
// per-attempt log to litellmcompat.RunCompletion, keeping the Frontier request
// shape and error text unchanged.
func (c *LLMClient) complete(ctx context.Context, request completionRequest) (completionResult, error) {
	profile, err := c.resolve(ctx, "completion")
	if err != nil {
		return completionResult{}, err
	}
	primary := ""
	if request.Model != nil {
		primary = *request.Model
	}
	if strings.TrimSpace(primary) == "" {
		primary = profile.Model
	}
	models := uniqueModels(append([]string{primary}, profile.FallbackModels...))
	client := litellmcompat.NewSettingsClient(nil, nil, litellmcompat.Config{}).WithHTTP(c.http)
	response, err := client.RunCompletion(ctx, crawlSharedProfile(profile), litellmcompat.CompletionPlan{
		OrgID:      request.OrgID,
		Models:     models,
		MaxRetries: profile.MaxRetries,
		MaxBody:    maxResponseBytes,
		Build: func(model string) ([]byte, string, string, error) {
			return buildCrawlCompletionPayload(profile, model, request)
		},
		Parse: func(status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
			return parseCrawlCompletion(profile, status, header, raw, model)
		},
		Stop: func(err error) bool {
			return errors.Is(err, errGuardrailBlocked)
		},
		Observer: crawlAttemptAdapter{client: c, metadata: request.Metadata},
	})
	if err != nil {
		return completionResult{}, err
	}
	choices := make([]completionChoice, 0, 1)
	if response.Content != "" {
		choices = append(choices, completionChoice{Message: struct{ Content string }{Content: response.Content}})
	}
	return completionResult{Choices: choices, Model: response.Model, Usage: modelUsageFromShared(response.Usage)}, nil
}

// buildCrawlCompletionPayload renders the Frontier chat/responses body.
func buildCrawlCompletionPayload(profile gatewayProfile, model string, request completionRequest) ([]byte, string, string, error) {
	payload := NewObject()
	payload.SetString("model", model)
	if profile.APISurface == "responses" {
		input := make([]map[string]string, 0, len(request.Messages))
		for _, message := range request.Messages {
			input = append(input, map[string]string{"role": message.Role, "content": message.Content})
		}
		payload.Set("input", input)
		payload.SetNumber("temperature", request.Temperature)
		payload.SetNumber("top_p", profile.TopP)
		payload.SetNumber("max_output_tokens", float64(request.MaxTokens))
		if format := resolveResponseFormat(request.ResponseFormat, profile.ResponseFormatMode); format != nil {
			payload.Set("text", map[string]any{"format": json.RawMessage(format)})
		}
	} else {
		payload.Set("messages", request.Messages)
		payload.SetNumber("temperature", request.Temperature)
		payload.SetNumber("top_p", profile.TopP)
		payload.SetNumber("max_tokens", float64(request.MaxTokens))
		if format := resolveResponseFormat(request.ResponseFormat, profile.ResponseFormatMode); format != nil {
			payload.SetRaw("response_format", format)
		}
		payload.SetBool("stream", false)
	}
	if profile.SendMetadata && request.Metadata != nil {
		payload.SetRaw("metadata", mustJSON(request.Metadata))
	}
	body, err := payload.MarshalJSON()
	if err != nil {
		return nil, "", "", err
	}
	primary, fallback := "/v1/chat/completions", "/chat/completions"
	if profile.APISurface == "responses" {
		primary, fallback = "/v1/responses", "/responses"
	}
	return body, primary, fallback, nil
}

// parseCrawlCompletion parses one Frontier exchange into the shared result.
func parseCrawlCompletion(profile gatewayProfile, status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		return litellmcompat.CompletionResponse{}, fmt.Errorf("model gateway request failed with status %d", status)
	}
	result, blocked, parseErr := parseCompletion(raw, profile.APISurface, model)
	if blocked {
		return litellmcompat.CompletionResponse{}, errGuardrailBlocked
	}
	if parseErr != nil {
		return litellmcompat.CompletionResponse{}, parseErr
	}
	usage := modelUsageToShared(result.Usage)
	if cost, ok := headerCost(header); ok {
		usage.CostUSD = &cost
	}
	if usage.CostUSD == nil {
		if cost, ok := payloadCost(raw); ok {
			usage.CostUSD = &cost
		}
	}
	content := ""
	if len(result.Choices) > 0 {
		content = result.Choices[0].Message.Content
	}
	return litellmcompat.CompletionResponse{Content: content, Model: result.Model, Usage: usage}, nil
}

// crawlSharedProfile projects the Frontier profile onto the shared profile so
// RunCompletion can read timeout, auth mode and governance attribution.
func crawlSharedProfile(profile gatewayProfile) litellmcompat.Profile {
	apiSurface := litellmcompat.APISurfaceChat
	if profile.APISurface == "responses" {
		apiSurface = litellmcompat.APISurfaceResponses
	}
	formatMode := litellmcompat.ResponseFormatJSONSchema
	switch profile.ResponseFormatMode {
	case "none":
		formatMode = litellmcompat.ResponseFormatNone
	case "json_object":
		formatMode = litellmcompat.ResponseFormatJSONObject
	}
	return litellmcompat.Profile{
		ID:                        profile.ID,
		APIBase:                   profile.APIBase,
		APIKey:                    profile.APIKey,
		Model:                     profile.Model,
		FallbackModels:            profile.FallbackModels,
		RerankModel:               profile.RerankModel,
		RerankFallbackModels:      profile.RerankFallbacks,
		Timeout:                   profile.Timeout,
		MaxRetries:                profile.MaxRetries,
		SendMetadata:              profile.SendMetadata,
		ResponseFormatMode:        formatMode,
		APISurface:                apiSurface,
		TopP:                      profile.TopP,
		GovernanceApplied:         profile.GovernanceApplied,
		AuthMode:                  profile.GovernanceAuthMode,
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
	}
}

func modelUsageFromShared(usage litellmcompat.Usage) ModelUsage {
	return ModelUsage{PromptTokens: usage.PromptTokens, CompletionTokens: usage.CompletionTokens, TotalTokens: usage.TotalTokens, CostUSD: usage.CostUSD}
}

func modelUsageToShared(usage ModelUsage) litellmcompat.Usage {
	return litellmcompat.Usage{PromptTokens: usage.PromptTokens, CompletionTokens: usage.CompletionTokens, TotalTokens: usage.TotalTokens, CostUSD: usage.CostUSD}
}

// crawlAttemptAdapter writes the per-attempt request log from the shared record.
type crawlAttemptAdapter struct {
	client   *LLMClient
	metadata *Object
}

func (a crawlAttemptAdapter) ObserveAttempt(ctx context.Context, attempt litellmcompat.Attempt) {
	if a.client == nil {
		return
	}
	apiSurface := "chat_completions"
	if attempt.APISurface == litellmcompat.APISurfaceResponses {
		apiSurface = "responses"
	}
	entry := RequestLogEntry{
		OrgID:                     attempt.OrgID,
		RequestType:               "completion",
		Status:                    "success",
		Latency:                   attempt.Latency,
		Feature:                   featureToken(a.metadata),
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         boolPointer(attempt.GovernanceApplied),
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		APISurface:                apiSurface,
		Metadata:                  a.metadata,
		OccurredAt:                a.client.now(),
	}
	if attempt.Success {
		entry.Model = attempt.ResponseModel
		if entry.Model == "" {
			entry.Model = attempt.Model
		}
		entry.Usage = modelUsageFromShared(attempt.Usage)
	} else {
		entry.Model = attempt.Model
		entry.Status = "error"
		if attempt.Err != nil {
			entry.Error = attempt.Err.Error()
		}
	}
	a.client.writeLog(ctx, entry)
}

// post issues one HTTP attempt.
func (c *LLMClient) post(ctx context.Context, profile gatewayProfile, path string, body []byte) (int, []byte, http.Header, error) {
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return litellmcompat.PostOnce(ctx, c.http, profile.APIBase, profile.APIKey, path, body, timeout, maxResponseBytes)
}

// rerankResult is one rerank hit.
type rerankResult struct {
	Index int
	Score float64
}

// rerank ports LiteLlmService.rerank. The model/fallback/retry/parse engine and
// the transport live in litellmcompat.Client.Rerank; this wrapper keeps the
// Frontier profile resolver override and the per-attempt frontier request log.
func (c *LLMClient) rerank(ctx context.Context, orgID string, model *string, query string, documents []string, topN int, metadata *Object) ([]rerankResult, error) {
	if len(documents) == 0 {
		return nil, errors.New("LiteLLM rerank documents are required")
	}
	trimmedQuery := jsTrim(query)
	if trimmedQuery == "" {
		return nil, errors.New("LiteLLM rerank query is required")
	}
	profile, err := c.resolve(ctx, "rerank")
	if err != nil {
		return nil, err
	}
	requested := ""
	if model != nil {
		requested = strings.TrimSpace(*model)
	}
	var models []string
	if requested != "" {
		models = uniqueModels(append([]string{requested}, profile.RerankFallbacks...))
	} else {
		models = uniqueModels(append([]string{profile.RerankModel}, profile.RerankFallbacks...))
	}
	if len(models) == 0 {
		return nil, errors.New("LiteLLM rerank model is not configured")
	}
	var requestMetadata litellmcompat.Metadata
	if profile.SendMetadata && metadata != nil {
		requestMetadata = frontierMetadata{object: metadata}
	}
	client := litellmcompat.NewSettingsClient(nil, nil, litellmcompat.Config{}).WithHTTP(c.http)
	response, err := client.RerankWithProfile(ctx, crawlSharedProfile(profile), litellmcompat.RerankRequest{
		OrgID:     orgID,
		Model:     requested,
		Query:     trimmedQuery,
		Documents: documents,
		TopN:      topN,
		Metadata:  requestMetadata,
		Observer:  crawlRerankAttemptAdapter{client: c, metadata: metadata},
	})
	if err != nil {
		return nil, err
	}
	results := make([]rerankResult, 0, len(response.Results))
	for _, result := range response.Results {
		results = append(results, rerankResult{Index: result.Index, Score: result.Score})
	}
	return results, nil
}

// frontierMetadata adapts the ordered Frontier metadata object onto the shared
// Metadata interface so the rerank payload keeps its exact JSON bytes.
type frontierMetadata struct {
	object *Object
}

func (m frontierMetadata) JSONValue() any {
	if m.object == nil {
		return nil
	}
	return json.RawMessage(mustJSON(m.object))
}

func (m frontierMetadata) LogFields() []llmlogs.ModelRequestMetadataField { return nil }

// crawlRerankAttemptAdapter writes the per-attempt frontier request log from the
// shared attempt record.
type crawlRerankAttemptAdapter struct {
	client   *LLMClient
	metadata *Object
}

func (a crawlRerankAttemptAdapter) ObserveAttempt(ctx context.Context, attempt litellmcompat.Attempt) {
	if a.client == nil {
		return
	}
	entry := RequestLogEntry{
		OrgID:                     attempt.OrgID,
		RequestType:               "rerank",
		Model:                     attempt.Model,
		Status:                    "success",
		Latency:                   attempt.Latency,
		Feature:                   featureToken(a.metadata),
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         boolPointer(attempt.GovernanceApplied),
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		APISurface:                "rerank",
		Metadata:                  a.metadata,
		OccurredAt:                a.client.now(),
	}
	if !attempt.Success {
		entry.Status = "error"
		if attempt.Err != nil {
			entry.Error = attempt.Err.Error()
		}
	}
	a.client.writeLog(ctx, entry)
}

func (c *LLMClient) writeLog(ctx context.Context, entry RequestLogEntry) {
	if c.sink == nil {
		return
	}
	_ = c.sink.WriteFrontierLog(ctx, entry)
}

// errGuardrailBlocked marks a LiteLLM guardrail refusal; Nest stops the model
// fallback chain on it.
var errGuardrailBlocked = errors.New("model gateway blocked the request by guardrails")

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// resolveResponseFormat ports resolveResponseFormat.
func resolveResponseFormat(responseFormat json.RawMessage, mode string) json.RawMessage {
	switch mode {
	case "none":
		return nil
	case "json_object":
		return json.RawMessage(`{"type":"json_object"}`)
	}
	if len(responseFormat) == 0 {
		return nil
	}
	return responseFormat
}

// featureToken is resolveFeatureToken(metadata) for the log row.
func featureToken(metadata *Object) string {
	if metadata == nil {
		return ""
	}
	for _, key := range []string{"feature", "source", "module"} {
		if value, ok := metadata.String(key); ok {
			normalized := strings.ToLower(jsTrim(value))
			if normalized != "" && len(normalized) <= 64 {
				return normalized
			}
		}
	}
	return ""
}

func headerCost(header http.Header) (float64, bool) {
	if header == nil {
		return 0, false
	}
	for _, name := range []string{"x-litellm-response-cost", "x-litellm-cost", "litellm-cost"} {
		value := strings.TrimSpace(header.Get(name))
		if value == "" {
			continue
		}
		parsed, err := strconv.ParseFloat(value, 64)
		if err == nil && isFinite(parsed) && parsed >= 0 {
			return parsed, true
		}
	}
	return 0, false
}

func payloadCost(raw []byte) (float64, bool) {
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		return 0, false
	}
	for _, source := range []any{document["response_cost"], nil} {
		if source == nil {
			break
		}
		if number, ok := finiteNumber(source); ok {
			return number, true
		}
	}
	if usage, ok := document["usage"].(map[string]any); ok {
		if number, ok := finiteNumber(usage["response_cost"]); ok {
			return number, true
		}
	}
	return 0, false
}

// parseCompletion normalizes chat_completions and responses payloads.
func parseCompletion(raw []byte, apiSurface, fallbackModel string) (completionResult, bool, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return completionResult{}, false, err
	}
	result := completionResult{Model: fallbackModel}
	if model, ok := jsonStringValue(document["model"]); ok && strings.TrimSpace(model) != "" {
		result.Model = strings.TrimSpace(model)
	}
	if usage, ok := ParseObject(document["usage"]); ok {
		result.Usage = usageFromObject(usage)
	}
	if apiSurface == "responses" {
		if text, ok := rawResponsesText(document); ok && strings.TrimSpace(text) != "" {
			result.Choices = []completionChoice{{Message: struct{ Content string }{Content: text}}}
		} else if isGuardrailBlockedPayload(document) {
			return completionResult{}, true, nil
		}
		return result, false, nil
	}
	if choicesRaw, ok := document["choices"]; ok {
		var choices []json.RawMessage
		if err := json.Unmarshal(choicesRaw, &choices); err != nil {
			return completionResult{}, false, err
		}
		for _, rawChoice := range choices {
			choice, ok := ParseObject(rawChoice)
			if !ok {
				continue
			}
			message, ok := choice.Object("message")
			if !ok {
				continue
			}
			content := messageContent(message)
			result.Choices = append(result.Choices, completionChoice{Message: struct{ Content string }{Content: content}})
		}
	}
	if len(result.Choices) == 0 && isGuardrailBlockedPayload(document) {
		return completionResult{}, true, nil
	}
	return result, false, nil
}

func messageContent(message *Object) string {
	raw, ok := message.Raw("content")
	if !ok {
		return ""
	}
	text, ok := jsonStringValue(raw)
	if ok {
		return text
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	var builder strings.Builder
	for _, part := range parts {
		record, ok := ParseObject(part)
		if !ok {
			continue
		}
		if value, ok := record.String("text"); ok {
			builder.WriteString(value)
		}
	}
	return builder.String()
}

func rawResponsesText(document map[string]json.RawMessage) (string, bool) {
	if outputText, ok := jsonStringValue(document["output_text"]); ok && strings.TrimSpace(outputText) != "" {
		return outputText, true
	}
	outputRaw, ok := document["output"]
	if !ok {
		return "", false
	}
	var output []json.RawMessage
	if err := json.Unmarshal(outputRaw, &output); err != nil {
		return "", false
	}
	var builder strings.Builder
	for _, item := range output {
		record, ok := ParseObject(item)
		if !ok {
			continue
		}
		contentRaw, ok := record.Raw("content")
		if !ok {
			continue
		}
		var content []json.RawMessage
		if err := json.Unmarshal(contentRaw, &content); err != nil {
			continue
		}
		for _, entry := range content {
			part, ok := ParseObject(entry)
			if !ok {
				continue
			}
			if text, ok := part.UntrimmedString("text"); ok {
				builder.WriteString(text)
			}
		}
	}
	return builder.String(), true
}

func isGuardrailBlockedPayload(document map[string]json.RawMessage) bool {
	raw, ok := document["messages"]
	if !ok {
		return false
	}
	var messages []json.RawMessage
	if err := json.Unmarshal(raw, &messages); err != nil {
		return false
	}
	return len(messages) > 0
}

func usageFromObject(object *Object) ModelUsage {
	usage := ModelUsage{}
	if value, ok := object.Number("prompt_tokens"); ok {
		usage.PromptTokens = &value
	}
	if value, ok := object.Number("completion_tokens"); ok {
		usage.CompletionTokens = &value
	}
	if value, ok := object.Number("total_tokens"); ok {
		usage.TotalTokens = &value
	}
	if usage.TotalTokens == nil && usage.PromptTokens != nil && usage.CompletionTokens != nil {
		total := *usage.PromptTokens + *usage.CompletionTokens
		usage.TotalTokens = &total
	}
	return usage
}

func boolPointer(value bool) *bool {
	out := value
	return &out
}

// finiteOrNil keeps only finite numbers.
func finiteOrNilLLM(value float64) *float64 {
	if !isFinite(value) {
		return nil
	}
	out := value
	return &out
}
