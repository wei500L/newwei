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

// This file adds the NewsNow hottest cluster-insight completion surface. It
// reuses the gateway client, profile resolution, governance, payload builders,
// retry policy and request-log observer used by the brief, RSS translation and
// clustering surfaces. The request shape mirrors
// newsnow-hottest-analysis.service.ts generateClusterInsights:
// temperature 0.15, top_p 0.9, max_tokens 1800, the json_schema response format
// named newsnow_hottest_cluster_insights_v1 and the feature/clusters metadata.

const hottestClusterFeature = "newsnow_hottest_cluster_analysis"

// HottestClusterMetadata is the model request metadata.
type HottestClusterMetadata struct {
	Feature  string `json:"feature"`
	Clusters int    `json:"clusters"`
}

// HottestClusterUsage is the token and cost accounting of one model call.
type HottestClusterUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// HottestClusterAttempt describes one real HTTP attempt.
type HottestClusterAttempt struct {
	OrgID                     string
	Model                     string
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	Attempt                   int
	ModelIndex                int
	Success                   bool
	Err                       error
	Latency                   time.Duration
	Usage                     HottestClusterUsage
	Metadata                  HottestClusterMetadata
}

// HottestClusterObserver receives every real model attempt. Implementations must
// not block or fail the analysis on their own errors.
type HottestClusterObserver interface {
	ObserveHottestClusterAttempt(ctx context.Context, attempt HottestClusterAttempt)
}

// HottestClusterRequest is the strongly typed completion input. The caller owns
// the prompt and the response schema.
type HottestClusterRequest struct {
	OrgID        string
	System       string
	User         string
	ClusterCount int
	Observer     HottestClusterObserver
}

// HottestClusterResult is one successful completion.
type HottestClusterResult struct {
	Content string
	Model   string
	Usage   HottestClusterUsage
}

// HottestClusterCompleter is the exported hottest completion surface.
type HottestClusterCompleter interface {
	CompleteHottestClusterInsights(ctx context.Context, req HottestClusterRequest) (HottestClusterResult, error)
}

// NewHottestClusterCompleter builds the production completer over the gateway
// settings reader. Configuration is resolved lazily on the first call.
func NewHottestClusterCompleter(settings BriefSettingsReader, env GatewayEnv) HottestClusterCompleter {
	if settings == nil {
		return unavailableHottestClusterCompleter{}
	}
	return newGateway(settings, env)
}

// CompleteHottestClusterInsights walks the primary model followed by the
// configured fallbacks through the shared completion engine, one attempt per
// configured retry.
func (g *gatewayClient) CompleteHottestClusterInsights(ctx context.Context, req HottestClusterRequest) (HottestClusterResult, error) {
	profile, client, err := g.resolveLitellmProfile(ctx)
	if err != nil {
		return HottestClusterResult{}, err
	}
	metadata := HottestClusterMetadata{Feature: hottestClusterFeature, Clusters: req.ClusterCount}
	plan := litellmcompat.CompletionPlan{
		OrgID:      req.OrgID,
		Models:     uniqueModels(append([]string{profile.Model}, profile.FallbackModels...)),
		MaxRetries: profile.MaxRetries,
		MaxBody:    2 << 20,
		Build: func(model string) ([]byte, string, string, error) {
			return buildHottestClusterPayload(profile, model, req, metadata)
		},
		Parse: func(status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
			return parseHottestClusterCompletion(profile, status, header, raw, model)
		},
		Stop:     isRssStopError,
		Observer: hottestAttemptAdapter{next: req.Observer, metadata: metadata},
	}
	response, err := client.RunCompletion(ctx, profile, plan)
	if err != nil {
		return HottestClusterResult{}, err
	}
	return HottestClusterResult{Content: response.Content, Model: response.Model, Usage: hottestClusterUsageFromBrief(briefUsageFromShared(response.Usage))}, nil
}

func parseHottestClusterCompletion(profile litellmcompat.Profile, status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
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
	// Empty content is a successful exchange; the caller falls back to the
	// heuristic labels without retrying another model.
	return litellmcompat.CompletionResponse{Content: content, Model: rssResponseModel(raw, model), Usage: briefUsageToShared(usage)}, nil
}

// hottestAttemptAdapter maps the shared attempt record onto the hottest attempt
// type.
type hottestAttemptAdapter struct {
	next     HottestClusterObserver
	metadata HottestClusterMetadata
}

func (a hottestAttemptAdapter) ObserveAttempt(_ context.Context, attempt litellmcompat.Attempt) {
	if a.next == nil {
		return
	}
	model := attempt.ResponseModel
	if model == "" {
		model = attempt.Model
	}
	a.next.ObserveHottestClusterAttempt(context.Background(), HottestClusterAttempt{
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
		Usage:                     hottestClusterUsageFromBrief(briefUsageFromShared(attempt.Usage)),
		Metadata:                  a.metadata,
	})
}

// hottestChatMessage is one OpenAI-compatible message.
type hottestChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type hottestJSONSchemaSpec struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"schema"`
}

type hottestJSONSchemaEnvelope struct {
	Type       string                 `json:"type"`
	JSONSchema *hottestJSONSchemaSpec `json:"json_schema,omitempty"`
}

type hottestResponsesText struct {
	Format *hottestJSONSchemaEnvelope `json:"format"`
}

type hottestChatPayload struct {
	Model          string                     `json:"model"`
	Messages       []hottestChatMessage       `json:"messages"`
	Temperature    float64                    `json:"temperature"`
	TopP           float64                    `json:"top_p"`
	MaxTokens      int                        `json:"max_tokens"`
	ResponseFormat *hottestJSONSchemaEnvelope `json:"response_format,omitempty"`
	Stream         bool                       `json:"stream"`
	Metadata       *HottestClusterMetadata    `json:"metadata,omitempty"`
}

type hottestResponsesPayload struct {
	Model           string                  `json:"model"`
	Input           []hottestChatMessage    `json:"input"`
	Temperature     float64                 `json:"temperature"`
	TopP            float64                 `json:"top_p"`
	MaxOutputTokens int                     `json:"max_output_tokens"`
	Text            *hottestResponsesText   `json:"text,omitempty"`
	Metadata        *HottestClusterMetadata `json:"metadata,omitempty"`
}

// buildHottestClusterPayload mirrors LiteLlmService.resolveResponseFormat: the
// explicit schema is sent when the profile mode is json_schema, json_object
// replaces it and none omits it.
func buildHottestClusterPayload(profile litellmcompat.Profile, model string, req HottestClusterRequest, metadata HottestClusterMetadata) ([]byte, string, string, error) {
	messages := []hottestChatMessage{
		{Role: "system", Content: req.System},
		{Role: "user", Content: req.User},
	}
	metadataPayload := &metadata
	if !profile.SendMetadata {
		metadataPayload = nil
	}
	format := hottestClusterResponseFormat(string(profile.ResponseFormatMode))
	var payload any
	var primary, fallback string
	if profile.APISurface == litellmcompat.APISurfaceResponses {
		responses := hottestResponsesPayload{
			Model:           model,
			Input:           messages,
			Temperature:     0.15,
			TopP:            0.9,
			MaxOutputTokens: 1800,
			Metadata:        metadataPayload,
		}
		if format != nil {
			responses.Text = &hottestResponsesText{Format: format}
		}
		payload = responses
		primary, fallback = "/v1/responses", "/responses"
	} else {
		chat := hottestChatPayload{
			Model:       model,
			Messages:    messages,
			Temperature: 0.15,
			TopP:        0.9,
			MaxTokens:   1800,
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

// hottestClusterResponseFormat mirrors resolveResponseFormat for the explicit
// cluster schema.
func hottestClusterResponseFormat(mode string) *hottestJSONSchemaEnvelope {
	switch mode {
	case "none":
		return nil
	case "json_object":
		return &hottestJSONSchemaEnvelope{Type: "json_object"}
	default:
		return &hottestJSONSchemaEnvelope{
			Type: "json_schema",
			JSONSchema: &hottestJSONSchemaSpec{
				Name:   "newsnow_hottest_cluster_insights_v1",
				Schema: hottestClusterJSONSchema(),
			},
		}
	}
}

// hottestClusterJSONSchema mirrors zodToJsonSchema(ClusterInsightResponseSchema,
// {$refStrategy: "none"}). Nullable members use the ["type","null"] form and the
// defaulted array/enum/boolean/number members carry their defaults.
func hottestClusterJSONSchema() map[string]any {
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
	entitySchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name": map[string]any{"type": "string", "minLength": 1, "maxLength": 64},
			"type": nullable(map[string]any{"type": "string", "maxLength": 32}),
		},
		"required": []string{"name"},
	}
	clusterSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"clusterId": map[string]any{"type": "string", "minLength": 1},
			"theme":     map[string]any{"type": "string", "minLength": 1, "maxLength": 80},
			"label":     map[string]any{"type": "string", "minLength": 1, "maxLength": 80},
			"summary":   nullable(map[string]any{"type": "string", "minLength": 1, "maxLength": 280}),
			"reason":    nullable(map[string]any{"type": "string", "maxLength": 200}),
			"topics": map[string]any{
				"type":     "array",
				"items":    map[string]any{"type": "string", "minLength": 1, "maxLength": 48},
				"maxItems": 8,
				"default":  []string{},
			},
			"entities": map[string]any{
				"type":     "array",
				"items":    entitySchema,
				"maxItems": 10,
				"default":  []string{},
			},
			"contentKind": map[string]any{
				"type":    "string",
				"enum":    []string{"article", "discussion", "video", "mixed", "unknown"},
				"default": "unknown",
			},
			"bridgeEligibleSuggestion": map[string]any{"type": "boolean", "default": false},
			"confidence":               map[string]any{"type": "number", "minimum": 0, "maximum": 1, "default": 0.5},
		},
		"required": []string{"clusterId", "theme", "label"},
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"clusters": map[string]any{
				"type":     "array",
				"items":    clusterSchema,
				"maxItems": 16,
				"default":  []string{},
			},
		},
		"required": []string{"clusters"},
	}
}

// hottestClusterUsageFromBrief converts the reused usage extractor.
func hottestClusterUsageFromBrief(usage BriefCompletionUsage) HottestClusterUsage {
	return HottestClusterUsage{
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		TotalTokens:      usage.TotalTokens,
		CostUSD:          usage.CostUSD,
	}
}

// unavailableHottestClusterCompleter fails every call when the settings reader is
// missing, so wiring the service in that state cannot panic later.
type unavailableHottestClusterCompleter struct{}

func (unavailableHottestClusterCompleter) CompleteHottestClusterInsights(context.Context, HottestClusterRequest) (HottestClusterResult, error) {
	return HottestClusterResult{}, errCompletionUnavailable
}
