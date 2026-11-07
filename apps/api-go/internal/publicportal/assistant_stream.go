package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/safego"
)

// This file adds the streaming half of the assistant model surface. The shared
// litellmcompat.CompletionStream engine owns the transport, fallback/retry loop,
// SSE framing, chat/responses decoding and usage/cost merge; this file keeps the
// assistant request body, guardrail conversion and the channel the caller reads.
// The fallback chain is only used when a model fails before emitting its first
// delta, mirroring LiteLlmService.stream.

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
	safego.Go("publicportal.assistantStream.stream", func() {
		defer close(events)
		client := litellmcompat.NewSettingsClient(nil, nil, litellmcompat.Config{}).WithHTTP(c.http)
		_, streamErr := client.CompletionStream(ctx, sharedProfileFromCompletion(profile.completionProfile), litellmcompat.StreamPlan{
			OrgID:      req.OrgID,
			Models:     models,
			MaxRetries: profile.MaxRetries,
			Timeout:    assistantStreamTimeout(profile, req.Timeout),
			Build: func(model string) ([]byte, string, string, error) {
				body, primary, fallback, _ := c.streamPayload(profile, model, req)
				return body, primary, fallback, nil
			},
			ClassifyStatus: func(_ litellmcompat.Profile, _ string, status int, header http.Header, raw []byte) error {
				if guardrail := assistantGuardrailFromResponse(raw, header, status, nil); guardrail != nil {
					return guardrail
				}
				return fmt.Errorf("LiteLLM request failed (HTTP %d)", status)
			},
			ClassifyNonSSE: func(_ litellmcompat.Profile, _ string, status int, header http.Header, raw []byte) error {
				if guardrail := assistantGuardrailFromResponse(raw, header, status, nil); guardrail != nil {
					return guardrail
				}
				contentType := strings.ToLower(header.Get("content-type"))
				return fmt.Errorf("LiteLLM stream returned non-SSE response (%s)", contentType)
			},
			Stop: func(err error) bool {
				var guardrail *AssistantGuardrailError
				return errors.As(err, &guardrail)
			},
			OnEvent: func(event litellmcompat.StreamEvent) error {
				// The assistant stream forwards delta text only; a finish-only
				// event must not become a caller-visible event.
				if event.Delta == "" {
					return nil
				}
				events <- AssistantStreamEvent{Delta: event.Delta, Model: event.Model}
				return nil
			},
			Observer:        assistantStreamAttemptAdapter{next: req.Observer, metadata: req.Metadata},
			ApplyCostHeader: false,
			FinishStarts:    false,
		})
		if streamErr != nil {
			events <- AssistantStreamEvent{Err: streamErr}
		}
	})
	return events, nil
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

// assistantStreamTimeout is the per-attempt deadline: the request timeout, then
// the profile timeout, then the 60 second default.
func assistantStreamTimeout(profile assistantProfile, request time.Duration) time.Duration {
	if request > 0 {
		return request
	}
	if profile.Timeout > 0 {
		return profile.Timeout
	}
	return 60 * time.Second
}

// assistantStreamAttemptAdapter maps the shared attempt record onto the
// assistant attempt type (streaming flavour).
type assistantStreamAttemptAdapter struct {
	next     AssistantAttemptObserver
	metadata AssistantRequestMetadata
}

func (a assistantStreamAttemptAdapter) ObserveAttempt(_ context.Context, attempt litellmcompat.Attempt) {
	if a.next == nil {
		return
	}
	a.next.ObserveAssistantAttempt(context.Background(), AssistantAttempt{
		OrgID:                     attempt.OrgID,
		Model:                     attempt.Model,
		ModelIndex:                attempt.ModelIndex,
		APISurface:                string(attempt.APISurface),
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         attempt.GovernanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		Success:                   attempt.Success,
		Err:                       attempt.Err,
		Latency:                   attempt.Latency,
		Usage:                     assistantUsageFromShared(attempt.Usage),
		Metadata:                  a.metadata,
		Streaming:                 true,
	})
}
