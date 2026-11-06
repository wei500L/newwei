package httproute

// DocsHandlerKey is the Go handler registration key of the /docs takeover. The
// docs handler dispatches the page, the OpenAPI document and the Swagger UI
// assets itself, so one key is enough.
const DocsHandlerKey = "/docs"

// WithDocs registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
func WithDocs(rules []Rule) []Rule {
	return append(rules, Rule{Prefix: DocsHandlerKey, HandlerKey: DocsHandlerKey})
}
