package litellmcompat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// streamErrorBodyLimit caps the non-2xx / non-SSE body the caller's error
// classifier reads. Both former streaming copies used 128 KiB so a huge HTML
// error page cannot be buffered in full.
const streamErrorBodyLimit = 128 * 1024

// errStreamDone stops the SSE reader as soon as the [DONE] frame is received,
// matching LiteLlmService.stream which must not wait for the upstream to close.
var errStreamDone = errors.New("litellmcompat: stream done")

// StreamEvent is one decoded server-sent event forwarded to a caller. A
// finish-only event carries FinishReason with an empty Delta; whether it counts
// as downstream output is the caller's call (see StreamPlan.FinishStarts).
type StreamEvent struct {
	Model        string
	Delta        string
	FinishReason string
}

// StreamResult is the successful stream: the model that produced it and the
// accumulated token/cost usage.
type StreamResult struct {
	Model string
	Usage Usage
}

// StreamPlan is one CompletionStream execution over an already resolved profile.
// The caller owns request construction, upstream error classification and
// event forwarding, so each streaming surface keeps its exact wire shape, error
// text and business event mapping while the retry/fallback transport, SSE
// framing, chat/responses decoding, usage/cost merge and per-attempt observer
// live in one place. It is the streaming counterpart of CompletionPlan.
type StreamPlan struct {
	OrgID string
	// Models is the candidate list in fallback order. Empty means the profile
	// model followed by its configured fallbacks.
	Models []string
	// MaxRetries is the attempts per model. Zero/negative means one attempt.
	MaxRetries int
	// Timeout is the per-attempt deadline. A non-positive value means no
	// deadline, matching an axios timeout of 0.
	Timeout time.Duration
	// DisableFallback stops after the primary model.
	DisableFallback bool
	// FinishStarts reports whether a finish-only event counts as downstream
	// output and therefore forbids a later fallback. The analysis stream counts
	// it; the assistant stream only counts emitted deltas.
	FinishStarts bool
	// ApplyCostHeader applies the x-litellm-response-cost header to the initial
	// usage before frames are read.
	ApplyCostHeader bool
	// Build renders the request body and the primary/fallback paths for one model.
	Build func(model string) (body []byte, primaryPath, fallbackPath string, err error)
	// ClassifyStatus turns a non-2xx exchange into the caller's typed error.
	ClassifyStatus func(profile Profile, model string, status int, header http.Header, raw []byte) error
	// ClassifyNonSSE turns a 2xx non-SSE response into the caller's typed error.
	ClassifyNonSSE func(profile Profile, model string, status int, header http.Header, raw []byte) error
	// Stop reports errors that terminate the fallback chain (guardrail,
	// compatibility). It does not affect retry of the same model.
	Stop func(err error) bool
	// OnEvent receives each decoded event. A returned error aborts the stream.
	OnEvent func(StreamEvent) error
	// Observer receives one record per real attempt.
	Observer AttemptObserver
}

// CompletionStream runs a streaming completion: the primary model then the
// configured fallbacks, per-model retries with exponential backoff, and one
// observer record per real attempt. A model may be replaced only before any
// event reached the caller; once output was yielded an error is final. Guardrail
// and compatibility errors end the chain immediately.
func (c *Client) CompletionStream(ctx context.Context, profile Profile, plan StreamPlan) (StreamResult, error) {
	models := plan.Models
	if len(models) == 0 {
		models = uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	}
	if plan.DisableFallback && len(models) > 1 {
		models = models[:1]
	}
	if len(models) == 0 {
		return StreamResult{}, ErrCompletionUnavailable
	}
	attempts := plan.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for index, model := range models {
		started := false
		delay := time.Second
		for attempt := 0; attempt < attempts; attempt++ {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return StreamResult{}, ctxErr
			}
			body, primaryPath, fallbackPath, buildErr := plan.Build(model)
			if buildErr != nil {
				return StreamResult{}, buildErr
			}
			startedAt := c.now()
			status, response, cancel, callErr := c.postStream(ctx, profile, primaryPath, fallbackPath, body, plan.Timeout)
			var acc Usage
			var attemptErr error
			if callErr != nil {
				attemptErr = callErr
			} else {
				attemptErr = c.readStream(ctx, profile, model, plan, status, response, &acc, &started)
				cancel()
			}
			latency := c.now().Sub(startedAt)
			if plan.Observer != nil {
				plan.Observer.ObserveAttempt(ctx, Attempt{
					OrgID:                     plan.OrgID,
					Model:                     model,
					ModelIndex:                index + 1,
					Attempt:                   attempt + 1,
					Success:                   attemptErr == nil,
					Err:                       attemptErr,
					Latency:                   latency,
					Usage:                     acc,
					APISurface:                profile.APISurface,
					GatewayProfileID:          profile.ID,
					GovernanceApplied:         profile.GovernanceApplied,
					AuthMode:                  profile.authMode(),
					GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				})
			}
			if attemptErr == nil {
				return StreamResult{Model: model, Usage: acc}, nil
			}
			lastErr = attemptErr
			if started || (plan.Stop != nil && plan.Stop(attemptErr)) {
				return StreamResult{}, attemptErr
			}
			if !retryableStatus(status, attemptErr) || attempt+1 >= attempts {
				break
			}
			if err := sleepContext(ctx, delay); err != nil {
				return StreamResult{}, err
			}
			delay = nextDelay(delay)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM stream failed")
	}
	return StreamResult{}, lastErr
}

// postStream performs one streaming POST, retrying the fallback path once on a
// 404/405 like the former per-surface loops. It never reads the body; the caller
// owns closing the returned response.
func (c *Client) postStream(ctx context.Context, profile Profile, primary, fallback string, body []byte, timeout time.Duration) (int, *http.Response, context.CancelFunc, error) {
	status, response, cancel, err := c.postStreamOnce(ctx, profile, primary, body, timeout)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) && fallback != "" {
		_ = response.Body.Close()
		cancel()
		return c.postStreamOnce(ctx, profile, fallback, body, timeout)
	}
	return status, response, cancel, err
}

func (c *Client) postStreamOnce(ctx context.Context, profile Profile, path string, body []byte, timeout time.Duration) (int, *http.Response, context.CancelFunc, error) {
	callCtx := ctx
	cancel := context.CancelFunc(func() {})
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, timeout)
	} else {
		callCtx, cancel = context.WithCancel(ctx)
	}
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		cancel()
		return 0, nil, func() {}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if profile.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	httpClient := c.http
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		cancel()
		return 0, nil, func() {}, err
	}
	return response.StatusCode, response, cancel, nil
}

// readStream classifies the response, then reads SSE frames and forwards the
// decoded events. It closes the response body on return.
func (c *Client) readStream(ctx context.Context, profile Profile, model string, plan StreamPlan, status int, response *http.Response, acc *Usage, started *bool) error {
	defer response.Body.Close()
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, streamErrorBodyLimit))
		return plan.ClassifyStatus(profile, model, status, response.Header, raw)
	}
	if plan.ApplyCostHeader {
		applyHeaderCost(acc, response.Header)
	}
	contentTypeRaw := response.Header.Get("Content-Type")
	contentType := strings.ToLower(contentTypeRaw)
	if contentType != "" && !strings.Contains(contentType, "text/event-stream") {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, streamErrorBodyLimit))
		return plan.ClassifyNonSSE(profile, model, status, response.Header, raw)
	}

	reader := bufio.NewReaderSize(response.Body, 64*1024)
	var dataLines []string
	dispatch := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		payload := strings.Join(dataLines, "\n")
		dataLines = nil
		return c.handleStreamFrame(profile, model, plan, payload, acc, started)
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, readErr := reader.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			if line == "" {
				if err := dispatch(); err != nil {
					if errors.Is(err, errStreamDone) {
						return nil
					}
					return err
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
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				if err := dispatch(); err != nil && !errors.Is(err, errStreamDone) {
					return err
				}
				return nil
			}
			return readErr
		}
	}
}

func (c *Client) handleStreamFrame(profile Profile, model string, plan StreamPlan, data string, acc *Usage, started *bool) error {
	if strings.TrimSpace(data) == "[DONE]" {
		return errStreamDone
	}
	events, err := decodeStreamFrame(profile, model, []byte(data), acc)
	if err != nil {
		return err
	}
	for _, event := range events {
		if event.Delta != "" || (plan.FinishStarts && event.FinishReason != "") {
			*started = true
		}
		if plan.OnEvent != nil {
			if err := plan.OnEvent(event); err != nil {
				return err
			}
		}
	}
	return nil
}

// decodeStreamFrame decodes one chat-completions or responses SSE frame into
// events and merges its usage/cost into acc. It reproduces the former analysis
// reader: malformed frames are skipped, responses error frames abort the stream.
func decodeStreamFrame(profile Profile, model string, raw []byte, acc *Usage) ([]StreamEvent, error) {
	var frame streamFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, nil
	}
	mergeStreamUsage(acc, frame.usage())
	if cost := frame.costUSD(); cost != nil {
		acc.CostUSD = cost
	}
	if profile.APISurface == APISurfaceResponses {
		event, err := frame.responsesEvent(model)
		if err != nil {
			return nil, err
		}
		if event != nil {
			return []StreamEvent{*event}, nil
		}
		return nil, nil
	}
	if event := frame.chatEvent(model); event != nil {
		return []StreamEvent{*event}, nil
	}
	return nil, nil
}

// streamFrame is the subset of an SSE data frame the stream surfaces consume.
// json.RawMessage leaves are protocol values, never business data.
type streamFrame struct {
	Type         string            `json:"type"`
	Delta        json.RawMessage   `json:"delta"`
	OutputText   json.RawMessage   `json:"output_text"`
	Error        json.RawMessage   `json:"error"`
	Message      json.RawMessage   `json:"message"`
	Messages     []json.RawMessage `json:"messages"`
	Choices      []streamChoice    `json:"choices"`
	Usage        *streamUsage      `json:"usage"`
	ResponseCost json.RawMessage   `json:"response_cost"`
	Cost         json.RawMessage   `json:"cost"`
	// Some OpenAI-compatible gateways put the usage counters on the root of the
	// final frame instead of a usage object.
	PromptTokens     json.RawMessage `json:"prompt_tokens"`
	InputTokens      json.RawMessage `json:"input_tokens"`
	CompletionTokens json.RawMessage `json:"completion_tokens"`
	OutputTokens     json.RawMessage `json:"output_tokens"`
	TotalTokens      json.RawMessage `json:"total_tokens"`
}

type streamChoice struct {
	Delta struct {
		Content json.RawMessage `json:"content"`
	} `json:"delta"`
	FinishReason json.RawMessage `json:"finish_reason"`
}

type streamUsage struct {
	PromptTokens     json.RawMessage `json:"prompt_tokens"`
	InputTokens      json.RawMessage `json:"input_tokens"`
	CompletionTokens json.RawMessage `json:"completion_tokens"`
	OutputTokens     json.RawMessage `json:"output_tokens"`
	TotalTokens      json.RawMessage `json:"total_tokens"`
	ResponseCost     json.RawMessage `json:"response_cost"`
}

func (f streamFrame) responsesEvent(model string) (*StreamEvent, error) {
	if f.Type == "response.error" || f.Type == "error" {
		message := streamRawText(f.Message)
		if message == "" {
			message = streamRawErrorMessage(f.Error)
		}
		if message == "" {
			message = "Responses stream failed"
		}
		return nil, errors.New(message)
	}
	if f.Type == "response.completed" {
		return &StreamEvent{Model: model, FinishReason: "stop"}, nil
	}
	delta := streamRawText(f.Delta)
	if delta == "" {
		delta = streamRawText(f.OutputText)
	}
	if delta != "" && strings.Contains(f.Type, "output_text") {
		return &StreamEvent{Model: model, Delta: delta}, nil
	}
	return nil, nil
}

func (f streamFrame) chatEvent(model string) *StreamEvent {
	if len(f.Choices) == 0 {
		return nil
	}
	choice := f.Choices[0]
	delta := streamRawText(choice.Delta.Content)
	finish := streamRawText(choice.FinishReason)
	if delta != "" {
		return &StreamEvent{Model: model, Delta: delta, FinishReason: finish}
	}
	if finish != "" {
		return &StreamEvent{Model: model, FinishReason: finish}
	}
	return nil
}

func (f streamFrame) usage() *streamUsage {
	if f.Usage != nil && f.Usage.hasTokensOrCost() {
		return f.Usage
	}
	if len(f.PromptTokens) > 0 || len(f.InputTokens) > 0 ||
		len(f.CompletionTokens) > 0 || len(f.OutputTokens) > 0 ||
		len(f.TotalTokens) > 0 || len(f.ResponseCost) > 0 {
		return &streamUsage{
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

func (u *streamUsage) hasTokensOrCost() bool {
	if u == nil {
		return false
	}
	return len(u.PromptTokens) > 0 || len(u.InputTokens) > 0 ||
		len(u.CompletionTokens) > 0 || len(u.OutputTokens) > 0 ||
		len(u.TotalTokens) > 0 || len(u.ResponseCost) > 0
}

func (f streamFrame) costUSD() *float64 {
	for _, raw := range []json.RawMessage{f.ResponseCost, f.Cost} {
		if value := streamRawNumber(raw); value != nil {
			return value
		}
	}
	if f.Usage != nil {
		return streamRawNumber(f.Usage.ResponseCost)
	}
	return nil
}

// mergeStreamUsage ports mergeAnalysisUsage onto the shared Usage value.
func mergeStreamUsage(target *Usage, frame *streamUsage) {
	if target == nil || frame == nil {
		return
	}
	if value := streamFirstNumber(frame.PromptTokens, frame.InputTokens); value != nil {
		target.PromptTokens = value
	}
	if value := streamFirstNumber(frame.CompletionTokens, frame.OutputTokens); value != nil {
		target.CompletionTokens = value
	}
	if value := streamRawNumber(frame.TotalTokens); value != nil {
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

func streamFirstNumber(values ...json.RawMessage) *float64 {
	for _, raw := range values {
		if value := streamRawNumber(raw); value != nil {
			return value
		}
	}
	return nil
}

func streamRawNumber(raw json.RawMessage) *float64 {
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

func streamRawText(raw json.RawMessage) string {
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

func streamRawErrorMessage(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var record struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &record); err == nil && strings.TrimSpace(record.Message) != "" {
		return strings.TrimSpace(record.Message)
	}
	return streamRawText(raw)
}
