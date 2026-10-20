package publicportal

// This file is the narrow analysis streaming client. It never persists a
// result, publishes an event or writes a log; the analysis domain owns those
// side effects.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
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

// errSSEDone stops the reader as soon as the [DONE] frame is received, exactly
// like LiteLlmService.stream, which must not wait for the upstream to close.
var errSSEDone = errors.New("analysis stream done")

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
// models. A model may be replaced only before any chunk was yielded. Once a
// delta or a finish-only chunk was yielded, an error is final: the text of two
// models is never concatenated. Guardrail and compatibility errors are final
// immediately.
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
		profile.APIKey = stripBearer(g.env.APIKey)
	}
	models := uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	if len(models) == 0 {
		return AnalysisStreamResult{}, errors.New("completion model is not configured")
	}

	var last error
	for _, model := range models {
		started := false
		startedAt := time.Now()
		usage, streamErr := g.streamAnalysisModel(ctx, profile, model, req, func(chunk AnalysisStreamChunk) error {
			started = true
			return req.OnChunk(chunk)
		})
		if req.Observer != nil {
			attempt := AnalysisStreamAttempt{
				OrgID:                     req.OrgID,
				Model:                     model,
				APISurface:                profile.APISurface,
				GatewayProfileID:          profile.ID,
				GovernanceApplied:         profile.GovernanceApplied,
				AuthMode:                  profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				Success:                   streamErr == nil,
				Err:                       streamErr,
				Latency:                   time.Since(startedAt),
				Usage:                     usage,
			}
			req.Observer.ObserveAnalysisStreamAttempt(ctx, attempt)
		}
		if streamErr == nil {
			return AnalysisStreamResult{Model: model, Usage: usage}, nil
		}
		if ctx.Err() != nil {
			return AnalysisStreamResult{}, streamErr
		}
		var guardrail *AnalysisGuardrailError
		if errors.As(streamErr, &guardrail) {
			return AnalysisStreamResult{}, streamErr
		}
		var compatibility *AnalysisCompatibilityError
		if errors.As(streamErr, &compatibility) {
			return AnalysisStreamResult{}, streamErr
		}
		if started {
			return AnalysisStreamResult{}, streamErr
		}
		last = streamErr
	}
	if last == nil {
		last = errors.New("LiteLLM stream failed")
	}
	return AnalysisStreamResult{}, last
}

// analysisStreamPayload is the closed set of request bodies for the two
// supported api surfaces. It keeps the payload union typed at the HTTP
// boundary instead of passing an untyped map.
type analysisStreamPayload interface {
	analysisPayload()
}

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

func (chatStreamPayload) analysisPayload() {}

type responsesStreamPayload struct {
	Model           string             `json:"model"`
	Input           []responsesMessage `json:"input"`
	Temperature     float64            `json:"temperature"`
	TopP            float64            `json:"top_p"`
	MaxOutputTokens int                `json:"max_output_tokens"`
	Stream          bool               `json:"stream"`
}

func (responsesStreamPayload) analysisPayload() {}

// streamAnalysisModel performs one model request and yields delta/finish chunks.
// The accumulated usage is returned even when the stream fails so the request
// log can record what the gateway reported before the failure.
func (g *gatewayClient) streamAnalysisModel(
	ctx context.Context,
	profile completionProfile,
	model string,
	req AnalysisStreamRequest,
	onChunk func(AnalysisStreamChunk) error,
) (AnalysisStreamUsage, error) {
	// Analysis passes ANALYSIS_LLM_TIMEOUT_MS directly. Zero means no timeout,
	// exactly like an axios timeout of 0; the gateway env timeout belongs to
	// the brief/RSS completion surfaces.
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	usage := AnalysisStreamUsage{}
	var payload analysisStreamPayload
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

	response, err := g.postAnalysisStream(ctx, profile, primary, fallback, payload)
	if err != nil {
		return usage, g.decorateAnalysisStreamError(err, profile)
	}
	defer response.Body.Close()
	if cost, ok := extractCostHeader(response.Header); ok {
		usage.CostUSD = &cost
	}

	surfaceName := "LiteLLM stream"
	if profile.APISurface == "responses" {
		surfaceName = "LiteLLM responses stream"
	}
	contentTypeRaw := response.Header.Get("Content-Type")
	contentType := strings.ToLower(contentTypeRaw)
	if contentType != "" && !strings.Contains(contentType, "text/event-stream") {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 128*1024))
		if message := guardrailMessageFromBody(body); message != "" {
			return usage, &AnalysisGuardrailError{Message: message}
		}
		return usage, fmt.Errorf("%s returned non-SSE response (%s)", surfaceName, contentTypeRaw)
	}

	err = readSSE(ctx, response.Body, func(data string) error {
		if strings.TrimSpace(data) == "[DONE]" {
			return errSSEDone
		}
		var frame sseFrame
		if err := json.Unmarshal([]byte(data), &frame); err != nil {
			return nil
		}
		mergeAnalysisUsage(&usage, frame.usage())
		if cost := frame.costUSD(); cost != nil {
			usage.CostUSD = cost
		}
		if profile.APISurface == "responses" {
			chunk, err := frame.responsesChunk()
			if err != nil {
				return err
			}
			if chunk != nil {
				chunk.Model = model
				return onChunk(*chunk)
			}
		}
		if chunk := frame.chatChunk(model); chunk != nil {
			return onChunk(*chunk)
		}
		return nil
	})
	if err != nil && !errors.Is(err, errSSEDone) {
		return usage, err
	}
	return usage, nil
}

func (g *gatewayClient) postAnalysisStream(ctx context.Context, profile completionProfile, primary, fallback string, payload analysisStreamPayload) (*http.Response, error) {
	response, err := g.postAnalysisStreamPath(ctx, profile, primary, payload)
	if err == nil {
		return response, nil
	}
	var status *upstreamStatusError
	if errors.As(err, &status) && (status.Status == http.StatusNotFound || status.Status == http.StatusMethodNotAllowed) {
		return g.postAnalysisStreamPath(ctx, profile, fallback, payload)
	}
	return nil, err
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

func (g *gatewayClient) postAnalysisStreamPath(ctx context.Context, profile completionProfile, path string, payload analysisStreamPayload) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if profile.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	response, err := g.http.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response, nil
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 128*1024))
	return nil, &upstreamStatusError{
		Status: response.StatusCode,
		Detail: sanitizeUpstreamDetail(raw),
	}
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

// sseFrame is the subset of an SSE data frame the analysis chain consumes.
// json.RawMessage leaves are protocol values, never business data.
type sseFrame struct {
	Type         string            `json:"type"`
	Delta        json.RawMessage   `json:"delta"`
	OutputText   json.RawMessage   `json:"output_text"`
	Error        json.RawMessage   `json:"error"`
	Message      json.RawMessage   `json:"message"`
	Messages     []json.RawMessage `json:"messages"`
	Choices      []sseChoice       `json:"choices"`
	Usage        *sseUsage         `json:"usage"`
	ResponseCost json.RawMessage   `json:"response_cost"`
	Cost         json.RawMessage   `json:"cost"`
	// Some OpenAI-compatible gateways put the usage counters on the root of
	// the final frame instead of a usage object.
	PromptTokens     json.RawMessage `json:"prompt_tokens"`
	InputTokens      json.RawMessage `json:"input_tokens"`
	CompletionTokens json.RawMessage `json:"completion_tokens"`
	OutputTokens     json.RawMessage `json:"output_tokens"`
	TotalTokens      json.RawMessage `json:"total_tokens"`
}

type sseChoice struct {
	Delta struct {
		Content json.RawMessage `json:"content"`
	} `json:"delta"`
	FinishReason json.RawMessage `json:"finish_reason"`
}

type sseUsage struct {
	PromptTokens     json.RawMessage `json:"prompt_tokens"`
	InputTokens      json.RawMessage `json:"input_tokens"`
	CompletionTokens json.RawMessage `json:"completion_tokens"`
	OutputTokens     json.RawMessage `json:"output_tokens"`
	TotalTokens      json.RawMessage `json:"total_tokens"`
	ResponseCost     json.RawMessage `json:"response_cost"`
}

func (f sseFrame) responsesChunk() (*AnalysisStreamChunk, error) {
	if f.Type == "response.error" || f.Type == "error" {
		message := rawText(f.Message)
		if message == "" {
			message = rawErrorMessage(f.Error)
		}
		if message == "" {
			message = "Responses stream failed"
		}
		return nil, errors.New(message)
	}
	if f.Type == "response.completed" {
		return &AnalysisStreamChunk{FinishReason: "stop"}, nil
	}
	delta := rawText(f.Delta)
	if delta == "" {
		delta = rawText(f.OutputText)
	}
	if delta != "" && strings.Contains(f.Type, "output_text") {
		return &AnalysisStreamChunk{Delta: delta}, nil
	}
	return nil, nil
}

func (f sseFrame) chatChunk(model string) *AnalysisStreamChunk {
	if len(f.Choices) == 0 {
		return nil
	}
	choice := f.Choices[0]
	delta := rawText(choice.Delta.Content)
	finish := rawText(choice.FinishReason)
	if delta != "" {
		return &AnalysisStreamChunk{Model: model, Delta: delta, FinishReason: finish}
	}
	if finish != "" {
		return &AnalysisStreamChunk{Model: model, FinishReason: finish}
	}
	return nil
}

func (f sseFrame) usage() *sseUsage {
	if f.Usage != nil && f.Usage.hasTokensOrCost() {
		return f.Usage
	}
	if len(f.PromptTokens) > 0 || len(f.InputTokens) > 0 ||
		len(f.CompletionTokens) > 0 || len(f.OutputTokens) > 0 ||
		len(f.TotalTokens) > 0 || len(f.ResponseCost) > 0 {
		return &sseUsage{
			PromptTokens:     f.PromptTokens,
			InputTokens:      f.InputTokens,
			CompletionTokens: f.CompletionTokens,
			OutputTokens:     f.OutputTokens,
			TotalTokens:      f.TotalTokens,
			ResponseCost:     f.ResponseCost,
		}
	}
	// An empty usage object still carries no accounting; return it so the
	// caller can see a response_cost leaf if one was present.
	return f.Usage
}

func (u *sseUsage) hasTokensOrCost() bool {
	if u == nil {
		return false
	}
	return len(u.PromptTokens) > 0 || len(u.InputTokens) > 0 ||
		len(u.CompletionTokens) > 0 || len(u.OutputTokens) > 0 ||
		len(u.TotalTokens) > 0 || len(u.ResponseCost) > 0
}

func (f sseFrame) costUSD() *float64 {
	for _, raw := range []json.RawMessage{f.ResponseCost, f.Cost} {
		if value := rawNumber(raw); value != nil {
			return value
		}
	}
	if f.Usage != nil {
		return rawNumber(f.Usage.ResponseCost)
	}
	return nil
}

func mergeAnalysisUsage(target *AnalysisStreamUsage, frame *sseUsage) {
	if target == nil || frame == nil {
		return
	}
	if value := firstNumber(frame.PromptTokens, frame.InputTokens); value != nil {
		target.PromptTokens = value
	}
	if value := firstNumber(frame.CompletionTokens, frame.OutputTokens); value != nil {
		target.CompletionTokens = value
	}
	if value := rawNumber(frame.TotalTokens); value != nil {
		target.TotalTokens = value
	} else if target.TotalTokens == nil && target.PromptTokens != nil {
		if target.CompletionTokens != nil {
			sum := *target.PromptTokens + *target.CompletionTokens
			target.TotalTokens = &sum
		} else {
			prompt := *target.PromptTokens
			target.TotalTokens = &prompt
		}
	}
}

func firstNumber(values ...json.RawMessage) *float64 {
	for _, raw := range values {
		if value := rawNumber(raw); value != nil {
			return value
		}
	}
	return nil
}

func rawNumber(raw json.RawMessage) *float64 {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return nil
	}
	if strings.HasPrefix(text, `"`) {
		var quoted string
		if err := json.Unmarshal(raw, &quoted); err != nil {
			return nil
		}
		text = strings.TrimSpace(quoted)
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return nil
	}
	return &value
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

// readSSE dispatches the `data` field of each SSE event. It tolerates CRLF,
// comments, multi-line data, blank frames and network chunk boundaries; the
// bufio reader reassembles UTF-8 sequences that split across reads.
func readSSE(ctx context.Context, body io.Reader, onData func(data string) error) error {
	reader := bufio.NewReaderSize(body, 64*1024)
	var dataLines []string
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			if line == "" {
				if len(dataLines) > 0 {
					if dispatchErr := onData(strings.Join(dataLines, "\n")); dispatchErr != nil {
						return dispatchErr
					}
					dataLines = nil
				}
			} else if !strings.HasPrefix(line, ":") {
				field, value, found := strings.Cut(line, ":")
				if found && strings.HasPrefix(value, " ") {
					value = value[1:]
				}
				if field == "data" {
					dataLines = append(dataLines, value)
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if len(dataLines) > 0 {
					if dispatchErr := onData(strings.Join(dataLines, "\n")); dispatchErr != nil {
						return dispatchErr
					}
				}
				return nil
			}
			return err
		}
	}
}
