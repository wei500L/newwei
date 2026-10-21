package nestnotfound

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// serve runs Write behind the real trace middleware so the trace id header and
// the context value agree exactly like in production.
func serve(t *testing.T, request *http.Request, policy cors.Policy, record Recorder) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler := httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		Write(w, r, policy, record)
	}))
	handler.ServeHTTP(response, request)
	return response
}

type captured struct {
	TraceID string
	Message string
	Path    string
	Method  string
}

func TestWriteMatchesNestNotFoundBody(t *testing.T) {
	var seen []captured
	record := func(r *http.Request, traceID, message string) {
		seen = append(seen, captured{TraceID: traceID, Message: message, Path: r.URL.RequestURI(), Method: r.Method})
	}
	request := httptest.NewRequest(http.MethodGet, "/api/nope?x=1&y=two", nil)
	request.Header.Set("x-trace-id", "abcdef0123456789abcdef0123456789")
	response := serve(t, request, cors.New("http://console.example.test"), record)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	if got := response.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	traceID := response.Header().Get("x-trace-id")
	if traceID != "abcdef0123456789abcdef0123456789" {
		t.Fatalf("x-trace-id = %q", traceID)
	}

	raw := response.Body.String()
	var decoded struct {
		StatusCode int    `json:"statusCode"`
		Message    string `json:"message"`
		Error      string `json:"error"`
		TraceID    string `json:"traceId"`
		Path       string `json:"path"`
		Timestamp  string `json:"timestamp"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, raw)
	}
	if decoded.StatusCode != 404 || decoded.Error != "Not Found" {
		t.Fatalf("unexpected body: %s", raw)
	}
	if decoded.Message != "Cannot GET /api/nope?x=1&y=two" {
		t.Fatalf("message = %q", decoded.Message)
	}
	if decoded.Path != "/api/nope?x=1&y=two" {
		t.Fatalf("path = %q, want the raw request URL including the query", decoded.Path)
	}
	if decoded.TraceID != traceID {
		t.Fatalf("body traceId = %q, header = %q", decoded.TraceID, traceID)
	}
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(decoded.Timestamp) {
		t.Fatalf("timestamp = %q, want ISO milliseconds with Z", decoded.Timestamp)
	}
	// Member order is part of the NestJS contract: statusCode, message, error,
	// traceId, path, timestamp.
	order := []string{`"statusCode"`, `"message"`, `"error"`, `"traceId"`, `"path"`, `"timestamp"`}
	last := -1
	for _, member := range order {
		index := strings.Index(raw, member)
		if index < 0 {
			t.Fatalf("body is missing %s: %s", member, raw)
		}
		if index < last {
			t.Fatalf("body member %s is out of order: %s", member, raw)
		}
		last = index
	}

	if len(seen) != 1 {
		t.Fatalf("recorder calls = %d, want 1", len(seen))
	}
	if seen[0].Message != decoded.Message || seen[0].TraceID != traceID {
		t.Fatalf("recorded event = %+v", seen[0])
	}
	if seen[0].Path != "/api/nope?x=1&y=two" || seen[0].Method != http.MethodGet {
		t.Fatalf("recorded request = %+v", seen[0])
	}
}

func TestWriteHeadHasNoBody(t *testing.T) {
	request := httptest.NewRequest(http.MethodHead, "/missing", nil)
	response := serve(t, request, cors.New(""), nil)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("HEAD body = %q, want empty", response.Body.String())
	}
	if got := response.Header().Get("content-length"); got == "" || got == "0" {
		t.Fatalf("HEAD content-length = %q, want the would-be body length", got)
	}
	if got := response.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("HEAD content-type = %q", got)
	}
}

func TestWriteAnswersPreflightWithoutRecording(t *testing.T) {
	recorded := 0
	record := func(*http.Request, string, string) { recorded++ }

	request := httptest.NewRequest(http.MethodOptions, "/unknown", nil)
	request.Header.Set("Origin", "http://console.example.test")
	request.Header.Set("Access-Control-Request-Method", "POST")
	response := serve(t, request, cors.New("http://console.example.test"), record)

	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", response.Code)
	}
	if got := response.Header().Get("access-control-allow-origin"); got != "http://console.example.test" {
		t.Fatalf("allow-origin = %q", got)
	}
	if got := response.Header().Get("access-control-allow-credentials"); got != "true" {
		t.Fatalf("allow-credentials = %q", got)
	}
	if recorded != 0 {
		t.Fatalf("preflight recorded %d exception events, want 0", recorded)
	}
}

func TestWriteNonPreflightOptionsIsNotFound(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/unknown?q=1", nil)
	response := serve(t, request, cors.New("http://console.example.test"), nil)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	if !strings.Contains(response.Body.String(), `"message":"Cannot OPTIONS /unknown?q=1"`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestWriteAppliesActualRequestCORSHeaders(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/unknown", nil)
	request.Header.Set("Origin", "http://console.example.test")
	response := serve(t, request, cors.New("http://console.example.test"), nil)

	if got := response.Header().Get("access-control-allow-origin"); got != "http://console.example.test" {
		t.Fatalf("allow-origin = %q", got)
	}
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
}

func TestWriteWithoutAllowlistSetsNoCORSHeaders(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/unknown", nil)
	request.Header.Set("Origin", "http://console.example.test")
	response := serve(t, request, cors.New(""), nil)

	if got := response.Header().Get("access-control-allow-origin"); got != "" {
		t.Fatalf("allow-origin = %q, want none", got)
	}
}
