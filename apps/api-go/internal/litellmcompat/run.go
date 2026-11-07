package litellmcompat

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Attempt is one real upstream HTTP attempt of a completion/embedding/rerank
// chain. It is the single attempt projection every LLM client shares, so the
// former per-package retry/fallback loops could stop recreating it.
//
// Model is the model requested for this attempt; ResponseModel is the model the
// gateway reported, empty when the attempt failed before a body was parsed.
type Attempt struct {
	OrgID                     string
	Model                     string
	ResponseModel             string
	ModelIndex                int
	Attempt                   int
	Success                   bool
	Err                       error
	Latency                   time.Duration
	Usage                     Usage
	APISurface                APISurface
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
}

// AttemptObserver receives every real attempt of a RunCompletion execution. A
// caller that does not persist attempt rows leaves it nil.
type AttemptObserver interface {
	ObserveAttempt(ctx context.Context, attempt Attempt)
}

// CompletionPlan is one RunCompletion execution over an already resolved profile.
// Build and Parse are caller-owned so each completion surface keeps its exact
// wire shape and error text while sharing the retry/fallback/transport/observer
// engine. This is the completion counterpart of the classifier Client.Completion
// for the surfaces whose payloads and error decoration differ from it.
type CompletionPlan struct {
	OrgID string
	// Models is the candidate list in fallback order. Empty means the profile
	// model followed by its configured fallbacks.
	Models []string
	// MaxRetries is the attempts per model. Zero means the profile MaxRetries.
	MaxRetries int
	// Timeout overrides the profile timeout when positive.
	Timeout time.Duration
	// DisableFallback stops after the primary model.
	DisableFallback bool
	// MaxBody caps the response body; zero means the package responseLimit.
	MaxBody int64
	// Build renders the request body and the primary/fallback paths for one model.
	Build func(model string) (body []byte, primaryPath, fallbackPath string, err error)
	// Parse turns one exchange into a result or a typed error. It is responsible
	// for the surface-specific status/error classification and usage extraction.
	Parse func(status int, header http.Header, raw []byte, model string) (CompletionResponse, error)
	// Stop reports the errors that terminate the fallback chain instead of
	// retrying or trying the next model (guardrail, compatibility, governance).
	Stop func(err error) bool
	// Observer receives one record per real attempt.
	Observer AttemptObserver
}

// RunCompletion executes the plan against profile: the primary model followed by
// the fallbacks, per-model retries with exponential backoff, and one observer
// record per real attempt. It returns the first parsed success or the last error.
func (c *Client) RunCompletion(ctx context.Context, profile Profile, plan CompletionPlan) (CompletionResponse, error) {
	models := plan.Models
	if len(models) == 0 {
		models = uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	}
	if plan.DisableFallback && len(models) > 1 {
		models = models[:1]
	}
	if len(models) == 0 {
		return CompletionResponse{}, ErrCompletionUnavailable
	}
	attempts := plan.MaxRetries
	if attempts <= 0 {
		attempts = profile.MaxRetries
	}
	if attempts < 1 {
		attempts = 1
	}
	timeout := plan.Timeout
	if timeout <= 0 {
		timeout = c.timeout(profile, 0)
	}
	maxBody := plan.MaxBody
	if maxBody <= 0 {
		maxBody = responseLimit
	}
	var lastErr error
	for index, model := range models {
		body, primaryPath, fallbackPath, buildErr := plan.Build(model)
		if buildErr != nil {
			return CompletionResponse{}, buildErr
		}
		delay := time.Second
		for attempt := 0; attempt < attempts; attempt++ {
			started := c.now()
			status, raw, header, callErr := c.postWithLimit(ctx, profile, primaryPath, fallbackPath, body, timeout, maxBody)
			latency := c.now().Sub(started)
			var response CompletionResponse
			if callErr == nil {
				response, callErr = plan.Parse(status, header, raw, model)
			}
			if plan.Observer != nil {
				plan.Observer.ObserveAttempt(ctx, Attempt{
					OrgID:                     plan.OrgID,
					Model:                     model,
					ResponseModel:             response.Model,
					ModelIndex:                index + 1,
					Attempt:                   attempt + 1,
					Success:                   callErr == nil,
					Err:                       callErr,
					Latency:                   latency,
					Usage:                     response.Usage,
					APISurface:                profile.APISurface,
					GatewayProfileID:          profile.ID,
					GovernanceApplied:         profile.GovernanceApplied,
					AuthMode:                  profile.authMode(),
					GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				})
			}
			if callErr == nil {
				return response, nil
			}
			lastErr = callErr
			// A stop error (guardrail, compatibility, governance) terminates the
			// whole chain: do not retry the model and do not try a fallback.
			if plan.Stop != nil && plan.Stop(callErr) {
				return CompletionResponse{}, callErr
			}
			if !retryableStatus(status, callErr) || attempt+1 >= attempts {
				break
			}
			if err := sleepContext(ctx, delay); err != nil {
				return CompletionResponse{}, err
			}
			delay = nextDelay(delay)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("LiteLLM completion failed")
	}
	return CompletionResponse{}, lastErr
}
