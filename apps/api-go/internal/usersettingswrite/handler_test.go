package usersettingswrite

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
)

func TestPutInvalidJSONRejectedBeforeAuth(t *testing.T) {
	handler := NewHandler(nil, nil)
	req := httptest.NewRequest(http.MethodPut, usersettingsread.Paths[0], strings.NewReader("{"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("content-type = %q, want application/json", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "Expected property name or '}' in JSON at position 1") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestInvalidJSONMessageMatchesNodeSnippet(t *testing.T) {
	body := []byte(strings.Repeat("x", 100*1024+1))
	got := invalidJSONMessage(body)
	want := "Unexpected token 'x', \"xxxxxxxxxx\"... is not valid JSON"
	if got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
}

func TestPutBodyOverNestLimitRejectedBeforeAuth(t *testing.T) {
	handler := NewHandler(nil, nil)
	payload := strings.Repeat("x", maxJSONBodyBytes+1)
	req := httptest.NewRequest(http.MethodPut, usersettingsread.Paths[0], strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "request entity too large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPutNonJSONContentTypeIsNotParsedAsInvalid(t *testing.T) {
	// 无 JSON content-type 时 body-parser 跳过。这里没有鉴权器，
	// 走到鉴权前的空体分支之后会因 auth=nil 失败——证明没有被当成非法 JSON。
	handler := NewHandler(nil, nil)
	req := httptest.NewRequest(http.MethodPut, usersettingsread.Paths[0], strings.NewReader("not-json"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code == http.StatusBadRequest {
		t.Fatalf("status = 400, 无 JSON content-type 不应走非法 JSON")
	}
}
