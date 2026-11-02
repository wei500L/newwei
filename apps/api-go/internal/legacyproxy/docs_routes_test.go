package legacyproxy

import (
	"net/http"
	"testing"
)

// TestWithDocsAppendsOnePrefixRule locks the takeover: exactly one /docs prefix
// rule with the handler key is appended to the table.
func TestWithDocsAppendsOnePrefixRule(t *testing.T) {
	base := BaseRules()
	rules := WithDocs(base)
	if len(rules) != len(base)+1 {
		t.Fatalf("added %d rules, want 1", len(rules)-len(base))
	}
	added := rules[len(rules)-1]
	if added.Prefix != DocsHandlerKey || added.HandlerKey != DocsHandlerKey || added.Exact {
		t.Fatalf("added rule = %+v, want the whole /docs prefix with the handler key", added)
	}
	count := 0
	for _, rule := range rules {
		if rule.Prefix == DocsHandlerKey {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("/docs rules = %d, want exactly 1", count)
	}
}

// TestWithDocsGoOwnsEveryDocsPath locks the matched rule for the page, the
// document, a static asset and every method: one prefix rule covers them all so
// the handler can answer CORS, GET/HEAD and the 404 contract itself.
func TestWithDocsGoOwnsEveryDocsPath(t *testing.T) {
	gateway := New(WithDocs(BaseRules()))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/docs"},
		{http.MethodGet, "/docs/"},
		{http.MethodGet, "/docs/index.html"},
		{http.MethodGet, "/docs/json"},
		{http.MethodGet, "/docs/swagger-ui.css"},
		{http.MethodGet, "/docs/swagger-ui-init.js"},
		{http.MethodPost, "/docs"},
		{http.MethodHead, "/docs/json"},
		{http.MethodOptions, "/docs/json"},
	} {
		rule, matched := gateway.matchRule(tc.method, tc.path)
		if !matched || rule.HandlerKey != DocsHandlerKey {
			t.Fatalf("%s %s matched %+v matched=%v, want the /docs go rule", tc.method, tc.path, rule, matched)
		}
	}
}

// TestWithDocsGoOwnsSimilarPrefixPaths documents the consequence of prefix
// matching: /docsx follows the same prefix into the Go handler, which renders the
// NestJS 404 itself.
func TestWithDocsGoOwnsSimilarPrefixPaths(t *testing.T) {
	gateway := New(WithDocs(BaseRules()))
	rule, matched := gateway.matchRule(http.MethodGet, "/docsx")
	if !matched || rule.HandlerKey != DocsHandlerKey {
		t.Fatalf("GET /docsx matched %+v matched=%v, want the /docs go rule", rule, matched)
	}
}

// TestWithDocsGoKeepsNonDocsPathsUnclaimed locks the inverse direction: the
// takeover never widens to another mount point.
func TestWithDocsGoKeepsNonDocsPathsUnclaimed(t *testing.T) {
	gateway := New(WithDocs(BaseRules()))
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/not-migrated-yet"},
		{http.MethodPost, "/api/items"},
		{http.MethodGet, "/admin/queues"},
		{http.MethodGet, "/graphql"},
		{http.MethodGet, "/"},
	} {
		if _, matched := gateway.matchRule(tc.method, tc.path); matched {
			t.Fatalf("%s %s unexpectedly matched", tc.method, tc.path)
		}
	}
}
