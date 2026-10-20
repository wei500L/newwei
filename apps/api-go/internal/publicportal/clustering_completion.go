package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// This file adds the news-event clustering LLM backfill completion surface. It
// reuses the gateway client, profile resolution, governance, API base
// normalization, retry policy, error decoration and usage extraction the brief
// and RSS translation surfaces already use. The only new request shape is the
// fixed JSON-schema decision call: an explicit model override, temperature 0,
// top_p 1, max_tokens 350, a json_schema response format named
// news_event_llm_backfill_decision_v1 and the feature/candidateCount/
// articleFingerprint metadata. gateway.go is untouched.

const clusteringDecisionFeature = "news_event_clustering_llm_backfill"

// ClusteringDecisionMetadata is the model request metadata of the clustering
// decision. It is serialized verbatim into the upstream request body when the
// active profile has sendMetadata enabled, and it is later filtered by the LLM
// request-log policy before it is written to llmrequestlogs.
type ClusteringDecisionMetadata struct {
	Feature            string `json:"feature"`
	CandidateCount     int    `json:"candidateCount"`
	ArticleFingerprint string `json:"articleFingerprint"`
}

// ClusteringDecisionUsage is the token and cost accounting of one model call. A
// value the gateway did not report stays nil; it is never coerced to zero.
type ClusteringDecisionUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// ClusteringDecisionAttempt describes one real HTTP attempt: one model, one
// try. The backfill chain uses the profile's maxRetries, so one model may
// produce several attempts and the fallback chain may add more. NestJS writes
// one log row per attempt, including the failed ones.
type ClusteringDecisionAttempt struct {
	OrgID                     string
	Model                     string
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	// Attempt is the 1-based attempt inside the current model.
	Attempt int
	// ModelIndex is the 1-based position of the model in the primary-plus-
	// fallback order.
	ModelIndex int
	Success    bool
	// Err is the attempt failure. It is nil on success.
	Err      error
	Latency  time.Duration
	Usage    ClusteringDecisionUsage
	Metadata ClusteringDecisionMetadata
}

// ClusteringDecisionObserver receives every real model attempt. Implementations
// must not block or fail the backfill on their own errors.
type ClusteringDecisionObserver interface {
	ObserveClusteringDecisionAttempt(ctx context.Context, attempt ClusteringDecisionAttempt)
}

// ClusteringDecisionRequest is the strongly typed decision completion input.
// The caller owns prompt construction, the decision schema and validation; this
// surface only performs the model call.
type ClusteringDecisionRequest struct {
	OrgID string
	// Model is the ready completion profile model (assistantModel ?? model).
	// An empty value falls back to the resolved profile model.
	Model              string
	System             string
	User               string
	CandidateCount     int
	ArticleFingerprint string
	Observer           ClusteringDecisionObserver
}

// ClusteringDecisionResult is one successful completion.
type ClusteringDecisionResult struct {
	Content string
	Model   string
	Usage   ClusteringDecisionUsage
}

// ClusteringDecisionCompleter is the exported clustering completion surface
// reused by the recovery worker.
type ClusteringDecisionCompleter interface {
	PrimaryModel(ctx context.Context) (string, error)
	CompleteClusteringDecision(ctx context.Context, req ClusteringDecisionRequest) (ClusteringDecisionResult, error)
}

// NewClusteringDecisionCompleter builds the production completer over the
// gateway settings reader. Configuration is resolved lazily on the first call,
// so no model is probed at startup.
func NewClusteringDecisionCompleter(settings BriefSettingsReader, env GatewayEnv) ClusteringDecisionCompleter {
	if settings == nil {
		return unavailableClusteringDecisionCompleter{}
	}
	return newGateway(settings, env)
}

// clusteringCompletionOutcome is one successful model HTTP exchange.
type clusteringCompletionOutcome struct {
	Content string
	Model   string
	Usage   ClusteringDecisionUsage
}

// CompleteClusteringDecision walks the requested model followed by the
// configured fallback models and performs one HTTP attempt per configured retry.
// observer, when not nil, receives one record per real attempt.
func (g *gatewayClient) CompleteClusteringDecision(ctx context.Context, req ClusteringDecisionRequest) (ClusteringDecisionResult, error) {
	profile, err := g.resolveRssProfile(ctx)
	if err != nil {
		return ClusteringDecisionResult{}, err
	}
	primary := strings.TrimSpace(req.Model)
	if primary == "" {
		primary = profile.Model
	}
	models := uniqueModels(append([]string{primary}, profile.FallbackModels...))
	if len(models) == 0 {
		return ClusteringDecisionResult{}, errors.New("completion model is not configured")
	}
	metadata := ClusteringDecisionMetadata{
		Feature:            clusteringDecisionFeature,
		CandidateCount:     req.CandidateCount,
		ArticleFingerprint: req.ArticleFingerprint,
	}
	var last error
	for modelIndex, model := range models {
		attempts := profile.MaxRetries
		if attempts < 1 {
			attempts = 1
		}
		delay := time.Second
		for attempt := 1; attempt <= attempts; attempt++ {
			outcome, status, attemptErr := g.completeClusteringModel(ctx, profile, model, modelIndex+1, attempt, req, metadata)
			if attemptErr == nil {
				return ClusteringDecisionResult{
					Content: outcome.Content,
					Model:   outcome.Model,
					Usage:   outcome.Usage,
				}, nil
			}
			if isRssStopError(attemptErr) {
				return ClusteringDecisionResult{}, attemptErr
			}
			last = attemptErr
			if !retryable(status, attemptErr) || attempt >= attempts {
				break
			}
			if sleepErr := sleep(ctx, delay); sleepErr != nil {
				return ClusteringDecisionResult{}, sleepErr
			}
			if delay < 10*time.Second {
				delay *= 2
				if delay > 10*time.Second {
					delay = 10 * time.Second
				}
			}
		}
	}
	if last == nil {
		last = errors.New("LiteLLM completion failed")
	}
	return ClusteringDecisionResult{}, last
}

// completeClusteringModel performs exactly one attempt and reports it to the
// observer.
func (g *gatewayClient) completeClusteringModel(ctx context.Context, profile completionProfile, model string, modelIndex, attempt int, req ClusteringDecisionRequest, metadata ClusteringDecisionMetadata) (clusteringCompletionOutcome, int, error) {
	started := time.Now()
	outcome, status, err := g.postClusteringCompletion(ctx, profile, model, req, metadata)
	attemptModel := outcome.Model
	if attemptModel == "" {
		// A failed attempt reports no response model; Nest logs the requested
		// model in that case.
		attemptModel = model
	}
	if req.Observer != nil {
		req.Observer.ObserveClusteringDecisionAttempt(ctx, ClusteringDecisionAttempt{
			OrgID:                     req.OrgID,
			Model:                     attemptModel,
			APISurface:                profile.APISurface,
			GatewayProfileID:          profile.ID,
			GovernanceApplied:         profile.GovernanceApplied,
			AuthMode:                  profile.authMode(),
			GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
			Attempt:                   attempt,
			ModelIndex:                modelIndex,
			Success:                   err == nil,
			Err:                       err,
			Latency:                   time.Since(started),
			Usage:                     outcome.Usage,
			Metadata:                  metadata,
		})
	}
	return outcome, status, err
}

func (g *gatewayClient) postClusteringCompletion(ctx context.Context, profile completionProfile, model string, req ClusteringDecisionRequest, metadata ClusteringDecisionMetadata) (clusteringCompletionOutcome, int, error) {
	body, primary, fallback, err := buildClusteringPayload(profile, model, req, metadata)
	if err != nil {
		return clusteringCompletionOutcome{}, 0, err
	}
	status, raw, header, err := g.post(ctx, profile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = g.post(ctx, profile, fallback, body)
	}
	if err != nil {
		return clusteringCompletionOutcome{}, status, err
	}
	if status < 200 || status >= 300 {
		detail := rssErrorDetail(raw)
		if rssGuardrailSignal(detail) {
			return clusteringCompletionOutcome{}, status, errRssContentBlocked
		}
		if issue, ok := rssCompatibilityIssue(status, detail, profile.APISurface); ok {
			return clusteringCompletionOutcome{}, status, &rssCompatibilityError{message: issue}
		}
		return clusteringCompletionOutcome{}, status, errors.New(rssHTTPErrorMessage(status, detail))
	}
	if isGuardrailBlockedResponse(raw) {
		return clusteringCompletionOutcome{}, status, errRssContentBlocked
	}
	content := strings.TrimSpace(completionText(raw, profile.APISurface))
	usage := clusteringUsageFromBrief(completionUsage(raw, profile.APISurface))
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	// Empty content is a successful exchange: the backfill turns it into a
	// terminal failure with the NestJS empty-content message instead of trying
	// another model here.
	return clusteringCompletionOutcome{
		Content: content,
		Model:   rssResponseModel(raw, model),
		Usage:   usage,
	}, status, nil
}

// clusteringChatMessage is one OpenAI-compatible message. The responses
// surface reuses the same {role,content} shape for its input items, exactly
// like toResponsesInput.
type clusteringChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// clusteringJSONSchemaEnvelope is the json_schema response format.
type clusteringJSONSchemaEnvelope struct {
	Type       string                    `json:"type"`
	JSONSchema *clusteringJSONSchemaSpec `json:"json_schema,omitempty"`
}

type clusteringJSONSchemaSpec struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"schema"`
}

type clusteringResponsesText struct {
	Format *clusteringJSONSchemaEnvelope `json:"format"`
}

type clusteringChatPayload struct {
	Model          string                        `json:"model"`
	Messages       []clusteringChatMessage       `json:"messages"`
	Temperature    float64                       `json:"temperature"`
	TopP           float64                       `json:"top_p"`
	MaxTokens      int                           `json:"max_tokens"`
	ResponseFormat *clusteringJSONSchemaEnvelope `json:"response_format,omitempty"`
	Stream         bool                          `json:"stream"`
	Metadata       *ClusteringDecisionMetadata   `json:"metadata,omitempty"`
}

type clusteringResponsesPayload struct {
	Model           string                      `json:"model"`
	Input           []clusteringChatMessage     `json:"input"`
	Temperature     float64                     `json:"temperature"`
	TopP            float64                     `json:"top_p"`
	MaxOutputTokens int                         `json:"max_output_tokens"`
	Text            *clusteringResponsesText    `json:"text,omitempty"`
	Metadata        *ClusteringDecisionMetadata `json:"metadata,omitempty"`
}

// buildClusteringPayload mirrors LiteLlmService's chat/responses payload: the
// explicit response_format is sent only when the profile mode is json_schema;
// `none` omits it and `json_object` replaces it, exactly like
// resolveResponseFormat and resolveResponsesTextFormat.
func buildClusteringPayload(profile completionProfile, model string, req ClusteringDecisionRequest, metadata ClusteringDecisionMetadata) ([]byte, string, string, error) {
	messages := []clusteringChatMessage{
		{Role: "system", Content: req.System},
		{Role: "user", Content: req.User},
	}
	metadataPayload := &metadata
	if !profile.SendMetadata {
		metadataPayload = nil
	}
	format := clusteringResponseFormat(profile.ResponseFormatMode)
	var payload any
	var primary, fallback string
	if profile.APISurface == "responses" {
		responses := clusteringResponsesPayload{
			Model:           model,
			Input:           messages,
			Temperature:     0,
			TopP:            1,
			MaxOutputTokens: 350,
			Metadata:        metadataPayload,
		}
		if format != nil {
			responses.Text = &clusteringResponsesText{Format: format}
		}
		payload = responses
		primary, fallback = "/v1/responses", "/responses"
	} else {
		chat := clusteringChatPayload{
			Model:       model,
			Messages:    messages,
			Temperature: 0,
			TopP:        1,
			MaxTokens:   350,
			Stream:      false,
			Metadata:    metadataPayload,
		}
		if format != nil {
			chat.ResponseFormat = format
		}
		payload = chat
		primary, fallback = "/v1/chat/completions", "/chat/completions"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", "", err
	}
	return body, primary, fallback, nil
}

// clusteringResponseFormat mirrors resolveResponseFormat for the explicit
// decision schema.
func clusteringResponseFormat(mode string) *clusteringJSONSchemaEnvelope {
	switch mode {
	case "none":
		return nil
	case "json_object":
		return &clusteringJSONSchemaEnvelope{Type: "json_object"}
	default:
		return &clusteringJSONSchemaEnvelope{
			Type: "json_schema",
			JSONSchema: &clusteringJSONSchemaSpec{
				Name:   "news_event_llm_backfill_decision_v1",
				Schema: clusteringDecisionJSONSchema(),
			},
		}
	}
}

// clusteringDecisionJSONSchema mirrors zodToJsonSchema(LLM_BACKFILL_DECISION_SCHEMA,
// {$refStrategy: "none"}): action is the only required member, the three
// optional members accept null, and unknown members are rejected.
func clusteringDecisionJSONSchema() map[string]any {
	nullable := func(schema map[string]any) map[string]any {
		copied := make(map[string]any, len(schema)+1)
		for key, value := range schema {
			copied[key] = value
		}
		if existing, ok := copied["type"].(string); ok {
			copied["type"] = []string{existing, "null"}
		}
		return copied
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{
				"type": "string",
				"enum": []string{"assign_existing", "create_new"},
			},
			"eventId": nullable(map[string]any{
				"type":      "string",
				"minLength": 1,
				"maxLength": 64,
			}),
			"confidence": nullable(map[string]any{
				"type":    "number",
				"minimum": 0,
				"maximum": 1,
			}),
			"reasoning": nullable(map[string]any{
				"type":      "string",
				"maxLength": 500,
			}),
		},
		"required":             []string{"action"},
		"additionalProperties": false,
	}
}

// clusteringUsageFromBrief converts the reused usage extractor into this type.
func clusteringUsageFromBrief(usage BriefCompletionUsage) ClusteringDecisionUsage {
	return ClusteringDecisionUsage{
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		TotalTokens:      usage.TotalTokens,
		CostUSD:          usage.CostUSD,
	}
}

// unavailableClusteringDecisionCompleter fails every call when the settings
// reader is missing, so wiring the worker in that state cannot panic later.
type unavailableClusteringDecisionCompleter struct{}

func (unavailableClusteringDecisionCompleter) PrimaryModel(context.Context) (string, error) {
	return "", errCompletionUnavailable
}

func (unavailableClusteringDecisionCompleter) CompleteClusteringDecision(context.Context, ClusteringDecisionRequest) (ClusteringDecisionResult, error) {
	return ClusteringDecisionResult{}, errCompletionUnavailable
}
