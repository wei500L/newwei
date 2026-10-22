package dataruntimesettings

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// dataRuntimeContractPath decodes only the `path` member of one contract error
// body.
type dataRuntimeContractPath struct {
	Path string `json:"path"`
}

// TestConflictPathKeepsQuery locks the GlobalExceptionFilter `path` field.
//
// NestJS writes `path: request?.url`
// (apps/api/src/common/filters/global-exception.filter.ts:112) and Express
// `req.url` is the path INCLUDING the query string. The lock-busy 409 is the
// reachable shape here, so it is the one asserted; writing r.URL.Path silently
// dropped the query.
func TestConflictPathKeepsQuery(t *testing.T) {
	const target = "/api/system-settings/geo/nominatim?retry=1"
	request := httptest.NewRequest(http.MethodPut, target, nil)
	recorder := httptest.NewRecorder()

	writeConflict(recorder, request, nominatimLockBusyMessage)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusConflict)
	}
	var body dataRuntimeContractPath
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode contract error body: %v", err)
	}
	if body.Path != target {
		t.Fatalf("path = %q, want %q", body.Path, target)
	}
}

// TestServiceUnavailablePathKeepsQuery covers the 503 shape, which this package
// produces itself rather than through authhttp.
func TestServiceUnavailablePathKeepsQuery(t *testing.T) {
	const target = "/api/system-settings/realtime-signals?probe=1"
	request := httptest.NewRequest(http.MethodPut, target, nil)
	recorder := httptest.NewRecorder()

	writeServiceUnavailable(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	var body dataRuntimeContractPath
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode contract error body: %v", err)
	}
	if body.Path != target {
		t.Fatalf("path = %q, want %q", body.Path, target)
	}
}
