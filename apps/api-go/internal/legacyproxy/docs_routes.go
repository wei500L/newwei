package legacyproxy

// DocsHandlerKey is the Go handler registration key of the /docs takeover. The
// docs handler dispatches the page, the OpenAPI document and the Swagger UI
// assets itself, so one key is enough.
const DocsHandlerKey = "/docs"

// WithDocs replaces the base /docs prefix rule with a Go-owned rule when mode
// is go.
//
// The base table declares {Prefix: "/docs", Mode: ModeLegacy} so every /docs
// request is proxied to NestJS. With the switch go, that one rule is replaced
// in place by a ModeGo rule with the handler key; no rule is appended and no
// duplicate prefix enters the table (the matcher sorts rules by prefix length
// with a stable sort, so a second /docs rule could shadow the first). The
// replacement is a plain prefix rule exactly like the rule it replaces: every
// method and every /docs sub-path reaches the Go handler, which answers CORS
// preflight first, serves GET/HEAD and renders the NestJS 404 for everything
// else. That also covers strings such as /docsx, which NestJS never served from
// the static mount (express mounts /docs on a path-segment boundary) and
// answered with the global exception filter's 404 anyway; leaving them on the
// proxy would turn into a 502 once NestJS is stopped.
//
// An empty, "legacy" or any other value keeps the rule table unchanged, so the
// default deployment and the rollback are a single variable flip.
func WithDocs(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	replacement := Rule{Prefix: DocsHandlerKey, Mode: ModeGo, HandlerKey: DocsHandlerKey}
	out := make([]Rule, 0, len(rules))
	replaced := false
	for _, rule := range rules {
		if rule.Prefix == DocsHandlerKey && !rule.Exact {
			if !replaced {
				out = append(out, replacement)
				replaced = true
			}
			// A second base /docs rule would only shadow the replacement.
			continue
		}
		out = append(out, rule)
	}
	if !replaced {
		out = append(out, replacement)
	}
	return out
}
