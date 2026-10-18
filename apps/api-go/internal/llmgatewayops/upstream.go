package llmgatewayops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// This file is the outbound HTTP layer shared by the LiteLLM management calls
// and the model probes. It mirrors the axios behaviour the NestJS service relies
// on: a JSON body, an Authorization header only when a key is configured, a
// per-request deadline, and the 404/405-only short-path fallback.

// upstreamResponse is one completed exchange.
type upstreamResponse struct {
	status int
	header http.Header
	body   []byte
}

// upstreamError reports a failed exchange. status is 0 when no HTTP response was
// received at all (DNS failure, refused connection, timeout), which is what maps
// onto the 503 branch of the diagnostic error contract.
type upstreamError struct {
	status     int
	statusText string
	code       string
	detail     string
	message    string
	requestID  string
	body       []byte
}

// Error implements the error interface.
func (e *upstreamError) Error() string {
	if e == nil {
		return "llm gateway request failed"
	}
	if e.status != 0 {
		return fmt.Sprintf("upstream responded with HTTP %d", e.status)
	}
	if e.message != "" {
		return e.message
	}
	return "upstream request failed"
}

// upstreamClient is one base URL plus the timeout and credential to use.
type upstreamClient struct {
	baseURL string
	apiKey  string
	timeout time.Duration
	http    *http.Client
}

// newUpstreamClient normalizes nothing: the caller passes the already normalized
// base. A non-positive timeout means "no client deadline beyond the request
// context".
func newUpstreamClient(httpClient *http.Client, baseURL, apiKey string, timeout time.Duration) upstreamClient {
	return upstreamClient{baseURL: baseURL, apiKey: apiKey, timeout: timeout, http: httpClient}
}

// endpoint joins the base URL and one request path. The trailing slashes of the
// base are stripped first because axios combineURLs does the same: the management
// client receives the raw stored apiBase, which may legitimately end with "/", and
// a plain concatenation would then request "//team/update".
func (c upstreamClient) endpoint(path string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(c.baseURL), "/")
	if base == "" {
		return "", errors.New("llmgatewayops: apiBase is not configured")
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path, nil
}

// get performs one GET.
func (c upstreamClient) get(ctx context.Context, path string) (upstreamResponse, error) {
	return c.do(ctx, http.MethodGet, path, nil)
}

// postBody performs one POST with an already marshalled JSON body. Callers
// marshal their own named payload type, so no loosely typed body crosses this
// boundary.
func (c upstreamClient) postBody(ctx context.Context, path string, body []byte) (upstreamResponse, error) {
	return c.do(ctx, http.MethodPost, path, body)
}

// getWithFallback retries the short path ONLY on 404/405. Every other failure,
// including 401/429/5xx, is returned unchanged: a diagnostic must not silently
// change its request in order to look successful.
func (c upstreamClient) getWithFallback(ctx context.Context, primary, fallback string) (upstreamResponse, error) {
	return c.withFallback(ctx, func() (upstreamResponse, error) {
		return c.get(ctx, primary)
	}, func() (upstreamResponse, error) {
		return c.get(ctx, fallback)
	})
}

// postBodyWithFallback is the POST equivalent of getWithFallback. The same body
// bytes are sent again, so the retry can never become a different request.
func (c upstreamClient) postBodyWithFallback(ctx context.Context, primary, fallback string, body []byte) (upstreamResponse, error) {
	return c.withFallback(ctx, func() (upstreamResponse, error) {
		return c.postBody(ctx, primary, body)
	}, func() (upstreamResponse, error) {
		return c.postBody(ctx, fallback, body)
	})
}

// withFallback runs primary and then fallback when primary failed with a 404 or
// a 405.
func (c upstreamClient) withFallback(ctx context.Context, primary, fallback func() (upstreamResponse, error)) (upstreamResponse, error) {
	response, err := primary()
	if err == nil {
		return response, nil
	}
	var upstream *upstreamError
	if errors.As(err, &upstream) && isFallbackStatus(upstream.status) {
		return fallback()
	}
	return upstreamResponse{}, err
}

// isFallbackStatus reports whether the short path should be tried.
func isFallbackStatus(status int) bool {
	return status == http.StatusNotFound || status == http.StatusMethodNotAllowed
}

// do performs one exchange and converts a non-2xx status into an upstreamError.
// body is nil for a GET and the already marshalled payload for a POST.
func (c upstreamClient) do(ctx context.Context, method, path string, body []byte) (upstreamResponse, error) {
	target, err := c.endpoint(path)
	if err != nil {
		return upstreamResponse{}, err
	}
	if _, parseErr := url.Parse(target); parseErr != nil {
		return upstreamResponse{}, &upstreamError{message: "apiBase is not a valid URL"}
	}

	var payload io.Reader
	if body != nil {
		payload = bytes.NewReader(body)
	}

	requestCtx := ctx
	if c.timeout > 0 {
		var cancel context.CancelFunc
		requestCtx, cancel = context.WithTimeout(ctx, c.timeout)
		defer cancel()
	}
	request, err := http.NewRequestWithContext(requestCtx, method, target, payload)
	if err != nil {
		return upstreamResponse{}, &upstreamError{message: err.Error()}
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key := strings.TrimSpace(c.apiKey); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	// The default axios Accept header: an upstream that content-negotiates must see
	// the same first choice the NestJS client sends.
	request.Header.Set("Accept", "application/json, text/plain, */*")

	response, err := c.http.Do(request)
	if err != nil {
		return upstreamResponse{}, classifyTransportError(requestCtx, err, c.timeout)
	}
	defer func() { _ = response.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, maxUpstreamBodyBytes))
	if readErr != nil {
		return upstreamResponse{}, classifyTransportError(requestCtx, readErr, c.timeout)
	}
	result := upstreamResponse{status: response.StatusCode, header: response.Header, body: raw}
	if response.StatusCode >= 200 && response.StatusCode <= 299 {
		return result, nil
	}
	statusText := strings.TrimSpace(strings.TrimPrefix(response.Status, fmt.Sprintf("%d ", response.StatusCode)))
	requestID := extractRequestID(response.Header)
	if requestID == "" {
		requestID = extractRequestIDFromBody(raw)
	}
	return upstreamResponse{}, &upstreamError{
		status:     response.StatusCode,
		statusText: statusText,
		detail:     extractUpstreamDetail(raw, response.StatusCode, statusText),
		requestID:  requestID,
		body:       raw,
	}
}

// maxUpstreamBodyBytes caps what one upstream response may consume. A gateway
// error page must never be able to exhaust memory.
const maxUpstreamBodyBytes = 4 << 20

// timeoutErrorCode is the axios class for a request that exceeded its deadline.
const timeoutErrorCode = "ECONNABORTED"

// classifyTransportError maps a transport failure onto the axios error shape: a
// deadline yields the timeout class, anything else keeps the Go message and no
// status. Neither case is retried.
//
// The text is also stored as the detail, because the diagnostic message is built
// from the detail: without it a connection failure would surface as a bare
// "LLM gateway request failed" instead of naming the reason the way the axios
// error message does in the source.
func classifyTransportError(ctx context.Context, err error, timeout time.Duration) error {
	text := err.Error()
	code := ""
	if ctx != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		text = fmt.Sprintf("timeout of %dms exceeded", timeout.Milliseconds())
		code = timeoutErrorCode
	}
	return &upstreamError{code: code, message: text, detail: sanitizeUpstreamErrorText(text, 500)}
}

// upstreamEnvelope is the tolerant decode boundary of an upstream error body.
// Every field stays a raw token so nested shapes are inspected without widening
// the payload into an untyped container.
type upstreamEnvelope struct {
	Error            json.RawMessage `json:"error"`
	Message          json.RawMessage `json:"message"`
	Detail           json.RawMessage `json:"detail"`
	ErrorDescription json.RawMessage `json:"error_description"`
	Type             json.RawMessage `json:"type"`
	Code             json.RawMessage `json:"code"`
	ErrorType        json.RawMessage `json:"error_type"`
	ErrorCode        json.RawMessage `json:"error_code"`
	RequestID        json.RawMessage `json:"request_id"`
	RequestIDCamel   json.RawMessage `json:"requestId"`
	Title            json.RawMessage `json:"title"`
	StatusText       json.RawMessage `json:"statusText"`
}

// secretPatterns redact the two credential shapes that can appear in an upstream
// error text before it reaches a response body or a log.
var (
	bearerSecretPattern = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._-]+`)
	openAIKeyPattern    = regexp.MustCompile(`\bsk-[A-Za-z0-9]{10,}\b`)
	requestIDPattern    = regexp.MustCompile(`(?i)request\s*id\s*[:=]\s*([A-Za-z0-9._-]{6,})`)
)

// redactSensitiveText removes bearer tokens and OpenAI-style keys.
func redactSensitiveText(value string) string {
	redacted := bearerSecretPattern.ReplaceAllString(value, "Bearer [REDACTED]")
	return openAIKeyPattern.ReplaceAllString(redacted, "sk-[REDACTED]")
}

// sanitizeUpstreamErrorText redacts and truncates one upstream text. An empty or
// non-text value becomes "".
func sanitizeUpstreamErrorText(value string, maxLength int) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if maxLength < 64 {
		maxLength = 500
	}
	redacted := redactSensitiveText(trimmed)
	if jsLength(redacted) <= maxLength {
		return redacted
	}
	return truncateUTF16(redacted, maxLength) + "…"
}

// extractUpstreamDetail mirrors extractAxiosDetail: the response body first, then
// the status text, then the transport message. Generic axios placeholders are
// dropped so the caller can fall back to its own message.
func extractUpstreamDetail(body []byte, status int, statusText string) string {
	if detail := normalizeDetail(extractDetailFromBody(body), status); detail != "" {
		return sanitizeUpstreamErrorText(detail, 500)
	}
	if detail := normalizeDetail(statusText, status); detail != "" {
		return sanitizeUpstreamErrorText(detail, 500)
	}
	return ""
}

// extractDetailFromBody mirrors extractDetailFromResponseData.
func extractDetailFromBody(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return ""
		}
		return strings.TrimSpace(text)
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return ""
		}
		messages := make([]string, 0, len(items))
		for _, item := range items {
			if text, ok := jsonStringValue(item); ok {
				if text = strings.TrimSpace(text); text != "" {
					messages = append(messages, text)
				}
			}
		}
		return strings.Join(messages, "; ")
	case '{':
		var envelope upstreamEnvelope
		if err := json.Unmarshal(trimmed, &envelope); err != nil {
			return ""
		}
		for _, candidate := range []json.RawMessage{envelope.Error, envelope.Message, envelope.Detail, envelope.ErrorDescription} {
			if text := messageLike(candidate); text != "" {
				return text
			}
		}
		return string(trimmed)
	default:
		return strings.TrimSpace(string(trimmed))
	}
}

// messageLike mirrors extractMessageLike for one raw JSON value.
func messageLike(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	switch trimmed[0] {
	case '"':
		text, ok := jsonStringValue(trimmed)
		if !ok {
			return ""
		}
		return strings.TrimSpace(text)
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return ""
		}
		messages := make([]string, 0, len(items))
		for _, item := range items {
			if text, ok := jsonStringValue(item); ok {
				if text = strings.TrimSpace(text); text != "" {
					messages = append(messages, text)
				}
			}
		}
		return strings.Join(messages, "; ")
	case '{':
		var envelope upstreamEnvelope
		if err := json.Unmarshal(trimmed, &envelope); err != nil {
			return ""
		}
		for _, candidate := range []json.RawMessage{envelope.Message, envelope.Detail, envelope.Error, envelope.Title, envelope.StatusText} {
			if text := messageLike(candidate); text != "" {
				return text
			}
		}
		return string(trimmed)
	default:
		return ""
	}
}

// jsonStringValue decodes one raw JSON token when it is a string.
func jsonStringValue(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// normalizeDetail drops the placeholders axios itself produces so the caller
// falls back to a meaningful message.
func normalizeDetail(detail string, status int) string {
	trimmed := strings.TrimSpace(detail)
	if trimmed == "" {
		return ""
	}
	switch trimmed {
	case "{}", "[]", "[object Object]":
		return ""
	}
	if isGenericAxiosErrorCode(trimmed) {
		return ""
	}
	if status != 0 && strings.EqualFold(trimmed, fmt.Sprintf("Request failed with status code %d", status)) {
		return ""
	}
	return trimmed
}

// isGenericAxiosErrorCode reports the axios error classes that carry no
// information for a human.
func isGenericAxiosErrorCode(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	if trimmed == "ERR_BAD_REQUEST" || trimmed == "ERR_BAD_RESPONSE" {
		return true
	}
	return genericAxiosCodePattern.MatchString(trimmed)
}

// genericAxiosCodePattern is /^ERR_[A-Z_]+$/.
var genericAxiosCodePattern = regexp.MustCompile(`^ERR_[A-Z_]+$`)

// extractRequestID reads the request id from the response headers the upstream
// families actually use.
func extractRequestID(header http.Header) string {
	candidates := []string{
		"x-request-id",
		"openai-request-id",
		"x-openai-request-id",
		"x-correlation-id",
		"x-amzn-requestid",
		"x-amzn-request-id",
		"x-amz-request-id",
	}
	for _, name := range candidates {
		if value := strings.TrimSpace(header.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

// extractRequestIDFromBody reads the request id the upstream echoed in its error
// payload.
func extractRequestIDFromBody(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}
	if trimmed[0] != '{' {
		return requestIDFromText(string(trimmed))
	}
	var envelope upstreamEnvelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return ""
	}
	for _, candidate := range []json.RawMessage{envelope.RequestID, envelope.RequestIDCamel} {
		if text, ok := jsonStringValue(candidate); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	var nested upstreamEnvelope
	if len(envelope.Error) > 0 && bytes.TrimSpace(envelope.Error)[0] == '{' {
		if err := json.Unmarshal(envelope.Error, &nested); err == nil {
			for _, candidate := range []json.RawMessage{nested.RequestID, nested.RequestIDCamel} {
				if text, ok := jsonStringValue(candidate); ok && strings.TrimSpace(text) != "" {
					return strings.TrimSpace(text)
				}
			}
		}
	}
	for _, candidate := range []json.RawMessage{envelope.Error, envelope.Message} {
		if text := requestIDFromText(messageLike(candidate)); text != "" {
			return text
		}
	}
	return ""
}

// requestIDFromText extracts a documented "request id: ..." occurrence.
func requestIDFromText(value string) string {
	if value == "" {
		return ""
	}
	match := requestIDPattern.FindStringSubmatch(value)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

// upstreamErrorMeta is the upstream type/code pair echoed in the error payload.
type upstreamErrorMeta struct {
	upstreamType string
	upstreamCode string
}

// extractUpstreamErrorMeta mirrors extractUpstreamErrorMeta.
func extractUpstreamErrorMeta(body []byte) upstreamErrorMeta {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return upstreamErrorMeta{}
	}
	var envelope upstreamEnvelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return upstreamErrorMeta{}
	}
	var nested upstreamEnvelope
	if len(envelope.Error) > 0 && bytes.TrimSpace(envelope.Error)[0] == '{' {
		if err := json.Unmarshal(envelope.Error, &nested); err == nil {
			// nested holds the OpenAI-style error object.
		}
	}
	upstreamType := firstNonEmpty(
		rawString(nested.Type), rawString(envelope.Type), rawString(envelope.ErrorType),
	)
	upstreamCode := firstNonEmpty(
		rawString(nested.Code), rawString(envelope.Code), rawString(envelope.ErrorCode),
	)
	return upstreamErrorMeta{upstreamType: upstreamType, upstreamCode: upstreamCode}
}

// rawString decodes one raw token when it is a non-empty string.
func rawString(raw json.RawMessage) string {
	text, ok := jsonStringValue(raw)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// firstNonEmpty returns the first non-empty candidate.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
