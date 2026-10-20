package publicportal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// This file adds the assistant model surface: non-streaming chat/responses
// completions, guardrail handling, the fallback-model chain, retry policy and
// per-attempt request logging. It reuses the gateway profile resolution,
// governance (managed runtime key) and usage extraction of gateway.go, and
// reads the assistant-specific profile fields (assistantModel, temperature,
// maxOutputTokens, web-search flag) directly from the stored document. It does
// not change the RSS translation or news-event brief request shapes.

// AssistantGatewayEnv is the environment default set of the assistant
// completion path. GatewayEnv keeps the values gateway.go already uses.
type AssistantGatewayEnv struct {
	GatewayEnv
	// Temperature is LITELLM_TEMPERATURE (0.2).
	Temperature float64
	// MaxOutputTokens mirrors LITELLM_MAX_TOKENS (falling back to
	// LITELLM_MAX_OUTPUT_TOKENS), the max_tokens/max_output_tokens default.
	MaxOutputTokens int
}

// AssistantMessage is one chat message. The assistant prompt builder only
// produces text content, so the wire shape stays a plain string.
type AssistantMessage struct {
	Role    string
	Content string
}

// AssistantUsage is the token and cost accounting of one model call.
type AssistantUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// AssistantRequestMetadata is the LLM request-log metadata. The feature must
// start with "assistant": the monthly token budget aggregates llmrequestlogs
// by that prefix.
type AssistantRequestMetadata struct {
	OrgID   string
	Source  string
	Feature string
}

// AssistantCompletionRequest is one non-streaming or streaming completion.
type AssistantCompletionRequest struct {
	OrgID          string
	Model          string
	Messages       []AssistantMessage
	ResponseFormat json.RawMessage
	Guardrails     []string
	Tools          []json.RawMessage
	Timeout        time.Duration
	Metadata       AssistantRequestMetadata
	// Observer, when set, receives one record per real HTTP attempt.
	Observer AssistantAttemptObserver
}

// AssistantCompletionResult is one successful non-streaming completion.
type AssistantCompletionResult struct {
	Content string
	Model   string
	Usage   AssistantUsage
}

// AssistantStreamEvent is one streamed delta or the terminal error.
type AssistantStreamEvent struct {
	Delta string
	Model string
	Err   error
}

// AssistantAttempt describes one real HTTP attempt. The assistant worker writes
// exactly one llmrequestlogs row per attempt, including fallbacks and failures.
type AssistantAttempt struct {
	OrgID                     string
	Model                     string
	ModelIndex                int
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	Success                   bool
	Err                       error
	Latency                   time.Duration
	Usage                     AssistantUsage
	Metadata                  AssistantRequestMetadata
	Streaming                 bool
}

// AssistantAttemptObserver persists one request-log row per attempt. It must
// not fail the completion on its own errors.
type AssistantAttemptObserver interface {
	ObserveAssistantAttempt(ctx context.Context, attempt AssistantAttempt)
}

// AssistantLLM is the assistant model surface used by internal/assistantruns.
type AssistantLLM interface {
	Complete(ctx context.Context, req AssistantCompletionRequest) (AssistantCompletionResult, error)
	Stream(ctx context.Context, req AssistantCompletionRequest) (<-chan AssistantStreamEvent, error)
	RuntimeCapabilities(ctx context.Context) (AssistantRuntimeCapabilities, error)
	AssistantModelOverride(ctx context.Context) (string, error)
}

// AssistantGuardrailError is the typed guardrail refusal. It mirrors
// LiteLlmGuardrailViolationError: the assistant worker writes the run as
// completed with a blocked output instead of failing it.
type AssistantGuardrailError struct {
	Message           string
	Code              string
	AppliedGuardrails []string
	UpstreamStatus    int
	Detail            string
}

func (e *AssistantGuardrailError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// assistantProfile is the resolved completion profile plus the assistant
// fields and request defaults gateway.go does not carry.
type assistantProfile struct {
	completionProfile
	AssistantModel   string
	Temperature      float64
	MaxOutputTokens  int
	WebSearchEnabled bool
}

type assistantClient struct {
	store BriefSettingsReader
	env   AssistantGatewayEnv
	http  *http.Client
}

// NewAssistantLLM builds the production assistant model client. Configuration
// is resolved on every call, so profile changes apply without a restart.
func NewAssistantLLM(settings BriefSettingsReader, env AssistantGatewayEnv) AssistantLLM {
	if env.Temperature < 0 {
		env.Temperature = 0.2
	}
	if env.MaxOutputTokens <= 0 {
		env.MaxOutputTokens = 1_200
	}
	return &assistantClient{store: settings, env: env, http: &http.Client{}}
}

// Complete performs one non-streaming completion over the active profile and
// its fallback chain.
func (c *assistantClient) Complete(ctx context.Context, req AssistantCompletionRequest) (AssistantCompletionResult, error) {
	return c.complete(ctx, req, false)
}

func (c *assistantClient) complete(ctx context.Context, req AssistantCompletionRequest, streaming bool) (AssistantCompletionResult, error) {
	profile, err := c.resolveProfile(ctx)
	if err != nil {
		return AssistantCompletionResult{}, err
	}
	models := assistantModels(profile, req.Model)
	if len(models) == 0 {
		return AssistantCompletionResult{}, errors.New("LiteLLM completion model is not configured in MySQL gateway profiles")
	}
	var lastErr error
	for index, model := range models {
		outcome, err := c.completeModel(ctx, profile, model, index+1, req, streaming)
		if err == nil {
			return outcome, nil
		}
		var guardrail *AssistantGuardrailError
		if errors.As(err, &guardrail) {
			return AssistantCompletionResult{}, err
		}
		var statusErr *StatusError
		if errors.As(err, &statusErr) {
			return AssistantCompletionResult{}, err
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM completion failed")
	}
	return AssistantCompletionResult{}, lastErr
}

func (c *assistantClient) resolveProfile(ctx context.Context) (assistantProfile, error) {
	profilesJSON, governanceJSON, err := c.store.GatewaySettings(ctx)
	if err != nil {
		return assistantProfile{}, err
	}
	base, err := resolveCompletionProfile(profilesJSON, governanceJSON, c.env.GatewayEnv)
	if err != nil {
		return assistantProfile{}, err
	}
	profile := assistantProfile{completionProfile: base}
	// The assistant-specific fields live on the selected profile document.
	// resolveCompletionProfile already performed selection and governance, so
	// the same id is read here for the extra fields only.
	var settings struct {
		Profiles []json.RawMessage `json:"profiles"`
	}
	if len(profilesJSON) > 0 {
		_ = json.Unmarshal(profilesJSON, &settings)
	}
	record := map[string]any(nil)
	for _, raw := range settings.Profiles {
		var candidate map[string]any
		if json.Unmarshal(raw, &candidate) != nil {
			continue
		}
		if jsonString(candidate["id"]) == base.ID {
			record = candidate
			break
		}
	}
	profile.Temperature = c.env.Temperature
	profile.MaxOutputTokens = c.env.MaxOutputTokens
	if record != nil {
		if value, ok := finiteNumber(record["temperature"]); ok {
			profile.Temperature = math.Max(0, math.Min(2, value))
		}
		if value, ok := positiveIntValue(record["maxOutputTokens"]); ok {
			profile.MaxOutputTokens = value
		}
		profile.AssistantModel = jsonString(record["assistantModel"])
		profile.WebSearchEnabled = jsonBool(record["assistantWebSearchEnabled"], false)
	}
	return profile, nil
}

func positiveIntValue(raw any) (int, bool) {
	value, ok := finiteNumber(raw)
	if !ok || value <= 0 {
		return 0, false
	}
	return int(value), true
}

// assistantModels is NestJS uniqueModelList([params.model ?? cfg.model,
// ...cfg.fallbackModels]).
func assistantModels(profile assistantProfile, requested string) []string {
	models := make([]string, 0, len(profile.FallbackModels)+1)
	primary := strings.TrimSpace(requested)
	if primary == "" {
		primary = strings.TrimSpace(profile.Model)
	}
	models = append(models, primary)
	for _, model := range profile.FallbackModels {
		models = append(models, strings.TrimSpace(model))
	}
	return uniqueModels(models)
}

func (c *assistantClient) completeModel(
	ctx context.Context,
	profile assistantProfile,
	model string,
	modelIndex int,
	req AssistantCompletionRequest,
	streaming bool,
) (AssistantCompletionResult, error) {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		started := time.Now()
		payload, path, fallbackPath, surface := c.completionPayload(profile, model, req)
		outcome, status, header, err := c.postJSON(ctx, profile, path, fallbackPath, payload, req.Timeout)
		var usage AssistantUsage
		guardrails := normalizeAssistantGuardrails(req.Guardrails)
		if err == nil {
			usage = assistantUsageFromResponse(outcome, surface)
			if cost, ok := extractCostHeader(header); ok {
				usage.CostUSD = &cost
			}
			var guardrailErr *AssistantGuardrailError
			guardrailErr = assistantGuardrailFromResponse(outcome, header, status, guardrails)
			if guardrailErr != nil {
				err = guardrailErr
			} else if status < 200 || status >= 300 {
				err = fmt.Errorf("LiteLLM request failed (HTTP %d)", status)
			} else if text := completionText(outcome, surface); strings.TrimSpace(text) != "" {
				// success below
			} else {
				err = errors.New("model gateway returned empty content")
			}
		} else if status != 0 {
			err = fmt.Errorf("LiteLLM request failed (HTTP %d)", status)
		}
		if err == nil {
			content := completionText(outcome, surface)
			normalizedModel := completionResponseModel(outcome, model)
			c.observe(ctx, req.Observer, profile, AssistantAttempt{
				OrgID:                     req.OrgID,
				Model:                     model,
				ModelIndex:                modelIndex,
				APISurface:                surface,
				GatewayProfileID:          profile.ID,
				GovernanceApplied:         profile.GovernanceApplied,
				AuthMode:                  profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				Success:                   true,
				Latency:                   time.Since(started),
				Usage:                     usage,
				Metadata:                  req.Metadata,
				Streaming:                 streaming,
			})
			return AssistantCompletionResult{Content: content, Model: normalizedModel, Usage: usage}, nil
		}
		c.observe(ctx, req.Observer, profile, AssistantAttempt{
			OrgID:                     req.OrgID,
			Model:                     model,
			ModelIndex:                modelIndex,
			APISurface:                surface,
			GatewayProfileID:          profile.ID,
			GovernanceApplied:         profile.GovernanceApplied,
			AuthMode:                  profile.authMode(),
			GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
			Success:                   false,
			Err:                       err,
			Latency:                   time.Since(started),
			Usage:                     usage,
			Metadata:                  req.Metadata,
			Streaming:                 streaming,
		})
		lastErr = err
		var guardrail *AssistantGuardrailError
		if errors.As(err, &guardrail) {
			return AssistantCompletionResult{}, err
		}
		if !retryable(status, err) || attempt+1 >= attempts {
			return AssistantCompletionResult{}, err
		}
		if sleepErr := sleep(ctx, delay); sleepErr != nil {
			return AssistantCompletionResult{}, sleepErr
		}
		if delay < 10*time.Second {
			delay *= 2
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
		}
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM completion exhausted retries")
	}
	return AssistantCompletionResult{}, lastErr
}

func (c *assistantClient) observe(ctx context.Context, observer AssistantAttemptObserver, _ assistantProfile, attempt AssistantAttempt) {
	if observer != nil {
		observer.ObserveAssistantAttempt(ctx, attempt)
	}
}

// completionPayload builds the request body and endpoint for the active API
// surface. It mirrors executeWithRetry/executeResponsesCompletionWithRetry:
// temperature, top_p, max_tokens/max_output_tokens, response_format/text.format,
// guardrails, tools and optional metadata.
func (c *assistantClient) completionPayload(profile assistantProfile, model string, req AssistantCompletionRequest) ([]byte, string, string, string) {
	guardrails := normalizeAssistantGuardrails(req.Guardrails)
	messages := make([]map[string]string, 0, len(req.Messages))
	for _, message := range req.Messages {
		messages = append(messages, map[string]string{"role": message.Role, "content": message.Content})
	}
	maxTokens := profile.MaxOutputTokens
	if profile.APISurface == "responses" {
		payload := map[string]any{
			"model":             model,
			"input":             messages,
			"temperature":       profile.Temperature,
			"top_p":             profile.TopP,
			"max_output_tokens": maxTokens,
		}
		if format := resolveResponsesTextFormat(req.ResponseFormat, profile.ResponseFormatMode); format != nil {
			payload["text"] = map[string]any{"format": format}
		}
		if len(guardrails) > 0 {
			payload["guardrails"] = guardrails
		}
		if len(req.Tools) > 0 {
			payload["tools"] = req.Tools
		}
		if metadata := assistantMetadata(req.Metadata, profile.SendMetadata); metadata != nil {
			payload["metadata"] = metadata
		}
		body, _ := json.Marshal(payload)
		return body, "/v1/responses", "/responses", "responses"
	}
	payload := map[string]any{
		"model":       model,
		"messages":    messages,
		"temperature": profile.Temperature,
		"top_p":       profile.TopP,
		"max_tokens":  maxTokens,
		"stream":      false,
	}
	if format := resolveChatResponseFormat(req.ResponseFormat, profile.ResponseFormatMode); format != nil {
		payload["response_format"] = format
	}
	if len(guardrails) > 0 {
		payload["guardrails"] = guardrails
	}
	if len(req.Tools) > 0 {
		payload["tools"] = req.Tools
	}
	if metadata := assistantMetadata(req.Metadata, profile.SendMetadata); metadata != nil {
		payload["metadata"] = metadata
	}
	body, _ := json.Marshal(payload)
	return body, "/v1/chat/completions", "/chat/completions", "chat_completions"
}

func assistantMetadata(metadata AssistantRequestMetadata, send bool) map[string]any {
	if !send {
		return nil
	}
	return map[string]any{
		"orgId":   metadata.OrgID,
		"source":  metadata.Source,
		"feature": metadata.Feature,
	}
}

func resolveResponsesTextFormat(raw json.RawMessage, mode string) any {
	if mode == "none" || len(raw) == 0 {
		return nil
	}
	if mode == "json_object" {
		return map[string]any{"type": "json_object"}
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil
	}
	record, ok := decoded.(map[string]any)
	if !ok {
		return nil
	}
	switch record["type"] {
	case "json_schema", "json_object", "text":
		return record
	default:
		return nil
	}
}

func resolveChatResponseFormat(raw json.RawMessage, mode string) any {
	if mode == "none" || len(raw) == 0 {
		return nil
	}
	if mode == "json_object" {
		return map[string]any{"type": "json_object"}
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return nil
	}
	return decoded
}

func (c *assistantClient) postJSON(
	ctx context.Context,
	profile assistantProfile,
	primaryPath, fallbackPath string,
	body []byte,
	timeout time.Duration,
) ([]byte, int, http.Header, error) {
	status, raw, header, err := c.post(ctx, profile, primaryPath, body, timeout)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = c.post(ctx, profile, fallbackPath, body, timeout)
	}
	return raw, status, header, err
}

func (c *assistantClient) post(ctx context.Context, profile assistantProfile, path string, body []byte, timeout time.Duration) (int, []byte, http.Header, error) {
	if timeout <= 0 {
		timeout = profile.Timeout
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return resp.StatusCode, nil, resp.Header, err
	}
	return resp.StatusCode, raw, resp.Header, nil
}

func assistantUsageFromResponse(raw []byte, surface string) AssistantUsage {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return AssistantUsage{}
	}
	usageRecord, _ := doc["usage"].(map[string]any)
	if surface == "responses" {
		prompt := firstFinite(usageRecord["prompt_tokens"], usageRecord["input_tokens"])
		completion := firstFinite(usageRecord["completion_tokens"], usageRecord["output_tokens"])
		if prompt == nil || completion == nil {
			return AssistantUsage{CostUSD: payloadCost(doc, usageRecord)}
		}
		total := firstFinite(usageRecord["total_tokens"], nil)
		if total == nil {
			sum := *prompt + *completion
			total = &sum
		}
		return AssistantUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usageRecord)}
	}
	prompt := firstFinite(usageRecord["prompt_tokens"], nil)
	completion := firstFinite(usageRecord["completion_tokens"], nil)
	total := firstFinite(usageRecord["total_tokens"], nil)
	if total == nil && prompt != nil && completion != nil {
		sum := *prompt + *completion
		total = &sum
	}
	return AssistantUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usageRecord)}
}

func normalizeAssistantGuardrails(raw []string) []string {
	out := make([]string, 0, len(raw))
	seen := make(map[string]bool, len(raw))
	for _, entry := range raw {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

// --- guardrail conversion, mirroring litellm.service.ts ---

func assistantGuardrailFromResponse(raw []byte, header http.Header, status int, requested []string) *AssistantGuardrailError {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	applied := appliedGuardrails(header)
	if message := guardrailBlockedMessage(doc); message != "" {
		return buildAssistantGuardrail(message, applied, status)
	}
	structured, detail := structuredGuardrailSignal(doc)
	lower := strings.ToLower(detail)
	definite := strings.Contains(lower, "violated guardrail") ||
		strings.Contains(lower, "guardrail_intervened") ||
		(strings.Contains(lower, "guardrail") && (strings.Contains(lower, "policy") || strings.Contains(lower, "blocked") || strings.Contains(lower, "reject")))
	injection := strings.Contains(lower, "prompt injection") || strings.Contains(lower, "promptinjection") || strings.Contains(lower, "jailbreak")
	trust := (strings.Contains(lower, "trust") && strings.Contains(lower, "safety") && strings.Contains(lower, "violation")) || strings.Contains(lower, "trust & safety violation")
	moderation := strings.Contains(lower, "moderation") && (strings.Contains(lower, "flag") || strings.Contains(lower, "blocked") || strings.Contains(lower, "violate"))
	requestedClientError := len(requested) > 0 && status >= 400 && status < 500 && guardrailStatusAllowed(status)
	if len(applied) > 0 || structured || requestedClientError || (status >= 400 && (definite || injection || trust || moderation)) {
		return buildAssistantGuardrail(detail, applied, status)
	}
	return nil
}

func guardrailStatusAllowed(status int) bool {
	switch status {
	case 400, 403, 422:
		return true
	default:
		return false
	}
}

func buildAssistantGuardrail(detail string, applied []string, status int) *AssistantGuardrailError {
	message, code := userFacingGuardrailMessage(detail)
	return &AssistantGuardrailError{
		Message:           message,
		Code:              code,
		AppliedGuardrails: applied,
		UpstreamStatus:    status,
		Detail:            detail,
	}
}

func guardrailBlockedMessage(doc map[string]any) string {
	messages, ok := doc["messages"].([]any)
	if !ok || len(messages) == 0 {
		return ""
	}
	if choices, ok := doc["choices"].([]any); ok && len(choices) > 0 {
		return ""
	}
	if first, ok := messages[0].(map[string]any); ok {
		if content, ok := first["content"].(string); ok && strings.TrimSpace(content) != "" {
			return strings.TrimSpace(content)
		}
	}
	return "Unable to complete request: blocked by content safety policy."
}

func appliedGuardrails(header http.Header) []string {
	if header == nil {
		return nil
	}
	raw := header.Get("x-litellm-applied-guardrails")
	if raw == "" {
		return nil
	}
	out := make([]string, 0)
	seen := map[string]bool{}
	for _, entry := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

var structuredGuardrailPattern = []string{"guardrail", "moderation", "prompt injection", "promptinjection", "jailbreak", "content policy", "content_policy", "trust safety", "trust & safety", "trust_safety"}

func structuredGuardrailSignal(doc map[string]any) (bool, string) {
	parts := make([]string, 0, 8)
	appendString := func(value any) {
		if text, ok := value.(string); ok && text != "" {
			parts = append(parts, text)
		}
	}
	appendString(doc["message"])
	var errorObject map[string]any
	if candidate, ok := doc["error"].(map[string]any); ok {
		errorObject = candidate
	}
	metadata, _ := doc["metadata"].(map[string]any)
	if errorObject != nil {
		appendString(errorObject["message"])
		appendString(errorObject["type"])
		appendString(errorObject["code"])
		appendString(errorObject["param"])
		if candidate, ok := errorObject["metadata"].(map[string]any); ok {
			metadata = candidate
		}
	}
	if metadata != nil {
		appendString(metadata["guardrail"])
		appendString(metadata["guardrail_name"])
	}
	joined := strings.Join(parts, " ")
	lower := strings.ToLower(joined)
	matched := false
	for _, needle := range structuredGuardrailPattern {
		if strings.Contains(lower, needle) {
			matched = true
			break
		}
	}
	return matched, joined
}

func userFacingGuardrailMessage(detail string) (string, string) {
	lower := strings.ToLower(strings.TrimSpace(detail))
	if strings.Contains(lower, "guardrail") && (strings.Contains(lower, "not found") || strings.Contains(lower, "unknown")) {
		return "AI safety checks are misconfigured (guardrail not found). Please contact an administrator.", "GUARDRAIL_MISCONFIG"
	}
	if strings.Contains(lower, "prompt injection") || strings.Contains(lower, "promptinjection") || strings.Contains(lower, "jailbreak") {
		return "Unable to complete request: prompt injection/jailbreak detected.", "PROMPT_INJECTION"
	}
	if strings.Contains(lower, "trust") && strings.Contains(lower, "safety") && strings.Contains(lower, "violation") {
		return "Unable to complete request: trust & safety violation detected.", "TRUST_SAFETY_VIOLATION"
	}
	if strings.Contains(lower, "language") && strings.Contains(lower, "violation") {
		return "Unable to complete request: language policy violation detected.", "LANGUAGE_POLICY_VIOLATION"
	}
	if strings.Contains(lower, "moderation") {
		return "Unable to complete request: blocked by content moderation.", "MODERATION_BLOCKED"
	}
	if strings.Contains(lower, "guardrail") {
		return "Unable to complete request: blocked by content safety guardrails.", "GUARDRAIL_BLOCKED"
	}
	return "Unable to complete request: blocked by content safety policy.", "GUARDRAIL_BLOCKED"
}

// AssistantRuntimeCapabilities is the capability projection the write path
// reuses. It matches AssistantService.getRuntimeCapabilities.
type AssistantRuntimeCapabilities struct {
	AssistantModel     string
	APISurface         string
	WebSearchSupported bool
}

// AssistantCapabilities resolves the active completion profile and projects the
// assistant capabilities. An empty result means no profile is configured.
func (c *assistantClient) capsValue(profile assistantProfile) AssistantRuntimeCapabilities {
	model := strings.TrimSpace(profile.AssistantModel)
	if model == "" {
		model = strings.TrimSpace(profile.Model)
	}
	return AssistantRuntimeCapabilities{
		AssistantModel:     model,
		APISurface:         profile.APISurface,
		WebSearchSupported: profile.APISurface == "responses" && profile.WebSearchEnabled,
	}
}

// AssistantModelOverride mirrors resolveAssistantModelOverride: only the
// profile's assistantModel is an override; an empty value means "use the
// profile model".
func (c *assistantClient) AssistantModelOverride(ctx context.Context) (string, error) {
	profile, err := c.resolveProfile(ctx)
	if err != nil {
		if strings.Contains(err.Error(), "not configured") {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(profile.AssistantModel), nil
}

// RuntimeCapabilities reads the active profile and projects the capability
// fields. It is exported for the submit path's web-search support check.
func (c *assistantClient) RuntimeCapabilities(ctx context.Context) (AssistantRuntimeCapabilities, error) {
	profile, err := c.resolveProfile(ctx)
	if err != nil {
		if strings.Contains(err.Error(), "not configured") {
			return AssistantRuntimeCapabilities{}, nil
		}
		return AssistantRuntimeCapabilities{}, err
	}
	return c.capsValue(profile), nil
}

// AssistantCapabilityReader is the narrow capability surface the submit path
// depends on.
type AssistantCapabilityReader interface {
	RuntimeCapabilities(ctx context.Context) (AssistantRuntimeCapabilities, error)
}
