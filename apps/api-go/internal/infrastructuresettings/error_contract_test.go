package infrastructuresettings

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// contractErrorPath decodes only the `path` member of one contract error body.
type contractErrorPath struct {
	Path string `json:"path"`
}

// TestContractErrorPathKeepsQuery locks the GlobalExceptionFilter `path` field.
//
// NestJS writes `path: request?.url`
// (apps/api/src/common/filters/global-exception.filter.ts:112) and Express
// `req.url` is the path INCLUDING the query string, so a request for
// /api/system-settings/vector-service?x=1 must report the query too. Writing
// r.URL.Path silently dropped it.
func TestContractErrorPathKeepsQuery(t *testing.T) {
	const target = "/api/system-settings/vector-service?x=1&y=two"
	request := httptest.NewRequest(http.MethodPut, target, nil)
	recorder := httptest.NewRecorder()

	writeContractError(recorder, request, contractError{
		statusCode: http.StatusConflict,
		message:    "busy",
		errorName:  "Conflict",
	})

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusConflict)
	}
	var body contractErrorPath
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode contract error body: %v", err)
	}
	if body.Path != target {
		t.Fatalf("path = %q, want %q", body.Path, target)
	}
}

// TestServiceUnavailablePathKeepsQuery covers the 503 shape, which is produced by
// this package itself (authhttp has no ServiceUnavailableException writer) and is
// therefore the one most likely to drift from the shared error bodies.
func TestServiceUnavailablePathKeepsQuery(t *testing.T) {
	const target = "/api/admin/settings/storage?probe=1"
	request := httptest.NewRequest(http.MethodPatch, target, nil)
	recorder := httptest.NewRecorder()

	writeServiceUnavailable(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	var body contractErrorPath
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode contract error body: %v", err)
	}
	if body.Path != target {
		t.Fatalf("path = %q, want %q", body.Path, target)
	}
}
