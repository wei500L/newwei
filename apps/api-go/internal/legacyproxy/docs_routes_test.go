package legacyproxy

import (
	"net/http"
	"reflect"
	"testing"
)

// TestWithDocsLeavesTheRuleTableUnchangedForLegacyMode locks the default and
// every non-go value: /docs keeps proxying to NestJS.
func TestWithDocsLeavesTheRuleTableUnchangedForLegacyMode(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	for _, mode := range []string{"", "legacy"} {
		if got := WithDocs(base, mode); !reflect.DeepEqual(got, base) {
			t.Fatalf("mode %q changed the rule table", mode)
		}
	}
}

// TestWithDocsReplacesTheBaseRuleInPlace locks the go replacement: one rule at
// the original position, whole /docs prefix, handler key attached, nothing
// appended and no duplicate /docs prefix.
func TestWithDocsReplacesTheBaseRuleInPlace(t *testing.T) {
	base := DefaultRulesWithWrite("", "", "")
	rules := WithDocs(base, string(ModeGo))

	if len(rules) != len(base) {
		t.Fatalf("rule count = %d, want %d (in-place replacement, no append)", len(rules), len(base))
	}
	index := -1
	for i, rule := range base {
		if rule.Prefix == DocsHandlerKey {
			if rule.Exact {
				t.Fatalf("base /docs rule is exact: %+v", rule)
			}
			index = i
		}
	}
	if index < 0 {
		t.Fatal("base table has no /docs rule to replace")
	}
	replaced := rules[index]
	if replaced.Prefix != DocsHandlerKey ||
		replaced.Mode != ModeGo ||
		replaced.HandlerKey != DocsHandlerKey ||
		replaced.Exact ||
		replaced.OneSegment ||
		replaced.TwoSegments ||
		replaced.Tail != "" ||
		replaced.TailSegment ||
		replaced.TailSuffix != "" ||
		len(replaced.Methods) != 0 {
		t.Fatalf("replaced rule = %+v, want the whole /docs prefix in go mode with the handler key", replaced)
	}
	for i := range base {
		if i == index {
			continue
		}
		if !reflect.DeepEqual(rules[i], base[i]) {
			t.Fatalf("rule %d changed: %+v -> %+v", i, base[i], rules[i])
		}
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
	gateway, err := New("http://legacy:4000", WithDocs(DefaultRulesWithWrite("", "", ""), string(ModeGo)))
	if err != nil {
		t.Fatal(err)
	}
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
		rule := gateway.match(tc.method, tc.path)
		if rule.Mode != ModeGo || rule.HandlerKey != DocsHandlerKey {
			t.Fatalf("%s %s matched %+v, want the /docs go rule", tc.method, tc.path, rule)
		}
	}
}

// TestWithDocsGoOwnsSimilarPrefixPaths documents the consequence of prefix
// matching: the base rule was a plain prefix rule too, so /docsx follows the
// same prefix into the Go handler. NestJS answers /docsx with its
// unmatched-route 404 (the static mount requires a path-segment boundary), and
// the Go docs handler renders the same 404, so no /docs* path needs NestJS to
// stay up.
func TestWithDocsGoOwnsSimilarPrefixPaths(t *testing.T) {
	gateway, err := New("http://legacy:4000", WithDocs(DefaultRulesWithWrite("", "", ""), string(ModeGo)))
	if err != nil {
		t.Fatal(err)
	}
	rule := gateway.match(http.MethodGet, "/docsx")
	if rule.Mode != ModeGo || rule.HandlerKey != DocsHandlerKey {
		t.Fatalf("GET /docsx matched %+v, want the /docs go rule", rule)
	}
}

// TestWithDocsGoKeepsNonDocsPathsOnLegacy locks the inverse direction: the
// takeover never widens to another mount point.
func TestWithDocsGoKeepsNonDocsPathsOnLegacy(t *testing.T) {
	gateway, err := New("http://legacy:4000", WithDocs(DefaultRulesWithWrite("", "", ""), string(ModeGo)))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/not-migrated-yet"},
		{http.MethodPost, "/api/items"},
		{http.MethodGet, "/admin/queues"},
		{http.MethodGet, "/graphql"},
		{http.MethodGet, "/"},
	} {
		if rule := gateway.match(tc.method, tc.path); rule.Mode != ModeLegacy {
			t.Fatalf("%s %s matched %+v, want legacy", tc.method, tc.path, rule)
		}
	}
}

// TestWithDocsAddsTheRuleWhenTheTableHasNone keeps the switch meaningful for a
// custom rule table that never declared the /docs prefix: exactly one rule is
// appended, never a duplicate.
func TestWithDocsAddsTheRuleWhenTheTableHasNone(t *testing.T) {
	rules := WithDocs([]Rule{{Prefix: "/api/", Mode: ModeLegacy}}, string(ModeGo))
	if len(rules) != 2 {
		t.Fatalf("rules = %d, want 2", len(rules))
	}
	added := rules[1]
	if added.Prefix != DocsHandlerKey || added.Mode != ModeGo || added.HandlerKey != DocsHandlerKey || added.Exact {
		t.Fatalf("added rule = %+v", added)
	}
}
