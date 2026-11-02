package legacyproxy

// DocsHandlerKey is the Go handler registration key of the /docs takeover. The
// docs handler dispatches the page, the OpenAPI document and the Swagger UI
// assets itself, so one key is enough.
const DocsHandlerKey = "/docs"

// WithDocs appends the /docs prefix rule owned by the Go docs handler.
//
// It is a plain prefix rule, exactly like the legacy rule it replaces: every
// method and every /docs sub-path reaches the Go handler, which answers CORS
// preflight first, serves GET/HEAD and renders the NestJS 404 for everything
// else. That also covers strings such as /docsx, which NestJS never served from
// the static mount (express mounts /docs on a path-segment boundary) and
// answered with the global exception filter's 404 anyway, so no /docs* path
// needs NestJS to stay up.
func WithDocs(rules []Rule) []Rule {
	return append(rules, Rule{Prefix: DocsHandlerKey, HandlerKey: DocsHandlerKey})
}
