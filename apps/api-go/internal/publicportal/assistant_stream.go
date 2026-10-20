package publicportal

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// This file adds the streaming half of the assistant model surface. It sends
// the same chat-completions or responses payload as the non-streaming path,
// reads server-sent events, and reports token usage and one request-log row per
// attempt. The fallback chain is only used when a model fails before emitting
// its first delta, mirroring LiteLlmService.stream.

// Stream performs one streaming completion. Configuration errors are returned
// synchronously; transport and upstream failures arrive as the terminal
// AssistantStreamEvent.Err so the caller can persist the partial summary.
func (c *assistantClient) Stream(ctx context.Context, req AssistantCompletionRequest) (<-chan AssistantStreamEvent, error) {
	profile, err := c.resolveProfile(ctx)
	if err != nil {
		return nil, err
	}
	models := assistantModels(profile, req.Model)
	if len(models) == 0 {
		return nil, errors.New("LiteLLM completion model is not configured in MySQL gateway profiles")
	}
	events := make(chan AssistantStreamEvent, 16)
	go func() {
		defer close(events)
		c.streamModels(ctx, profile, models, req, events)
	}()
	return events, nil
}

func (c *assistantClient) streamModels(ctx context.Context, profile assistantProfile, models []string, req AssistantCompletionRequest, events chan<- AssistantStreamEvent) {
	var lastErr error
	for index, model := range models {
		started := false
		err := c.streamModel(ctx, profile, model, index+1, req, events, &started)
		if err == nil {
			return
		}
		if started {
			// Once a delta reached the caller the answer is partial; retrying
			// against another model would duplicate or contradict it.
			events <- AssistantStreamEvent{Model: model, Err: err}
			return
		}
		var guardrail *AssistantGuardrailError
		if errors.As(err, &guardrail) {
			events <- AssistantStreamEvent{Model: model, Err: err}
			return
		}
		var statusErr *StatusError
		if errors.As(err, &statusErr) {
			events <- AssistantStreamEvent{Model: model, Err: err}
			return
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM stream failed")
	}
	events <- AssistantStreamEvent{Err: lastErr}
}

func (c *assistantClient) streamModel(
	ctx context.Context,
	profile assistantProfile,
	model string,
	modelIndex int,
	req AssistantCompletionRequest,
	events chan<- AssistantStreamEvent,
	started *bool,
) error {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		startedAt := time.Now()
		payload, primaryPath, fallbackPath, surface := c.streamPayload(profile, model, req)
		status, resp, err := c.openStream(ctx, profile, primaryPath, fallbackPath, payload, req.Timeout)
		if err != nil {
			if status != 0 {
				// A non-2xx response may carry a guardrail signal. The body is
				// read by openStream and returned in the error detail; the
				// structured conversion is handled below when the status is a
				// guardrail client error.
				if guardrail := guardrailFromAttemptError(err); guardrail != nil {
					c.observeStreamAttempt(ctx, profile, model, modelIndex, surface, req, startedAt, false, AssistantUsage{}, guardrail)
					return guardrail
				}
			}
			c.observeStreamAttempt(ctx, profile, model, modelIndex, surface, req, startedAt, false, AssistantUsage{}, err)
			lastErr = err
			if !retryable(status, err) || attempt+1 >= attempts {
				return err
			}
			if sleepErr := sleep(ctx, delay); sleepErr != nil {
				return sleepErr
			}
			delay = nextDelay(delay)
			continue
		}
		usage, cost, err := c.consumeStream(ctx, profile, req, model, surface, resp, events, started)
		if cost != nil {
			usage.CostUSD = cost
		}
		if err != nil {
			c.observeStreamAttempt(ctx, profile, model, modelIndex, surface, req, startedAt, false, usage, err)
			lastErr = err
			if *started {
				return err
			}
			var guardrail *AssistantGuardrailError
			if errors.As(err, &guardrail) {
				return err
			}
			if !retryable(status, err) || attempt+1 >= attempts {
				return err
			}
			if sleepErr := sleep(ctx, delay); sleepErr != nil {
				return sleepErr
			}
			delay = nextDelay(delay)
			continue
		}
		c.observeStreamAttempt(ctx, profile, model, modelIndex, surface, req, startedAt, true, usage, nil)
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM stream failed")
	}
	return lastErr
}

func nextDelay(delay time.Duration) time.Duration {
	delay *= 2
	if delay > 10*time.Second {
		return 10 * time.Second
	}
	return delay
}

func (c *assistantClient) observeStreamAttempt(ctx context.Context, profile assistantProfile, model string, modelIndex int, surface string, req AssistantCompletionRequest, startedAt time.Time, success bool, usage AssistantUsage, err error) {
	if req.Observer == nil {
		return
	}
	req.Observer.ObserveAssistantAttempt(ctx, AssistantAttempt{
		OrgID:                     req.OrgID,
		Model:                     model,
		ModelIndex:                modelIndex,
		APISurface:                surface,
		GatewayProfileID:          profile.ID,
		GovernanceApplied:         profile.GovernanceApplied,
		AuthMode:                  profile.authMode(),
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
		Success:                   success,
		Err:                       err,
		Latency:                   time.Since(startedAt),
		Usage:                     usage,
		Metadata:                  req.Metadata,
		Streaming:                 true,
	})
}

// streamPayload is completionPayload with stream:true and the SSE accept path.
func (c *assistantClient) streamPayload(profile assistantProfile, model string, req AssistantCompletionRequest) ([]byte, string, string, string) {
	body, primary, fallback, surface := c.completionPayload(profile, model, req)
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return body, primary, fallback, surface
	}
	payload["stream"] = true
	encoded, _ := json.Marshal(payload)
	return encoded, primary, fallback, surface
}

// openStream posts the payload and returns the response when it is a 2xx SSE
// stream. Non-2xx bodies are read and folded into the error so guardrail
// conversion can still see them.
func (c *assistantClient) openStream(ctx context.Context, profile assistantProfile, primaryPath, fallbackPath string, payload []byte, timeout time.Duration) (int, *streamResponse, error) {
	status, resp, err := c.postStream(ctx, profile, primaryPath, payload, timeout)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, resp, err = c.postStream(ctx, profile, fallbackPath, payload, timeout)
	}
	return status, resp, err
}

func (c *assistantClient) postStream(ctx context.Context, profile assistantProfile, path string, payload []byte, timeout time.Duration) (int, *streamResponse, error) {
	if timeout <= 0 {
		timeout = profile.Timeout
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		cancel()
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if profile.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		cancel()
		return 0, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 128*1024))
		_ = resp.Body.Close()
		cancel()
		guardrail := assistantGuardrailFromResponse(raw, resp.Header, resp.StatusCode, nil)
		if guardrail != nil {
			return resp.StatusCode, nil, &streamAttemptError{status: resp.StatusCode, err: guardrail}
		}
		return resp.StatusCode, nil, &streamAttemptError{status: resp.StatusCode, err: fmt.Errorf("LiteLLM request failed (HTTP %d)", resp.StatusCode)}
	}
	contentType := strings.ToLower(resp.Header.Get("content-type"))
	if contentType != "" && !strings.Contains(contentType, "text/event-stream") {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 128*1024))
		_ = resp.Body.Close()
		cancel()
		if guardrail := assistantGuardrailFromResponse(raw, resp.Header, resp.StatusCode, nil); guardrail != nil {
			return resp.StatusCode, nil, &streamAttemptError{status: resp.StatusCode, err: guardrail}
		}
		return resp.StatusCode, nil, &streamAttemptError{status: resp.StatusCode, err: fmt.Errorf("LiteLLM stream returned non-SSE response (%s)", contentType)}
	}
	return resp.StatusCode, &streamResponse{Response: resp, cancel: cancel}, nil
}

// streamResponse ties the response body to its request context.
type streamResponse struct {
	*http.Response
	cancel context.CancelFunc
}

// streamAttemptError carries the HTTP status of a failed attempt so the retry
// policy can see it.
type streamAttemptError struct {
	status int
	err    error
}

func (e *streamAttemptError) Error() string { return e.err.Error() }
func (e *streamAttemptError) Unwrap() error { return e.err }

func guardrailFromAttemptError(err error) *AssistantGuardrailError {
	var attempt *streamAttemptError
	if errors.As(err, &attempt) {
		var guardrail *AssistantGuardrailError
		if errors.As(attempt.err, &guardrail) {
			return guardrail
		}
	}
	return nil
}

// consumeStream reads SSE events until [DONE]/EOF and forwards deltas. Usage is
// merged from every chunk that reports it.
func (c *assistantClient) consumeStream(
	ctx context.Context,
	profile assistantProfile,
	req AssistantCompletionRequest,
	model string,
	surface string,
	response *streamResponse,
	events chan<- AssistantStreamEvent,
	started *bool,
) (AssistantUsage, *float64, error) {
	stream := response.Body
	defer response.cancel()
	defer stream.Close()
	usage := AssistantUsage{}
	var cost *float64
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			return usage, cost, nil
		}
		var parsed map[string]any
		if json.Unmarshal([]byte(data), &parsed) != nil {
			continue
		}
		mergeStreamUsage(&usage, parsed)
		if chunkCost := chunkCost(parsed); chunkCost != nil {
			cost = chunkCost
		}
		switch surface {
		case "responses":
			delta, streamErr := responsesStreamChunk(parsed)
			if streamErr != nil {
				return usage, cost, streamErr
			}
			if delta != "" {
				*started = true
				events <- AssistantStreamEvent{Delta: delta, Model: model}
			}
		default:
			delta, finish := chatStreamChunk(parsed)
			_ = finish
			if delta != "" {
				*started = true
				events <- AssistantStreamEvent{Delta: delta, Model: model}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return usage, cost, ctx.Err()
		}
		return usage, cost, err
	}
	return usage, cost, nil
}

func responsesStreamChunk(parsed map[string]any) (string, error) {
	chunkType, _ := parsed["type"].(string)
	if chunkType == "response.error" || chunkType == "error" {
		if errorObject, ok := parsed["error"].(map[string]any); ok {
			if message, ok := errorObject["message"].(string); ok && strings.TrimSpace(message) != "" {
				return "", errors.New(strings.TrimSpace(message))
			}
		}
		if message, ok := parsed["message"].(string); ok && strings.TrimSpace(message) != "" {
			return "", errors.New(strings.TrimSpace(message))
		}
		return "", errors.New("Responses stream failed")
	}
	if chunkType == "response.completed" {
		return "", nil
	}
	delta, _ := parsed["delta"].(string)
	if delta == "" {
		delta, _ = parsed["output_text"].(string)
	}
	if delta != "" && strings.Contains(chunkType, "output_text") {
		return delta, nil
	}
	return "", nil
}

func chatStreamChunk(parsed map[string]any) (string, string) {
	choices, ok := parsed["choices"].([]any)
	if !ok || len(choices) == 0 {
		return "", ""
	}
	choice, _ := choices[0].(map[string]any)
	deltaRecord, _ := choice["delta"].(map[string]any)
	delta, _ := deltaRecord["content"].(string)
	finish, _ := choice["finish_reason"].(string)
	return delta, finish
}

func mergeStreamUsage(usage *AssistantUsage, parsed map[string]any) {
	record, ok := parsed["usage"].(map[string]any)
	if !ok || record == nil {
		return
	}
	if prompt := firstFinite(record["prompt_tokens"], record["input_tokens"]); prompt != nil {
		usage.PromptTokens = prompt
	}
	if completion := firstFinite(record["completion_tokens"], record["output_tokens"]); completion != nil {
		usage.CompletionTokens = completion
	}
	total := firstFinite(record["total_tokens"], nil)
	if total == nil && usage.PromptTokens != nil && usage.CompletionTokens != nil {
		sum := *usage.PromptTokens + *usage.CompletionTokens
		total = &sum
	}
	if total != nil {
		usage.TotalTokens = total
	}
	if responseCost := firstFinite(record["response_cost"], nil); responseCost != nil {
		usage.CostUSD = responseCost
	}
}

func chunkCost(parsed map[string]any) *float64 {
	if responseCost := firstFinite(parsed["response_cost"], nil); responseCost != nil {
		return responseCost
	}
	if record, ok := parsed["usage"].(map[string]any); ok {
		return firstFinite(record["response_cost"], nil)
	}
	return nil
}
