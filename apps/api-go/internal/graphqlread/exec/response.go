package exec

import (
	"encoding/json"
	"net/http"
)

const (
	codeParseFailed         = "GRAPHQL_PARSE_FAILED"
	codeValidationFailed    = "GRAPHQL_VALIDATION_FAILED"
	codeBadUserInput        = "BAD_USER_INPUT"
	codeBadRequest          = "BAD_REQUEST"
	codeOperationResolution = "OPERATION_RESOLUTION_FAILURE"
	codePersistedNotFound   = "PERSISTED_QUERY_NOT_FOUND"
	codePersistedNotSupport = "PERSISTED_QUERY_NOT_SUPPORTED"
	codeQueryTooComplex     = "QUERY_TOO_COMPLEX"
)

type graphError struct {
	Message    string         `json:"message"`
	Locations  []location     `json:"locations,omitempty"`
	Path       []any          `json:"path,omitempty"`
	Extensions map[string]any `json:"extensions,omitempty"`
}

type location struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// Result is a finished GraphQL HTTP response. The dispatcher returns it for
// protocol errors; Execute returns it after resolvers.
type Result struct {
	Status int
	Header http.Header
	Body   []byte
}

func protocolResult(status int, header http.Header, errors ...graphError) Result {
	payload := map[string]any{"errors": errors}
	body, err := json.Marshal(payload)
	if err != nil {
		body = []byte(`{"errors":[{"message":"Internal server error","extensions":{"code":"INTERNAL_SERVER_ERROR"}}]}`)
		status = http.StatusInternalServerError
	}
	if header == nil {
		header = http.Header{}
	}
	return Result{Status: status, Header: header, Body: body}
}

func dataResult(status int, data []byte, dataNull bool, includeData bool, errors []graphError, header http.Header) Result {
	payload := map[string]any{}
	if includeData {
		if dataNull {
			payload["data"] = nil
		} else {
			payload["data"] = json.RawMessage(data)
		}
	}
	if len(errors) > 0 {
		payload["errors"] = errors
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return protocolResult(http.StatusInternalServerError, header, graphError{
			Message:    "Internal server error",
			Extensions: map[string]any{"code": "INTERNAL_SERVER_ERROR", "http": map[string]any{"status": 500}},
		})
	}
	if header == nil {
		header = http.Header{}
	}
	return Result{Status: status, Header: header, Body: body}
}

func parseError(message string, line, column int) Result {
	err := graphError{
		Message:    message,
		Extensions: map[string]any{"code": codeParseFailed, "http": map[string]any{"status": 400}},
	}
	if line > 0 {
		err.Locations = []location{{Line: line, Column: column}}
	}
	return protocolResult(http.StatusBadRequest, nil, err)
}

func validationErrors(items []graphError) Result {
	for i := range items {
		if items[i].Extensions == nil {
			items[i].Extensions = map[string]any{}
		}
		items[i].Extensions["code"] = codeValidationFailed
		items[i].Extensions["http"] = map[string]any{"status": 400}
	}
	if len(items) == 0 {
		items = []graphError{{
			Message:    "GraphQL validation failed",
			Extensions: map[string]any{"code": codeValidationFailed, "http": map[string]any{"status": 400}},
		}}
	}
	return protocolResult(http.StatusBadRequest, nil, items...)
}

// BadRequest is an Apollo BAD_REQUEST response.
func BadRequest(message string) Result { return badRequest(message, http.StatusBadRequest) }

// PersistedNotFound is the Apollo APQ cache miss.
func PersistedNotFound() Result { return persistedNotFound() }

// PersistedNotSupported is returned when APQ is disabled.
func PersistedNotSupported() Result { return persistedNotSupported() }

// HashMismatch is returned when the raw query string does not match the hash.
func HashMismatch() Result { return hashMismatch() }

// UnsupportedPersistedVersion is returned when persistedQuery.version is not 1.
func UnsupportedPersistedVersion() Result { return unsupportedPersistedVersion() }

func badRequest(message string, status int) Result {
	if status == 0 {
		status = http.StatusBadRequest
	}
	return protocolResult(status, nil, graphError{
		Message:    message,
		Extensions: map[string]any{"code": codeBadRequest, "http": map[string]any{"status": status}},
	})
}

func operationResolution(message string) Result {
	return protocolResult(http.StatusBadRequest, nil, graphError{
		Message: message,
		Extensions: map[string]any{
			"code": codeOperationResolution,
			"http": map[string]any{"status": 400},
		},
	})
}

func userInput(message string, line, column int) Result {
	err := graphError{
		Message:    message,
		Extensions: map[string]any{"code": codeBadUserInput, "http": map[string]any{"status": 400}},
	}
	if line > 0 {
		err.Locations = []location{{Line: line, Column: column}}
	}
	return protocolResult(http.StatusBadRequest, nil, err)
}

func persistedNotFound() Result {
	header := http.Header{}
	header.Set("Cache-Control", "private, no-cache, must-revalidate")
	return protocolResult(http.StatusOK, header, graphError{
		Message: "PersistedQueryNotFound",
		Extensions: map[string]any{
			"code": codePersistedNotFound,
			"http": map[string]any{"status": 200},
		},
	})
}

func persistedNotSupported() Result {
	header := http.Header{}
	header.Set("Cache-Control", "private, no-cache, must-revalidate")
	return protocolResult(http.StatusOK, header, graphError{
		Message: "PersistedQueryNotSupported",
		Extensions: map[string]any{
			"code": codePersistedNotSupport,
			"http": map[string]any{"status": 200},
		},
	})
}

func hashMismatch() Result {
	return protocolResult(http.StatusBadRequest, nil, graphError{
		Message:    "provided sha does not match query",
		Extensions: map[string]any{"http": map[string]any{"status": 400}},
	})
}

func unsupportedPersistedVersion() Result {
	return protocolResult(http.StatusBadRequest, nil, graphError{
		Message:    "Unsupported persisted query version",
		Extensions: map[string]any{"http": map[string]any{"status": 400}},
	})
}

func complexityTooHigh(complexity, limit int, operationName string) Result {
	if operationName == "" {
		operationName = "anonymous"
	}
	return protocolResult(http.StatusInternalServerError, nil, graphError{
		Message: "Query is too complex: " + itoa(complexity) + ". Maximum allowed complexity: " + itoa(limit),
		Extensions: map[string]any{
			"code":          codeQueryTooComplex,
			"complexity":    complexity,
			"operationName": operationName,
		},
	})
}

func itoa(value int) string {
	return jsonNumber(value)
}

func jsonNumber(value int) string {
	return string(mustJSON(value))
}

func mustJSON(value any) []byte {
	body, err := json.Marshal(value)
	if err != nil {
		return []byte("0")
	}
	return body
}

func statusFromErrors(errors []graphError, fallback int) int {
	maxStatus := 0
	for _, err := range errors {
		status := httpStatus(err.Extensions)
		if status > maxStatus {
			maxStatus = status
		}
	}
	if maxStatus > 0 {
		return maxStatus
	}
	return fallback
}

func httpStatus(extensions map[string]any) int {
	if extensions == nil {
		return 0
	}
	httpExt, ok := extensions["http"].(map[string]any)
	if !ok {
		return 0
	}
	switch status := httpExt["status"].(type) {
	case int:
		return status
	case int64:
		return int(status)
	case float64:
		return int(status)
	default:
		return 0
	}
}
