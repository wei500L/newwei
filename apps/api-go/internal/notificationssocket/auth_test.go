package notificationssocket

import (
	"net/http/httptest"
	"testing"
)

func TestResolveClientIPIgnoresForwardedWithoutTrustProxy(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-notifications/", nil)
	request.RemoteAddr = "10.0.0.7:1234"
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := resolveClientIP(request, false); got != "10.0.0.7" {
		t.Fatalf("resolveClientIP() = %q, want raw remote address", got)
	}
	if got := resolveClientIP(request, true); got != "203.0.113.9" {
		t.Fatalf("resolveClientIP() = %q, want first forwarded hop", got)
	}
}

func TestResolveClientIPStripsIPv4MappedPrefix(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-notifications/", nil)
	request.RemoteAddr = "[::ffff:192.0.2.5]:443"
	if got := resolveClientIP(request, false); got != "192.0.2.5" {
		t.Fatalf("resolveClientIP() = %q, want stripped address", got)
	}
}

func TestRequestOriginNormalizesReferer(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-notifications/", nil)
	request.Header.Set("Referer", "https://console.example/app?x=1")
	if got := requestOrigin(request); got != "https://console.example" {
		t.Fatalf("requestOrigin() = %q", got)
	}
}

func TestExtractTokenPrecedence(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-notifications/?token=query-token", nil)
	request.Header.Set("Authorization", "Bearer header-token")
	if got := extractToken(request, []byte(`{"token":"auth-token"}`)); got != "header-token" {
		t.Fatalf("extractToken() = %q, want header token", got)
	}
	request.Header.Del("Authorization")
	if got := extractToken(request, []byte(`{"token":"auth-token"}`)); got != "auth-token" {
		t.Fatalf("extractToken() = %q, want auth payload token", got)
	}
	if got := extractToken(request, nil); got != "query-token" {
		t.Fatalf("extractToken() = %q, want query token", got)
	}
}
