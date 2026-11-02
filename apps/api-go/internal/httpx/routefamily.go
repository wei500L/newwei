package httpx

import "strings"

// RouteFamily collapses a request path into a bounded route-family label:
// "/api/<first segment>", "/graphql", "/socket.io", "/admin", or "/" for a bare
// root.
//
// This is the label value for both api_go_legacy_proxy_requests_total (computed
// by legacyproxy) and the route label of http_request_duration_seconds, so one
// route keeps a single series across its cutover from the NestJS proxy to a Go
// handler. It never contains a path parameter, ID, token or query string.
func RouteFamily(path string) string {
	if strings.HasPrefix(path, "/api/") {
		rest := strings.TrimPrefix(path, "/api/")
		if index := strings.IndexByte(rest, '/'); index >= 0 {
			rest = rest[:index]
		}
		if rest == "" {
			return "/api"
		}
		return "/api/" + rest
	}
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return "/"
	}
	if index := strings.IndexByte(trimmed, '/'); index >= 0 {
		trimmed = trimmed[:index]
	}
	return "/" + trimmed
}
