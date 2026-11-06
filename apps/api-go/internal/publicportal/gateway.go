package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// StatusError 是要按 Nest HTTP 异常原样返回的失败。
type StatusError struct {
	Code    int
	Message string
	Name    string
}

func (e *StatusError) Error() string { return e.Message }

// GatewayEnv 是 Nest 已经使用的模型网关环境。空值按 Nest env schema 的默认。
type GatewayEnv struct {
	EncryptionKey string
	APIBase       string
	APIKey        string
	TimeoutMs     int
	MaxRetries    int
	// TopP is the LITELLM_TOP_P gateway default (0.9). It is the fallback for a
	// profile without an explicit topP and is consumed by the RSS translation
	// completion surface and the analysis stream; the brief request keeps its
	// own literal 0.9.
	TopP float64
	// Temperature and MaxOutputTokens are the LITELLM_TEMPERATURE (0.2) and
	// effective LITELLM_MAX_TOKENS (2048) defaults. They are only read by the
	// analysis stream; the brief and RSS completion requests keep their own
	// hard-coded sampling values.
	Temperature     float64
	MaxOutputTokens int
}

type completionRequest struct {
	OrgID    string
	System   string
	User     string
	Metadata BriefCompletionMetadata
}

// BriefSettingsReader is the only store capability the model gateway needs:
// the raw llm_gateway_profiles and litellm_proxy_governance documents. Keeping
// it narrow lets the exported brief completion surface run without the public
// portal home/channel reads.
type BriefSettingsReader interface {
	GatewaySettings(ctx context.Context) (profiles, governance []byte, err error)
}

type completionProfile struct {
	ID                 string
	APIBase            string
	APIKey             string
	Model              string
	FallbackModels     []string
	Timeout            time.Duration
	MaxRetries         int
	SendMetadata       bool
	ResponseFormatMode string
	APISurface         string
	// TopP mirrors the normalized profile topP (clamped 0..1, env default 0.9).
	// The RSS translation request and the analysis stream use it; the brief
	// request keeps its own literal 0.9.
	TopP float64
	// Temperature and MaxOutputTokens mirror the normalized profile values
	// (temperature clamped 0..2, env default 0.2; positive maxOutputTokens,
	// effective env default 2048). They are only read by the analysis stream.
	Temperature     float64
	MaxOutputTokens int
	// Governance mirrors Nest's resolved config after
	// applyManagedProxyGovernance: whether the managed runtime key replaced
	// the profile key, the auth mode the request used, and the governance
	// target profile id. They are also written to the LLM request log.
	GovernanceApplied         bool
	GovernanceAuthMode        string
	GovernanceTargetProfileID string
}

// authMode mirrors litellm.service.ts governanceAuthMode ?? "profile_key".
func (p completionProfile) authMode() string {
	if p.GovernanceApplied {
		return "managed_runtime_key"
	}
	return "profile_key"
}

type gatewayClient struct {
	store BriefSettingsReader
	env   GatewayEnv
	http  *http.Client
}

func newGateway(store BriefSettingsReader, env GatewayEnv) *gatewayClient {
	if env.APIBase == "" {
		env.APIBase = "http://localhost:4001"
	}
	if env.TimeoutMs <= 0 {
		env.TimeoutMs = 60_000
	}
	if env.MaxRetries <= 0 {
		env.MaxRetries = 3
	}
	if env.TopP <= 0 {
		env.TopP = 0.9
	}
	if env.Temperature <= 0 {
		env.Temperature = 0.2
	}
	if env.MaxOutputTokens <= 0 {
		env.MaxOutputTokens = 2_048
	}
	return &gatewayClient{store: store, env: env, http: &http.Client{}}
}

// errContentBlocked marks an upstream guardrail refusal that arrived as a
// successful HTTP response. Nest stops the fallback chain on this error, so the
// completion loop must not paper over it with another model.
var errContentBlocked = errors.New("model gateway blocked the request by guardrails")

// completionOutcome is one successful or failed model HTTP exchange.
type completionOutcome struct {
	Content string
	Usage   BriefCompletionUsage
}

// Complete keeps the public portal story-detail call shape: content only.
func (g *gatewayClient) Complete(ctx context.Context, req completionRequest) (string, error) {
	outcome, err := g.complete(ctx, req, nil)
	if err != nil {
		return "", err
	}
	return outcome.Content, nil
}

// complete resolves the active profile and walks the primary model followed by
// the configured fallback models. observer, when not nil, receives one record
// per real HTTP attempt.
func (g *gatewayClient) complete(ctx context.Context, req completionRequest, observer BriefCompletionObserver) (completionOutcome, error) {
	profiles, governance, err := g.store.GatewaySettings(ctx)
	if err != nil {
		return completionOutcome{}, err
	}
	profile, err := resolveCompletionProfile(profiles, governance, g.env)
	if err != nil {
		return completionOutcome{}, err
	}
	models := uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	if len(models) == 0 {
		return completionOutcome{}, errors.New("completion model is not configured")
	}
	var last error
	for index, model := range models {
		outcome, err := g.completeModel(ctx, profile, model, index, req, observer)
		if err == nil {
			return outcome, nil
		}
		if status, ok := err.(*StatusError); ok {
			return completionOutcome{}, status
		}
		if errors.Is(err, errContentBlocked) {
			// A guardrail refusal terminates the whole chain; Nest does not
			// retry it against a fallback model.
			return completionOutcome{}, err
		}
		last = err
	}
	if last == nil {
		last = errors.New("completion failed")
	}
	return completionOutcome{}, last
}

func (g *gatewayClient) completeModel(ctx context.Context, profile completionProfile, model string, modelIndex int, req completionRequest, observer BriefCompletionObserver) (completionOutcome, error) {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		started := time.Now()
		outcome, status, err := g.postCompletion(ctx, profile, model, req)
		if observer != nil {
			observer.ObserveBriefCompletionAttempt(ctx, BriefCompletionAttempt{
				OrgID:                     req.OrgID,
				Model:                     model,
				APISurface:                profile.APISurface,
				GatewayProfileID:          profile.ID,
				GovernanceApplied:         profile.GovernanceApplied,
				AuthMode:                  profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				Attempt:                   attempt + 1,
				ModelIndex:                modelIndex + 1,
				Success:                   err == nil,
				Err:                       err,
				Latency:                   time.Since(started),
				Usage:                     outcome.Usage,
				Metadata:                  req.Metadata,
			})
		}
		if err == nil {
			return outcome, nil
		}
		last = err
		if errors.Is(err, errContentBlocked) || !retryable(status, err) || attempt+1 >= attempts {
			return completionOutcome{}, err
		}
		if sleepErr := sleep(ctx, delay); sleepErr != nil {
			return completionOutcome{}, sleepErr
		}
		if delay < 10*time.Second {
			delay *= 2
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
		}
	}
	return completionOutcome{}, last
}

func (g *gatewayClient) postCompletion(ctx context.Context, profile completionProfile, model string, req completionRequest) (completionOutcome, int, error) {
	payload := map[string]any{
		"temperature": 0.2,
		"top_p":       0.9,
	}
	format := briefResponseFormat(profile.ResponseFormatMode)
	if profile.SendMetadata {
		payload["metadata"] = req.Metadata
	}
	var primary, fallback string
	if profile.APISurface == "responses" {
		payload["model"] = model
		payload["input"] = []map[string]string{
			{"role": "system", "content": req.System},
			{"role": "user", "content": req.User},
		}
		payload["max_output_tokens"] = 1200
		if format != nil {
			payload["text"] = map[string]any{"format": format}
		}
		primary, fallback = "/v1/responses", "/responses"
	} else {
		payload["model"] = model
		payload["messages"] = []map[string]string{
			{"role": "system", "content": req.System},
			{"role": "user", "content": req.User},
		}
		payload["max_tokens"] = 1200
		payload["stream"] = false
		if format != nil {
			payload["response_format"] = format
		}
		primary, fallback = "/v1/chat/completions", "/chat/completions"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return completionOutcome{}, 0, err
	}
	status, raw, header, err := g.post(ctx, profile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = g.post(ctx, profile, fallback, body)
	}
	if err != nil {
		return completionOutcome{}, status, err
	}
	if status < 200 || status >= 300 {
		return completionOutcome{}, status, errors.New("model gateway request failed")
	}
	content := completionText(raw, profile.APISurface)
	usage := completionUsage(raw, profile.APISurface)
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	if strings.TrimSpace(content) == "" {
		if isGuardrailBlockedResponse(raw) {
			return completionOutcome{Usage: usage}, status, errContentBlocked
		}
		return completionOutcome{Usage: usage}, status, errors.New("model gateway returned empty content")
	}
	return completionOutcome{Content: content, Usage: usage}, status, nil
}

func (g *gatewayClient) post(ctx context.Context, profile completionProfile, path string, body []byte) (int, []byte, http.Header, error) {
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return litellmcompat.PostOnce(ctx, g.http, profile.APIBase, profile.APIKey, path, body, timeout, 2<<20)
}

// isGuardrailBlockedResponse mirrors Nest's extractGuardrailBlockedMessage:
// LiteLLM reports a guardrail refusal as a successful response whose body
// carries a non-empty messages array and no usable choice.
func isGuardrailBlockedResponse(raw []byte) bool {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	messages, ok := doc["messages"].([]any)
	if !ok || len(messages) == 0 {
		return false
	}
	choices, _ := doc["choices"].([]any)
	return len(choices) == 0
}

// completionUsage extracts the token accounting of one successful response.
// Unknown values stay nil; they are never coerced to zero. The responses
// surface reports no usage at all unless both token counts are numeric, which
// mirrors normalizeCompletionUsageFromResponses.
func completionUsage(raw []byte, surface string) BriefCompletionUsage {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return BriefCompletionUsage{}
	}
	usageRecord, _ := doc["usage"].(map[string]any)
	if surface == "responses" {
		prompt := firstFinite(usageRecord["prompt_tokens"], usageRecord["input_tokens"])
		completion := firstFinite(usageRecord["completion_tokens"], usageRecord["output_tokens"])
		if prompt == nil || completion == nil {
			return BriefCompletionUsage{CostUSD: payloadCost(doc, usageRecord)}
		}
		total := firstFinite(usageRecord["total_tokens"], nil)
		if total == nil {
			sum := *prompt + *completion
			total = &sum
		}
		return BriefCompletionUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usageRecord)}
	}
	prompt := firstFinite(usageRecord["prompt_tokens"], nil)
	completion := firstFinite(usageRecord["completion_tokens"], nil)
	total := firstFinite(usageRecord["total_tokens"], nil)
	if total == nil && prompt != nil && completion != nil {
		sum := *prompt + *completion
		total = &sum
	}
	return BriefCompletionUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usageRecord)}
}

func payloadCost(doc, usageRecord map[string]any) *float64 {
	if usageRecord != nil {
		if cost := firstFinite(usageRecord["response_cost"], nil); cost != nil {
			return cost
		}
	}
	return firstFinite(doc["response_cost"], nil)
}

func firstFinite(values ...any) *float64 {
	for _, value := range values {
		if value == nil {
			continue
		}
		number, ok := finiteNumber(value)
		if !ok {
			continue
		}
		return &number
	}
	return nil
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

// extractCostHeader reads the LiteLLM cost headers in Nest's order.
func extractCostHeader(header http.Header) (float64, bool) {
	if header == nil {
		return 0, false
	}
	for _, name := range []string{"x-litellm-response-cost", "x-litellm-cost", "litellm-cost"} {
		raw := strings.TrimSpace(header.Get(name))
		if raw == "" {
			continue
		}
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed, true
		}
	}
	return 0, false
}

func retryable(status int, err error) bool {
	if err == nil {
		return false
	}
	if status == 0 {
		return true
	}
	switch status {
	case 408, 409, 423, 425, 429, 500, 502, 503, 504:
		return true
	default:
		return false
	}
}

func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func completionText(raw []byte, surface string) string {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	if surface == "responses" {
		if text, ok := doc["output_text"].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
		output, _ := doc["output"].([]any)
		var parts []string
		for _, item := range output {
			record, _ := item.(map[string]any)
			content, _ := record["content"].([]any)
			for _, entry := range content {
				part, _ := entry.(map[string]any)
				if text, ok := part["text"].(string); ok && text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "")
	}
	choices, _ := doc["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	switch content := message["content"].(type) {
	case string:
		return content
	case []any:
		var parts []string
		for _, part := range content {
			record, _ := part.(map[string]any)
			if text, ok := record["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

// resolveCompletionProfile resolves the active completion profile through the
// shared litellmcompat resolver so the public portal no longer keeps its own
// copy of profile normalization, secret decryption, governance and API-base
// normalization. The package-private completionProfile shape is kept because the
// completion surfaces read its fields directly.
func resolveCompletionProfile(profilesJSON, governanceJSON []byte, env GatewayEnv) (completionProfile, error) {
	cfg := litellmcompat.Config{
		EncryptionKey:          env.EncryptionKey,
		APIBase:                defaultString(env.APIBase, "http://localhost:4001"),
		Timeout:                time.Duration(defaultPositive(env.TimeoutMs, 60_000)) * time.Millisecond,
		MaxRetries:             defaultPositive(env.MaxRetries, 3),
		DefaultTemperature:     defaultFloat(env.Temperature, 0.2),
		DefaultTopP:            defaultFloat(env.TopP, 0.9),
		DefaultMaxOutputTokens: defaultPositive(env.MaxOutputTokens, 2_048),
	}
	profile, err := litellmcompat.ResolveProfileFromSettings(litellmcompat.ProfileCompletion, profilesJSON, governanceJSON, cfg)
	if err != nil {
		return completionProfile{}, translateProfileError(err)
	}
	if profile.Model == "" || profile.APIBase == "" {
		return completionProfile{}, errors.New("completion model is not configured")
	}
	return completionProfileFromShared(profile), nil
}

// translateProfileError maps the shared resolver errors onto the public portal
// contract: a missing profile is the historic "not configured" message and a
// governance misconfiguration keeps the HTTP 503 StatusError envelope.
func translateProfileError(err error) error {
	var governance *litellmcompat.GovernanceError
	if errors.As(err, &governance) {
		return &StatusError{Code: http.StatusServiceUnavailable, Message: governance.Message, Name: "Service Unavailable"}
	}
	if errors.Is(err, litellmcompat.ErrCompletionUnavailable) {
		return errors.New("completion model is not configured")
	}
	return err
}

func completionProfileFromShared(profile litellmcompat.Profile) completionProfile {
	return completionProfile{
		ID:                        profile.ID,
		APIBase:                   profile.APIBase,
		APIKey:                    profile.APIKey,
		Model:                     profile.Model,
		FallbackModels:            profile.FallbackModels,
		Timeout:                   profile.Timeout,
		MaxRetries:                profile.MaxRetries,
		SendMetadata:              profile.SendMetadata,
		ResponseFormatMode:        string(profile.ResponseFormatMode),
		APISurface:                string(profile.APISurface),
		TopP:                      profile.TopP,
		Temperature:               profile.Temperature,
		MaxOutputTokens:           profile.MaxOutputTokens,
		GovernanceApplied:         profile.GovernanceApplied,
		GovernanceAuthMode:        profile.AuthMode,
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
	}
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func defaultPositive(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func defaultFloat(value, fallback float64) float64 {
	if value <= 0 {
		return fallback
	}
	return value
}

func uniqueModels(models []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func jsonString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func jsonBool(value any, fallback bool) bool {
	flag, ok := value.(bool)
	if !ok {
		return fallback
	}
	return flag
}

func briefResponseFormat(mode string) any {
	switch mode {
	case "none":
		return nil
	case "json_object":
		return map[string]any{"type": "json_object"}
	default:
		return map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "news_event_brief_v1",
				"schema": briefJSONSchema(),
			},
		}
	}
}

// briefJSONSchema mirrors the JSON schema zodToJsonSchema derives from
// NewsEventBriefPayloadSchema: the point object requires only text (citations
// has a default), key_points carries minItems 1, and latest_update is nullable.
func briefJSONSchema() map[string]any {
	point := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text":      map[string]any{"type": "string", "minLength": 1},
			"citations": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1}, "maxItems": 12, "default": []any{}},
		},
		"required":             []string{"text"},
		"additionalProperties": false,
	}
	points := func(max int) map[string]any {
		return map[string]any{"type": "array", "items": point, "maxItems": max, "default": []any{}}
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"detailed_summary": map[string]any{"type": "string", "minLength": 1},
			"tldr":             map[string]any{"type": "string", "minLength": 1},
			"key_points":       map[string]any{"type": "array", "items": point, "minItems": 1, "maxItems": 10},
			"why_it_matters":   points(10),
			"latest_update":    map[string]any{"anyOf": []any{point, map[string]any{"type": "null"}}},
			"what_to_watch":    points(12),
			"comparison": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"consensus":  points(12),
					"divergence": points(12),
				},
				"additionalProperties": false,
			},
			"limitations": map[string]any{"type": []any{"string", "null"}},
		},
		"required":             []string{"detailed_summary", "tldr"},
		"additionalProperties": false,
	}
}
