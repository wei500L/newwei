package httproute

import (
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// referenceLinearMatch reproduces the pre-refactor per-request algorithm: copy
// the table, stable-sort by descending Prefix length, scan for the first rule
// whose path and method match, then resolve the handler exactly as
// matchGoHandler did. It is the oracle the precompiled Router must match.
func referenceLinearMatch(rules []Rule, handlers map[string]GoHandler, method, path string) (Rule, GoHandler, bool) {
	method = strings.ToUpper(method)
	sorted := make([]Rule, len(rules))
	copy(sorted, rules)
	sort.SliceStable(sorted, func(i, j int) bool {
		return len(sorted[i].Prefix) > len(sorted[j].Prefix)
	})
	for _, rule := range sorted {
		if !rule.matchesPath(path) {
			continue
		}
		if len(rule.Methods) > 0 && !rule.Methods[method] {
			continue
		}
		key := rule.Prefix
		if rule.HandlerKey != "" {
			key = rule.HandlerKey
		}
		return rule, referenceMatchGoHandler(handlers, key), true
	}
	return Rule{}, nil, false
}

func referenceMatchGoHandler(handlers map[string]GoHandler, prefix string) GoHandler {
	if handler, ok := handlers[prefix]; ok {
		return handler
	}
	keys := make([]string, 0, len(handlers))
	for key := range handlers {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	for _, key := range keys {
		if strings.HasPrefix(prefix, key) {
			return handlers[key]
		}
	}
	return nil
}

// handlerProbe lets the test identify which registered handler a match resolved
// to, without relying on function-code pointers (which are equal for closures
// built from the same literal).
var handlerProbe struct{ last int }

func handlerID(handler GoHandler) int {
	if handler == nil {
		return -1
	}
	handlerProbe.last = -2
	handler(nil, nil)
	return handlerProbe.last
}

func newProbeHandlers(keys []string) map[string]GoHandler {
	handlers := make(map[string]GoHandler, len(keys))
	for i, key := range keys {
		id := i
		handlers[key] = func(http.ResponseWriter, *http.Request) { handlerProbe.last = id }
	}
	return handlers
}

// routerEquivalenceCases covers every documented contract route (dynamic
// segments made concrete), random unknown paths across all methods, and method
// mismatches on a deterministic sample of contract paths.
func routerEquivalenceCases(t *testing.T) []struct{ method, path string } {
	t.Helper()
	fixture := loadRouteFixture(t, "testdata/nest-routes.txt")
	methods := []string{
		http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodOptions, http.MethodHead,
	}

	var cases []struct{ method, path string }
	for _, route := range fixture {
		cases = append(cases, struct{ method, path string }{route[0], concreteRoutePath(route[1])})
	}
	for _, path := range []string{
		"/", "/wp-admin", "/.env", "/api/nope", "/api/items/x/extra",
		"/socket.io", "/graphql/extra", "/api/admin/news-sources/42/preview",
	} {
		for _, method := range methods {
			cases = append(cases, struct{ method, path string }{method, path})
		}
	}
	for i, route := range fixture {
		if i%20 != 0 {
			continue
		}
		path := concreteRoutePath(route[1])
		for _, method := range methods {
			cases = append(cases, struct{ method, path string }{method, path})
		}
	}
	return cases
}

// TestPrecompiledRouterMatchesReferenceLinearScan is the equivalence gate for
// the router precompilation: for the real AllRoutes table, the frozen Router and
// the reference linear implementation must agree on the matched rule and its
// handler for every case, under both a full and a coarse (prefix-fallback)
// handler map.
func TestPrecompiledRouterMatchesReferenceLinearScan(t *testing.T) {
	rules := AllRoutes()

	// Production registers a handler for every rule lookup key.
	var productionKeys []string
	seen := make(map[string]bool)
	for _, rule := range rules {
		key := rule.Prefix
		if rule.HandlerKey != "" {
			key = rule.HandlerKey
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		productionKeys = append(productionKeys, key)
	}
	productionHandlers := newProbeHandlers(productionKeys)
	// The coarse map registers only a few keys so most rules must fall back to
	// the longest registered prefix.
	coarseHandlers := newProbeHandlers([]string{"/api/", "/graphql", "/socket.io-notifications"})

	for name, handlers := range map[string]map[string]GoHandler{
		"production-keys": productionHandlers,
		"coarse-prefix":   coarseHandlers,
	} {
		t.Run(name, func(t *testing.T) {
			router := New(rules)
			for key, handler := range handlers {
				router.Handle(key, handler)
			}
			router.Freeze()

			for _, testCase := range routerEquivalenceCases(t) {
				gotRule, gotMatched := router.matchRule(testCase.method, testCase.path)
				wantRule, wantHandler, wantMatched := referenceLinearMatch(rules, handlers, testCase.method, testCase.path)
				if gotMatched != wantMatched {
					t.Fatalf("%s %s matched=%v, want %v", testCase.method, testCase.path, gotMatched, wantMatched)
				}
				if !gotMatched {
					continue
				}
				gotCmp, wantCmp := gotRule, wantRule
				gotCmp.handler, wantCmp.handler = nil, nil
				if !reflect.DeepEqual(gotCmp, wantCmp) {
					t.Fatalf("%s %s rule=%+v, want %+v", testCase.method, testCase.path, gotRule, wantRule)
				}
				if gotID, wantID := handlerID(gotRule.handler), handlerID(wantHandler); gotID != wantID {
					t.Fatalf("%s %s handler id=%d, want %d", testCase.method, testCase.path, gotID, wantID)
				}
			}
		})
	}
}

// BenchmarkRouterMatchRule measures the per-request match after precompilation;
// it is not a CI gate.
func BenchmarkRouterMatchRule(b *testing.B) {
	router := New(AllRoutes())
	router.Freeze()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		router.matchRule(http.MethodGet, "/api/items")
	}
}
