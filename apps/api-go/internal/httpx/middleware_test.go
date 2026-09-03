package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// trace 头解析优先级与回写（镜像 apps/api TraceIdMiddleware）。
func TestTraceMiddlewarePriorityAndHeaders(t *testing.T) {
	cases := []struct {
		name        string
		headers     map[string]string
		wantTraceID string
		wantParent  string
	}{
		{
			name:        "x-trace-id wins",
			headers:     map[string]string{"x-trace-id": "abcdef0123456789", "x-request-id": "ffffffffffffffff"},
			wantTraceID: "abcdef0123456789",
			wantParent:  "00-abcdef0123456789-0000000000000000-01",
		},
		{
			name:        "x-request-id second",
			headers:     map[string]string{"x-request-id": "1122334455667788"},
			wantTraceID: "1122334455667788",
		},
		{
			name:        "traceparent segment third",
			headers:     map[string]string{"traceparent": "00-1234567890abcdef1234567890abcdef-0102030405060708-01"},
			wantTraceID: "1234567890abcdef1234567890abcdef",
			wantParent:  "00-1234567890abcdef1234567890abcdef-0102030405060708-01",
		},
		{
			name: "nothing provided generates",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.wantTraceID != "" && TraceIDFromContext(r.Context()) != tc.wantTraceID {
					t.Errorf("context trace = %q, want %q", TraceIDFromContext(r.Context()), tc.wantTraceID)
				}
				w.WriteHeader(http.StatusOK)
			}))
			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			gotTrace := rec.Header().Get("x-trace-id")
			if tc.wantTraceID != "" {
				if gotTrace != tc.wantTraceID {
					t.Errorf("x-trace-id = %q, want %q", gotTrace, tc.wantTraceID)
				}
			} else if len(gotTrace) != 32 {
				t.Errorf("generated x-trace-id should be 32-hex, got %q", gotTrace)
			}
			if tc.wantParent != "" && rec.Header().Get("traceparent") != tc.wantParent {
				t.Errorf("traceparent = %q, want %q", rec.Header().Get("traceparent"), tc.wantParent)
			}
		})
	}
}

// 非法字符被剥离，超长截断到 32（镜像 ensureTraceId；大小写保留）。
func TestEnsureTraceIDNormalization(t *testing.T) {
	if got := EnsureTraceID("!!-abcdef0123456789abcdef0123456789abcdef0123456789-!!"); got != "abcdef0123456789abcdef0123456789" {
		t.Errorf("normalized = %q, want first 32 hex chars", got)
	}
	if got := EnsureTraceID("ABCDEF0123456789ABCDEF0123456789"); got != "ABCDEF0123456789ABCDEF0123456789" {
		t.Errorf("case must be preserved, got %q", got)
	}
	if got := EnsureTraceID("short"); len(got) != 32 {
		t.Errorf("short input should generate 32-hex, got %q", got)
	}
}
