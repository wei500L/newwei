package publicportal

// This file is the narrow analysis streaming client. It never persists a
// result, publishes an event or writes a log; the analysis domain owns those
// side effects. The transport, fallback/retry policy, SSE framing, chat/responses
// decoding and usage/cost merge live in litellmcompat.CompletionStream; this file
// keeps only the analysis prompt/event mapping and its error decoration.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// AnalysisMessage is one chat message of an analysis prompt. The analysis
// prompts are plain text system/user messages, never the multipart content
// shape used by other model paths.
type AnalysisMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// AnalysisStreamUsage is the token/cost accounting of one streamed model
// attempt. Unreported values stay nil and are never coerced to zero.
type AnalysisStreamUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// AnalysisStreamChunk is one yielded SSE chunk. A chunk with only
// FinishReason still counts as "started" for fallback purposes, exactly like
// LiteLlmService.stream: after any yield the next model must not be spliced in.
type AnalysisStreamChunk struct {
	Model        string
	Delta        string
	FinishReason string
}

// AnalysisStreamAttempt is one real HTTP attempt (one model, one request).
type AnalysisStreamAttempt struct {
	OrgID                     string
	Model                     string
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	Success                   bool
	Err                       error
	Latency                   time.Duration
	Usage                     AnalysisStreamUsage
}

// AnalysisStreamObserver receives every real model attempt. Implementations
// must not change the stream outcome on their own failure.
type AnalysisStreamObserver interface {
	ObserveAnalysisStreamAttempt(ctx context.Context, attempt AnalysisStreamAttempt)
}

// AnalysisStreamRequest is one analysis model stream. The caller owns prompt
// construction, incremental flushing and persistence.
type AnalysisStreamRequest struct {
	OrgID    string
	Messages []AnalysisMessage
	Timeout  time.Duration
	Observer AnalysisStreamObserver
	OnChunk  func(AnalysisStreamChunk) error
}

// AnalysisStreamResult is the successful model and the accumulated usage of the
// attempt that produced the stream.
type AnalysisStreamResult struct {
	Model string
	Usage AnalysisStreamUsage
}

// AnalysisGuardrailError is an upstream guardrail refusal. Nest stops the
// fallback chain on this error.
type AnalysisGuardrailError struct{ Message string }

func (e *AnalysisGuardrailError) Error() string {
	if e == nil {
		return "model gateway blocked the request by guardrails"
	}
	return e.Message
}

// AnalysisCompatibilityError is an OpenAI-compatibility failure. Nest stops the
// fallback chain on this error too.
type AnalysisCompatibilityError struct{ Message string }

func (e *AnalysisCompatibilityError) Error() string {
	if e == nil {
		return "model gateway is incompatible with the requested API surface"
	}
	return e.Message
}

// AnalysisStreamer streams an analysis completion through the active gateway
// profile. It is a narrow surface: it never writes the result document, never
// publishes events and never logs by itself.
type AnalysisStreamer interface {
	StreamAnalysis(ctx context.Context, req AnalysisStreamRequest) (AnalysisStreamResult, error)
}

// NewAnalysisStreamer builds the production streamer over the narrow gateway
// settings reader. Configuration is resolved lazily on every call; startup
// never probes an external model.
func NewAnalysisStreamer(settings BriefSettingsReader, env GatewayEnv) AnalysisStreamer {
	if settings == nil {
		return unavailableAnalysisStreamer{}
	}
	return newGateway(settings, env)
}

type unavailableAnalysisStreamer struct{}

func (unavailableAnalysisStreamer) StreamAnalysis(context.Context, AnalysisStreamRequest) (AnalysisStreamResult, error) {
	return AnalysisStreamResult{}, errors.New("model gateway is not configured")
}

// StreamAnalysis walks the primary model followed by the configured fallback
// models through the shared CompletionStream engine. A model may be replaced
// only before any chunk was yielded. Once a delta or a finish-only chunk was
// yielded, an error is final: the text of two models is never concatenated.
// Guardrail and compatibility errors are final immediately.
func (g *gatewayClient) StreamAnalysis(ctx context.Context, req AnalysisStreamRequest) (AnalysisStreamResult, error) {
	if req.OnChunk == nil {
		return AnalysisStreamResult{}, errors.New("analysis stream requires a chunk callback")
	}
	profiles, governance, err := g.store.GatewaySettings(ctx)
	if err != nil {
		return AnalysisStreamResult{}, err
	}
	profile, err := resolveCompletionProfile(profiles, governance, g.env)
	if err != nil {
		return AnalysisStreamResult{}, err
	}
	// Nest merges the pipeline LITELLM_* config with the profile overrides, so a
	// profile without its own apiKey still uses LITELLM_API_KEY. The brief and
	// RSS surfaces keep their existing behavior; this fallback is local to the
	// analysis stream.
	if profile.APIKey == "" {
		profile.APIKey = settingscrypto.NormalizeGatewaySecret(g.env.APIKey)
	}
	models := uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	if len(models) == 0 {
		return AnalysisStreamResult{}, errors.New("completion model is not configured")
	}

	client := litellmcompat.NewSettingsClient(nil, nil, litellmcompat.Config{}).WithHTTP(g.http)
	result, err := client.CompletionStream(ctx, sharedProfileFromCompletion(profile), litellmcompat.StreamPlan{
		OrgID:      req.OrgID,
		Models:     models,
		MaxRetries: 1,
		Timeout:    req.Timeout,
		Build: func(model string) ([]byte, string, string, error) {
			return buildAnalysisStreamPayload(profile, model, req)
		},
		ClassifyStatus: func(_ litellmcompat.Profile, _ string, status int, _ http.Header, raw []byte) error {
			upstream := &upstreamStatusError{Status: status, Detail: sanitizeUpstreamDetail(raw)}
			return g.decorateAnalysisStreamError(upstream, profile)
		},
		ClassifyNonSSE: func(_ litellmcompat.Profile, _ string, _ int, header http.Header, raw []byte) error {
			if message := guardrailMessageFromBody(raw); message != "" {
				return &AnalysisGuardrailError{Message: message}
			}
			surfaceName := "LiteLLM stream"
			if profile.APISurface == "responses" {
				surfaceName = "LiteLLM responses stream"
			}
			return fmt.Errorf("%s returned non-SSE response (%s)", surfaceName, header.Get("Content-Type"))
		},
		Stop: func(err error) bool {
			var guardrail *AnalysisGuardrailError
			if errors.As(err, &guardrail) {
				return true
			}
			var compatibility *AnalysisCompatibilityError
			return errors.As(err, &compatibility)
		},
		OnEvent: func(event litellmcompat.StreamEvent) error {
			return req.OnChunk(AnalysisStreamChunk{Model: event.Model, Delta: event.Delta, FinishReason: event.FinishReason})
		},
		Observer:        analysisStreamAttemptAdapter{next: req.Observer},
		ApplyCostHeader: true,
		FinishStarts:    true,
	})
	if err != nil {
		return AnalysisStreamResult{}, err
	}
	return AnalysisStreamResult{Model: result.Model, Usage: analysisUsageFromShared(result.Usage)}, nil
}

// analysisStreamPayload is the closed set of request bodies for the two
// supported api surfaces. It keeps the payload union typed at the HTTP
// boundary instead of passing an untyped map.
type chatStreamPayload struct {
	Model       string            `json:"model"`
	Messages    []AnalysisMessage `json:"messages"`
	Temperature float64           `json:"temperature"`
	TopP        float64           `json:"top_p"`
	MaxTokens   int               `json:"max_tokens"`
	Stream      bool              `json:"stream"`
}

type responsesMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type responsesStreamPayload struct {
	Model           string             `json:"model"`
	Input           []responsesMessage `json:"input"`
	Temperature     float64            `json:"temperature"`
	TopP            float64            `json:"top_p"`
	MaxOutputTokens int                `json:"max_output_tokens"`
	Stream          bool               `json:"stream"`
}

// buildAnalysisStreamPayload renders the analysis chat/responses body for one
// model. Analysis passes ANALYSIS_LLM_TIMEOUT_MS directly (a zero timeout means
// no deadline), and keeps its profile temperature/top_p/max tokens.
func buildAnalysisStreamPayload(profile completionProfile, model string, req AnalysisStreamRequest) ([]byte, string, string, error) {
	var payload any
	var primary, fallback string
	if profile.APISurface == "responses" {
		input := make([]responsesMessage, 0, len(req.Messages))
		for _, message := range req.Messages {
			input = append(input, responsesMessage{Role: message.Role, Content: message.Content})
		}
		payload = responsesStreamPayload{
			Model:           model,
			Input:           input,
			Temperature:     profile.Temperature,
			TopP:            profile.TopP,
			MaxOutputTokens: profile.MaxOutputTokens,
			Stream:          true,
		}
		primary, fallback = "/v1/responses", "/responses"
	} else {
		payload = chatStreamPayload{
			Model:       model,
			Messages:    req.Messages,
			Temperature: profile.Temperature,
			TopP:        profile.TopP,
			MaxTokens:   profile.MaxOutputTokens,
			Stream:      true,
		}
		primary, fallback = "/v1/chat/completions", "/chat/completions"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", "", err
	}
	return body, primary, fallback, nil
}

// analysisStreamAttemptAdapter maps the shared attempt record onto the analysis
// attempt type so the existing observer keeps receiving its fields.
type analysisStreamAttemptAdapter struct {
	next AnalysisStreamObserver
}

func (a analysisStreamAttemptAdapter) ObserveAttempt(_ context.Context, attempt litellmcompat.Attempt) {
	if a.next == nil {
		return
	}
	a.next.ObserveAnalysisStreamAttempt(context.Background(), AnalysisStreamAttempt{
		OrgID:                     attempt.OrgID,
		Model:                     attempt.Model,
		APISurface:                string(attempt.APISurface),
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         attempt.GovernanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		Success:                   attempt.Success,
		Err:                       attempt.Err,
		Latency:                   attempt.Latency,
		Usage:                     analysisUsageFromShared(attempt.Usage),
	})
}

func analysisUsageFromShared(usage litellmcompat.Usage) AnalysisStreamUsage {
	return AnalysisStreamUsage{
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		TotalTokens:      usage.TotalTokens,
		CostUSD:          usage.CostUSD,
	}
}

type upstreamStatusError struct {
	Status int
	Detail string
}

func (e *upstreamStatusError) Error() string {
	if e == nil {
		return "model gateway request failed"
	}
	return fmt.Sprintf("LiteLLM request failed (HTTP %d): %s", e.Status, e.Detail)
}

// decorateAnalysisStreamError mirrors the compatibility and guardrail
// classification of LiteLlmService before the plain HTTP error is returned.
func (g *gatewayClient) decorateAnalysisStreamError(err error, profile completionProfile) error {
	var status *upstreamStatusError
	if !errors.As(err, &status) {
		return err
	}
	lower := strings.ToLower(status.Detail)
	if status.Status == http.StatusBadRequest ||
		status.Status == http.StatusForbidden ||
		status.Status == http.StatusUnprocessableEntity {
		if containsAny(lower, []string{"guardrail", "moderation", "prompt injection", "promptinjection", "jailbreak", "trust & safety violation"}) {
			return &AnalysisGuardrailError{Message: err.Error()}
		}
	}
	if (status.Status == http.StatusBadRequest ||
		status.Status == http.StatusNotFound ||
		status.Status == http.StatusMethodNotAllowed ||
		status.Status == http.StatusUnprocessableEntity ||
		status.Status == http.StatusNotImplemented) &&
		containsAny(lower, []string{
			"unsupported", "not supported", "not allowed", "not permitted",
			"unrecognized", "unknown", "invalid argument", "invalid parameter",
			"method not allowed", "not implemented", "endpoint not found",
		}) {
		return &AnalysisCompatibilityError{Message: err.Error()}
	}
	return err
}

// guardrailMessageFromBody recognizes a guardrail refusal that arrived as a
// successful HTTP response: a non-empty messages array without a usable choice.
func guardrailMessageFromBody(body []byte) string {
	var record struct {
		Messages []json.RawMessage `json:"messages"`
		Choices  []json.RawMessage `json:"choices"`
		Error    json.RawMessage   `json:"error"`
		Message  json.RawMessage   `json:"message"`
	}
	if err := json.Unmarshal(body, &record); err != nil {
		return ""
	}
	if len(record.Messages) > 0 && len(record.Choices) == 0 {
		var first struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal(record.Messages[0], &first); err == nil {
			if content := strings.TrimSpace(first.Content); content != "" {
				return content
			}
		}
		return "Unable to complete request: blocked by content safety policy."
	}
	return ""
}

// sanitizeUpstreamDetail extracts a short, non-HTML error text.
func sanitizeUpstreamDetail(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	var record struct {
		Error   json.RawMessage `json:"error"`
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(body, &record); err == nil {
		if message := rawErrorMessage(record.Error); message != "" {
			return truncateRunes(message, 500)
		}
		if message := rawText(record.Message); message != "" {
			return truncateRunes(message, 500)
		}
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "<!doctype") || strings.Contains(lower, "<html") {
		return "HTML error response"
	}
	return truncateRunes(text, 500)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func containsAny(value string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func rawText(raw json.RawMessage) string {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return ""
	}
	if strings.HasPrefix(text, `"`) {
		var decoded string
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return ""
		}
		return decoded
	}
	return ""
}

func rawErrorMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var record struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &record); err == nil && strings.TrimSpace(record.Message) != "" {
		return strings.TrimSpace(record.Message)
	}
	return rawText(raw)
}
