package httpx

import "net/http"

// NestJS runs `app.use(helmet())` at the process entrance
// (apps/api/src/main.ts:107) with no options, so every response the NestJS
// process writes carries helmet 7.2.0's default header set. api-go writes a
// growing share of those responses itself, and a Go-written response bypasses
// that middleware entirely. This file restores the same defaults for exactly
// those responses.
//
// # Why the values are literal constants
//
// The strings below are byte-identical to what helmet 7.2.0 emits for
// `helmet()` — they are transcribed from
// node_modules/helmet/index.mjs and must not be "tidied" (the CSP separator is
// ";" with no following space, HSTS uses "; " with one, and
// upgrade-insecure-requests is a bare directive name). A test pins each value
// so a future edit cannot silently change the contract.
//
// # Why "fill in missing" instead of "set"
//
// Two response classes must not be touched:
//
//   - Responses proxied to NestJS. The ReverseProxy copies the upstream headers
//     into the client header map before the first WriteHeader, so NestJS's own
//     helmet values are already present. Setting them again would either be a
//     redundant overwrite or, for a repeated header, a duplicate.
//   - Responses that deliberately narrow one header. The crawl media handler
//     installs `Content-Security-Policy: default-src 'none'; sandbox` for an
//     inline preview, which is stricter than the global policy and must win.
//
// Applying a default only when the header is absent preserves both, and it makes
// the ordering irrelevant: whoever sets the header first owns it.
//
// # What is deliberately not applied
//
// Cross-Origin-Embedder-Policy is not set: helmet's own default for it is
// "disabled", so NestJS never sends it either. Adding it here would require every
// cross-origin subresource of the console to opt in and is out of scope for a
// parity fix.
//
// The remaining headers keep helmet's default even where a stricter value looks
// tempting (for example Cross-Origin-Resource-Policy: same-origin, which also
// governs whether the console may embed a media preview). This package restores
// the existing behaviour; changing a security posture is a separate decision.

// helmetDefaultCSP is helmet 7.2.0's contentSecurityPolicy() header value with
// no options: the DEFAULT_DIRECTIVES object in source order, joined by ";".
//
// The directives matter for the surfaces api-go serves:
//
//   - script-src 'self' allows the Swagger UI bundles, which the page loads from
//     its own ./docs/ path, and forbids any third-party script;
//   - style-src carries 'unsafe-inline' (helmet's default), which the Swagger
//     page's inline <style> block and the styles Swagger UI injects need;
//   - img-src and font-src keep 'self' plus data:, which covers the two favicons
//     and the CSS-embedded fonts;
//   - connect-src is absent, so it inherits default-src 'self', which is what the
//     page's fetch of /docs/json resolves to.
//
// No directive lists "*", a bare https:, or 'unsafe-eval', so the docs surface
// cannot become a foothold for loading arbitrary origins.
const helmetDefaultCSP = "default-src 'self';base-uri 'self';font-src 'self' https: data:;" +
	"form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';" +
	"script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';" +
	"upgrade-insecure-requests"

// helmetDefaultHSTS is strictTransportSecurity()'s default:
// max-age=180 days with includeSubDomains and without preload.
const helmetDefaultHSTS = "max-age=15552000; includeSubDomains"

// securityDefaults is helmet()'s default set in the order helmet's middleware
// chain installs it. The order is not observable in the response, but keeping it
// makes a comparison against the source straightforward.
var securityDefaults = []struct {
	name  string
	value string
}{
	{"Content-Security-Policy", helmetDefaultCSP},
	{"Cross-Origin-Opener-Policy", "same-origin"},
	{"Cross-Origin-Resource-Policy", "same-origin"},
	{"Origin-Agent-Cluster", "?1"},
	{"Referrer-Policy", "no-referrer"},
	{"Strict-Transport-Security", helmetDefaultHSTS},
	{"X-Content-Type-Options", "nosniff"},
	{"X-DNS-Prefetch-Control", "off"},
	{"X-Download-Options", "noopen"},
	{"X-Frame-Options", "SAMEORIGIN"},
	{"X-Permitted-Cross-Domain-Policies", "none"},
	{"X-XSS-Protection", "0"},
}

// ApplySecurityHeaders installs helmet's defaults on a response api-go is about
// to write. A header that is already present is left untouched, which is what
// keeps a proxied NestJS response and the narrower media CSP authoritative.
//
// It must run after the handler has had its chance to set headers and before the
// status line is written, so callers use it as the hook of Wrap.
func ApplySecurityHeaders(header http.Header) {
	for _, entry := range securityDefaults {
		if header.Get(entry.name) != "" {
			continue
		}
		header.Set(entry.name, entry.value)
	}
	// helmet's hidePoweredBy removes the header Express would otherwise send. Go
	// never sets it, so this is a no-op on a Go-written response; it is kept so
	// the two processes cannot diverge if something else in the chain adds it.
	header.Del("X-Powered-By")
}

// SecurityHeadersMiddleware wraps next so every response that reaches it carries
// helmet's defaults unless the response already sets them.
//
// It is the outermost wrapper in cmd/api: TraceMiddleware runs inside it, so the
// trace headers are still set before the hook fires, and the Go handlers,
// nestnotfound 404s and the metrics endpoint all write through it. A response
// proxied to NestJS already owns these headers and passes through unchanged.
func SecurityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// headersOwned=false means a protocol upgrade the reverse proxy hijacked before
		// copying the upstream head: that response's headers belong to NestJS, which
		// already sent its own helmet values.
		response := Wrap(w, func(_ int, headersOwned bool) {
			if !headersOwned {
				return
			}
			ApplySecurityHeaders(w.Header())
		})
		next.ServeHTTP(response.Writer, r)
		response.Done()
	})
}
