package itemsreading

import (
	"net/http/httptest"
	"reflect"
	"testing"
)

// TestExtractBearerTokenAcceptsCaseInsensitiveScheme pins the authentication
// scheme parsing against passport-jwt's /^Bearer\s+(.+)$/i extractor, which the
// NestJS global JwtAuthGuard uses. A case-sensitive comparison here would answer
// 401 for a request NestJS authenticates.
func TestExtractBearerTokenAcceptsCaseInsensitiveScheme(t *testing.T) {
	cases := []struct {
		name   string
		header string
		want   string
	}{
		{name: "canonical", header: "Bearer token-value", want: "token-value"},
		{name: "lowercase scheme", header: "bearer token-value", want: "token-value"},
		{name: "mixed case scheme", header: "bEaReR token-value", want: "token-value"},
		{name: "machine token", header: "Bearer mtk_abc", want: "mtk_abc"},
		{name: "surrounding spaces", header: "Bearer   token-value  ", want: "token-value"},
		{name: "missing scheme", header: "token-value", want: ""},
		{name: "empty", header: "", want: ""},
		{name: "other scheme", header: "Basic dXNlcjpsZW4=", want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", PathList, nil)
			if testCase.header != "" {
				request.Header.Set("Authorization", testCase.header)
			}
			if got := ExtractBearerToken(request); got != testCase.want {
				t.Fatalf("ExtractBearerToken(%q) = %q, want %q", testCase.header, got, testCase.want)
			}
		})
	}
}

// TestParseListQueryReportsPerPropertyMessages pins the ListItemsDto validation
// envelope. A repeated parameter arrives as an array in Express and fails its own
// constraint, so `search` must report "must be a string" instead of the page /
// pageSize number-string wording, and an unknown parameter must be rejected.
func TestParseListQueryReportsPerPropertyMessages(t *testing.T) {
	cases := []struct {
		name   string
		query  string
		want   []string
		values ListQuery
	}{
		{
			name:   "accepted",
			query:  "page=2&pageSize=10&search=climate&orderBy=PUBLISHED_DESC",
			want:   nil,
			values: ListQuery{Page: "2", PageSize: "10", Search: "climate", OrderBy: "PUBLISHED_DESC"},
		},
		{
			name:  "unknown property",
			query: "pagee=1",
			want:  []string{"property pagee should not exist"},
		},
		{
			name:  "repeated search",
			query: "search=a&search=b",
			want:  []string{listSearchMessage},
		},
		{
			name:  "repeated orderBy",
			query: "orderBy=CREATED_DESC&orderBy=PUBLISHED_DESC",
			want:  []string{listOrderByMessage},
		},
		{
			name:  "repeated pageSize",
			query: "pageSize=10&pageSize=20",
			want:  []string{listPageSizeMessage},
		},
		{
			name:  "malformed number",
			query: "page=1.5.5&orderBy=RECENCY",
			want:  []string{listOrderByMessage, listPageMessage},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", PathList+"?"+testCase.query, nil)
			values, failures := parseListQuery(request)
			if len(testCase.want) == 0 {
				if len(failures) != 0 {
					t.Fatalf("failures = %v, want none", failures)
				}
				if values != testCase.values {
					t.Fatalf("values = %+v, want %+v", values, testCase.values)
				}
				return
			}
			if !reflect.DeepEqual(failures, testCase.want) {
				t.Fatalf("failures = %v, want %v", failures, testCase.want)
			}
		})
	}
}
