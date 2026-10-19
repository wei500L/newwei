package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// This file adds the knowledge-graph completion surface. It reuses the gateway
// client, profile resolution, governance, API base normalization, retry policy
// and usage extraction that the news-event brief already uses, but sends the
// knowledge-graph request shape: temperature 0, an explicit token budget, a
// named json_schema response format and the {task,orgId,articleId} metadata.
//
// The knowledge-graph metadata never carries a feature/source/stage token, so
// LiteLlmService.resolveRequestGuardrails adds no guardrail for these calls;
// the request therefore omits the guardrails field. The brief and RSS request
// paths are untouched.

// KGCompletionMetadata is the model request metadata for the knowledge-graph
// validation and disambiguation calls. It is serialized verbatim into the
// upstream request body when the active profile has sendMetadata enabled, and
// it is later filtered by the LLM request-log policy before it is written to
// llmrequestlogs.
type KGCompletionMetadata struct {
	Task      string `json:"task"`
	OrgID     string `json:"orgId"`
	ArticleID string `json:"articleId,omitempty"`
}

// KGCompletionUsage is the token and cost accounting of one model call. A value
// the gateway did not report stays nil; it is never coerced to zero.
type KGCompletionUsage = BriefCompletionUsage

// KGCompletionAttempt describes one real HTTP attempt: one model, one try. The
// knowledge-graph callers pass maxRetries=1, so the fallback chain performs
// exactly one attempt per model and NestJS still writes one log row per
// attempt, including the failed ones.
type KGCompletionAttempt struct {
	OrgID                     string
	Model                     string
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	// Attempt is the 1-based try within one model; ModelIndex is the 1-based
	// position of the model in the requested-plus-fallback order.
	Attempt    int
	ModelIndex int
	Success    bool
	// Err is the attempt failure. It is nil on success.
	Err     error
	Latency time.Duration
	Usage   KGCompletionUsage
	// Metadata is the unfiltered request metadata, exactly as sent upstream.
	Metadata KGCompletionMetadata
}

// KGCompletionObserver receives every real model attempt. Implementations must
// not block or fail the caller on their own errors.
type KGCompletionObserver interface {
	ObserveKGCompletionAttempt(ctx context.Context, attempt KGCompletionAttempt)
}

// KGCompletionRequest is the strongly typed knowledge-graph completion input.
// The caller owns prompt construction and response parsing; this surface only
// performs the model call.
type KGCompletionRequest struct {
	OrgID string
	// Model is the explicitly requested model. Empty means the profile primary
	// model. Every call still appends the profile fallback models and dedupes,
	// matching LiteLlmService.acompletion.
	Model  string
	System string
	User   string
	// SchemaName is the json_schema name (kg_relation_validation or
	// kg_entity_disambiguation).
	SchemaName string
	// Schema is the json_schema `schema` object.
	Schema json.RawMessage
	// MaxTokens is max_tokens / max_output_tokens.
	MaxTokens int
	// TimeoutMS overrides the profile timeout for this request, matching the
	// explicit timeoutMs the knowledge-graph call sites pass.
	TimeoutMS  int
	MaxRetries int
	Metadata   KGCompletionMetadata
	Observer   KGCompletionObserver
}

// KGCompletionResult is one successful completion.
type KGCompletionResult struct {
	Content string
	Model   string
	Usage   KGCompletionUsage
}

// KGCompleter is the exported knowledge-graph completion surface reused by the
// ingestion quality and disambiguation paths.
type KGCompleter interface {
	// KGModels returns the primary model plus the configured fallback models,
	// trimmed and deduplicated in order.
	KGModels(ctx context.Context) ([]string, error)
	KGComplete(ctx context.Context, req KGCompletionRequest) (KGCompletionResult, error)
}

// NewKGCompleter builds the production knowledge-graph completer over the
// gateway settings reader. Configuration is resolved lazily on the first call,
// so no model is probed at startup.
func NewKGCompleter(settings BriefSettingsReader, env GatewayEnv) KGCompleter {
	if settings == nil {
		return unavailableKGCompleter{}
	}
	return newGateway(settings, env)
}

// unavailableKGCompleter reports a missing settings reader instead of panicking.
type unavailableKGCompleter struct{}

func (unavailableKGCompleter) KGModels(context.Context) ([]string, error) {
	return nil, errors.New("completion model is not configured")
}

func (unavailableKGCompleter) KGComplete(context.Context, KGCompletionRequest) (KGCompletionResult, error) {
	return KGCompletionResult{}, errors.New("completion model is not configured")
}

// kgSchemaResponseFormat is the chat-completions json_schema envelope.
type kgSchemaResponseFormat struct {
	Type       string           `json:"type"`
	JSONSchema kgSchemaEnvelope `json:"json_schema"`
}

type kgSchemaEnvelope struct {
	Name   string          `json:"name"`
	Schema json.RawMessage `json:"schema"`
}

// KGRelationValidationSchema is the JSON schema zodToJsonSchema derives from
// the relation validation payload.
const KGRelationValidationSchema = `{"type":"object","properties":{"verdict":{"type":"string","enum":["yes","no","uncertain"]},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["verdict","confidence"],"additionalProperties":false}`

// KGEntityDisambiguationSchema is the JSON schema zodToJsonSchema derives from
// the entity disambiguation payload.
const KGEntityDisambiguationSchema = `{"type":"object","properties":{"entityId":{"type":["string","null"]},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["entityId","confidence"],"additionalProperties":false}`

// errKGContentBlocked marks an upstream guardrail refusal that arrived as a
// successful response. Nest stops the fallback chain on this error, so the
// completion loop must not paper over it with another model.
var errKGContentBlocked = errors.New("model gateway blocked the request by guardrails")

// KGModels resolves the active completion profile and returns the primary model
// followed by the configured fallback models.
func (g *gatewayClient) KGModels(ctx context.Context) ([]string, error) {
	profiles, governance, err := g.store.GatewaySettings(ctx)
	if err != nil {
		return nil, err
	}
	profile, err := resolveCompletionProfile(profiles, governance, g.env)
	if err != nil {
		return nil, err
	}
	return uniqueModels(append([]string{profile.Model}, profile.FallbackModels...)), nil
}

// KGComplete walks the requested model followed by the configured fallback
// models and performs the configured attempts per model. observer, when not
// nil, receives one record per real attempt.
func (g *gatewayClient) KGComplete(ctx context.Context, req KGCompletionRequest) (KGCompletionResult, error) {
	profiles, governance, err := g.store.GatewaySettings(ctx)
	if err != nil {
		return KGCompletionResult{}, err
	}
	profile, err := resolveCompletionProfile(profiles, governance, g.env)
	if err != nil {
		return KGCompletionResult{}, err
	}
	requested := strings.TrimSpace(req.Model)
	if requested == "" {
		requested = profile.Model
	}
	models := uniqueModels(append([]string{requested}, profile.FallbackModels...))
	if len(models) == 0 {
		return KGCompletionResult{}, errors.New("completion model is not configured")
	}

	var last error
	for index, model := range models {
		outcome, attemptErr := g.completeKGModel(ctx, profile, model, index+1, req)
		if attemptErr == nil {
			return KGCompletionResult{
				Content: outcome.Content,
				Model:   outcome.Model,
				Usage:   outcome.Usage,
			}, nil
		}
		if isKGStopError(attemptErr) {
			return KGCompletionResult{}, attemptErr
		}
		last = attemptErr
	}
	if last == nil {
		last = errors.New("LiteLLM completion failed")
	}
	return KGCompletionResult{}, last
}

// kgCompletionOutcome is one successful model HTTP exchange.
type kgCompletionOutcome struct {
	Content string
	Model   string
	Usage   KGCompletionUsage
}

// completeKGModel performs the configured attempts for one model and reports
// every attempt to the observer.
func (g *gatewayClient) completeKGModel(
	ctx context.Context,
	profile completionProfile,
	model string,
	modelIndex int,
	req KGCompletionRequest,
) (kgCompletionOutcome, error) {
	attempts := req.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		started := time.Now()
		outcome, status, err := g.postKGCompletion(ctx, profile, model, req)
		attemptModel := outcome.Model
		if attemptModel == "" {
			// A failed attempt reports no response model; Nest logs the
			// requested model in that case.
			attemptModel = model
		}
		if req.Observer != nil {
			req.Observer.ObserveKGCompletionAttempt(ctx, KGCompletionAttempt{
				OrgID:                     req.OrgID,
				Model:                     attemptModel,
				APISurface:                profile.APISurface,
				GatewayProfileID:          profile.ID,
				GovernanceApplied:         profile.GovernanceApplied,
				AuthMode:                  profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				Attempt:                   attempt + 1,
				ModelIndex:                modelIndex,
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
		if errors.Is(err, errKGContentBlocked) || !retryable(status, err) || attempt+1 >= attempts {
			return kgCompletionOutcome{}, err
		}
		if sleepErr := sleep(ctx, delay); sleepErr != nil {
			return kgCompletionOutcome{}, sleepErr
		}
		if delay < 10*time.Second {
			delay *= 2
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
		}
	}
	return kgCompletionOutcome{}, last
}

// postKGCompletion sends one attempt and normalizes the response. It mirrors
// executeWithRetry / executeResponsesCompletionWithRetry payload construction
// for the knowledge-graph call site.
func (g *gatewayClient) postKGCompletion(
	ctx context.Context,
	profile completionProfile,
	model string,
	req KGCompletionRequest,
) (kgCompletionOutcome, int, error) {
	temperature := 0.0
	topP := profile.TopP
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 120
	}

	format := kgResponseFormat(profile.ResponseFormatMode, req.SchemaName, req.Schema)
	payload := map[string]any{
		"model":       model,
		"temperature": temperature,
		"top_p":       topP,
	}
	if profile.SendMetadata {
		payload["metadata"] = req.Metadata
	}

	var primary, fallback string
	if profile.APISurface == "responses" {
		payload["input"] = []map[string]string{
			{"role": "system", "content": req.System},
			{"role": "user", "content": req.User},
		}
		payload["max_output_tokens"] = maxTokens
		if format != nil {
			payload["text"] = map[string]any{"format": format}
		}
		primary, fallback = "/v1/responses", "/responses"
	} else {
		payload["messages"] = []map[string]string{
			{"role": "system", "content": req.System},
			{"role": "user", "content": req.User},
		}
		payload["max_tokens"] = maxTokens
		payload["stream"] = false
		if format != nil {
			payload["response_format"] = format
		}
		primary, fallback = "/v1/chat/completions", "/chat/completions"
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return kgCompletionOutcome{}, 0, err
	}
	callProfile := profile
	if req.TimeoutMS > 0 {
		callProfile.Timeout = time.Duration(req.TimeoutMS) * time.Millisecond
	}
	status, raw, header, err := g.post(ctx, callProfile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = g.post(ctx, callProfile, fallback, body)
	}
	if err != nil {
		return kgCompletionOutcome{}, status, err
	}
	if status < 200 || status >= 300 {
		return kgCompletionOutcome{}, status, errors.New("model gateway request failed")
	}
	content := completionText(raw, profile.APISurface)
	usage := completionUsage(raw, profile.APISurface)
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	if strings.TrimSpace(content) == "" {
		if isGuardrailBlockedResponse(raw) {
			return kgCompletionOutcome{Usage: usage}, status, errKGContentBlocked
		}
		return kgCompletionOutcome{Usage: usage}, status, errors.New("model gateway returned empty content")
	}
	return kgCompletionOutcome{Content: content, Model: completionResponseModel(raw, model), Usage: usage}, status, nil
}

// kgResponseFormat reproduces resolveResponseFormat /
// resolveResponsesTextFormat: an explicit profile mode wins over the requested
// schema.
func kgResponseFormat(mode, schemaName string, schema json.RawMessage) any {
	switch mode {
	case "none":
		return nil
	case "json_object":
		return map[string]any{"type": "json_object"}
	}
	if len(schema) == 0 || strings.TrimSpace(schemaName) == "" {
		return nil
	}
	return kgSchemaResponseFormat{
		Type: "json_schema",
		JSONSchema: kgSchemaEnvelope{
			Name:   schemaName,
			Schema: schema,
		},
	}
}

// completionResponseModel reads the model the gateway reports. An absent or
// non-string value falls back to the requested model.
func completionResponseModel(raw []byte, requested string) string {
	var doc struct {
		Model json.RawMessage `json:"model"`
	}
	if err := json.Unmarshal(raw, &doc); err == nil {
		var model string
		if json.Unmarshal(doc.Model, &model) == nil {
			if trimmed := strings.TrimSpace(model); trimmed != "" {
				return trimmed
			}
		}
	}
	return requested
}

// isKGStopError reports the failures that terminate the fallback chain: a
// governance configuration error (StatusError) and a guardrail refusal.
func isKGStopError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errKGContentBlocked) {
		return true
	}
	var status *StatusError
	return errors.As(err, &status)
}
