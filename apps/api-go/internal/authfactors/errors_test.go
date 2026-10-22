package authfactors

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// contractErrorBody is the asserted subset of the GlobalExceptionFilter body.
type contractErrorBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// TestContractErrorPathKeepsTheQueryString locks the `path` member of the error
// body: GlobalExceptionFilter writes `path: request.url`
// (apps/api/src/common/filters/global-exception.filter.ts:114) and Express
// `req.url` is the request target *including* the query string. Writing
// `r.URL.Path` alone would silently drop `?query` from every error of this unit,
// so the value must come from `r.URL.RequestURI()`.
func TestContractErrorPathKeepsTheQueryString(t *testing.T) {
	for _, testCase := range []struct {
		method string
		target string
	}{
		{http.MethodPost, "/api/auth/mfa/verify-enroll?code=123456"},
		{http.MethodGet, "/api/auth/mfa?org=org-1"},
		{http.MethodGet, "/api/auth/mfa"},
	} {
		request := httptest.NewRequest(testCase.method, testCase.target, nil)
		recorder := httptest.NewRecorder()

		writeServiceUnavailable(recorder, request)

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, want 503", testCase.target, recorder.Code)
		}
		if contentType := recorder.Header().Get("content-type"); contentType != "application/json; charset=utf-8" {
			t.Fatalf("%s: content-type = %q", testCase.target, contentType)
		}
		var body contractErrorBody
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body is not json: %v", testCase.target, err)
		}
		if body.Path != testCase.target {
			t.Fatalf("%s: path = %q, want %q", testCase.target, body.Path, testCase.target)
		}
		if body.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("%s: statusCode = %d, want 503", testCase.target, body.StatusCode)
		}
		if body.Message != "Internal server error" || body.Error != "Service Unavailable" {
			t.Fatalf("%s: message = %q, error = %q", testCase.target, body.Message, body.Error)
		}
	}
}
