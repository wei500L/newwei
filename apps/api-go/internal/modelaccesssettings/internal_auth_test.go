package modelaccesssettings

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestExtractBearerToken pins apps/api/src/common/internal-token.ts.
func TestExtractBearerToken(t *testing.T) {
	cases := []struct {
		header string
		want   string
		ok     bool
	}{
		{header: "Bearer abc", want: "abc", ok: true},
		{header: "bearer abc", want: "abc", ok: true},
		{header: "BEARER\tabc", want: "abc", ok: true},
		{header: "Bearer   abc  ", want: "abc", ok: true},
		{header: "  Bearer abc  ", want: "abc", ok: true},
		{header: "Bearer\tabc", want: "abc", ok: true},
		{header: "bearer\nabc", want: "abc", ok: true},
		{header: "bearer \u2028abc", want: "abc", ok: true},
		{header: "bearer \n abc", want: "abc", ok: true},
		{header: "Bearer", ok: false},
		{header: "bearer", ok: false},
		{header: "bearer ", ok: false},
		{header: "bearer   ", ok: false},
		{header: "", ok: false},
		{header: "   ", ok: false},
		{header: "Token abc", ok: false},
		{header: "bearerabc", ok: false},
		{header: "abc", ok: false},
		{header: "Bearer abc\u2028def", ok: false},
		{header: "Bearer abc\ndef", ok: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.header, func(t *testing.T) {
			got, ok := extractBearerToken(testCase.header)
			if ok != testCase.ok {
				t.Fatalf("extractBearerToken(%q) ok = %v, want %v (token %q)", testCase.header, ok, testCase.ok, got)
			}
			if ok && got != testCase.want {
				t.Fatalf("extractBearerToken(%q) = %q, want %q", testCase.header, got, testCase.want)
			}
		})
	}
}

// TestConstantTimeTokenEqual pins length-then-compare semantics.
func TestConstantTimeTokenEqual(t *testing.T) {
	if !constantTimeTokenEqual("secret", "secret") {
		t.Fatalf("equal tokens must match")
	}
	if constantTimeTokenEqual("secret", "secret2") {
		t.Fatalf("different lengths must not match")
	}
	if constantTimeTokenEqual("secret", "secreT") {
		t.Fatalf("different content must not match")
	}
	// Two empty strings compare equal, exactly like Node's tokensEqual
	// (byteLength 0 === 0 then timingSafeEqual). It is unreachable in the guard:
	// a blank configured token is a 403 and extractBearerToken never returns "".
	if !constantTimeTokenEqual("", "") {
		t.Fatalf("empty/empty must match Node's tokensEqual semantics")
	}
}

// callAuthorizeInternal drives the guard with a fake config.
func callAuthorizeInternal(t *testing.T, expected, header string) *httptest.ResponseRecorder {
	t.Helper()
	harness := newTestHarness(Config{LiteLLMConfigInternalToken: expected})
	request := httptest.NewRequest(http.MethodGet, pathInternalOpenAiKeys, nil)
	if header != "" {
		request.Header.Set("Authorization", header)
	}
	recorder := httptest.NewRecorder()
	harness.service.authorizeInternal(recorder, request)
	return recorder
}

// TestAuthorizeInternalFailureOrder pins 403 -> 401 missing -> 401 invalid.
func TestAuthorizeInternalFailureOrder(t *testing.T) {
	cases := []struct {
		name     string
		expected string
		header   string
		status   int
		message  string
	}{
		{name: "not configured wins over a missing header", expected: "", header: "", status: 403, message: "LITELLM_CONFIG_INTERNAL_TOKEN is not configured"},
		{name: "not configured wins over a wrong token", expected: "", header: "Bearer x", status: 403, message: "LITELLM_CONFIG_INTERNAL_TOKEN is not configured"},
		{name: "blank configuration counts as missing", expected: "   ", header: "Bearer x", status: 403, message: "LITELLM_CONFIG_INTERNAL_TOKEN is not configured"},
		{name: "missing bearer", expected: "the-token", header: "", status: 401, message: "Missing bearer token"},
		{name: "unparseable bearer", expected: "the-token", header: "Token x", status: 401, message: "Missing bearer token"},
		{name: "wrong token", expected: "the-token", header: "Bearer other", status: 401, message: "Invalid bearer token"},
		{name: "prefix only", expected: "the-token", header: "Bearer", status: 401, message: "Missing bearer token"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := callAuthorizeInternal(t, testCase.expected, testCase.header)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, testCase.status, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), `"message":"`+testCase.message+`"`) {
				t.Fatalf("body = %s, want message %q", recorder.Body.String(), testCase.message)
			}
			if testCase.status == 403 && !strings.Contains(recorder.Body.String(), `"error":"Forbidden"`) {
				t.Fatalf("403 body = %s", recorder.Body.String())
			}
			if testCase.status == 401 && !strings.Contains(recorder.Body.String(), `"error":"Unauthorized"`) {
				t.Fatalf("401 body = %s", recorder.Body.String())
			}
		})
	}
}

// TestAuthorizeInternalAcceptsTheExactToken proves the happy path and that the
// expected value is used raw (no trimming).
func TestAuthorizeInternalAcceptsTheExactToken(t *testing.T) {
	recorder := callAuthorizeInternal(t, "the-token", "Bearer the-token")
	if recorder.Body.Len() != 0 {
		t.Fatalf("a valid token must not write a body, got %s", recorder.Body.String())
	}
	// A padded configuration value is compared verbatim, so the trimmed header
	// value does not match it.
	padded := callAuthorizeInternal(t, " the-token ", "Bearer the-token")
	if padded.Code != 401 {
		t.Fatalf("a padded expected token must not match: %d %s", padded.Code, padded.Body.String())
	}
}

// TestFingerprintFromPathRequiresExactlyOneSegment pins the dynamic route shape.
func TestFingerprintFromPathRequiresExactlyOneSegment(t *testing.T) {
	cases := []struct {
		path string
		want string
		ok   bool
	}{
		{path: pathOpenAiKeysKeyPrefix + "abc", want: "abc", ok: true},
		{path: pathOpenAiKeysKeyPrefix, ok: false},
		{path: pathOpenAiKeysKeyPrefix + "abc/def", ok: false},
		{path: pathOpenAiKeys + "/abc", ok: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.path, func(t *testing.T) {
			got, ok := fingerprintFromPath(testCase.path)
			if ok != testCase.ok || got != testCase.want {
				t.Fatalf("fingerprintFromPath(%q) = %q, %v; want %q, %v", testCase.path, got, ok, testCase.want, testCase.ok)
			}
		})
	}
}

// TestInternalRouteDispatchIsExact proves the neighbouring internal route is not
// captured.
func TestInternalRouteDispatchIsExact(t *testing.T) {
	cases := []struct {
		path string
		want internalRoute
	}{
		{path: pathInternalOpenAiKeys, want: internalRouteGetKeys},
		{path: pathInternalOpenAiKeysApplied, want: internalRouteReportApplied},
		{path: "/api/internal/litellm/proxy-load-balancing", want: internalRouteNone},
		{path: pathInternalOpenAiKeys + "/extra", want: internalRouteNone},
		{path: "/api/system-settings/llm-gateways", want: internalRouteNone},
	}
	for _, testCase := range cases {
		t.Run(testCase.path, func(t *testing.T) {
			if got := internalRouteForPath(testCase.path); got != testCase.want {
				t.Fatalf("internalRouteForPath(%q) = %v, want %v", testCase.path, got, testCase.want)
			}
		})
	}
}
