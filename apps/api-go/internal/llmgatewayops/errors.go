package llmgatewayops

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// LLM gateway error codes. The literals are part of the wire contract: the
// NestJS service returns them in the `code` field of a 400/404 body and the
// console keys its messages off them.
const (
	// errorCodeProfileNotFound is a missing saved profile.
	errorCodeProfileNotFound = "LLM_GATEWAY_PROFILE_NOT_FOUND"
	// errorCodeAPIBaseRequired is a profile without a usable apiBase.
	errorCodeAPIBaseRequired = "LLM_GATEWAY_API_BASE_REQUIRED"
	// errorCodeModelRequired is a completion test with no model at all.
	errorCodeModelRequired = "LLM_GATEWAY_MODEL_REQUIRED"
	// errorCodeNothingToTest is a request that disabled all three probes.
	errorCodeNothingToTest = "LLM_GATEWAY_NOTHING_TO_TEST"
	// errorCodeEmbeddingModelRequired is an embeddings probe without a model.
	errorCodeEmbeddingModelRequired = "LLM_GATEWAY_EMBEDDING_MODEL_REQUIRED"
	// errorCodeRerankQueryRequired is a rerank probe without a query.
	errorCodeRerankQueryRequired = "LLM_GATEWAY_RERANK_QUERY_REQUIRED"
	// errorCodeRerankDocumentsRequired is a rerank probe without documents.
	errorCodeRerankDocumentsRequired = "LLM_GATEWAY_RERANK_DOCUMENTS_REQUIRED"
	// errorCodeRerankModelRequired is a rerank probe without a model.
	errorCodeRerankModelRequired = "LLM_GATEWAY_RERANK_MODEL_REQUIRED"
	// errorCodeInvalidEmbeddingResponse is a 2xx embeddings body without a
	// usable vector.
	errorCodeInvalidEmbeddingResponse = "LLM_GATEWAY_INVALID_EMBEDDING_RESPONSE"
	// errorCodeInvalidRerankResponse is a 2xx rerank body without scored rows.
	errorCodeInvalidRerankResponse = "LLM_GATEWAY_INVALID_RERANK_RESPONSE"
	// errorCodeRerankTestFailed is the fallback when every rerank model failed
	// with a non-request error.
	errorCodeRerankTestFailed = "LLM_GATEWAY_RERANK_TEST_FAILED"
	// errorCodeRequestFailed is the generic diagnostic failure.
	errorCodeRequestFailed = "LLM_GATEWAY_REQUEST_FAILED"
	// errorCodeUnavailable is a request that never reached the upstream (DNS,
	// connection, timeout).
	errorCodeUnavailable = "LLM_GATEWAY_UNAVAILABLE"
	// errorCodeCompatibility is the umbrella code for a structured
	// OpenAI-compatibility rejection.
	errorCodeCompatibility = "LLM_COMPATIBILITY_ERROR"
)

// errNoDatabase reports a missing MySQL pool on every persistence path.
var errNoDatabase = errors.New("llmgatewayops: mysql is not configured")

// httpError is a status-coded failure rendered as the GlobalExceptionFilter
// body. code is only set when the NestJS source throws an object payload, which
// is what makes the `code` field survive the filter.
type httpError struct {
	status  int
	message string
	code    string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// badRequest builds a plain 400 (BadRequestException("...")).
func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

// codedBadRequest builds a 400 with the diagnostic `code` field.
func codedBadRequest(code, message string) error {
	return &httpError{status: http.StatusBadRequest, message: message, code: code}
}

// notFound builds a 404 with the diagnostic `code` field.
func notFound(code, message string) error {
	return &httpError{status: http.StatusNotFound, message: message, code: code}
}

// badGateway builds the 502 the diagnostic path returns for an upstream 5xx.
func badGateway(code, message string) error {
	return &httpError{status: http.StatusBadGateway, message: message, code: code}
}

// serviceUnavailable builds a 503. A 503 body never carries the diagnostic
// code: the NestJS filter replaces the message of every 5xx with the generic
// text, so only the status and the error name reach the client.
func serviceUnavailable(message string) error {
	return &httpError{status: http.StatusServiceUnavailable, message: message}
}

// serviceUnavailableCoded builds a 503 that keeps the diagnostic code, which is
// what an object-payload ServiceUnavailableException produces.
func serviceUnavailableCoded(code, message string) error {
	return &httpError{status: http.StatusServiceUnavailable, message: message, code: code}
}

// errorResponse is the GlobalExceptionFilter REST body. Field order matches the
// NestJS spread order so byte-equivalent contract comparisons hold.
type errorResponse struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error,omitempty"`
	Code       string `json:"code,omitempty"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// nestTimestamp is new Date().toISOString() (millisecond UTC).
func nestTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// writeErrorResponse writes one contract error body.
func writeErrorResponse(w http.ResponseWriter, r *http.Request, body errorResponse) {
	body.TraceID = httpx.TraceIDFromContext(r.Context())
	body.Path = r.URL.Path
	body.Timestamp = nestTimestamp()
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(body.StatusCode)
	data, err := json.Marshal(body)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}

// httpStatusErrorName mirrors the NestJS HttpStatus name mapping the exception
// filter prints in the `error` field.
func httpStatusErrorName(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "Bad Request"
	case http.StatusUnauthorized:
		return "Unauthorized"
	case http.StatusForbidden:
		return "Forbidden"
	case http.StatusNotFound:
		return "Not Found"
	case http.StatusConflict:
		return "Conflict"
	case http.StatusUnprocessableEntity:
		return "Unprocessable Entity"
	case http.StatusTooManyRequests:
		return "Too Many Requests"
	case http.StatusBadGateway:
		return "Bad Gateway"
	case http.StatusServiceUnavailable:
		return "Service Unavailable"
	case http.StatusGatewayTimeout:
		return "Gateway Timeout"
	default:
		if status >= 500 {
			return "Internal Server Error"
		}
		return "Error"
	}
}

// writeServiceError maps a service error onto the NestJS error contract.
//
// A 5xx body keeps only the status, the error name and (when the source threw an
// object payload) the diagnostic code: the NestJS filter replaces every 5xx
// message with the generic text, so the LiteLLM remote error detail must not be
// echoed here.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		if coded.status >= http.StatusInternalServerError {
			log.Printf("llmgatewayops: %s", coded.message)
			body := errorResponse{
				StatusCode: coded.status,
				Message:    "Internal server error",
				Error:      httpStatusErrorName(coded.status),
			}
			if coded.code != "" {
				body.Code = coded.code
			}
			writeErrorResponse(w, r, body)
			return
		}
		body := errorResponse{
			StatusCode: coded.status,
			Message:    coded.message,
			Error:      httpStatusErrorName(coded.status),
		}
		if coded.code != "" {
			body.Code = coded.code
		}
		writeErrorResponse(w, r, body)
		return
	}
	if errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("llmgatewayops: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
