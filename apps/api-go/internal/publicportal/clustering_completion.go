package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
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

// CompleteClusteringDecision walks the requested model followed by the
// configured fallback models through the shared completion engine, one attempt
// per configured retry. observer, when not nil, receives one record per attempt.
func (g *gatewayClient) CompleteClusteringDecision(ctx context.Context, req ClusteringDecisionRequest) (ClusteringDecisionResult, error) {
	profile, client, err := g.resolveLitellmProfile(ctx)
	if err != nil {
		return ClusteringDecisionResult{}, err
	}
	primary := strings.TrimSpace(req.Model)
	if primary == "" {
		primary = profile.Model
	}
	metadata := ClusteringDecisionMetadata{
		Feature:            clusteringDecisionFeature,
		CandidateCount:     req.CandidateCount,
		ArticleFingerprint: req.ArticleFingerprint,
	}
	plan := litellmcompat.CompletionPlan{
		OrgID:      req.OrgID,
		Models:     uniqueModels(append([]string{primary}, profile.FallbackModels...)),
		MaxRetries: profile.MaxRetries,
		MaxBody:    2 << 20,
		Build: func(model string) ([]byte, string, string, error) {
			return buildClusteringPayload(profile, model, req, metadata)
		},
		Parse: func(status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
			return parseClusteringCompletion(profile, status, header, raw, model)
		},
		Stop:     isRssStopError,
		Observer: clusteringAttemptAdapter{next: req.Observer, metadata: metadata},
	}
	response, err := client.RunCompletion(ctx, profile, plan)
	if err != nil {
		return ClusteringDecisionResult{}, err
	}
	return ClusteringDecisionResult{Content: response.Content, Model: response.Model, Usage: clusteringUsageFromBrief(briefUsageFromShared(response.Usage))}, nil
}

func parseClusteringCompletion(profile litellmcompat.Profile, status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
	if status < 200 || status >= 300 {
		detail := rssErrorDetail(raw)
		if rssGuardrailSignal(detail) {
			return litellmcompat.CompletionResponse{}, errRssContentBlocked
		}
		if issue, ok := rssCompatibilityIssue(status, detail, string(profile.APISurface)); ok {
			return litellmcompat.CompletionResponse{}, &rssCompatibilityError{message: issue}
		}
		return litellmcompat.CompletionResponse{}, errors.New(rssHTTPErrorMessage(status, detail))
	}
	if isGuardrailBlockedResponse(raw) {
		return litellmcompat.CompletionResponse{}, errRssContentBlocked
	}
	content := strings.TrimSpace(completionText(raw, string(profile.APISurface)))
	usage := completionUsage(raw, string(profile.APISurface))
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	// Empty content is a successful exchange: the backfill turns it into a
	// terminal failure with the NestJS empty-content message instead of trying
	// another model here.
	return litellmcompat.CompletionResponse{Content: content, Model: rssResponseModel(raw, model), Usage: briefUsageToShared(usage)}, nil
}

// clusteringAttemptAdapter maps the shared attempt record onto the clustering
// attempt type.
type clusteringAttemptAdapter struct {
	next     ClusteringDecisionObserver
	metadata ClusteringDecisionMetadata
}

func (a clusteringAttemptAdapter) ObserveAttempt(_ context.Context, attempt litellmcompat.Attempt) {
	if a.next == nil {
		return
	}
	model := attempt.ResponseModel
	if model == "" {
		model = attempt.Model
	}
	a.next.ObserveClusteringDecisionAttempt(context.Background(), ClusteringDecisionAttempt{
		OrgID:                     attempt.OrgID,
		Model:                     model,
		APISurface:                string(attempt.APISurface),
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         attempt.GovernanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		Attempt:                   attempt.Attempt,
		ModelIndex:                attempt.ModelIndex,
		Success:                   attempt.Success,
		Err:                       attempt.Err,
		Latency:                   attempt.Latency,
		Usage:                     clusteringUsageFromBrief(briefUsageFromShared(attempt.Usage)),
		Metadata:                  a.metadata,
	})
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
func buildClusteringPayload(profile litellmcompat.Profile, model string, req ClusteringDecisionRequest, metadata ClusteringDecisionMetadata) ([]byte, string, string, error) {
	messages := []clusteringChatMessage{
		{Role: "system", Content: req.System},
		{Role: "user", Content: req.User},
	}
	metadataPayload := &metadata
	if !profile.SendMetadata {
		metadataPayload = nil
	}
	format := clusteringResponseFormat(string(profile.ResponseFormatMode))
	var payload any
	var primary, fallback string
	if profile.APISurface == litellmcompat.APISurfaceResponses {
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
