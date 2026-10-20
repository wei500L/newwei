package realtimesignals

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
)

// This file ports fetchJsonWithRetry and fetchWithIpv4Fallback. The request shape
// (method, accept header, content-type rule, form body) and the error model are
// part of the contract: the diagnostics endpoint stores lastError,
// lastErrorCode, lastErrorKind, lastErrorStatus and lastRateLimit from here.

// ipv4FallbackHosts is DEFAULT_IPV4_FALLBACK_HOSTS. Only the GDELT GKG host gets
// the one-shot IPv4 retry, exactly like NestJS.
var ipv4FallbackHosts = []string{"api.gdeltproject.org"}

// upstreamError carries the HTTP or transport failure fields the cache document
// and the diagnostics reader need.
type upstreamError struct {
	message      string
	status       int
	statusText   string
	body         string
	retryAfterMs *int64
	rateLimit    *RateLimitDetails
	code         string
	kind         string
	timedOut     bool
	aborted      bool
	// budgetRecorded is the Go equivalent of __openskyBudgetErrorRecorded.
	budgetRecorded bool
}

func (e *upstreamError) Error() string {
	if e == nil {
		return "Unknown realtime signal fetch error"
	}
	if e.message != "" {
		return e.message
	}
	return "Unknown realtime signal fetch error"
}

// httpClient holds the default client and the IPv4-only client. They are built
// once and shared by every source, matching Node's pooled agent.
type httpClient struct {
	primary *http.Client
	ipv4    *http.Client
}

func newHTTPClient() *httpClient {
	ipv4Transport := http.DefaultTransport.(*http.Transport).Clone()
	ipv4Transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		dialer := &net.Dialer{}
		return dialer.DialContext(ctx, "tcp4", address)
	}
	return &httpClient{
		primary: &http.Client{},
		ipv4:    &http.Client{Transport: ipv4Transport},
	}
}

// fetchOptions is JsonFetchOptions. RawBody replaces Body when set; NestJS never
// sends a JSON body from the collector, so Body is unused but kept for the
// documented contract.
type fetchOptions struct {
	Method        string
	Headers       map[string]string
	RawBody       string
	Body          json.RawMessage
	BeforeAttempt func(context.Context) error
	MaxRetries    *int
	ShouldRetry   func(error) bool
}

// fetchJSON issues one JSON request with the NestJS retry policy and returns the
// raw response body. Callers decode it into a typed payload.
func (c *httpClient) fetchJSON(ctx context.Context, runtime *dataruntimesettings.RealtimeCronRuntime, target string, options fetchOptions) (json.RawMessage, error) {
	timeoutMs := runtime.RequestTimeoutMs
	if timeoutMs < 1000 {
		timeoutMs = 1000
	}
	maxRetries := runtime.MaxRetries
	if options.MaxRetries != nil {
		maxRetries = *options.MaxRetries
	}
	if maxRetries < 0 {
		maxRetries = 0
	}
	method := options.Method
	if method == "" {
		method = http.MethodGet
	}

	body := options.RawBody
	hasJSONBody := false
	if body == "" && len(options.Body) > 0 {
		body = string(options.Body)
		hasJSONBody = true
	}
	headers := map[string]string{"accept": "application/json"}
	if hasJSONBody {
		headers["content-type"] = "application/json"
	}
	for key, value := range options.Headers {
		headers[key] = value
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if options.BeforeAttempt != nil {
			if err := options.BeforeAttempt(ctx); err != nil {
				return nil, err
			}
		}
		payload, err := c.attempt(ctx, target, method, headers, body, timeoutMs)
		if err == nil {
			return payload, nil
		}
		lastErr = err
		if attempt >= maxRetries {
			break
		}
		shouldRetry := shouldRetryFetchError
		if options.ShouldRetry != nil {
			shouldRetry = options.ShouldRetry
		}
		if !shouldRetry(err) {
			break
		}
		delay := 300 * (attempt + 1)
		if delay > 5000 {
			delay = 5000
		}
		sleepMillis(ctx, delay)
	}
	if lastErr == nil {
		lastErr = errors.New("Unknown fetch error")
	}
	return nil, lastErr
}

// attempt performs one request with the timeout budget and the single IPv4
// fallback for the configured hosts.
func (c *httpClient) attempt(ctx context.Context, target, method string, headers map[string]string, body string, timeoutMs int) (json.RawMessage, error) {
	payload, err := c.request(ctx, c.primary, target, method, headers, body, timeoutMs)
	if err == nil {
		return payload, nil
	}
	if ctx.Err() != nil {
		return nil, err
	}
	if !shouldRetryWithIPv4(target, err) {
		return nil, err
	}
	return c.request(ctx, c.ipv4, target, method, headers, body, timeoutMs)
}

func (c *httpClient) request(ctx context.Context, client *http.Client, target, method string, headers map[string]string, body string, timeoutMs int) (json.RawMessage, error) {
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(requestCtx, method, target, reader)
	if err != nil {
		return nil, &upstreamError{message: "fetch failed", code: codeNetworkError}
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, transportError(err, requestCtx, timeoutMs)
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if readErr != nil {
		return nil, transportError(readErr, requestCtx, timeoutMs)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		details, retryAfterMs := readRateLimitDetails(resp.Header)
		statusText := resp.Status
		if text := http.StatusText(resp.StatusCode); text != "" {
			statusText = text
		}
		return nil, &upstreamError{
			message:      "HTTP " + strconv.Itoa(resp.StatusCode) + " " + statusText,
			status:       resp.StatusCode,
			statusText:   statusText,
			body:         string(raw),
			retryAfterMs: retryAfterMs,
			rateLimit:    details,
		}
	}
	if !json.Valid(raw) {
		return nil, &upstreamError{message: "invalid JSON response body", code: codeFetchError, kind: kindUnknown}
	}
	return json.RawMessage(raw), nil
}

// transportError maps a Go transport failure onto the NestJS normalized error:
// a timeout is "Network request timed out after {timeoutMs}ms" with code
// ETIMEDOUT, every other dial/read failure is "fetch failed" with the nested
// Node error code the classifier reads.
func transportError(err error, requestCtx context.Context, timeoutMs int) error {
	timedOut := errors.Is(err, context.DeadlineExceeded) || errors.Is(requestCtx.Err(), context.DeadlineExceeded)
	if timedOut {
		return &upstreamError{
			message:  fmt.Sprintf("Network request timed out after %dms", timeoutMs),
			code:     codeRequestTimeout,
			kind:     kindTimeout,
			timedOut: true,
		}
	}
	if errors.Is(err, context.Canceled) {
		return &upstreamError{message: "This operation was aborted", code: codeRequestTimeout, kind: kindTimeout, aborted: true}
	}
	code := codeNetworkError
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		code = codeDNSResolutionFailed
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		return &upstreamError{
			message:  fmt.Sprintf("Network request timed out after %dms", timeoutMs),
			code:     codeRequestTimeout,
			kind:     kindTimeout,
			timedOut: true,
		}
	}
	return &upstreamError{message: "fetch failed", code: code, kind: kindNetwork}
}

// shouldRetryWithIPv4 mirrors shouldRetryWithIPv4: the target host must be in the
// configured set, the request must have failed for a network reason, and a caller
// cancellation is never retried.
func shouldRetryWithIPv4(target string, err error) bool {
	parsed, parseErr := url.Parse(target)
	if parseErr != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return false
	}
	matches := false
	for _, host := range ipv4FallbackHosts {
		if parsed.Hostname() == host || strings.HasSuffix(parsed.Hostname(), "."+host) {
			matches = true
			break
		}
	}
	if !matches {
		return false
	}
	var failure *upstreamError
	if errors.As(err, &failure) {
		if failure.timedOut {
			return true
		}
		return failure.code == codeNetworkError || failure.code == codeDNSResolutionFailed
	}
	return false
}

// readRateLimitDetails mirrors readRateLimitDetails. The returned pointer is nil
// when no rate-limit header is present, while retryAfterMs may still be set: that
// is exactly what the NestJS helper returns.
func readRateLimitDetails(headers http.Header) (*RateLimitDetails, *int64) {
	retryAfterRaw := normalizeHeader(headers.Get("retry-after"))
	retryAfterMs := parseRetryAfterMs(retryAfterRaw)
	retryAfterSec := (*float64)(nil)
	if retryAfterMs != nil {
		value := float64(maxInt(0, int(math.Ceil(float64(*retryAfterMs)/1000))))
		retryAfterSec = &value
	}
	details := &RateLimitDetails{
		RetryAfterSec:   retryAfterSec,
		RateLimit:       normalizeHeader(headers.Get("ratelimit")),
		RateLimitPolicy: normalizeHeader(headers.Get("ratelimit-policy")),
		CFRay:           normalizeHeader(headers.Get("cf-ray")),
	}
	if details.RetryAfterSec == nil && details.RateLimit == "" && details.RateLimitPolicy == "" && details.CFRay == "" {
		return nil, retryAfterMs
	}
	return details, retryAfterMs
}

func normalizeHeader(value string) string {
	return jsTrim(value)
}

// parseRetryAfterMs mirrors parseRetryAfterMs: a non-negative numeric value is
// seconds, otherwise the value is parsed as an HTTP date and clamped at zero.
func parseRetryAfterMs(value string) *int64 {
	normalized := normalizeHeader(value)
	if normalized == "" {
		return nil
	}
	if numeric, ok := parseJSNumber(normalized); ok && numeric >= 0 {
		millis := int64(jsRound(numeric * 1000))
		return &millis
	}
	if parsed, err := http.ParseTime(normalized); err == nil {
		millis := parsed.UnixMilli() - millisNow()
		if millis < 0 {
			millis = 0
		}
		return &millis
	}
	return nil
}

// shouldRetryFetchError mirrors shouldRetryFetchError: 408/425 retry, 429 never,
// 5xx always, and a transport message with a network keyword.
func shouldRetryFetchError(err error) bool {
	var failure *upstreamError
	if errors.As(err, &failure) {
		if failure.aborted {
			return false
		}
		if failure.status != 0 {
			if failure.status == 408 || failure.status == 425 {
				return true
			}
			if failure.status == 429 {
				return false
			}
			return failure.status >= 500
		}
		switch failure.code {
		case codeRequestTimeout, codeNetworkError, codeDNSResolutionFailed:
			return true
		default:
			return false
		}
	}
	return false
}

// diagnosticErrorDetails is toDiagnosticErrorDetails.
func diagnosticErrorDetails(err error) DiagnosticErrorDetails {
	status := readHTTPStatus(err)
	return DiagnosticErrorDetails{
		Code:    classifyUpstreamCode(err, status),
		Kind:    classifyOpenskyKind(err, status),
		Status:  status,
		Message: diagnosticErrorMessage(err, status),
	}
}

func readHTTPStatus(err error) *float64 {
	var failure *upstreamError
	if errors.As(err, &failure) && failure.status >= 100 {
		value := float64(failure.status)
		return &value
	}
	return nil
}

func classifyUpstreamCode(err error, status *float64) string {
	if status != nil {
		switch {
		case *status == 401 || *status == 403:
			return codeUpstreamAuthFailed
		case *status == 429:
			return codeUpstreamRateLimited
		case *status >= 500:
			return codeUpstreamServerError
		}
	}
	var failure *upstreamError
	if errors.As(err, &failure) {
		if failure.code != "" {
			return failure.code
		}
		if failure.timedOut {
			return codeRequestTimeout
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return codeRequestTimeout
	}
	return codeFetchError
}

func classifyOpenskyKind(err error, status *float64) string {
	if status != nil {
		switch {
		case *status == 401 || *status == 403:
			return kindAuth
		case *status == 429:
			return kindRateLimited
		case *status >= 500:
			return kindServer
		}
	}
	var failure *upstreamError
	if errors.As(err, &failure) {
		if failure.kind != "" {
			return failure.kind
		}
		if failure.timedOut {
			return kindTimeout
		}
		if failure.code == codeNetworkError || failure.code == codeDNSResolutionFailed {
			return kindNetwork
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return kindTimeout
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "oauth client credentials"),
		strings.Contains(message, "access_token"),
		strings.Contains(message, "unauthorized"),
		strings.Contains(message, "forbidden"):
		return kindAuth
	case strings.Contains(message, "429"), strings.Contains(message, "rate limit"):
		return kindRateLimited
	case strings.Contains(message, "fetch failed"), strings.Contains(message, "network"):
		return kindNetwork
	}
	return kindUnknown
}

// diagnosticErrorMessage is toDiagnosticErrorMessage for the Error instances this
// collector produces.
func diagnosticErrorMessage(err error, status *float64) string {
	if err == nil {
		return "Unknown realtime signal fetch error"
	}
	if status == nil {
		return err.Error()
	}
	return err.Error()
}

// retryAfterMillis is getRetryAfterMs.
func retryAfterMillis(err error) *int64 {
	var failure *upstreamError
	if errors.As(err, &failure) {
		return failure.retryAfterMs
	}
	return nil
}

// rateLimitDetails is getRateLimitDetails.
func rateLimitDetails(err error) *RateLimitDetails {
	var failure *upstreamError
	if errors.As(err, &failure) {
		return failure.rateLimit
	}
	return nil
}

// sleepMillis waits, but returns early when the context is cancelled.
func sleepMillis(ctx context.Context, millis int) {
	if millis <= 0 {
		return
	}
	timer := time.NewTimer(time.Duration(millis) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// bytesTrimmedEqual is used by tests to compare stored JSON while ignoring
// insignificant whitespace.
func bytesTrimmedEqual(left, right []byte) bool {
	return bytes.Equal(bytes.TrimSpace(left), bytes.TrimSpace(right))
}
