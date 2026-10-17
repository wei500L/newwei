package newsindicator

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestHandlerRequiresBearer(t *testing.T) {
	handler := NewHandler(nil, NewService(nil, nil))
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/news-indicator/associations"},
		{http.MethodGet, "/api/news-indicator/associations/assoc-1"},
		{http.MethodPost, "/api/news-indicator/refresh"},
	} {
		req := httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status=%d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

func TestHandlerUnknownRoutesAreNotFound(t *testing.T) {
	handler := NewHandler(nil, NewService(nil, nil))
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/news-indicator"},
		{http.MethodGet, "/api/news-indicator/associations/a/b"},
		{http.MethodGet, "/api/news-indicator/associations/"},
		{http.MethodDelete, "/api/news-indicator/associations/assoc-1"},
		{http.MethodGet, "/api/news-indicator/refresh"},
		{http.MethodGet, "/api/news-indicator/settings"},
	} {
		req := httptest.NewRequest(tc.method, "http://gateway"+tc.path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s status=%d, want 404", tc.method, tc.path, rec.Code)
		}
	}
}

func TestParseListOptionsDefaultsAndValidation(t *testing.T) {
	options := parseListOptions(url.Values{})
	if options.limit != nil || options.scopeType != "" || options.featureMetric != "" {
		t.Fatalf("empty query = %+v", options)
	}

	values := url.Values{}
	values.Set("limit", "12.7")
	values.Set("scopeType", "INVALID")
	values.Set("featureMetric", "  Negative_Ratio ")
	values.Set("scopeKey", "  acme ")
	values.Set("indicatorSlug", " cpi ")
	options = parseListOptions(values)
	if options.limit == nil || *options.limit != 12.7 {
		t.Fatalf("limit = %v", options.limit)
	}
	if options.scopeType != "" {
		t.Fatalf("invalid scopeType = %q, want empty", options.scopeType)
	}
	if options.featureMetric != "negative_ratio" {
		t.Fatalf("featureMetric = %q, want negative_ratio", options.featureMetric)
	}

	// 非有限数/空串按缺省处理，不报 400。
	for _, raw := range []string{"", "abc", "NaN", "Infinity"} {
		if parsed := parseFiniteQuery(raw); parsed != nil {
			t.Fatalf("parseFiniteQuery(%q) = %v, want nil", raw, *parsed)
		}
	}
}

func TestParseGetOptionsBacktestsLimit(t *testing.T) {
	if options := parseGetOptions(url.Values{}); options.backtestsLimit != nil {
		t.Fatalf("empty backtestsLimit = %v", options.backtestsLimit)
	}
	values := url.Values{}
	values.Set("backtestsLimit", "0")
	options := parseGetOptions(values)
	if options.backtestsLimit == nil || *options.backtestsLimit != 0 {
		t.Fatalf("backtestsLimit = %v", options.backtestsLimit)
	}
}

func TestOrgLockNameRule(t *testing.T) {
	if got := orgLockName("org-short"); got != "ni:org-short" {
		t.Fatalf("orgLockName = %q", got)
	}
	long := ""
	for len(long) < 80 {
		long += "abcdefghij"
	}
	got := orgLockName(long)
	if len(got) != 63 {
		t.Fatalf("hashed lock name length = %d, want 63", len(got))
	}
	if got[:3] != "ni:" {
		t.Fatalf("hashed lock name = %q", got)
	}
}
