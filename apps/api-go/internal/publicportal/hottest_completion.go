package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
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

type hottestClusterOutcome struct {
	Content string
	Model   string
	Usage   HottestClusterUsage
}

// CompleteHottestClusterInsights walks the primary model followed by the
// configured fallbacks and performs one HTTP attempt per configured retry.
func (g *gatewayClient) CompleteHottestClusterInsights(ctx context.Context, req HottestClusterRequest) (HottestClusterResult, error) {
	profile, err := g.resolveRssProfile(ctx)
	if err != nil {
		return HottestClusterResult{}, err
	}
	models := uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	if len(models) == 0 {
		return HottestClusterResult{}, errors.New("completion model is not configured")
	}
	metadata := HottestClusterMetadata{Feature: hottestClusterFeature, Clusters: req.ClusterCount}
	var last error
	for modelIndex, model := range models {
		attempts := profile.MaxRetries
		if attempts < 1 {
			attempts = 1
		}
		delay := time.Second
		for attempt := 1; attempt <= attempts; attempt++ {
			outcome, status, attemptErr := g.completeHottestClusterModel(ctx, profile, model, modelIndex+1, attempt, req, metadata)
			if attemptErr == nil {
				return HottestClusterResult{
					Content: outcome.Content,
					Model:   outcome.Model,
					Usage:   outcome.Usage,
				}, nil
			}
			if isRssStopError(attemptErr) {
				return HottestClusterResult{}, attemptErr
			}
			last = attemptErr
			if !retryable(status, attemptErr) || attempt >= attempts {
				break
			}
			if sleepErr := sleep(ctx, delay); sleepErr != nil {
				return HottestClusterResult{}, sleepErr
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
	return HottestClusterResult{}, last
}

// completeHottestClusterModel performs exactly one attempt and reports it.
func (g *gatewayClient) completeHottestClusterModel(ctx context.Context, profile completionProfile, model string, modelIndex, attempt int, req HottestClusterRequest, metadata HottestClusterMetadata) (hottestClusterOutcome, int, error) {
	started := time.Now()
	outcome, status, err := g.postHottestClusterCompletion(ctx, profile, model, req, metadata)
	attemptModel := outcome.Model
	if attemptModel == "" {
		attemptModel = model
	}
	if req.Observer != nil {
		req.Observer.ObserveHottestClusterAttempt(ctx, HottestClusterAttempt{
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

func (g *gatewayClient) postHottestClusterCompletion(ctx context.Context, profile completionProfile, model string, req HottestClusterRequest, metadata HottestClusterMetadata) (hottestClusterOutcome, int, error) {
	body, primary, fallback, err := buildHottestClusterPayload(profile, model, req, metadata)
	if err != nil {
		return hottestClusterOutcome{}, 0, err
	}
	status, raw, header, err := g.post(ctx, profile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = g.post(ctx, profile, fallback, body)
	}
	if err != nil {
		return hottestClusterOutcome{}, status, err
	}
	if status < 200 || status >= 300 {
		detail := rssErrorDetail(raw)
		if rssGuardrailSignal(detail) {
			return hottestClusterOutcome{}, status, errRssContentBlocked
		}
		if issue, ok := rssCompatibilityIssue(status, detail, profile.APISurface); ok {
			return hottestClusterOutcome{}, status, &rssCompatibilityError{message: issue}
		}
		return hottestClusterOutcome{}, status, errors.New(rssHTTPErrorMessage(status, detail))
	}
	if isGuardrailBlockedResponse(raw) {
		return hottestClusterOutcome{}, status, errRssContentBlocked
	}
	content := strings.TrimSpace(completionText(raw, profile.APISurface))
	usage := hottestClusterUsageFromBrief(completionUsage(raw, profile.APISurface))
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	// Empty content is a successful exchange; the caller falls back to the
	// heuristic labels without retrying another model.
	return hottestClusterOutcome{
		Content: content,
		Model:   rssResponseModel(raw, model),
		Usage:   usage,
	}, status, nil
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
func buildHottestClusterPayload(profile completionProfile, model string, req HottestClusterRequest, metadata HottestClusterMetadata) ([]byte, string, string, error) {
	messages := []hottestChatMessage{
		{Role: "system", Content: req.System},
		{Role: "user", Content: req.User},
	}
	metadataPayload := &metadata
	if !profile.SendMetadata {
		metadataPayload = nil
	}
	format := hottestClusterResponseFormat(profile.ResponseFormatMode)
	var payload any
	var primary, fallback string
	if profile.APISurface == "responses" {
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
