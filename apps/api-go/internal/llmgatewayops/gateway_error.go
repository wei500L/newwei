package llmgatewayops

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// This file reproduces apps/api/src/common/llm-openai-compat.ts plus the
// toGatewayErrorInfo / throwGatewayError pair of the gateway test service. The
// compatibility codes are part of the console contract: folding every upstream
// rejection into one generic 500 would hide whether the gateway rejected
// metadata, response_format, the JSON schema or the whole Responses API.

// Compatibility error codes.
const (
	// compatibilityUnsupportedMetadata is an upstream rejection of metadata.
	compatibilityUnsupportedMetadata = "UNSUPPORTED_METADATA"
	// compatibilityUnsupportedResponseFormat is a rejection of response_format.
	compatibilityUnsupportedResponseFormat = "UNSUPPORTED_RESPONSE_FORMAT"
	// compatibilityUnsupportedJSONSchema is a rejection of a JSON schema.
	compatibilityUnsupportedJSONSchema = "UNSUPPORTED_JSON_SCHEMA"
	// compatibilityInvalidMessageContent is a rejection of the message shape.
	compatibilityInvalidMessageContent = "INVALID_MESSAGE_CONTENT"
	// compatibilityResponsesAPIUnsupported is a gateway without /responses.
	compatibilityResponsesAPIUnsupported = "RESPONSES_API_UNSUPPORTED"
)

// compatibilityInfo is the compatibilityError payload.
type compatibilityInfo struct {
	Code              string `json:"code"`
	IncompatibleField string `json:"incompatibleField"`
	Hint              string `json:"hint"`
	UpstreamMessage   string `json:"upstreamMessage"`
	Status            *int   `json:"status,omitempty"`
}

// compatibilityError is the LlmCompatibilityError equivalent. It is a distinct
// type because a compatibility rejection stops the model fallback loop instead of
// trying the next model.
type compatibilityError struct {
	code              string
	incompatibleField string
	hint              string
	upstreamMessage   string
	status            int
	hasStatus         bool
}

// Error implements the error interface.
func (e *compatibilityError) Error() string {
	return "LLM compatibility error [" + e.code + "] on " + e.incompatibleField + ": " + e.hint
}

// info renders the payload.
func (e *compatibilityError) info() compatibilityInfo {
	result := compatibilityInfo{
		Code:              e.code,
		IncompatibleField: e.incompatibleField,
		Hint:              e.hint,
		UpstreamMessage:   e.upstreamMessage,
	}
	if e.hasStatus {
		status := e.status
		result.Status = &status
	}
	return result
}

// testError is the per-probe error object of the diagnostic response.
type testError struct {
	Code          *string            `json:"code,omitempty"`
	Message       string             `json:"message"`
	Status        *int               `json:"status,omitempty"`
	AxiosCode     *string            `json:"axiosCode,omitempty"`
	RequestID     *string            `json:"requestId,omitempty"`
	UpstreamType  *string            `json:"upstreamType,omitempty"`
	UpstreamCode  *string            `json:"upstreamCode,omitempty"`
	Compatibility *compatibilityInfo `json:"compatibilityError,omitempty"`
}

// gatewayErrorInfo is the transport-independent error description.
type gatewayErrorInfo struct {
	Code          string
	Message       string
	Status        *int
	AxiosCode     string
	RequestID     string
	UpstreamType  string
	UpstreamCode  string
	Compatibility *compatibilityInfo
}

// toTestError renders one error object.
func (i gatewayErrorInfo) toTestError() testError {
	result := testError{Message: i.Message, Status: i.Status, Compatibility: i.Compatibility}
	if i.Code != "" {
		code := i.Code
		result.Code = &code
	}
	if i.AxiosCode != "" {
		code := i.AxiosCode
		result.AxiosCode = &code
	}
	if i.RequestID != "" {
		requestID := i.RequestID
		result.RequestID = &requestID
	}
	if i.UpstreamType != "" {
		value := i.UpstreamType
		result.UpstreamType = &value
	}
	if i.UpstreamCode != "" {
		value := i.UpstreamCode
		result.UpstreamCode = &value
	}
	return result
}

// errorContext carries what the message builder needs to explain an auth failure.
type errorContext struct {
	apiKeyConfigured *bool
	apiSurface       string
}

// toGatewayErrorInfo mirrors toGatewayErrorInfo.
func toGatewayErrorInfo(err error, context errorContext) gatewayErrorInfo {
	if err == nil {
		return gatewayErrorInfo{Code: errorCodeRequestFailed, Message: "LLM gateway request failed"}
	}

	var coded *httpError
	if errors.As(err, &coded) {
		code := coded.code
		if code == "" {
			switch coded.status {
			case http.StatusNotFound:
				code = errorCodeProfileNotFound
			case http.StatusServiceUnavailable:
				code = errorCodeUnavailable
			default:
				code = errorCodeRequestFailed
			}
		}
		status := coded.status
		return gatewayErrorInfo{Code: code, Message: coded.message, Status: &status}
	}

	var compatibility *compatibilityError
	if errors.As(err, &compatibility) {
		info := compatibility.info()
		result := gatewayErrorInfo{
			Code:          errorCodeCompatibility,
			Message:       compatibility.Error(),
			Compatibility: &info,
		}
		if compatibility.hasStatus {
			status := compatibility.status
			result.Status = &status
		}
		return result
	}

	var upstream *upstreamError
	if errors.As(err, &upstream) {
		return upstreamErrorInfo(upstream, context)
	}

	return gatewayErrorInfo{Code: errorCodeRequestFailed, Message: err.Error()}
}

// upstreamErrorInfo mirrors the AxiosError branch of toGatewayErrorInfo.
func upstreamErrorInfo(upstream *upstreamError, context errorContext) gatewayErrorInfo {
	var status *int
	if upstream.status != 0 {
		value := upstream.status
		status = &value
	}
	meta := extractUpstreamErrorMeta(upstream.body)

	detail := upstream.detail
	if upstream.status == http.StatusUnauthorized && strings.EqualFold(strings.TrimSpace(detail), "unauthorized") {
		detail = ""
	}
	if upstream.status == http.StatusForbidden && strings.EqualFold(strings.TrimSpace(detail), "forbidden") {
		detail = ""
	}
	if upstream.status == http.StatusUnauthorized || upstream.status == http.StatusForbidden {
		if detail == "" {
			detail = buildAuthHint(upstream.status, context.apiKeyConfigured)
		}
	}

	// The rerank surface is not part of the compatibility vocabulary: its
	// provider-specific rejections must stay plain upstream errors.
	compatSurface := context.apiSurface
	if compatSurface == "rerank" {
		compatSurface = ""
	}
	if issue := detectCompatibilityIssue(upstream.status, detail, compatSurface); issue != nil {
		info := issue.info()
		return gatewayErrorInfo{
			Code:          errorCodeCompatibility,
			Message:       issue.Error(),
			Status:        status,
			AxiosCode:     upstream.code,
			RequestID:     upstream.requestID,
			UpstreamType:  meta.upstreamType,
			UpstreamCode:  meta.upstreamCode,
			Compatibility: &info,
		}
	}

	message := "LLM gateway request failed"
	if upstream.status != 0 {
		message = "LLM gateway request failed (HTTP " + itoa(upstream.status) + ")"
	}
	if detail != "" {
		message += ": " + detail
	}
	return gatewayErrorInfo{
		Code:         upstreamStatusCode(upstream.status),
		Message:      message,
		Status:       status,
		AxiosCode:    upstream.code,
		RequestID:    upstream.requestID,
		UpstreamType: meta.upstreamType,
		UpstreamCode: meta.upstreamCode,
	}
}

// upstreamStatusCode maps an HTTP status onto the upstream_* diagnostic code.
func upstreamStatusCode(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return "UPSTREAM_UNAUTHORIZED"
	case http.StatusForbidden:
		return "UPSTREAM_FORBIDDEN"
	case http.StatusNotFound:
		return "UPSTREAM_NOT_FOUND"
	case http.StatusMethodNotAllowed:
		return "UPSTREAM_METHOD_NOT_ALLOWED"
	case http.StatusRequestTimeout:
		return "UPSTREAM_TIMEOUT"
	case http.StatusTooManyRequests:
		return "UPSTREAM_RATE_LIMITED"
	case 0:
		return errorCodeUnavailable
	default:
		if status >= 500 {
			return "UPSTREAM_SERVER_ERROR"
		}
		return "UPSTREAM_REQUEST_FAILED"
	}
}

// throwGatewayError mirrors throwGatewayError: the status of the diagnostic
// failure decides the HTTP status, and the compatibility code keeps its own 400.
func throwGatewayError(info gatewayErrorInfo) error {
	if info.Code == errorCodeCompatibility {
		return codedBadRequest(info.Code, info.Message)
	}
	if info.Status == nil {
		code := info.Code
		if code == "" {
			code = errorCodeUnavailable
		}
		return serviceUnavailableCoded(code, info.Message)
	}
	if *info.Status >= 500 {
		code := info.Code
		if code == "" {
			code = errorCodeRequestFailed
		}
		return badGateway(code, info.Message)
	}
	code := info.Code
	if code == "" {
		code = errorCodeRequestFailed
	}
	return codedBadRequest(code, info.Message)
}

// buildAuthHint mirrors buildAuthHint.
func buildAuthHint(status int, apiKeyConfigured *bool) string {
	base := "Unauthorized"
	if status == http.StatusForbidden {
		base = "Forbidden"
	}
	if apiKeyConfigured == nil {
		return base
	}
	if *apiKeyConfigured {
		return base + " (check apiKey)"
	}
	return base + " (apiKey is not configured)"
}

// unsupportedCues and invalidArgumentCues are the wording families the source
// treats as a structured compatibility rejection.
var (
	unsupportedCues = []string{
		"unsupported",
		"not supported",
		"not allowed",
		"not permitted",
		"unrecognized",
		"unknown",
		"extra fields",
		"additional properties",
		"unexpected field",
		"unexpected parameter",
	}
	invalidArgumentCues = []string{
		"invalid request argument",
		"invalid argument",
		"invalid parameter",
	}
	responsesEndpointReferences = []string{
		"/v1/responses",
		"/responses",
		"responses api",
		"responses endpoint",
	}
	responsesRouteUnsupportedCues = []string{
		"method not allowed",
		"not implemented",
		"does not support responses",
		"responses is not supported",
		"route not found",
		"unknown route",
		"unknown path",
		"no route",
		"endpoint not found",
		"not found",
	}
)

// containsAny reports whether input contains one candidate.
func containsAny(input string, candidates []string) bool {
	for _, candidate := range candidates {
		if strings.Contains(input, candidate) {
			return true
		}
	}
	return false
}

// detectCompatibilityIssue mirrors detectOpenAiCompatibilityIssue.
func detectCompatibilityIssue(status int, errorText, apiSurface string) *compatibilityError {
	sanitized := sanitizeUpstreamErrorText(errorText, 500)
	if sanitized == "" {
		return nil
	}
	lower := strings.ToLower(sanitized)
	hasUnsupportedCue := containsAny(lower, unsupportedCues)
	hasInvalidArgumentCue := containsAny(lower, invalidArgumentCues)

	hasResponsesReference := containsAny(lower, responsesEndpointReferences)
	hasResponsesRouteCue := status == http.StatusNotImplemented || containsAny(lower, responsesRouteUnsupportedCues)

	newIssue := func(code, field, hint string) *compatibilityError {
		issue := &compatibilityError{
			code:              code,
			incompatibleField: field,
			hint:              hint,
			upstreamMessage:   sanitized,
		}
		if status != 0 {
			issue.status = status
			issue.hasStatus = true
		}
		return issue
	}

	if (status == http.StatusBadRequest || status == http.StatusNotFound ||
		status == http.StatusMethodNotAllowed || status == http.StatusNotImplemented) &&
		apiSurface == "responses" && hasResponsesReference && hasResponsesRouteCue {
		return newIssue(
			compatibilityResponsesAPIUnsupported,
			"apiSurface",
			"Upstream gateway does not support Responses API. Use chat/completions for this profile.",
		)
	}

	if status != 0 {
		switch status {
		case http.StatusBadRequest, http.StatusNotFound, http.StatusMethodNotAllowed,
			http.StatusUnprocessableEntity, http.StatusNotImplemented:
		default:
			return nil
		}
	}

	if strings.Contains(lower, "metadata") && (hasUnsupportedCue || hasInvalidArgumentCue) {
		return newIssue(
			compatibilityUnsupportedMetadata,
			"metadata",
			"Remove metadata from request or switch to a gateway/provider that supports metadata forwarding.",
		)
	}
	if (strings.Contains(lower, "json_schema") || strings.Contains(lower, "json schema") ||
		strings.Contains(lower, "structured output")) && (hasUnsupportedCue || hasInvalidArgumentCue) {
		return newIssue(
			compatibilityUnsupportedJSONSchema,
			"response_format.json_schema",
			"This gateway does not support JSON schema structured outputs. Use json_object or plain text.",
		)
	}
	if (strings.Contains(lower, "response_format") || strings.Contains(lower, "response format")) &&
		(hasUnsupportedCue || hasInvalidArgumentCue) {
		return newIssue(
			compatibilityUnsupportedResponseFormat,
			"response_format",
			"This gateway does not support response_format on this endpoint/model.",
		)
	}
	if (strings.Contains(lower, "messages") || strings.Contains(lower, "message")) &&
		strings.Contains(lower, "content") &&
		(hasUnsupportedCue || hasInvalidArgumentCue || strings.Contains(lower, "invalid") || strings.Contains(lower, "must be")) {
		return newIssue(
			compatibilityInvalidMessageContent,
			"messages[].content",
			"Normalize message content to the OpenAI-compatible text format required by the upstream gateway.",
		)
	}
	return nil
}

// itoa renders an int the way the message interpolation does.
func itoa(value int) string { return strconv.Itoa(value) }
