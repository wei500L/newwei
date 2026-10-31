package apidocs

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// cspDirectivePattern extracts one directive's value list from a serialized CSP.
func cspDirective(policy, name string) string {
	for _, directive := range strings.Split(policy, ";") {
		directive = strings.TrimSpace(directive)
		if directive == name {
			return ""
		}
		if strings.HasPrefix(directive, name+" ") {
			return strings.TrimPrefix(directive, name+" ")
		}
	}
	return ""
}

// TestSwaggerPageIsCompatibleWithTheGlobalCSP proves the docs surface actually
// loads under helmet's default policy instead of having a policy written around it.
//
// Three things the page needs, checked against the served bytes:
//
//  1. every script and stylesheet it references is same-origin (./docs/...), which
//     script-src 'self' and style-src 'self' allow;
//  2. the inline <style> block needs style-src 'unsafe-inline', which helmet's
//     default includes;
//  3. the document is fetched from /docs/json, which connect-src would govern — it
//     is absent, so it inherits default-src 'self'.
//
// The test fails if the page ever gains a third-party origin, because that would
// require widening the global policy for the whole API.
func TestSwaggerPageIsCompatibleWithTheGlobalCSP(t *testing.T) {
	handler := newTestHandler(true)
	response := do(t, handler, http.MethodGet, "/docs", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /docs = %d, want 200", response.Code)
	}
	page := response.Body.String()

	// The middleware is what installs the policy on a Go-written response; run the
	// served page through it so the assertion is about the real header pair.
	recorder := httptest.NewRecorder()
	httpx.SecurityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(page))
	})).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/docs", nil))
	policy := recorder.Header().Get("Content-Security-Policy")
	if policy == "" {
		t.Fatal("the docs response carries no Content-Security-Policy")
	}

	// 1. No absolute or protocol-relative URL may appear in a src/href attribute.
	absolute := regexp.MustCompile(`(src|href)="(?:(?:https?:)?//[^"]*)"`)
	if match := absolute.FindString(page); match != "" {
		t.Fatalf("the page loads a non-relative asset %q, which script-src 'self' forbids", match)
	}
	// Every script must come from the relative asset base.
	scripts := regexp.MustCompile(`<script src="([^"]+)"`)
	found := scripts.FindAllStringSubmatch(page, -1)
	if len(found) == 0 {
		t.Fatal("the page has no script tags")
	}
	for _, script := range found {
		if !strings.HasPrefix(script[1], "./docs/") {
			t.Errorf("script %q is not on the relative asset base", script[1])
		}
	}

	// 2. The inline <style> block requires 'unsafe-inline' in style-src.
	if !strings.Contains(page, "<style>") {
		t.Fatal("the page no longer has an inline style block; revisit the CSP claim")
	}
	if styleSrc := cspDirective(policy, "style-src"); !strings.Contains(styleSrc, "'unsafe-inline'") {
		t.Errorf("style-src = %q, which blocks the page's inline <style> block", styleSrc)
	}

	// 3. The document fetch inherits default-src 'self'; connect-src must stay absent
	// rather than being widened to an origin list.
	if connect := cspDirective(policy, "connect-src"); connect != "" {
		t.Errorf("connect-src = %q, want it absent so default-src 'self' applies", connect)
	}
	if defaultSrc := cspDirective(policy, "default-src"); defaultSrc != "'self'" {
		t.Errorf("default-src = %q, want 'self'", defaultSrc)
	}

	// The script directive must stay narrow: no wildcard, no bare scheme, no
	// 'unsafe-eval'. The bundle's only new Function() sits in webpack's
	// globalThis fallback, which is inside a try/catch that falls back to window.
	scriptSrc := cspDirective(policy, "script-src")
	if scriptSrc != "'self'" {
		t.Errorf("script-src = %q, want 'self' only", scriptSrc)
	}
	for _, forbidden := range []string{"*", "https:", "'unsafe-eval'", "'unsafe-inline'"} {
		if strings.Contains(policy, "script-src "+forbidden) || strings.Contains(scriptSrc, forbidden) {
			t.Errorf("script-src carries %q", forbidden)
		}
	}
}

// TestSwaggerAssetsAreSameOrigin proves each asset the page loads is served by the
// handler itself, so no policy exception is needed for them.
func TestSwaggerAssetsAreSameOrigin(t *testing.T) {
	handler := newTestHandler(true)
	for _, path := range []string{
		"/docs/swagger-ui.css",
		"/docs/swagger-ui-bundle.js",
		"/docs/swagger-ui-standalone-preset.js",
		"/docs/swagger-ui-init.js",
		"/docs/favicon-16x16.png",
		"/docs/favicon-32x32.png",
		"/docs/json",
		"/docs/oauth2-redirect.html",
		"/docs/oauth2-redirect.js",
	} {
		response := do(t, handler, http.MethodGet, path, nil)
		if response.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, response.Code)
		}
	}
}

// TestSwaggerInitScriptUsesTheRelativeDocumentURL proves the bootstrap references
// the same-origin document, not an absolute URL that connect-src would have to
// allow.
func TestSwaggerInitScriptUsesTheRelativeDocumentURL(t *testing.T) {
	handler := newTestHandler(true)
	response := do(t, handler, http.MethodGet, "/docs/swagger-ui-init.js", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("GET the init script = %d, want 200", response.Code)
	}
	body := response.Body.String()
	if !strings.Contains(body, `url: "/docs/json"`) {
		t.Fatalf("the init script does not load /docs/json relatively: %s", body)
	}
	if strings.Contains(body, "http://") || strings.Contains(body, "https://") {
		t.Fatalf("the init script references an absolute URL: %s", body)
	}
}

// TestDocsNotFoundStillCarriesSecurityHeaders proves the Go-written 404 keeps the
// helmet defaults, which is the case that would silently regress if the headers
// were only applied by the docs success path.
func TestDocsNotFoundStillCarriesSecurityHeaders(t *testing.T) {
	handler := newTestHandler(true)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/docs/not-a-file", nil)
	httpx.SecurityHeadersMiddleware(httpx.TraceMiddleware(handler)).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	for _, name := range []string{
		"Content-Security-Policy",
		"X-Content-Type-Options",
		"X-Frame-Options",
		"Referrer-Policy",
	} {
		if got := recorder.Header().Get(name); got == "" {
			t.Errorf("the docs 404 lost %s", name)
		}
	}
}

// TestSwaggerHandlerWithDisabledDocsKeepsThePolicy proves SWAGGER_ENABLED=false
// still answers through the security middleware; the docs 404 is a Go response and
// must not be the one path without the header set.
func TestSwaggerHandlerWithDisabledDocsKeepsThePolicy(t *testing.T) {
	handler := newTestHandler(false)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/docs", nil)
	httpx.SecurityHeadersMiddleware(httpx.TraceMiddleware(handler)).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Security-Policy"); got == "" {
		t.Fatal("the disabled-docs 404 carries no Content-Security-Policy")
	}
}

// TestMediaCSPOverridesTheGlobalDefault proves the crawl media handler's narrower
// policy survives the global defaults, which is the response class that must not be
// widened to helmet's page policy.
func TestMediaCSPOverridesTheGlobalDefault(t *testing.T) {
	recorder := httptest.NewRecorder()
	httpx.SecurityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/crawl-media-assets/a/preview", nil))
	if got := recorder.Header().Get("Content-Security-Policy"); got != "default-src 'none'; sandbox" {
		t.Fatalf("media CSP = %q, want the handler's narrower policy", got)
	}
	// The global defaults still cover the headers the media handler does not set.
	if got := recorder.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want the default", got)
	}
}
