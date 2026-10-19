package crawl4ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// maxResponseBytes bounds how much of a /crawl response is decoded. The NestJS
// client has no explicit cap, but the response only ever carries markdown and
// links, so an unbounded read would be a memory risk without adding fidelity.
const maxResponseBytes = 32 << 20

// maxIdleConnsPerHost keeps the keep-alive pool at least as large as the
// discovery chain's widest fan-out (deep discovery pageConcurrency <= 6, list
// discovery listPageConcurrency <= 5, head fetches <= 5). The pool is shared by
// every caller of one client instance.
const maxIdleConnsPerHost = 50

// Settings is the crawl client settings subset the client needs. It is loaded
// from the shared crawl_client:settings cache/SystemSetting row by the caller so
// one request reads it once.
type Settings struct {
	// RequestTimeoutNormalMs is requestTimeoutNormalMs with the legacy
	// requestTimeoutMs alias already resolved.
	RequestTimeoutNormalMs int
	// HealthCheckTTLMs is healthCheckTtlMs.
	HealthCheckTTLMs int
}

// DefaultSettings mirrors the NestJS fallbacks (CRAWL4AI_TIMEOUT_MS-based
// 120s request timeout and a 60s health check TTL).
func DefaultSettings() Settings {
	return Settings{RequestTimeoutNormalMs: 120_000, HealthCheckTTLMs: 60_000}
}

// Client is a crawl4ai /crawl client. It is safe for concurrent use.
type Client struct {
	options    Options
	httpClient *http.Client

	// mu also serializes the health probe: concurrent crawls that arrive after
	// the TTL expires wait for the single in-flight probe instead of each
	// issuing their own GET /health. The TTL and failure semantics are
	// unchanged (O3).
	mu              sync.Mutex
	lastHealthCheck int64
	hasHealthCheck  bool
}

// New builds a client. An empty BaseURL yields a client whose Crawl calls fail
// with a connection-style error, which the discovery chain reports the same way
// as an unreachable service.
func New(options Options) *Client {
	httpClient := options.HTTPClient
	if httpClient == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConnsPerHost = maxIdleConnsPerHost
		transport.MaxIdleConns = maxIdleConnsPerHost * 2
		httpClient = &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Client{options: options, httpClient: httpClient}
}

// Configured reports whether the client has a base URL.
func (c *Client) Configured() bool {
	return c != nil && c.options.Configured()
}

// BaseURL returns the configured base URL (without trailing slash).
func (c *Client) BaseURL() string {
	if c == nil {
		return ""
	}
	return c.options.BaseURL
}

func (c *Client) now() int64 {
	if c.options.Now != nil {
		return c.options.Now()
	}
	return time.Now().UnixMilli()
}

// Crawl posts one URL to /crawl and normalizes the response. The returned error
// is always a *Error when the failure can be attributed to the request or the
// service.
func (c *Client) Crawl(ctx context.Context, request CrawlRequest, settings Settings) (Response, error) {
	timeoutMs := resolveRequestTimeout(request.RequestTimeoutMs, settings)
	if err := c.ensureHealthy(ctx, settings); err != nil {
		return Response{}, err
	}
	target := strings.TrimSpace(request.URL)
	if err := c.validateRequestURLs(ctx, []string{target}); err != nil {
		return Response{}, err
	}

	payload, err := buildPayload(request, c.options.SSRFProxyURL, c.options.JSCodeEnabled)
	if err != nil {
		return Response{}, err
	}
	response, err := c.send(ctx, payload, timeoutMs)
	if err == nil {
		return response, nil
	}

	resolvedError := err
	resolvedPayload := payload
	if compatibility, ok := prefetchCompatibilityPayload(payload, err); ok {
		retried, retryErr := c.send(ctx, compatibility, timeoutMs)
		if retryErr == nil {
			retried.SystemEvents = append(retried.SystemEvents, SystemEvent{
				Level:         "warn",
				EventType:     "prefetch_compatibility_fallback",
				Message:       "crawl4ai server rejected prefetch; retried without prefetch",
				TriggerReason: stringPtr("prefetch_incompatible"),
				BeforeCount:   intPtr(1),
				AfterCount:    intPtr(1),
				RescuedCount:  intPtr(1),
				Details:       rawObject(map[string]string{"requestUrl": target, "fallbackMode": "disable_prefetch"}),
				Timestamp:     nestNow(c.now()),
			})
			return retried, nil
		}
		resolvedError = retryErr
		resolvedPayload = compatibility
	}

	if fallback, ok := scanFullPageFallbackPayload(request, resolvedPayload, resolvedError); ok {
		retried, retryErr := c.send(ctx, fallback, timeoutMs)
		if retryErr == nil {
			triggerReason := "scan_full_page_failure"
			if isTimeoutError(resolvedError) {
				triggerReason = "scan_full_page_timeout"
			}
			retried.SystemEvents = append(retried.SystemEvents, SystemEvent{
				Level:         "warn",
				EventType:     "scan_full_page_virtual_scroll_fallback",
				Message:       "scanFullPage failed or timed out; retried with bounded virtualScroll",
				TriggerReason: &triggerReason,
				BeforeCount:   intPtr(1),
				AfterCount:    intPtr(1),
				RescuedCount:  intPtr(1),
				Details:       rawObject(map[string]string{"requestUrl": target, "fallbackMode": "bounded_virtual_scroll"}),
				Timestamp:     nestNow(c.now()),
			})
			return retried, nil
		}
		resolvedError = retryErr
	}

	return Response{}, classifyError(request, resolvedError, timeoutMs)
}

func resolveRequestTimeout(override int, settings Settings) int {
	if override > 0 {
		return maxInt(1000, override)
	}
	timeout := settings.RequestTimeoutNormalMs
	if timeout <= 0 {
		timeout = DefaultSettings().RequestTimeoutNormalMs
	}
	return maxInt(1000, timeout)
}

// ensureHealthy mirrors ensureHealthy: GET /health at most once per
// healthCheckTtlMs per process, with concurrent probes merged into one. A failed
// probe fails the crawl with the NestJS message and no status.
func (c *Client) ensureHealthy(ctx context.Context, settings Settings) error {
	ttl := settings.HealthCheckTTLMs
	if ttl <= 0 {
		ttl = DefaultSettings().HealthCheckTTLMs
	}
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hasHealthCheck && now-c.lastHealthCheck < int64(ttl) {
		return nil
	}

	healthTimeoutMs := settings.RequestTimeoutNormalMs
	if healthTimeoutMs <= 0 {
		healthTimeoutMs = DefaultSettings().RequestTimeoutNormalMs
	}
	healthTimeoutMs = maxInt(1000, healthTimeoutMs)
	healthCtx, cancel := context.WithTimeout(ctx, time.Duration(healthTimeoutMs)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(healthCtx, http.MethodGet, c.options.BaseURL+"/health", nil)
	if err != nil {
		return newError(0, "crawl4ai health check failed")
	}
	c.applyHeaders(request)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return newError(0, "crawl4ai health check failed")
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return newError(0, "crawl4ai health check failed")
	}

	c.lastHealthCheck = now
	c.hasHealthCheck = true
	return nil
}

func (c *Client) applyHeaders(request *http.Request) {
	request.Header.Set("content-type", "application/json")
	if c.options.APIKey != "" {
		request.Header.Set("x-api-key", c.options.APIKey)
	}
}

// validateRequestURLs applies the shared SSRF rules to every target before the
// request is issued. newssources.ValidateOutboundTargetURL performs both the
// synchronous rule check and the DNS-backed re-check, matching the NestJS
// validateRequestUrls pair.
func (c *Client) validateRequestURLs(ctx context.Context, targets []string) error {
	for _, target := range targets {
		reason, ok := newssources.ValidateOutboundTargetURL(ctx, target)
		if ok {
			continue
		}
		if reason == "" {
			reason = "URL is not safe (potential SSRF vulnerability)"
		}
		return newError(http.StatusBadRequest, "URL blocked by SSRF protection: "+reason)
	}
	return nil
}

func (c *Client) send(ctx context.Context, payload httpPayload, timeoutMs int) (Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return Response{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, c.options.BaseURL+"/crawl", bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	c.applyHeaders(request)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return Response{}, err
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return Response{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Response{}, &httpStatusError{status: response.StatusCode, body: data}
	}
	return normalizeResponse(data)
}

// httpStatusError carries a non-2xx response so the classifier can include the
// upstream status and the server-provided message.
type httpStatusError struct {
	status int
	body   []byte
}

func (e *httpStatusError) Error() string {
	return "Request failed with status code " + parseStatusText(&e.status)
}

func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}

// classifyError builds the Crawl4aiRequestException-equivalent error: a timeout
// is 408 with the elapsed budget and the scanFullPage/image hints, any other
// failure keeps the upstream status (or no status for connection failures) and
// appends the display/proxy hints.
func classifyError(request CrawlRequest, err error, timeoutMs int) error {
	if isTimeoutError(err) {
		message := "crawl4ai request timed out after " + itoa(timeoutMs) + "ms"
		requestURL := strings.TrimSpace(request.URL)
		hints := []string{}
		if request.Options.ScanFullPage {
			hints = append(hints,
				"Hint: scanFullPage can hang on infinite-scroll pages. Consider disabling scanFullPage or switching to virtualScroll (bounded scrollCount).")
		}
		if request.Options.WaitForImages || request.Options.IncludeImages || request.Options.StoreMedia {
			hints = append(hints,
				"Hint: images/media extraction can slow down crawling. Consider disabling waitForImages/includeImages/storeMedia or increasing CRAWL4AI_TIMEOUT_MS.")
		}
		prefix := ""
		if requestURL != "" {
			prefix = requestURL + ": "
		}
		messageWithHint := prefix + message
		if len(hints) > 0 {
			messageWithHint += "\n" + strings.Join(hints, "\n")
		}
		return newError(http.StatusRequestTimeout, messageWithHint)
	}

	var statusErr *httpStatusError
	status := 0
	parts := []string{}
	if errors.As(err, &statusErr) {
		status = statusErr.status
		parts = append(parts, messageFromPayload(statusErr.body)...)
	}
	fallback := strings.TrimSpace(err.Error())
	if fallback == "" {
		fallback = "crawl4ai request failed"
	}
	parts = append(parts, fallback)
	message := strings.Join(nonEmpty(parts), "\n")
	if status != 0 {
		message += "\n(status " + itoa(status) + ")"
	}

	normalized := strings.ToLower(message)
	hints := []string{}
	if strings.Contains(normalized, "cannot open display") ||
		strings.Contains(normalized, "missing x server") ||
		strings.Contains(normalized, "xvfb") ||
		(strings.Contains(normalized, "x11") && strings.Contains(normalized, "display")) {
		hints = append(hints,
			"Hint: crawl4ai may be running with headless=false. Ensure Xvfb/DISPLAY is configured (see infra/docker/docker-compose.yml) or set crawlOptions.headless=true.")
	}
	if strings.Contains(normalized, "err_proxy_connection_failed") ||
		strings.Contains(normalized, "proxy_connection_failed") ||
		strings.Contains(normalized, "proxy connection failed") ||
		(strings.Contains(normalized, "proxy") && strings.Contains(normalized, "connection failed")) {
		hints = append(hints,
			"Hint: crawl4ai failed to connect to the configured proxy. If the proxy is on the Docker host, use host.docker.internal (e.g. http://host.docker.internal:7890) instead of 127.0.0.1/localhost.")
	}
	if len(hints) > 0 {
		message += "\n" + strings.Join(hints, "\n")
	}
	return newError(status, message)
}

// messageFromPayload mirrors messageFromPayload: a string body, or the first of
// message/detail/error on an object body.
func messageFromPayload(body []byte) []string {
	trimmedBody := bytes.TrimSpace(body)
	if len(trimmedBody) == 0 {
		return nil
	}
	if trimmedBody[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmedBody, &text); err == nil {
			if message := strings.TrimSpace(text); message != "" {
				return []string{message}
			}
		}
		return nil
	}
	if trimmedBody[0] != '{' {
		return nil
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(trimmedBody, &record); err != nil {
		return nil
	}
	for _, key := range []string{"message", "detail", "error"} {
		raw, ok := record[key]
		if !ok {
			continue
		}
		if message := normalizeMessageRaw(raw); message != "" {
			return []string{message}
		}
	}
	return nil
}

func normalizeMessageRaw(raw json.RawMessage) string {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err == nil {
		parts := []string{}
		for _, item := range list {
			var entry string
			if err := json.Unmarshal(item, &entry); err == nil {
				if trimmed := strings.TrimSpace(entry); trimmed != "" {
					parts = append(parts, trimmed)
				}
			}
		}
		return strings.Join(parts, "; ")
	}
	return ""
}

// prefetchCompatibilityPayload drops `prefetch` when the server rejects it as an
// unexpected keyword argument.
func prefetchCompatibilityPayload(payload httpPayload, err error) (httpPayload, bool) {
	if !isPrefetchCompatibilityError(err) {
		return httpPayload{}, false
	}
	params, ok := payload.CrawlerConf.Params.(crawlerParams)
	if !ok || params.Prefetch == nil {
		return httpPayload{}, false
	}
	params.Prefetch = nil
	payload.CrawlerConf.Params = params
	return payload, true
}

func isPrefetchCompatibilityError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	if statusErr, ok := err.(*httpStatusError); ok {
		text += "\n" + strings.ToLower(string(statusErr.body))
	}
	return strings.Contains(text, "unexpected keyword argument") && strings.Contains(text, "prefetch")
}

// scanFullPageFallbackPayload rebuilds the payload with scan_full_page disabled
// and a bounded virtualScroll, mirroring buildScanFullPageFallbackPayload.
func scanFullPageFallbackPayload(request CrawlRequest, payload httpPayload, err error) (httpPayload, bool) {
	if !request.Options.ScanFullPage || request.Options.VirtualScroll != nil {
		return httpPayload{}, false
	}
	params, ok := payload.CrawlerConf.Params.(crawlerParams)
	if !ok || params.ScanFullPage == nil || !*params.ScanFullPage || params.VirtualScrollConfig != nil {
		return httpPayload{}, false
	}
	if !isTimeoutError(err) {
		text := strings.ToLower(err.Error())
		if statusErr, ok := err.(*httpStatusError); ok {
			text += "\n" + strings.ToLower(string(statusErr.body))
		}
		switch {
		case strings.Contains(text, "timeout"), strings.Contains(text, "timed out"),
			strings.Contains(text, "execution context was destroyed"),
			strings.Contains(text, "target closed"):
		default:
			return httpPayload{}, false
		}
	}

	sourceScrollDelay := 0.35
	if params.ScrollDelay != nil {
		sourceScrollDelay = *params.ScrollDelay
	}
	waitAfterScroll := roundTo(mathMax(0.2, mathMin(2.5, sourceScrollDelay+0.15)), 2)
	scrollCount := 24
	if scroll := request.Options.VirtualScroll; scroll != nil && scroll.ScrollCount != nil {
		scrollCount = maxInt(4, minInt(60, *scroll.ScrollCount))
	}

	params.ScanFullPage = boolPtr(false)
	params.ScrollDelay = nil
	params.VirtualScrollConfig = &component{Type: "VirtualScrollConfig", Params: virtualScrollParams{
		ContainerSelector: "body",
		ScrollCount:       intPtr(scrollCount),
		ScrollBy:          stringPtr("page_height"),
		WaitAfterScroll:   &waitAfterScroll,
	}}
	if params.AdjustViewportToContent == nil {
		params.AdjustViewportToContent = boolPtr(true)
	}
	if params.WaitUntil == "" || params.WaitUntil == "networkidle" {
		params.WaitUntil = "domcontentloaded"
	}
	if params.WaitForTimeout == nil {
		params.WaitForTimeout = intPtr(8000)
	} else {
		params.WaitForTimeout = intPtr(clampInt(*params.WaitForTimeout, 3000, 12000))
	}
	if params.PageTimeout == nil {
		params.PageTimeout = intPtr(45000)
	} else {
		params.PageTimeout = intPtr(clampInt(*params.PageTimeout, 15000, 90000))
	}
	payload.CrawlerConf.Params = params
	return payload, true
}

func nonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

func rawObject(value map[string]string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func stringPtr(value string) *string { return &value }

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
