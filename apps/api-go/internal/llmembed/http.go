package llmembed

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	retryDelayStart = time.Second
	retryDelayMax   = 10 * time.Second
)

func (c *Client) postWithRetry(ctx context.Context, profile runtimeProfile, primary, fallback string, payload any) ([]byte, error) {
	attempts := profile.MaxRetries
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
		status, raw, callErr := c.post(ctx, profile, primary, body)
		if callErr == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) && fallback != "" {
			status, raw, callErr = c.post(ctx, profile, fallback, body)
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
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
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

func normalizeAPIBase(raw string) string {
	base := strings.TrimSpace(raw)
	base = strings.TrimRight(base, "/")
	if base == "" {
		return ""
	}
	lower := strings.ToLower(base)
	for _, suffix := range []string{
		"/v1/chat/completions",
		"/chat/completions",
		"/v1/embeddings",
		"/embeddings",
		"/v1/models",
		"/models",
		"/v1/responses",
		"/responses",
	} {
		if strings.HasSuffix(lower, suffix) {
			base = strings.TrimRight(base[:len(base)-len(suffix)], "/")
			break
		}
	}
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		base = base[:len(base)-len("/v1")]
	}
	return strings.TrimRight(base, "/")
}
