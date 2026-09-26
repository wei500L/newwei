package cors

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAllowlistMatchesNestNormalization(t *testing.T) {
	policy := New(" http://localhost:3000/console , https://console.example.com ")
	if !policy.allows("http://localhost:3000") {
		t.Fatal("path on an allowlist entry must compare as origin")
	}
	if !policy.allows("https://console.example.com") {
		t.Fatal("second origin was dropped")
	}
	if policy.allows("https://evil.example") || policy.allows("*") || policy.allows("") {
		t.Fatal("allowlist matched an origin that was not configured")
	}

	star := New("*")
	if star.allows("http://localhost:3000") || star.allows("*") {
		t.Fatal("a literal * entry must not allow every origin")
	}
	if New("").enabled() || New(" , ").enabled() {
		t.Fatal("empty CORS_ORIGIN must disable CORS")
	}
}

func TestPreflightAndErrorResponsesUseTheSameOriginPolicy(t *testing.T) {
	policy := New("http://localhost:3000")

	preflight := httptest.NewRequest(http.MethodOptions, "http://gateway/api/user-settings/ui/onboarding", nil)
	preflight.Header.Set("Origin", "http://localhost:3000")
	preflight.Header.Set("Access-Control-Request-Method", "PUT")
	preflight.Header.Set("Access-Control-Request-Headers", "authorization,content-type,x-trace-id")
	allowed := httptest.NewRecorder()
	if !policy.FinishOptions(allowed, preflight) {
		t.Fatal("valid preflight must be finished by Go")
	}
	if allowed.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", allowed.Code)
	}
	if got := allowed.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("allow-origin = %q", got)
	}
	if allowed.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("credentials must be true for an allowed origin")
	}
	if strings.Contains(allowed.Header().Get("Access-Control-Allow-Origin"), "*") {
		t.Fatal("credentialed response must not use a wildcard origin")
	}
	if !strings.Contains(allowed.Header().Get("Access-Control-Allow-Methods"), "PUT") {
		t.Fatalf("allow-methods = %q", allowed.Header().Get("Access-Control-Allow-Methods"))
	}
	if allowed.Header().Get("Access-Control-Allow-Headers") != "authorization,content-type,x-trace-id" {
		t.Fatalf("allow-headers = %q", allowed.Header().Get("Access-Control-Allow-Headers"))
	}
	vary := allowed.Header().Get("Vary")
	if !strings.Contains(vary, "Origin") || !strings.Contains(vary, "Access-Control-Request-Headers") {
		t.Fatalf("vary = %q", vary)
	}

	deniedReq := httptest.NewRequest(http.MethodOptions, "http://gateway/api/user-settings/ui/onboarding", nil)
	deniedReq.Header.Set("Origin", "https://evil.example")
	deniedReq.Header.Set("Access-Control-Request-Method", "GET")
	denied := httptest.NewRecorder()
	if !policy.FinishOptions(denied, deniedReq) {
		t.Fatal("disallowed origin is still a preflight Go must finish")
	}
	if denied.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("disallowed origin was reflected: %q", denied.Header().Get("Access-Control-Allow-Origin"))
	}

	plain := httptest.NewRequest(http.MethodOptions, "http://gateway/api/user-settings/ui/onboarding", nil)
	plainRec := httptest.NewRecorder()
	if policy.FinishOptions(plainRec, plain) {
		t.Fatal("OPTIONS without preflight headers must fall through")
	}
	if plainRec.Header().Get("Access-Control-Allow-Methods") != "" {
		t.Fatal("non-preflight OPTIONS must not be answered here")
	}

	put := httptest.NewRequest(http.MethodPut, "http://gateway/api/user-settings/ui/onboarding", strings.NewReader("{"))
	put.Header.Set("Origin", "http://localhost:3000")
	putRec := httptest.NewRecorder()
	if policy.FinishOptions(putRec, put) {
		t.Fatal("PUT must not be treated as a preflight")
	}
	putRec.WriteHeader(http.StatusBadRequest)
	_, _ = putRec.Write([]byte(`{"statusCode":400}`))
	if putRec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatal("non-200 Go response lost the allow-origin header")
	}
	if putRec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("non-200 Go response lost the credentials header")
	}
}
