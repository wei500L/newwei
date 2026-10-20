package crawlfrontierllm

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
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

// complete ports acompletion.
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
	if len(models) == 0 {
		return completionResult{}, errors.New("completion model is not configured")
	}
	var lastErr error
	for _, model := range models {
		result, callErr := c.completeModel(ctx, profile, model, request)
		if callErr == nil {
			return result, nil
		}
		if errors.Is(callErr, errGuardrailBlocked) {
			return completionResult{}, callErr
		}
		var nested *NestError
		if errors.As(callErr, &nested) {
			return completionResult{}, callErr
		}
		lastErr = callErr
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM completion failed")
	}
	return completionResult{}, lastErr
}

func (c *LLMClient) completeModel(ctx context.Context, profile gatewayProfile, model string, request completionRequest) (completionResult, error) {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		started := c.now()
		result, status, callErr := c.postCompletion(ctx, profile, model, request)
		latency := c.now().Sub(started)
		apiSurface := "chat_completions"
		if profile.APISurface == "responses" {
			apiSurface = "responses"
		}
		if callErr == nil {
			c.writeLog(ctx, RequestLogEntry{
				OrgID: request.OrgID, RequestType: "completion", Model: result.Model,
				Status: "success", Latency: latency, Usage: result.Usage,
				Feature: featureToken(request.Metadata), GatewayProfileID: profile.ID,
				GovernanceApplied: boolPointer(profile.GovernanceApplied), AuthMode: profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				APISurface:                apiSurface, Metadata: request.Metadata, OccurredAt: c.now(),
			})
			return result, nil
		}
		c.writeLog(ctx, RequestLogEntry{
			OrgID: request.OrgID, RequestType: "completion", Model: model,
			Status: "error", Error: callErr.Error(), Latency: latency,
			Feature: featureToken(request.Metadata), GatewayProfileID: profile.ID,
			GovernanceApplied: boolPointer(profile.GovernanceApplied), AuthMode: profile.authMode(),
			GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
			APISurface:                apiSurface, Metadata: request.Metadata, OccurredAt: c.now(),
		})
		lastErr = callErr
		if errors.Is(callErr, errGuardrailBlocked) || !isRetryableStatus(status) || attempt+1 >= attempts {
			return completionResult{}, callErr
		}
		if sleepErr := sleepContext(ctx, delay); sleepErr != nil {
			return completionResult{}, sleepErr
		}
		delay *= 2
		if delay > 10*time.Second {
			delay = 10 * time.Second
		}
	}
	return completionResult{}, lastErr
}

func (c *LLMClient) postCompletion(ctx context.Context, profile gatewayProfile, model string, request completionRequest) (completionResult, int, error) {
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
		return completionResult{}, 0, err
	}
	primary, fallback := "/v1/chat/completions", "/chat/completions"
	if profile.APISurface == "responses" {
		primary, fallback = "/v1/responses", "/responses"
	}
	status, raw, header, err := c.post(ctx, profile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = c.post(ctx, profile, fallback, body)
	}
	if err != nil {
		return completionResult{}, status, err
	}
	if status < 200 || status >= 300 {
		return completionResult{}, status, fmt.Errorf("model gateway request failed with status %d", status)
	}
	result, blocked, parseErr := parseCompletion(raw, profile.APISurface, model)
	if blocked {
		return completionResult{}, status, errGuardrailBlocked
	}
	if parseErr != nil {
		return completionResult{}, status, parseErr
	}
	if cost, ok := headerCost(header); ok {
		result.Usage.CostUSD = &cost
	}
	if result.Usage.CostUSD == nil {
		if cost, ok := payloadCost(raw); ok {
			result.Usage.CostUSD = &cost
		}
	}
	return result, status, nil
}

// post issues one HTTP attempt.
func (c *LLMClient) post(ctx context.Context, profile gatewayProfile, path string, body []byte) (int, []byte, http.Header, error) {
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	httpRequest, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		httpRequest.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	response, err := c.http.Do(httpRequest)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	return response.StatusCode, raw, response.Header.Clone(), err
}

// rerankResult is one rerank hit.
type rerankResult struct {
	Index int
	Score float64
}

// rerank ports LiteLlmService.rerank.
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
	var lastErr error
	for _, candidate := range models {
		results, callErr := c.rerankModel(ctx, profile, candidate, orgID, trimmedQuery, documents, topN, metadata)
		if callErr == nil {
			return results, nil
		}
		var nested *NestError
		if errors.As(callErr, &nested) {
			return nil, callErr
		}
		lastErr = callErr
	}
	lastMessage := "unknown upstream error"
	if lastErr != nil {
		lastMessage = lastErr.Error()
	}
	return nil, fmt.Errorf("LiteLLM rerank unavailable: all configured rerank models failed (%s). Last error: %s", strings.Join(models, ", "), lastMessage)
}

func (c *LLMClient) rerankModel(ctx context.Context, profile gatewayProfile, model, orgID, query string, documents []string, topN int, metadata *Object) ([]rerankResult, error) {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		started := c.now()
		results, status, callErr := c.postRerank(ctx, profile, model, query, documents, topN, metadata)
		latency := c.now().Sub(started)
		if callErr == nil {
			c.writeLog(ctx, RequestLogEntry{
				OrgID: orgID, RequestType: "rerank", Model: model, Status: "success",
				Latency: latency, Feature: featureToken(metadata), GatewayProfileID: profile.ID,
				GovernanceApplied: boolPointer(profile.GovernanceApplied), AuthMode: profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				APISurface:                "rerank", Metadata: metadata, OccurredAt: c.now(),
			})
			return results, nil
		}
		c.writeLog(ctx, RequestLogEntry{
			OrgID: orgID, RequestType: "rerank", Model: model, Status: "error",
			Error: callErr.Error(), Latency: latency, Feature: featureToken(metadata),
			GatewayProfileID: profile.ID, GovernanceApplied: boolPointer(profile.GovernanceApplied),
			AuthMode: profile.authMode(), GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
			APISurface: "rerank", Metadata: metadata, OccurredAt: c.now(),
		})
		lastErr = callErr
		if !isRetryableStatus(status) || attempt+1 >= attempts {
			return nil, callErr
		}
		if sleepErr := sleepContext(ctx, delay); sleepErr != nil {
			return nil, sleepErr
		}
		delay *= 2
		if delay > 10*time.Second {
			delay = 10 * time.Second
		}
	}
	return nil, lastErr
}

func (c *LLMClient) postRerank(ctx context.Context, profile gatewayProfile, model, query string, documents []string, topN int, metadata *Object) ([]rerankResult, int, error) {
	payload := NewObject()
	payload.SetString("model", model)
	payload.SetString("query", query)
	payload.Set("documents", documents)
	limit := topN
	if limit <= 0 {
		limit = len(documents)
	}
	payload.SetNumber("top_n", float64(limit))
	if profile.SendMetadata && metadata != nil {
		payload.SetRaw("metadata", mustJSON(metadata))
	}
	body, err := payload.MarshalJSON()
	if err != nil {
		return nil, 0, err
	}
	status, raw, _, err := c.post(ctx, profile, "/v1/rerank", body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, _, err = c.post(ctx, profile, "/rerank", body)
	}
	if err != nil {
		return nil, status, err
	}
	if status < 200 || status >= 300 {
		return nil, status, fmt.Errorf("model gateway rerank failed with status %d", status)
	}
	results, parseErr := parseRerankResults(raw)
	if parseErr != nil {
		return nil, status, parseErr
	}
	if len(results) == 0 {
		return nil, status, errors.New("LiteLLM rerank returned no usable results")
	}
	return results, status, nil
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

func isRetryableStatus(status int) bool {
	switch status {
	case 0, 408, 409, 423, 425, 429, 500, 502, 503, 504:
		return true
	}
	return false
}

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

// parseRerankResults ports normalizeRerankResults and sorts by score desc.
func parseRerankResults(raw []byte) ([]rerankResult, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	rawResults, ok := document["results"]
	if !ok {
		rawResults = document["data"]
	}
	if len(rawResults) == 0 {
		return nil, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(rawResults, &entries); err != nil {
		return nil, err
	}
	results := make([]rerankResult, 0, len(entries))
	for _, entry := range entries {
		record, ok := ParseObject(entry)
		if !ok {
			continue
		}
		index, ok := record.Number("index")
		if !ok || index != roundToFixed(index, 0) {
			continue
		}
		scoreRaw, ok := firstPresent(record, "relevance_score", "relevanceScore", "score", "similarity")
		if !ok {
			continue
		}
		score, ok := toFiniteNumber(scoreRaw)
		if !ok {
			continue
		}
		results = append(results, rerankResult{Index: int(index), Score: score})
	}
	sort.SliceStable(results, func(left, right int) bool {
		return results[left].Score > results[right].Score
	})
	return results, nil
}

func firstPresent(object *Object, keys ...string) (json.RawMessage, bool) {
	for _, key := range keys {
		if raw, ok := object.Raw(key); ok && !isEmptyJSON(raw) {
			return raw, true
		}
	}
	return nil, false
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
