package llmembed

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

const (
	retryDelayStart = time.Second
	retryDelayMax   = 10 * time.Second
)

func (c *Client) postWithRetry(ctx context.Context, profile runtimeProfile, primary, fallback string, payload any) ([]byte, error) {
	return c.postWithRetryOptions(ctx, profile, primary, fallback, payload, 0, profile.MaxRetries)
}

// postWithRetryOptions is postWithRetry with a per-request timeout and retry
// budget. A zero timeout keeps profile.Timeout and a non-positive maxRetries
// keeps at least one attempt, so the shared callers are unaffected.
func (c *Client) postWithRetryOptions(
	ctx context.Context,
	profile runtimeProfile,
	primary string,
	fallback string,
	payload any,
	timeout time.Duration,
	maxRetries int,
) ([]byte, error) {
	attempts := maxRetries
	if attempts < 1 {
		attempts = 1
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, errUpstream
	}
	delay := retryDelayStart
	for attempt := 0; attempt < attempts; attempt++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		status, raw, callErr := c.postWithTimeout(ctx, profile, primary, body, timeout)
		if callErr == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) && fallback != "" {
			status, raw, callErr = c.postWithTimeout(ctx, profile, fallback, body, timeout)
		}
		if callErr == nil && status >= 200 && status < 300 {
			return raw, nil
		}
		if ctx.Err() != nil || !retryable(status, callErr) || attempt+1 >= attempts {
			return nil, errUpstream
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		delay *= 2
		if delay > retryDelayMax {
			delay = retryDelayMax
		}
	}
	return nil, errUpstream
}

func (c *Client) post(ctx context.Context, profile runtimeProfile, path string, body []byte) (int, []byte, error) {
	return c.postWithTimeout(ctx, profile, path, body, 0)
}

// postWithTimeout issues one HTTP attempt. A non-positive timeout falls back to
// the profile timeout (or 60 seconds), which is the shared behavior.
func (c *Client) postWithTimeout(ctx context.Context, profile runtimeProfile, path string, body []byte, timeout time.Duration) (int, []byte, error) {
	if timeout <= 0 {
		timeout = profile.Timeout
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	status, raw, _, err := litellmcompat.PostOnce(ctx, c.http, profile.APIBase, profile.APIKey, path, body, timeout, 8<<20)
	return status, raw, err
}

func retryable(status int, callErr error) bool {
	if callErr != nil && status == 0 {
		return true
	}
	switch status {
	case http.StatusRequestTimeout, http.StatusConflict, http.StatusLocked, 425, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}
