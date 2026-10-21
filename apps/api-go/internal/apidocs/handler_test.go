package apidocs

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// consoleOrigin is the allowlisted browser origin used by the CORS tests.
const consoleOrigin = "http://console.example.test"

// timestampPattern is the JavaScript Date#toISOString() shape the NestJS
// exception filter writes.
var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// etagPattern is the quoted 16-hex-digit entity tag of an embedded body.
var etagPattern = regexp.MustCompile(`^"[0-9a-f]{16}"$`)

// nestNotFoundBody is the NestJS global exception filter payload.
type nestNotFoundBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// newTestHandler builds the production configuration shape with a local-console
// allowlist and no exception recorder.
func newTestHandler(enabled bool) *Handler {
	return NewHandler(Config{Enabled: enabled, Policy: cors.New(consoleOrigin)})
}

// do runs one request through the trace middleware, the way cmd/api mounts the
// handler, so 404 bodies carry a real trace id.
func do(t *testing.T, handler http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	httpx.TraceMiddleware(handler).ServeHTTP(response, request)
	return response
}

// assertNestNotFound verifies status, content type, member order and payload of
// one Go-written unmatched-route response.
func assertNestNotFound(t *testing.T, response *httptest.ResponseRecorder, method, target string) {
	t.Helper()
	if response.Code != http.StatusNotFound {
		t.Fatalf("%s %s status = %d, want 404", method, target, response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != string(mediaTypeJSON) {
		t.Fatalf("%s %s content-type = %q, want %q", method, target, got, mediaTypeJSON)
	}
	traceID := response.Header().Get("x-trace-id")
	if traceID == "" {
		t.Fatalf("%s %s is missing x-trace-id", method, target)
	}
	raw := response.Body.String()
	// Member order is part of the NestJS contract: statusCode, message, error,
	// traceId, path, timestamp.
	order := []string{`"statusCode"`, `"message"`, `"error"`, `"traceId"`, `"path"`, `"timestamp"`}
	last := -1
	for _, member := range order {
		index := strings.Index(raw, member)
		if index < 0 {
			t.Fatalf("%s %s body is missing %s: %s", method, target, member, raw)
		}
		if index < last {
			t.Fatalf("%s %s body member %s is out of order: %s", method, target, member, raw)
		}
		last = index
	}
	var decoded nestNotFoundBody
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("%s %s body is not JSON: %v (%s)", method, target, err, raw)
	}
	if decoded.StatusCode != http.StatusNotFound || decoded.Error != "Not Found" {
		t.Fatalf("%s %s body = %s", method, target, raw)
	}
	if decoded.Message != "Cannot "+method+" "+target {
		t.Fatalf("%s %s message = %q", method, target, decoded.Message)
	}
	if decoded.Path != target {
		t.Fatalf("%s %s path = %q, want the raw request target", method, target, decoded.Path)
	}
	if decoded.TraceID != traceID {
		t.Fatalf("%s %s traceId = %q, header = %q", method, target, decoded.TraceID, traceID)
	}
	if !timestampPattern.MatchString(decoded.Timestamp) {
		t.Fatalf("%s %s timestamp = %q", method, target, decoded.Timestamp)
	}
}

// TestHandlerServesTheSwaggerPage locks the three page spellings, the shared
// body and every resource the page links.
func TestHandlerServesTheSwaggerPage(t *testing.T) {
	handler := newTestHandler(true)
	paths := []string{string(pageRootPath), string(pageSlashPath), string(pageIndexPath)}
	var first []byte
	for index, path := range paths {
		response := do(t, handler, http.MethodGet, path, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", path, response.Code)
		}
		if got := response.Header().Get("Content-Type"); got != string(mediaTypeHTML) {
			t.Fatalf("GET %s content-type = %q", path, got)
		}
		body := response.Body.Bytes()
		if index == 0 {
			first = body
		} else if !bytes.Equal(body, first) {
			t.Fatalf("GET %s body differs from GET %s", path, paths[0])
		}
		text := string(body)
		for _, want := range []string{
			"<title>Swagger UI</title>",
			`href="./docs/swagger-ui.css"`,
			`href="./docs/favicon-32x32.png"`,
			`href="./docs/favicon-16x16.png"`,
			`src="./docs/swagger-ui-bundle.js"`,
			`src="./docs/swagger-ui-standalone-preset.js"`,
			`src="./docs/swagger-ui-init.js"`,
			documentURL,
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("GET %s page is missing %q: %s", path, want, text)
			}
		}
	}
}

// TestHandlerServesTheEmbeddedOpenAPIDocument locks the byte-for-byte document
// response and its cache metadata.
func TestHandlerServesTheEmbeddedOpenAPIDocument(t *testing.T) {
	handler := newTestHandler(true)
	response := do(t, handler, http.MethodGet, string(documentPath), nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != string(mediaTypeJSON) {
		t.Fatalf("content-type = %q, want %q", got, mediaTypeJSON)
	}
	if body := response.Body.Bytes(); !bytes.Equal(body, openapiSnapshot) {
		t.Fatalf("body is not the embedded snapshot: %d vs %d bytes", len(body), len(openapiSnapshot))
	}
	if got := response.Header().Get("Cache-Control"); got != string(cacheControlDocument) {
		t.Fatalf("cache-control = %q, want %q", got, cacheControlDocument)
	}
	if etag := response.Header().Get("ETag"); !etagPattern.MatchString(etag) {
		t.Fatalf("ETag = %q, want a quoted 16-hex digest", etag)
	}
}

// TestHandlerServesEmbeddedStaticAssets locks every served swagger-ui-dist file
// against its embedded body and media type.
func TestHandlerServesEmbeddedStaticAssets(t *testing.T) {
	handler := newTestHandler(true)
	cases := []struct {
		path        assetPath
		body        []byte
		contentType mediaType
	}{
		{cssPath, swaggerUICSS, mediaTypeCSS},
		{bundlePath, swaggerUIBundle, mediaTypeJavaScript},
		{presetPath, swaggerUIStandalonePreset, mediaTypeJavaScript},
		{favicon16Path, favicon16, mediaTypePNG},
		{favicon32Path, favicon32, mediaTypePNG},
		{oauthRedirectHTMLPath, oauth2RedirectHTML, mediaTypeHTML},
		{oauthRedirectJSPath, oauth2RedirectJS, mediaTypeJavaScript},
	}
	for _, tc := range cases {
		response := do(t, handler, http.MethodGet, string(tc.path), nil)
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", tc.path, response.Code)
		}
		if got := response.Header().Get("Content-Type"); got != string(tc.contentType) {
			t.Fatalf("GET %s content-type = %q, want %q", tc.path, got, tc.contentType)
		}
		if body := response.Body.Bytes(); !bytes.Equal(body, tc.body) {
			t.Fatalf("GET %s body is not the embedded file", tc.path)
		}
		if got := response.Header().Get("Cache-Control"); got != string(cacheControlStatic) {
			t.Fatalf("GET %s cache-control = %q, want %q", tc.path, got, cacheControlStatic)
		}
	}
}

// TestHandlerServesTheGeneratedInitScript locks the bootstrap options and the
// absence of any remote URL.
func TestHandlerServesTheGeneratedInitScript(t *testing.T) {
	handler := newTestHandler(true)
	response := do(t, handler, http.MethodGet, string(initScriptPath), nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != string(mediaTypeJavaScript) {
		t.Fatalf("content-type = %q", got)
	}
	script := response.Body.String()
	for _, want := range []string{
		"window.onload = function(){",
		`url: "/docs/json"`,
		`dom_id: "#swagger-ui"`,
		"deepLinking: true",
		"SwaggerUIBundle.presets.apis",
		"SwaggerUIStandalonePreset",
		"SwaggerUIBundle.plugins.DownloadUrl",
		`layout: "StandaloneLayout"`,
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("init script is missing %q: %s", want, script)
		}
	}
	for _, unwanted := range []string{"http://", "https://", "cdn.", "unpkg"} {
		if strings.Contains(script, unwanted) {
			t.Fatalf("init script must not load remote resources, found %q: %s", unwanted, script)
		}
	}
}

// TestHandlerAnswersNestNotFoundForUnknownSubpaths locks the whitelist edges:
// the files NestJS serves from the static directory but api-go does not, the
// explicit NestJS /docs/LICENSE 404 and unknown names keep the exception-filter
// contract.
func TestHandlerAnswersNestNotFoundForUnknownSubpaths(t *testing.T) {
	recorded := 0
	handler := NewHandler(Config{
		Enabled:  true,
		Policy:   cors.New(consoleOrigin),
		Recorder: func(*http.Request, string, string) { recorded++ },
	})
	targets := []string{
		"/docs/nope",
		"/docs/LICENSE",
		"/docs/NOTICE",
		"/docs/swagger-ui-bundle.js.LICENSE.txt",
		"/docs/swagger-ui-bundle.js.map",
		"/docs/swagger-ui.js",
		"/docs/index.css",
		"/docs/json/",
		"/docs/nope?x=1&y=two",
	}
	for _, target := range targets {
		response := do(t, handler, http.MethodGet, target, map[string]string{
			"x-trace-id": "abcdef0123456789abcdef0123456789",
		})
		assertNestNotFound(t, response, http.MethodGet, target)
	}
	if recorded != len(targets) {
		t.Fatalf("recorder calls = %d, want %d", recorded, len(targets))
	}
}

// TestHandlerAliasesTheDuplicatedStaticMount locks the /docs/docs/... alias.
// NestJS mounts swagger-ui-dist twice (at /docs and at /docs/docs) so the
// relative "./docs/..." asset URLs keep working when the page is opened as
// /docs/ or /docs/index.html; api-go mirrors that mount against the same
// embedded asset table.
func TestHandlerAliasesTheDuplicatedStaticMount(t *testing.T) {
	handler := newTestHandler(true)
	for _, asset := range []string{string(cssPath), string(bundlePath), string(presetPath), string(favicon32Path)} {
		direct := do(t, handler, http.MethodGet, asset, nil)
		aliased := do(t, handler, http.MethodGet, "/docs"+asset, nil)
		if direct.Code != http.StatusOK || aliased.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, GET /docs%s = %d, want 200", asset, direct.Code, asset, aliased.Code)
		}
		if !bytes.Equal(direct.Body.Bytes(), aliased.Body.Bytes()) {
			t.Fatalf("GET %s and GET /docs%s bodies differ", asset, asset)
		}
	}
	// The duplicated mount only aliases real assets; unknown names still 404.
	assertNestNotFound(t, do(t, handler, http.MethodGet, "/docs/docs/nope", nil), http.MethodGet, "/docs/docs/nope")
}

// TestHandlerAnswersOnlyGETAndHEAD locks the method boundary: SwaggerModule
// registers GET handlers, so every other method is an unmatched route.
func TestHandlerAnswersOnlyGETAndHEAD(t *testing.T) {
	handler := newTestHandler(true)
	for _, method := range []string{
		http.MethodPost,
		http.MethodPut,
		http.MethodPatch,
		http.MethodDelete,
		http.MethodOptions,
	} {
		for _, target := range []string{string(pageRootPath), string(documentPath)} {
			response := do(t, handler, method, target, nil)
			assertNestNotFound(t, response, method, target)
		}
	}
}

// TestHandlerAnswersCORSPreflight locks the real-preflight path: the CORS policy
// answers 204 before the route table is consulted, for known and unknown paths
// alike.
func TestHandlerAnswersCORSPreflight(t *testing.T) {
	handler := newTestHandler(true)
	for _, target := range []string{string(documentPath), "/docs/nope"} {
		response := do(t, handler, http.MethodOptions, target, map[string]string{
			"Origin":                        consoleOrigin,
			"Access-Control-Request-Method": http.MethodGet,
		})
		if response.Code != http.StatusNoContent {
			t.Fatalf("OPTIONS %s status = %d, want 204", target, response.Code)
		}
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != consoleOrigin {
			t.Fatalf("OPTIONS %s allow-origin = %q", target, got)
		}
		if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Fatalf("OPTIONS %s allow-credentials = %q", target, got)
		}
		if body := response.Body.String(); body != "" {
			t.Fatalf("OPTIONS %s body = %q, want empty", target, body)
		}
		if etag := response.Header().Get("ETag"); etag != "" {
			t.Fatalf("OPTIONS %s ETag = %q, want none", target, etag)
		}
	}
}

// TestHandlerAppliesActualRequestCORSHeaders locks the actual-request header
// path for an allowlisted origin.
func TestHandlerAppliesActualRequestCORSHeaders(t *testing.T) {
	handler := newTestHandler(true)
	response := do(t, handler, http.MethodGet, string(documentPath), map[string]string{
		"Origin": consoleOrigin,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != consoleOrigin {
		t.Fatalf("allow-origin = %q", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("allow-credentials = %q", got)
	}
}

// TestHandlerWithoutAllowlistAddsNoCORSHeaders locks the empty CORS_ORIGIN case:
// no reflected origin and no wildcard.
func TestHandlerWithoutAllowlistAddsNoCORSHeaders(t *testing.T) {
	handler := NewHandler(Config{Enabled: true, Policy: cors.New("")})
	response := do(t, handler, http.MethodGet, string(pageRootPath), map[string]string{
		"Origin": consoleOrigin,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("allow-origin = %q, want none", got)
	}
}

// TestHandlerSupportsConditionalRequests locks If-None-Match handling for the
// page, the document and a static asset: strong, weak, list and wildcard forms
// produce a bodyless 304, a mismatch still produces 200.
func TestHandlerSupportsConditionalRequests(t *testing.T) {
	handler := newTestHandler(true)
	for _, path := range []string{string(pageRootPath), string(documentPath), string(cssPath)} {
		full := do(t, handler, http.MethodGet, path, nil)
		etag := full.Header().Get("ETag")
		if !etagPattern.MatchString(etag) {
			t.Fatalf("GET %s ETag = %q", path, etag)
		}
		for _, candidate := range []string{etag, "W/" + etag, `"other", ` + etag, "*"} {
			response := do(t, handler, http.MethodGet, path, map[string]string{
				"If-None-Match": candidate,
			})
			if response.Code != http.StatusNotModified {
				t.Fatalf("GET %s If-None-Match %q status = %d, want 304", path, candidate, response.Code)
			}
			if response.Body.Len() != 0 {
				t.Fatalf("GET %s If-None-Match %q body = %q, want empty", path, candidate, response.Body.String())
			}
			if got := response.Header().Get("ETag"); got != etag {
				t.Fatalf("GET %s If-None-Match %q ETag = %q, want %q", path, candidate, got, etag)
			}
			if got := response.Header().Get("Cache-Control"); got != full.Header().Get("Cache-Control") {
				t.Fatalf("GET %s If-None-Match %q cache-control = %q", path, candidate, got)
			}
			if got := response.Header().Get("Content-Type"); got != "" {
				t.Fatalf("GET %s If-None-Match %q content-type = %q, want none on 304", path, candidate, got)
			}
		}
		miss := do(t, handler, http.MethodGet, path, map[string]string{
			"If-None-Match": `"not-the-current-etag"`,
		})
		if miss.Code != http.StatusOK {
			t.Fatalf("GET %s stale If-None-Match status = %d, want 200", path, miss.Code)
		}
		if !bytes.Equal(miss.Body.Bytes(), full.Body.Bytes()) {
			t.Fatalf("GET %s stale If-None-Match body differs", path)
		}
		head := do(t, handler, http.MethodHead, path, map[string]string{
			"If-None-Match": etag,
		})
		if head.Code != http.StatusNotModified || head.Body.Len() != 0 {
			t.Fatalf("HEAD %s conditional = %d with %d body bytes, want 304", path, head.Code, head.Body.Len())
		}
	}
}

// TestHandlerHEADHasNoBody locks HEAD for the page, the document and every
// static class: status, media type and the would-be length, but no body.
func TestHandlerHEADHasNoBody(t *testing.T) {
	handler := newTestHandler(true)
	cases := []struct {
		path        string
		size        int
		contentType mediaType
	}{
		{string(pageRootPath), len(buildSwaggerUIPage()), mediaTypeHTML},
		{string(documentPath), len(openapiSnapshot), mediaTypeJSON},
		{string(initScriptPath), len(buildSwaggerInitJS()), mediaTypeJavaScript},
		{string(cssPath), len(swaggerUICSS), mediaTypeCSS},
		{string(bundlePath), len(swaggerUIBundle), mediaTypeJavaScript},
		{string(favicon32Path), len(favicon32), mediaTypePNG},
	}
	for _, tc := range cases {
		response := do(t, handler, http.MethodHead, tc.path, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("HEAD %s status = %d, want 200", tc.path, response.Code)
		}
		if response.Body.Len() != 0 {
			t.Fatalf("HEAD %s body = %q, want empty", tc.path, response.Body.String())
		}
		if got := response.Header().Get("Content-Length"); got != strconv.Itoa(tc.size) {
			t.Fatalf("HEAD %s content-length = %q, want %d", tc.path, got, tc.size)
		}
		if got := response.Header().Get("Content-Type"); got != string(tc.contentType) {
			t.Fatalf("HEAD %s content-type = %q, want %q", tc.path, got, tc.contentType)
		}
	}
}

// TestHandlerWithSwaggerDisabledAnswersNotFoundForEveryRequest locks the
// unmounted-docs behaviour: every method and every /docs path is the NestJS
// unmatched-route 404 and no asset metadata leaks.
func TestHandlerWithSwaggerDisabledAnswersNotFoundForEveryRequest(t *testing.T) {
	handler := newTestHandler(false)
	paths := []string{
		string(pageRootPath),
		string(pageSlashPath),
		string(pageIndexPath),
		string(documentPath),
		string(initScriptPath),
		string(cssPath),
		string(bundlePath),
		string(presetPath),
		string(favicon16Path),
		string(favicon32Path),
		string(oauthRedirectHTMLPath),
		string(oauthRedirectJSPath),
		"/docs/nope",
		"/docs/LICENSE",
	}
	methods := []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodOptions}
	for _, method := range methods {
		for _, path := range paths {
			response := do(t, handler, method, path, nil)
			if response.Code != http.StatusNotFound {
				t.Fatalf("%s %s status = %d, want 404", method, path, response.Code)
			}
			if etag := response.Header().Get("ETag"); etag != "" {
				t.Fatalf("%s %s ETag = %q, want none", method, path, etag)
			}
			if cache := response.Header().Get("Cache-Control"); cache != "" {
				t.Fatalf("%s %s cache-control = %q, want none", method, path, cache)
			}
			if method == http.MethodHead {
				if response.Body.Len() != 0 {
					t.Fatalf("HEAD %s body = %q, want empty", path, response.Body.String())
				}
				continue
			}
			assertNestNotFound(t, response, method, path)
		}
	}
	// The express cors() middleware runs before routing, so a real preflight is
	// still answered 204 even when the docs routes were never mounted.
	preflight := do(t, handler, http.MethodOptions, string(documentPath), map[string]string{
		"Origin":                        consoleOrigin,
		"Access-Control-Request-Method": http.MethodGet,
	})
	if preflight.Code != http.StatusNoContent {
		t.Fatalf("preflight with docs disabled status = %d, want 204", preflight.Code)
	}
	if got := preflight.Header().Get("Access-Control-Allow-Origin"); got != consoleOrigin {
		t.Fatalf("preflight with docs disabled allow-origin = %q", got)
	}
}

// TestNilHandlerAnswersNotFound keeps the zero value safe for wiring mistakes.
func TestNilHandlerAnswersNotFound(t *testing.T) {
	var handler *Handler
	response := do(t, handler, http.MethodGet, "/docs", nil)
	assertNestNotFound(t, response, http.MethodGet, "/docs")
}

// TestHandlerSetsCacheControlPerResponseClass locks the two cache policies: the
// page, the init script and every static file are cacheable for five minutes,
// the OpenAPI document is revalidated on every request.
func TestHandlerSetsCacheControlPerResponseClass(t *testing.T) {
	handler := newTestHandler(true)
	staticPaths := []assetPath{
		pageRootPath,
		initScriptPath,
		cssPath,
		bundlePath,
		presetPath,
		favicon16Path,
		favicon32Path,
		oauthRedirectHTMLPath,
		oauthRedirectJSPath,
	}
	for _, path := range staticPaths {
		response := do(t, handler, http.MethodGet, string(path), nil)
		if got := response.Header().Get("Cache-Control"); got != string(cacheControlStatic) {
			t.Fatalf("GET %s cache-control = %q, want %q", path, got, cacheControlStatic)
		}
	}
	response := do(t, handler, http.MethodGet, string(documentPath), nil)
	if got := response.Header().Get("Cache-Control"); got != string(cacheControlDocument) {
		t.Fatalf("GET %s cache-control = %q, want %q", documentPath, got, cacheControlDocument)
	}
}

// TestHandlerETagsAreDistinctQuotedDigests locks the ETag shape and its
// uniqueness across the served representations.
func TestHandlerETagsAreDistinctQuotedDigests(t *testing.T) {
	handler := newTestHandler(true)
	seen := map[string]string{string(pageRootPath): handler.page.etag}
	if !etagPattern.MatchString(handler.page.etag) {
		t.Fatalf("page ETag = %q", handler.page.etag)
	}
	for path, file := range handler.files {
		if !etagPattern.MatchString(file.etag) {
			t.Fatalf("%s ETag = %q", path, file.etag)
		}
		if other, ok := seen[file.etag]; ok {
			t.Fatalf("%s and %s share the ETag %q", other, path, file.etag)
		}
		seen[file.etag] = string(path)
		if got := contentETag(file.body); got != file.etag {
			t.Fatalf("%s ETag = %q, computed %q", path, file.etag, got)
		}
	}
}

// TestHandlerIgnoresQueryStrings locks route matching on the path only, like
// NestJS: a query string never turns a known path into a 404.
func TestHandlerIgnoresQueryStrings(t *testing.T) {
	handler := newTestHandler(true)
	page := do(t, handler, http.MethodGet, string(pageRootPath)+"?url=https%3A%2F%2Fexample.test%2Fspec.json", nil)
	if page.Code != http.StatusOK || page.Header().Get("Content-Type") != string(mediaTypeHTML) {
		t.Fatalf("GET /docs?url=... = %d %q", page.Code, page.Header().Get("Content-Type"))
	}
	document := do(t, handler, http.MethodGet, string(documentPath)+"?v=1", nil)
	if document.Code != http.StatusOK {
		t.Fatalf("GET /docs/json?v=1 status = %d, want 200", document.Code)
	}
	if !bytes.Equal(document.Body.Bytes(), openapiSnapshot) {
		t.Fatal("GET /docs/json?v=1 body is not the embedded snapshot")
	}
}
