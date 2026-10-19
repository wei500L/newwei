package newsnowsources

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// browserUserAgent is the myFetch default header. Providers that pass their own
// User-Agent override it, exactly like ofetch's header merge.
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// retryStatusCodes mirrors ofetch's default set. Together with network failures
// these are retried up to myFetch's `retry: 3` (four attempts total).
var retryStatusCodes = map[int]struct{}{
	http.StatusRequestTimeout:      {},
	http.StatusConflict:            {},
	http.StatusTooEarly:            {},
	http.StatusTooManyRequests:     {},
	http.StatusInternalServerError: {},
	http.StatusBadGateway:          {},
	http.StatusServiceUnavailable:  {},
	http.StatusGatewayTimeout:      {},
}

// fetchClient is the single outbound HTTP client of the source unit. One
// transport is shared across providers; no provider adds its own retry layer.
type fetchClient struct {
	client *http.Client
}

// newFetchClient mirrors myFetch: 10 second timeout per attempt and three
// retries.
func newFetchClient() *fetchClient {
	return &fetchClient{client: &http.Client{Timeout: 10 * time.Second}}
}

// closeIdleConnections releases pooled upstream connections at shutdown.
func (c *fetchClient) closeIdleConnections() {
	if c != nil && c.client != nil {
		c.client.CloseIdleConnections()
	}
}

// fetchSpec is one upstream request. JSONBody asks the client to apply ofetch's
// automatic content-type/accept headers for a serialised object body.
type fetchSpec struct {
	Method   string
	URL      string
	Headers  map[string]string
	JSONBody []byte
}

// fetchStatusError carries the upstream status so callers can keep <500
// HttpExceptions and wrap everything else.
type fetchStatusError struct {
	Method string
	URL    string
	Status int
}

// Error mirrors the FetchError message shape closely enough for the 502 detail.
func (e *fetchStatusError) Error() string {
	return fmt.Sprintf("[%s] %q: %d %s", e.Method, e.URL, e.Status, http.StatusText(e.Status))
}

// do executes one request with the ofetch retry policy and returns the body.
func (c *fetchClient) do(ctx context.Context, spec fetchSpec) ([]byte, error) {
	return c.doWithAttempts(ctx, spec, 4)
}

// doWithAttempts runs the request, retrying network errors and retryable
// statuses while attempts remain.
func (c *fetchClient) doWithAttempts(ctx context.Context, spec fetchSpec, attempts int) ([]byte, error) {
	method := spec.Method
	if method == "" {
		method = http.MethodGet
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		body, _, err := c.once(ctx, method, spec)
		if err == nil {
			return body, nil
		}
		lastErr = err
		retryable := true
		var statusErr *fetchStatusError
		if errors.As(err, &statusErr) {
			_, retryable = retryStatusCodes[statusErr.Status]
		}
		if !retryable || attempt == attempts-1 {
			break
		}
	}
	return nil, lastErr
}

// once performs a single attempt.
func (c *fetchClient) once(ctx context.Context, method string, spec fetchSpec) ([]byte, int, error) {
	var reader io.Reader
	if spec.JSONBody != nil {
		reader = bytes.NewReader(spec.JSONBody)
	}
	request, err := http.NewRequestWithContext(ctx, method, spec.URL, reader)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("User-Agent", browserUserAgent)
	for key, value := range spec.Headers {
		request.Header.Set(key, value)
	}
	if spec.JSONBody != nil {
		if request.Header.Get("Content-Type") == "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if request.Header.Get("Accept") == "" {
			request.Header.Set("Accept", "application/json")
		}
	}

	response, err := c.client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, response.StatusCode, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response.StatusCode, &fetchStatusError{Method: method, URL: spec.URL, Status: response.StatusCode}
	}
	return body, response.StatusCode, nil
}

// rawCookies performs the `$fetch.raw(...).headers.getSetCookie()` call used by
// the Douyin and Xueqiu cookie bootstrap. It deliberately does not use the
// myFetch wrapper: no browser User-Agent, no retries, and the raw Set-Cookie
// values are joined with "; " exactly like the original code.
func (c *fetchClient) rawCookies(ctx context.Context, url string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "node")
	response, err := c.client.Do(request)
	if err != nil {
		return "", err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return "", &fetchStatusError{Method: http.MethodGet, URL: url, Status: response.StatusCode}
	}
	return strings.Join(response.Header.Values("Set-Cookie"), "; "), nil
}

// get performs a GET with optional headers.
func (c *fetchClient) get(ctx context.Context, url string, headers map[string]string) ([]byte, error) {
	return c.do(ctx, fetchSpec{Method: http.MethodGet, URL: url, Headers: headers})
}

// postJSON performs a POST whose body is already serialised JSON.
func (c *fetchClient) postJSON(ctx context.Context, url string, headers map[string]string, body []byte) ([]byte, error) {
	return c.do(ctx, fetchSpec{Method: http.MethodPost, URL: url, Headers: headers, JSONBody: body})
}
