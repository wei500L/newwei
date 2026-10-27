package modelaccesssettings

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestServiceUnavailableBodyKeepsTheQueryString pins the `path` field of the 503
// envelope: GlobalExceptionFilter writes `request.url`, which in Express still
// carries the query string, so a request to `/x?a=1` must report
// "/x?a=1" and not "/x".
func TestServiceUnavailableBodyKeepsTheQueryString(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/system-settings/llm-gateways/proxy-load-balancing?force=1", nil)
	recorder := httptest.NewRecorder()

	writeServiceUnavailable(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
	var body serviceUnavailableBody
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v (%s)", err, recorder.Body.String())
	}
	if body.Path != "/api/system-settings/llm-gateways/proxy-load-balancing?force=1" {
		t.Fatalf("path = %q", body.Path)
	}
	if body.Message != "Internal server error" || body.Error != "Service Unavailable" {
		t.Fatalf("body = %+v", body)
	}
	if len(body.Timestamp) == 0 || body.Timestamp[len(body.Timestamp)-1] != 'Z' {
		t.Fatalf("timestamp = %q", body.Timestamp)
	}
}
