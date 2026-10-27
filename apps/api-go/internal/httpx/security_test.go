package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestSecurityDefaultsAreHelmetValues pins every header to the exact string
// helmet 7.2.0 emits for `helmet()` with no options. The values are copied from
// node_modules/helmet/index.mjs; a change here is a change of the security
// contract, not a refactor.
func TestSecurityDefaultsAreHelmetValues(t *testing.T) {
	want := map[string]string{
		"Content-Security-Policy": "default-src 'self';base-uri 'self';" +
			"font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';" +
			"img-src 'self' data:;object-src 'none';script-src 'self';" +
			"script-src-attr 'none';style-src 'self' https: 'unsafe-inline';" +
			"upgrade-insecure-requests",
		"Cross-Origin-Opener-Policy":        "same-origin",
		"Cross-Origin-Resource-Policy":      "same-origin",
		"Origin-Agent-Cluster":              "?1",
		"Referrer-Policy":                   "no-referrer",
		"Strict-Transport-Security":         "max-age=15552000; includeSubDomains",
		"X-Content-Type-Options":            "nosniff",
		"X-DNS-Prefetch-Control":            "off",
		"X-Download-Options":                "noopen",
		"X-Frame-Options":                   "SAMEORIGIN",
		"X-Permitted-Cross-Domain-Policies": "none",
		"X-XSS-Protection":                  "0",
	}
	header := http.Header{}
	ApplySecurityHeaders(header)
	for name, value := range want {
		if got := header.Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
	// helmet's own default leaves Cross-Origin-Embedder-Policy unset, so NestJS
	// never sends it. Setting it here would change the response contract.
	if got := header.Get("Cross-Origin-Embedder-Policy"); got != "" {
		t.Errorf("Cross-Origin-Embedder-Policy = %q, want unset", got)
	}
	// helmet removes Express's server banner.
	if got := header.Get("X-Powered-By"); got != "" {
		t.Errorf("X-Powered-By = %q, want unset", got)
	}
}

// TestSecurityHeadersLeaveExplicitValuesAlone covers the two response classes the
// defaults must not touch: a proxied NestJS response that already carries helmet's
// values, and the media handler's narrower CSP.
func TestSecurityHeadersLeaveExplicitValuesAlone(t *testing.T) {
	header := http.Header{}
	header.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	header.Set("X-Frame-Options", "DENY")
	ApplySecurityHeaders(header)
	if got := header.Get("Content-Security-Policy"); got != "default-src 'none'; sandbox" {
		t.Errorf("media CSP was overwritten: %q", got)
	}
	if got := header.Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("explicit X-Frame-Options was overwritten: %q", got)
	}
	// The headers nobody set are still filled in.
	if got := header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want the default", got)
	}
}

// TestSecurityHeadersMiddlewareCoversSuccessErrorAndEmptyResponses drives the real
// middleware over the three response shapes a Go handler produces.
func TestSecurityHeadersMiddlewareCoversSuccessErrorAndEmptyResponses(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		status  int
	}{
		{
			name: "success",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("content-type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"ok":true}`))
			},
			status: http.StatusOK,
		},
		{
			name: "error",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"statusCode":400}`))
			},
			status: http.StatusBadRequest,
		},
		{
			name: "implicit 200 without a body",
			handler: func(http.ResponseWriter, *http.Request) {
			},
			status: http.StatusOK,
		},
		{
			name: "implicit 200 with only a body write",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte("body"))
			},
			status: http.StatusOK,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			SecurityHeadersMiddleware(testCase.handler).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/items", nil))
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d", recorder.Code, testCase.status)
			}
			for _, name := range []string{
				"Content-Security-Policy",
				"Cross-Origin-Opener-Policy",
				"Cross-Origin-Resource-Policy",
				"Origin-Agent-Cluster",
				"Referrer-Policy",
				"Strict-Transport-Security",
				"X-Content-Type-Options",
				"X-DNS-Prefetch-Control",
				"X-Download-Options",
				"X-Frame-Options",
				"X-Permitted-Cross-Domain-Policies",
				"X-XSS-Protection",
			} {
				if got := recorder.Header().Get(name); got == "" {
					t.Errorf("%s missing on the %s response", name, testCase.name)
				}
			}
		})
	}
}

// TestSecurityHeadersPreserveStreamingFlush proves the header middleware does not
// take the flusher away: the dashboard SSE handler type-asserts http.Flusher and
// answers 500 when the assertion fails.
func TestSecurityHeadersPreserveStreamingFlush(t *testing.T) {
	flushed := make(chan struct{}, 1)
	sink := &flushProbe{ResponseRecorder: httptest.NewRecorder(), flushed: flushed}
	handler := SecurityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("the wrapped writer lost http.Flusher")
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		_, _ = w.Write([]byte("data: {}\n\n"))
		flusher.Flush()
	}))
	handler.ServeHTTP(sink, httptest.NewRequest(http.MethodGet, "/api/dashboard/stream", nil))
	<-flushed
	if sink.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", sink.Code)
	}
	if got := sink.Header().Get("Content-Security-Policy"); got == "" {
		t.Error("flushed stream response lost the security headers")
	}
}

// flushProbe is a ResponseWriter that records Flush calls, so the test can prove
// the wrapper kept the capability instead of only compiling.
type flushProbe struct {
	*httptest.ResponseRecorder
	flushed chan struct{}
}

func (f *flushProbe) Flush() {
	f.ResponseRecorder.Flush()
	select {
	case f.flushed <- struct{}{}:
	default:
	}
}
