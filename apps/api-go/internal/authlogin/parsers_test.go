package authlogin

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseRefreshTokenAcceptsBothFormats(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	// The current tokenId.orgId.secret form.
	credential, err := parseRefreshToken("11111111-2222-3333-4444-555555555555.org-1." + secret)
	if err != nil {
		t.Fatal(err)
	}
	if credential.TokenID != "11111111-2222-3333-4444-555555555555" || credential.OrgID != "org-1" || credential.Secret != secret {
		t.Fatalf("credential = %+v", credential)
	}

	// The legacy NestJS tokenId.secret form keeps working.
	credential, err = parseRefreshToken("tokenid-1." + secret)
	if err != nil {
		t.Fatal(err)
	}
	if credential.TokenID != "tokenid-1" || credential.OrgID != "" || credential.Secret != secret {
		t.Fatalf("legacy credential = %+v", credential)
	}

	// A malformed token is the shared 401, never a 400: the shape must not be
	// distinguishable from a wrong credential.
	for _, malformed := range []string{"", "tokenid", "tokenid.nothex", "tokenid." + secret[:31]} {
		_, err := parseRefreshToken(malformed)
		if err == nil {
			t.Fatalf("%q must be rejected", malformed)
		}
		coded, ok := err.(*httpError)
		if !ok || coded.status != http.StatusUnauthorized || coded.message != invalidRefreshTokenMessage {
			t.Fatalf("%q error = %#v", malformed, err)
		}
	}
}

func TestParseTimespan(t *testing.T) {
	cases := map[string]time.Duration{
		"15m": 15 * time.Minute,
		"7d":  7 * 24 * time.Hour,
		"30s": 30 * time.Second,
		"2h":  2 * time.Hour,
	}
	for value, want := range cases {
		got, err := parseTimespan(value)
		if err != nil || got != want {
			t.Fatalf("%q = %v (%v), want %v", value, got, err, want)
		}
	}
	// A malformed value is the same 400 the NestJS signing path answers with.
	_, err := parseTimespan("15")
	if got := errorMessage(t, err); got != "Invalid timespan format" {
		t.Fatalf("messages = %q", got)
	}
}

func TestBuildPasswordResetURL(t *testing.T) {
	got, err := buildPasswordResetURL("http://localhost:3000", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://localhost:3000/reset-password?token=abc123" {
		t.Fatalf("url = %q", got)
	}
	// An absolute path replaces any path on the base, like `new URL(path, base)`.
	got, err = buildPasswordResetURL("https://console.example.com/console", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://console.example.com/reset-password?token=abc123" {
		t.Fatalf("url = %q", got)
	}
	// The controller's NEXTAUTH_URL fallback.
	got, err = buildPasswordResetURL("   ", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://localhost:3000/reset-password?token=abc123" {
		t.Fatalf("fallback url = %q", got)
	}
}

func TestClientIPDoesNotTrustForwardedHeaderByDefault(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, PathLogin, nil)
	request.RemoteAddr = "10.0.0.9:51234"
	request.Header.Set("X-Forwarded-For", "203.0.113.7")

	// TRUST_PROXY unset: the socket address wins, so the login bucket cannot be
	// spoofed by a client-supplied header.
	ip := clientIP(request, "")
	if ip == nil || *ip != "10.0.0.9" {
		t.Fatalf("ip = %v", ip)
	}

	// One trusted hop: the rightmost forwarded entry is the proxy's peer.
	request.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	ip = clientIP(request, "1")
	if ip == nil || *ip != "10.0.0.1" {
		t.Fatalf("one-hop ip = %v", ip)
	}

	// A non-numeric value is treated as one trusted hop, matching the address
	// resolution the other api-go takeovers already use for TRUST_PROXY.
	ip = clientIP(request, "true")
	if ip == nil || *ip != "10.0.0.1" {
		t.Fatalf("non-numeric trust value ip = %v", ip)
	}
}

func TestBuildLoginRateLimitKeyUsesOneCombinedBucket(t *testing.T) {
	ip := "203.0.113.7"
	if got := buildLoginRateLimitKey(sceneLoginPassword, "a@b.com", &ip); got != "login:a@b.com:203.0.113.7" {
		t.Fatalf("key = %q", got)
	}
	if got := buildLoginRateLimitKey(sceneLoginCode, "a@b.com", nil); got != "login-code:a@b.com:unknown-ip" {
		t.Fatalf("key = %q", got)
	}
}
