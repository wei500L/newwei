package litellmcompat

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

const responseLimit = 8 << 20

// LogWriter is the request-log surface.
type LogWriter interface {
	Write(ctx context.Context, entry llmlogs.ModelRequestEntry) error
}

// SettingLoader reads one SystemSetting value. Tests inject an in-memory
// loader; production uses the MySQL row.
type SettingLoader func(ctx context.Context, key string) (json.RawMessage, bool, error)

// Client is the shared LiteLLM-compatible client.
type Client struct {
	db      *sql.DB
	logs    LogWriter
	cfg     Config
	http    *http.Client
	now     func() time.Time
	loadRow SettingLoader
}

// NewClient wires the shared MySQL pool and the request-log writer. A nil writer
// disables logging only; request behaviour is unchanged.
func NewClient(db *sql.DB, logs LogWriter, cfg Config) *Client {
	if cfg.APIBase == "" {
		cfg.APIBase = "http://localhost:4001"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 60 * time.Second
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 3
	}
	if cfg.DefaultModel == "" {
		cfg.DefaultModel = "openai/gpt-4o-mini"
	}
	if cfg.DefaultTemperature == 0 {
		cfg.DefaultTemperature = 0.2
	}
	if cfg.DefaultTopP == 0 {
		cfg.DefaultTopP = 0.9
	}
	if cfg.DefaultMaxOutputTokens <= 0 {
		cfg.DefaultMaxOutputTokens = 2048
	}
	return &Client{db: db, logs: logs, cfg: cfg, http: &http.Client{}, now: time.Now}
}

// WithSettingLoader replaces the SystemSetting reader. It is used by tests and
// by callers that already hold a settings snapshot.
func (c *Client) WithSettingLoader(loader SettingLoader) *Client {
	if c == nil {
		return nil
	}
	c.loadRow = loader
	return c
}

// Completion runs acompletion: primary model then configured fallbacks, with
// per-model retries, guardrail termination and compatibility classification.
func (c *Client) Completion(ctx context.Context, req CompletionRequest) (CompletionResponse, error) {
	guardrails, err := c.requestGuardrails(ctx, req.Guardrails, req.Metadata)
	if err != nil {
		return CompletionResponse{}, err
	}
	profile, err := c.resolveCompletion(ctx)
	if err != nil {
		return CompletionResponse{}, err
	}
	models := uniqueModels(append([]string{trimOr(req.Model, profile.Model)}, profile.FallbackModels...))
	if len(models) == 0 {
		return CompletionResponse{}, ErrCompletionUnavailable
	}
	requestedModel := models[0]
	var lastErr error
	for _, model := range models {
		response, err := c.completeModel(ctx, profile, model, req, guardrails)
		if err == nil {
			response.RequestedModel = requestedModel
			response.FallbackUsed = model != requestedModel
			return response, nil
		}
		if isGuardrailViolation(err) || isCompatibilityError(err) {
			return CompletionResponse{}, err
		}
		lastErr = err
		if c.cfg.Logger != nil {
			c.cfg.Logger("litellmcompat: completion model %s failed, trying the next fallback: %v", model, err)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM completion failed")
	}
	return CompletionResponse{}, lastErr
}

func (c *Client) completeModel(ctx context.Context, profile gatewayProfile, model string, req CompletionRequest, guardrails []string) (CompletionResponse, error) {
	attempts := maxAttempts(req.MaxRetries, profile.MaxRetries)
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		started := c.now()
		payload := c.completionPayload(profile, model, req, guardrails)
		body, err := json.Marshal(payload)
		if err != nil {
			return CompletionResponse{}, err
		}
		primary, fallback := "/v1/chat/completions", "/chat/completions"
		if profile.APISurface == APISurfaceResponses {
			primary, fallback = "/v1/responses", "/responses"
		}
		status, raw, header, callErr := c.post(ctx, profile, primary, fallback, body, c.timeout(profile, req.Timeout))
		latency := c.now().Sub(started)
		if callErr == nil && status >= 200 && status < 300 {
			if violation := blockedCompletionResponse(status, header, raw); violation != nil {
				c.log(ctx, profile, "completion", model, req.OrgID, req.Metadata, latency, Usage{}, violation)
				return CompletionResponse{}, violation
			}
			response, parseErr := parseCompletionResponse(raw, model, profile.APISurface, header)
			if parseErr != nil {
				c.log(ctx, profile, "completion", model, req.OrgID, req.Metadata, latency, Usage{}, parseErr)
				return CompletionResponse{}, parseErr
			}
			c.log(ctx, profile, "completion", model, req.OrgID, req.Metadata, latency, response.Usage, nil)
			latencyMS := float64(latency.Milliseconds())
			response.LatencyMS = &latencyMS
			return response, nil
		}
		detail := extractUpstreamErrorText(status, raw, callErr)
		if violation := guardrailViolationFromStatus(status, detail, guardrails, appliedGuardrails(header)); violation != nil {
			c.log(ctx, profile, "completion", model, req.OrgID, req.Metadata, latency, Usage{}, violation)
			return CompletionResponse{}, violation
		}
		if compatibility := detectCompatibilityIssue(status, detail, profile.APISurface); compatibility != nil {
			c.log(ctx, profile, "completion", model, req.OrgID, req.Metadata, latency, Usage{}, compatibility)
			return CompletionResponse{}, compatibility
		}
		callErr = statusError(status, detail, callErr)
		c.log(ctx, profile, "completion", model, req.OrgID, req.Metadata, latency, Usage{}, callErr)
		lastErr = callErr
		if attempt+1 >= attempts || !retryableStatus(status, callErr) {
			break
		}
		if err := sleepContext(ctx, delay); err != nil {
			return CompletionResponse{}, err
		}
		delay = nextDelay(delay)
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM completion failed")
	}
	return CompletionResponse{}, lastErr
}

func (c *Client) completionPayload(profile gatewayProfile, model string, req CompletionRequest, guardrails []string) any {
	temperature := profile.Temperature
	if req.Temperature != nil {
		temperature = *req.Temperature
	}
	topP := profile.TopP
	if req.TopP != nil {
		topP = *req.TopP
	}
	maxTokens := profile.MaxOutputTokens
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	}
	var metadata any
	if profile.SendMetadata && req.Metadata != nil {
		metadata = req.Metadata.JSONValue()
	}
	if profile.APISurface == APISurfaceResponses {
		payload := responsesJSON{
			Model:           model,
			Input:           req.Messages,
			Temperature:     temperature,
			TopP:            topP,
			MaxOutputTokens: maxTokens,
			Guardrails:      guardrails,
			Metadata:        metadata,
		}
		if format := resolveResponsesTextFormat(req.ResponseFormat, profile.ResponseFormatMode); format != nil {
			payload.Text = &responsesText{Format: format}
		}
		return payload
	}
	return completionJSON{
		Model:          model,
		Messages:       req.Messages,
		Temperature:    temperature,
		TopP:           topP,
		MaxTokens:      maxTokens,
		ResponseFormat: resolveResponseFormat(req.ResponseFormat, profile.ResponseFormatMode),
		Stream:         false,
		Guardrails:     guardrails,
		Metadata:       metadata,
	}
}

// Embedding runs one embedding attempt chain. The caller keeps the model
// selection (news classifier O2 reuses taxonomy vectors inside one task).
func (c *Client) Embedding(ctx context.Context, req EmbeddingRequest) (EmbeddingResponse, error) {
	if len(req.Input) == 0 {
		return EmbeddingResponse{}, errors.New("LiteLLM embedding input is required")
	}
	profile, err := c.resolveEmbedding(ctx)
	if err != nil {
		return EmbeddingResponse{}, err
	}
	model := trimOr(req.Model, trimOr(profile.EmbeddingModel, profile.Model))
	if model == "" {
		return EmbeddingResponse{}, ErrEmbeddingUnavailable
	}
	payload := embeddingJSON{
		Model: model,
		Input: req.Input,
	}
	if profile.SendMetadata && req.Metadata != nil {
		payload.Metadata = req.Metadata.JSONValue()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return EmbeddingResponse{}, err
	}
	attempts := maxAttempts(req.MaxRetries, profile.MaxRetries)
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		started := c.now()
		status, raw, header, callErr := c.post(ctx, profile, "/v1/embeddings", "/embeddings", body, c.timeout(profile, 0))
		latency := c.now().Sub(started)
		if callErr == nil && status >= 200 && status < 300 {
			response, parseErr := parseEmbeddingResponse(raw, model, header)
			if parseErr != nil {
				c.log(ctx, profile, "embedding", model, req.OrgID, req.Metadata, latency, Usage{}, parseErr)
				return EmbeddingResponse{}, parseErr
			}
			c.log(ctx, profile, "embedding", model, req.OrgID, req.Metadata, latency, response.Usage, nil)
			return response, nil
		}
		detail := extractUpstreamErrorText(status, raw, callErr)
		if compatibility := detectCompatibilityIssue(status, detail, APISurfaceChat); compatibility != nil {
			c.log(ctx, profile, "embedding", model, req.OrgID, req.Metadata, latency, Usage{}, compatibility)
			return EmbeddingResponse{}, compatibility
		}
		callErr = statusError(status, detail, callErr)
		c.log(ctx, profile, "embedding", model, req.OrgID, req.Metadata, latency, Usage{}, callErr)
		lastErr = callErr
		if attempt+1 >= attempts || !retryableStatus(status, callErr) {
			break
		}
		if err := sleepContext(ctx, delay); err != nil {
			return EmbeddingResponse{}, err
		}
		delay = nextDelay(delay)
	}
	if lastErr == nil {
		lastErr = ErrEmbeddingUnavailable
	}
	return EmbeddingResponse{}, lastErr
}

// Rerank runs the primary rerank model followed by its configured fallbacks.
func (c *Client) Rerank(ctx context.Context, req RerankRequest) (RerankResponse, error) {
	if len(req.Documents) == 0 {
		return RerankResponse{}, errors.New("LiteLLM rerank documents are required")
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return RerankResponse{}, errors.New("LiteLLM rerank query is required")
	}
	profile, err := c.resolveRerank(ctx)
	if err != nil {
		return RerankResponse{}, err
	}
	models := uniqueModels(append([]string{trimOr(req.Model, profile.RerankModel)}, profile.RerankFallbackModels...))
	if len(models) == 0 {
		return RerankResponse{}, ErrRerankUnavailable
	}
	topN := req.TopN
	if topN <= 0 || topN > len(req.Documents) {
		topN = len(req.Documents)
	}
	var lastErr error
	for _, model := range models {
		response, err := c.rerankModel(ctx, profile, model, query, req, topN)
		if err == nil {
			if response.Model == "" {
				response.Model = model
			}
			return response, nil
		}
		if isGuardrailViolation(err) || isCompatibilityError(err) {
			return RerankResponse{}, err
		}
		lastErr = err
		if c.cfg.Logger != nil {
			c.cfg.Logger("litellmcompat: rerank model %s failed, trying the next fallback: %v", model, err)
		}
	}
	lastMessage := "unknown upstream error"
	if lastErr != nil {
		lastMessage = lastErr.Error()
	}
	return RerankResponse{}, fmt.Errorf(
		"LiteLLM rerank unavailable: all configured rerank models failed (%s). Last error: %s",
		strings.Join(models, ", "), lastMessage,
	)
}

func (c *Client) rerankModel(ctx context.Context, profile gatewayProfile, model, query string, req RerankRequest, topN int) (RerankResponse, error) {
	payload := rerankJSON{
		Model:     model,
		Query:     query,
		Documents: req.Documents,
		TopN:      topN,
	}
	if profile.SendMetadata && req.Metadata != nil {
		payload.Metadata = req.Metadata.JSONValue()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return RerankResponse{}, err
	}
	attempts := maxAttempts(nil, profile.MaxRetries)
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		started := c.now()
		status, raw, header, callErr := c.post(ctx, profile, "/v1/rerank", "/rerank", body, c.timeout(profile, 0))
		latency := c.now().Sub(started)
		if callErr == nil && status >= 200 && status < 300 {
			response, parseErr := parseRerankResponse(raw, len(req.Documents), model, header)
			if parseErr != nil {
				c.log(ctx, profile, "rerank", model, req.OrgID, req.Metadata, latency, Usage{}, parseErr)
				return RerankResponse{}, parseErr
			}
			c.log(ctx, profile, "rerank", model, req.OrgID, req.Metadata, latency, response.Usage, nil)
			return response, nil
		}
		detail := extractUpstreamErrorText(status, raw, callErr)
		if compatibility := detectCompatibilityIssue(status, detail, APISurfaceChat); compatibility != nil {
			c.log(ctx, profile, "rerank", model, req.OrgID, req.Metadata, latency, Usage{}, compatibility)
			return RerankResponse{}, compatibility
		}
		callErr = statusError(status, detail, callErr)
		c.log(ctx, profile, "rerank", model, req.OrgID, req.Metadata, latency, Usage{}, callErr)
		lastErr = callErr
		if attempt+1 >= attempts || !retryableStatus(status, callErr) {
			break
		}
		if err := sleepContext(ctx, delay); err != nil {
			return RerankResponse{}, err
		}
		delay = nextDelay(delay)
	}
	if lastErr == nil {
		lastErr = ErrRerankUnavailable
	}
	return RerankResponse{}, lastErr
}

// --- HTTP ---

func (c *Client) post(ctx context.Context, profile gatewayProfile, primary, fallback string, body []byte, timeout time.Duration) (int, []byte, http.Header, error) {
	status, raw, header, err := c.postOnce(ctx, profile, primary, body, timeout)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) && fallback != "" {
		return c.postOnce(ctx, profile, fallback, body, timeout)
	}
	return status, raw, header, err
}

func (c *Client) postOnce(ctx context.Context, profile gatewayProfile, path string, body []byte, timeout time.Duration) (int, []byte, http.Header, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, responseLimit))
	return response.StatusCode, raw, response.Header.Clone(), readErr
}

func statusError(status int, detail string, callErr error) error {
	if callErr != nil {
		return callErr
	}
	if status != 0 {
		if detail != "" {
			return fmt.Errorf("LiteLLM request failed (HTTP %d): %s", status, detail)
		}
		return fmt.Errorf("LiteLLM request failed (HTTP %d)", status)
	}
	return errors.New("LiteLLM request failed")
}

func extractUpstreamErrorText(status int, raw []byte, callErr error) string {
	if callErr != nil {
		return sanitizeUpstreamErrorText(callErr.Error(), 500)
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		if status != 0 {
			return fmt.Sprintf("HTTP %d", status)
		}
		return ""
	}
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "<!doctype") || strings.Contains(lower, "<html") {
		if title := betweenTags(trimmed, "title"); title != "" {
			return sanitizeUpstreamErrorText(title, 500)
		}
		if h1 := betweenTags(trimmed, "h1"); h1 != "" {
			return sanitizeUpstreamErrorText(h1, 500)
		}
		return "HTML error response"
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err == nil {
		if errorField, ok := doc["error"].(map[string]any); ok {
			if message, ok := errorField["message"].(string); ok {
				return sanitizeUpstreamErrorText(message, 500)
			}
		}
		if message, ok := doc["message"].(string); ok {
			return sanitizeUpstreamErrorText(message, 500)
		}
		if message, ok := doc["message"].([]any); ok {
			parts := make([]string, 0, len(message))
			for _, entry := range message {
				if text, ok := entry.(string); ok {
					parts = append(parts, text)
				}
			}
			return sanitizeUpstreamErrorText(strings.Join(parts, "; "), 500)
		}
		return sanitizeUpstreamErrorText(trimmed, 500)
	}
	return sanitizeUpstreamErrorText(trimmed, 500)
}

func betweenTags(raw, tag string) string {
	lower := strings.ToLower(raw)
	open := "<" + tag
	start := strings.Index(lower, open)
	if start < 0 {
		return ""
	}
	start += len(open)
	if end := strings.Index(lower[start:], ">"); end >= 0 {
		start += end + 1
	} else {
		return ""
	}
	closing := "</" + tag + ">"
	end := strings.Index(lower[start:], closing)
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(raw[start : start+end])
}

func appliedGuardrails(header http.Header) []string {
	if header == nil {
		return nil
	}
	raw := strings.TrimSpace(header.Get("x-litellm-applied-guardrails"))
	if raw == "" {
		return nil
	}
	out := make([]string, 0, 2)
	seen := make(map[string]struct{})
	for _, entry := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func blockedCompletionResponse(status int, header http.Header, raw []byte) *GuardrailViolationError {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	messages, ok := doc["messages"].([]any)
	if !ok || len(messages) == 0 {
		return nil
	}
	choices, _ := doc["choices"].([]any)
	if len(choices) > 0 {
		return nil
	}
	message := "Unable to complete request: blocked by content safety policy."
	if first, ok := messages[0].(map[string]any); ok {
		if content, ok := first["content"].(string); ok && strings.TrimSpace(content) != "" {
			message = strings.TrimSpace(content)
		}
	}
	return &GuardrailViolationError{
		Message: message, Code: "GUARDRAIL_BLOCKED", UpstreamStatus: status,
		AppliedGuardrails: appliedGuardrails(header),
	}
}

// --- response parsing ---

func parseCompletionResponse(raw []byte, usedModel string, surface APISurface, header http.Header) (CompletionResponse, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return CompletionResponse{}, err
	}
	if surface == APISurfaceResponses {
		content := responsesTextContent(doc)
		if content == "" {
			return CompletionResponse{}, errors.New("model gateway returned empty content")
		}
		usage := responsesUsage(doc)
		applyHeaderCost(&usage, header)
		return CompletionResponse{
			Content: content,
			Model:   trimOr(stringFromAny(doc["model"]), usedModel),
			Usage:   usage,
		}, nil
	}
	choices, _ := doc["choices"].([]any)
	if len(choices) == 0 {
		return CompletionResponse{}, errors.New("model gateway returned no choices")
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	content := messageContent(message["content"])
	if content == "" {
		return CompletionResponse{}, errors.New("model gateway returned empty content")
	}
	usage := chatUsage(doc)
	applyHeaderCost(&usage, header)
	return CompletionResponse{
		Content: content,
		Model:   trimOr(stringFromAny(doc["model"]), usedModel),
		Usage:   usage,
	}, nil
}

func messageContent(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, entry := range typed {
			record, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := record["text"].(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func responsesTextContent(doc map[string]any) string {
	if text, ok := doc["output_text"].(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	output, _ := doc["output"].([]any)
	parts := make([]string, 0, len(output))
	for _, item := range output {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		content, _ := record["content"].([]any)
		for _, entry := range content {
			entryRecord, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := entryRecord["text"].(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
	}
	return strings.Join(parts, "")
}

func chatUsage(doc map[string]any) Usage {
	usage, _ := doc["usage"].(map[string]any)
	prompt := firstNumber(usage["prompt_tokens"])
	completion := firstNumber(usage["completion_tokens"])
	total := firstNumber(usage["total_tokens"])
	if total == nil && prompt != nil && completion != nil {
		sum := *prompt + *completion
		total = &sum
	}
	return Usage{
		PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total,
		CostUSD: payloadCost(doc, usage),
	}
}

func responsesUsage(doc map[string]any) Usage {
	usage, _ := doc["usage"].(map[string]any)
	prompt := firstNumber(usage["prompt_tokens"], usage["input_tokens"])
	completion := firstNumber(usage["completion_tokens"], usage["output_tokens"])
	if prompt == nil || completion == nil {
		return Usage{CostUSD: payloadCost(doc, usage)}
	}
	total := firstNumber(usage["total_tokens"])
	if total == nil {
		sum := *prompt + *completion
		total = &sum
	}
	return Usage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usage)}
}

func parseEmbeddingResponse(raw []byte, model string, header http.Header) (EmbeddingResponse, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return EmbeddingResponse{}, err
	}
	rows, _ := doc["data"].([]any)
	out := make([]EmbeddingRow, 0, len(rows))
	for _, entry := range rows {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		index, ok := integerFromAny(record["index"])
		if !ok || index < 0 {
			continue
		}
		vector := floatSlice(record["embedding"])
		if len(vector) == 0 {
			continue
		}
		out = append(out, EmbeddingRow{Index: index, Embedding: vector})
	}
	usage, _ := doc["usage"].(map[string]any)
	prompt := firstNumber(usage["prompt_tokens"])
	total := firstNumber(usage["total_tokens"])
	if total == nil {
		total = prompt
	}
	parsedUsage := Usage{PromptTokens: prompt, TotalTokens: total, CostUSD: payloadCost(doc, usage)}
	applyHeaderCost(&parsedUsage, header)
	return EmbeddingResponse{
		Rows:  out,
		Model: trimOr(stringFromAny(doc["model"]), model),
		Usage: parsedUsage,
	}, nil
}

func parseRerankResponse(raw []byte, documentCount int, model string, header http.Header) (RerankResponse, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return RerankResponse{}, err
	}
	rows, _ := doc["results"].([]any)
	if rows == nil {
		rows, _ = doc["data"].([]any)
	}
	out := make([]RerankResult, 0, len(rows))
	for _, entry := range rows {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		index, ok := integerFromAny(record["index"])
		if !ok || index < 0 || index >= documentCount {
			continue
		}
		score, ok := rerankScore(record)
		if !ok {
			continue
		}
		out = append(out, RerankResult{Index: index, Score: score})
	}
	if len(out) == 0 {
		return RerankResponse{}, errors.New("LiteLLM rerank returned no usable results")
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	usage, _ := doc["usage"].(map[string]any)
	parsedUsage := Usage{CostUSD: payloadCost(doc, usage)}
	applyHeaderCost(&parsedUsage, header)
	return RerankResponse{
		Results: out,
		Model:   trimOr(stringFromAny(doc["model"]), model),
		Usage:   parsedUsage,
	}, nil
}

func rerankScore(record map[string]any) (float64, bool) {
	for _, key := range []string{"relevance_score", "relevanceScore", "score", "similarity"} {
		if value := firstNumber(record[key]); value != nil {
			return *value, true
		}
	}
	return 0, false
}

func firstNumber(values ...any) *float64 {
	for _, value := range values {
		switch typed := value.(type) {
		case float64:
			if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
				copy := typed
				return &copy
			}
		case json.Number:
			if parsed, err := typed.Float64(); err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
				copy := parsed
				return &copy
			}
		case string:
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
				copy := parsed
				return &copy
			}
		}
	}
	return nil
}

func integerFromAny(value any) (int, bool) {
	number := firstNumber(value)
	if number == nil || *number < 0 || math.Trunc(*number) != *number {
		return 0, false
	}
	return int(*number), true
}

func floatSlice(value any) []float64 {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	out := make([]float64, len(items))
	for index, item := range items {
		number := firstNumber(item)
		if number == nil {
			return nil
		}
		out[index] = *number
	}
	return out
}

func payloadCost(doc, usage map[string]any) *float64 {
	if cost := firstNumber(doc["response_cost"]); cost != nil {
		return cost
	}
	if usage != nil {
		return firstNumber(usage["response_cost"])
	}
	return nil
}

// applyHeaderCost reproduces the LiteLLM cost header precedence.
func applyHeaderCost(usage *Usage, header http.Header) {
	if usage == nil || header == nil {
		return
	}
	for _, name := range []string{"x-litellm-response-cost", "x-litellm-cost", "litellm-cost"} {
		raw := strings.TrimSpace(header.Get(name))
		if raw == "" {
			continue
		}
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			continue
		}
		value := parsed
		usage.CostUSD = &value
		return
	}
}

func stringFromAny(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func trimOr(value, fallback string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(fallback)
}

func uniqueModels(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

func maxAttempts(request *int, configured int) int {
	value := configured
	if request != nil {
		value = *request
	}
	if value < 1 {
		return 1
	}
	return value
}

func retryableStatus(status int, err error) bool {
	if err == nil {
		return false
	}
	if status == 0 {
		return true
	}
	switch status {
	case http.StatusRequestTimeout, http.StatusConflict, http.StatusLocked, 425,
		http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func nextDelay(current time.Duration) time.Duration {
	next := current * 2
	if next > 10*time.Second {
		return 10 * time.Second
	}
	return next
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

// resolveResponseFormat mirrors resolveResponseFormat.
func resolveResponseFormat(format *ResponseFormat, mode ResponseFormatMode) *ResponseFormat {
	switch mode {
	case ResponseFormatNone:
		return nil
	case ResponseFormatJSONObject:
		return &ResponseFormat{Type: "json_object"}
	default:
		return format
	}
}

func resolveResponsesTextFormat(format *ResponseFormat, mode ResponseFormatMode) any {
	switch mode {
	case ResponseFormatNone:
		return nil
	case ResponseFormatJSONObject:
		return map[string]any{"type": "json_object"}
	default:
		if format == nil {
			return nil
		}
		switch format.Type {
		case "json_schema", "json_object", "text":
			return format
		default:
			return nil
		}
	}
}

// log writes one attempt row. Logging is best effort: a Mongo failure never
// changes the model result.
func (c *Client) log(ctx context.Context, profile gatewayProfile, requestType, model, orgID string, metadata Metadata, latency time.Duration, usage Usage, callErr error) {
	if c == nil || c.logs == nil {
		return
	}
	status := "success"
	errorText := ""
	governance := profile.GovernanceApplied
	if callErr != nil {
		status = "error"
		errorText = callErr.Error()
	}
	entry := llmlogs.ModelRequestEntry{
		OrgID:                     orgID,
		RequestType:               requestType,
		Model:                     model,
		Status:                    status,
		Error:                     errorText,
		Latency:                   latency,
		Usage:                     llmlogs.CompletionUsage{PromptTokens: usage.PromptTokens, CompletionTokens: usage.CompletionTokens, TotalTokens: usage.TotalTokens, CostUSD: usage.CostUSD},
		Feature:                   metadataFeature(metadata),
		GatewayProfileID:          profile.ID,
		GovernanceApplied:         &governance,
		AuthMode:                  profile.authMode(),
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
		APISurface:                surfaceForRequest(requestType, profile.APISurface),
		Metadata:                  metadataLogFields(metadata),
		OccurredAt:                c.now(),
	}
	if err := c.logs.Write(ctx, entry); err != nil && c.cfg.Logger != nil {
		c.cfg.Logger("litellmcompat: write request log: %v", err)
	}
}

func surfaceForRequest(requestType string, surface APISurface) string {
	switch requestType {
	case "embedding":
		return "embeddings"
	case "rerank":
		return "rerank"
	default:
		return string(surface)
	}
}
