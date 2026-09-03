package health

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 契约测试：对齐 NestJS HealthController.getLiveness（health.controller.ts:75-84）。
func TestLiveHandlerReturnsOkPayload(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req, _ := http.NewRequest(method, "http://gateway/api/healthz/live", nil)
		rec := httptest.NewRecorder()
		LiveHandler(rec, req)

		if method == http.MethodGet {
			if rec.Code != http.StatusOK {
				t.Errorf("%s: status = %d, want 200", method, rec.Code)
			}
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("%s: body not JSON: %v", method, err)
			}
			if body["status"] != "ok" {
				t.Errorf("%s: status field = %q, want ok", method, body["status"])
			}
			if len(body) != 1 {
				// 版本/时间戳绝不能出现在公开探针里（版本泄露防护）。
				t.Errorf("%s: body has %d keys, want exactly 1: %v", method, len(body), body)
			}
		}
	}
}

func TestLiveHandlerRejectsNonGet(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		req, _ := http.NewRequest(method, "http://gateway/api/healthz/live", nil)
		rec := httptest.NewRecorder()
		LiveHandler(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404（NestJS 只注册 GET）", method, rec.Code)
		}
	}
}

func TestLiveResultMatchesHandlerOutput(t *testing.T) {
	// shadow 差分与 go 模式使用同一实现：Result 形状必须与 handler 输出一致。
	req, _ := http.NewRequest(http.MethodGet, "http://gateway/api/healthz/live", nil)
	rec := httptest.NewRecorder()
	LiveHandler(rec, req)

	result := LiveResult()
	if result.StatusCode != rec.Code {
		t.Errorf("LiveResult status = %d, handler = %d", result.StatusCode, rec.Code)
	}

	var handlerBody, resultBody map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &handlerBody); err != nil {
		t.Fatalf("handler body: %v", err)
	}
	if err := json.Unmarshal(result.Body, &resultBody); err != nil {
		t.Fatalf("result body: %v", err)
	}
	if handlerBody["status"] != resultBody["status"] {
		t.Errorf("bodies differ: %v vs %v", handlerBody, resultBody)
	}
}
