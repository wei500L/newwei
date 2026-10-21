package apidocs

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// assetPath is one /docs sub-path the handler answers. The named type keeps the
// route table and its dispatch from being mixed with the other string fields of
// the package.
type assetPath string

// The routes owned by the handler: the exact set NestJS registers through
// SwaggerModule plus the swagger-ui-dist files the page loads.
const (
	// pageRootPath, pageSlashPath and pageIndexPath are the three spellings of
	// the Swagger UI page (swagger-module.js registers finalPath, finalPath + "/"
	// and finalPath + "/index.html").
	pageRootPath  assetPath = "/docs"
	pageSlashPath assetPath = "/docs/"
	pageIndexPath assetPath = "/docs/index.html"

	// documentPath is the OpenAPI document (jsonDocumentUrl: "docs/json").
	documentPath assetPath = "/docs/json"
	// initScriptPath is the generated SwaggerUIBundle bootstrap.
	initScriptPath assetPath = "/docs/swagger-ui-init.js"

	// cssPath, bundlePath and presetPath are the three files the page loads.
	cssPath    assetPath = "/docs/swagger-ui.css"
	bundlePath assetPath = "/docs/swagger-ui-bundle.js"
	presetPath assetPath = "/docs/swagger-ui-standalone-preset.js"

	// favicon16Path and favicon32Path are the two icons the page links.
	favicon16Path assetPath = "/docs/favicon-16x16.png"
	favicon32Path assetPath = "/docs/favicon-32x32.png"

	// oauthRedirectHTMLPath and oauthRedirectJSPath are the OAuth2 redirect pair
	// from swagger-ui-dist. The API only uses bearer auth, but the files are part
	// of the static directory NestJS serves.
	oauthRedirectHTMLPath assetPath = "/docs/oauth2-redirect.html"
	oauthRedirectJSPath   assetPath = "/docs/oauth2-redirect.js"
)

// Config is the resolved handler configuration built by the cmd/api wiring.
type Config struct {
	// Enabled mirrors the NestJS SWAGGER_ENABLED switch (see SwaggerEnabled).
	// When false the docs routes are not mounted at all, so every /docs request
	// is an unmatched route.
	Enabled bool
	// Policy answers CORS preflight and writes the actual-request headers, using
	// the same CORS_ORIGIN allowlist as the rest of api-go.
	Policy cors.Policy
	// Recorder receives the NestJS-compatible exception event for every 404. It
	// may be nil; the response is written either way.
	Recorder nestnotfound.Recorder
}

// Handler serves the embedded Swagger UI surface. It is immutable after
// NewHandler and safe for concurrent use.
type Handler struct {
	cfg   Config
	page  asset
	files map[assetPath]asset
}

// NewHandler builds the handler and its immutable asset table.
func NewHandler(cfg Config) *Handler {
	return &Handler{
		cfg:  cfg,
		page: newAsset(buildSwaggerUIPage(), mediaTypeHTML, cacheControlStatic),
		files: map[assetPath]asset{
			documentPath:          newAsset(openapiSnapshot, mediaTypeJSON, cacheControlDocument),
			initScriptPath:        newAsset(buildSwaggerInitJS(), mediaTypeJavaScript, cacheControlStatic),
			cssPath:               newAsset(swaggerUICSS, mediaTypeCSS, cacheControlStatic),
			bundlePath:            newAsset(swaggerUIBundle, mediaTypeJavaScript, cacheControlStatic),
			presetPath:            newAsset(swaggerUIStandalonePreset, mediaTypeJavaScript, cacheControlStatic),
			favicon16Path:         newAsset(favicon16, mediaTypePNG, cacheControlStatic),
			favicon32Path:         newAsset(favicon32, mediaTypePNG, cacheControlStatic),
			oauthRedirectHTMLPath: newAsset(oauth2RedirectHTML, mediaTypeHTML, cacheControlStatic),
			oauthRedirectJSPath:   newAsset(oauth2RedirectJS, mediaTypeJavaScript, cacheControlStatic),
		},
	}
}

// ServeHTTP serves one /docs request.
//
// The decision order mirrors NestJS:
//
//  1. SWAGGER_ENABLED=false: SwaggerModule.setup never ran, so no docs route
//     exists and every method and sub-path reaches the global exception filter.
//  2. CORS: express's cors() middleware runs before routing, so a real
//     preflight is answered without touching the route table.
//  3. GET/HEAD only: SwaggerModule registers GET handlers only, so every other
//     method is an unmatched route.
//  4. A known path: serve the embedded body with its ETag and cache headers.
//  5. Anything else under /docs: the same unmatched-route 404.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		nestnotfound.Write(w, r, cors.Policy{}, nil)
		return
	}
	if !h.cfg.Enabled {
		h.writeNotFound(w, r)
		return
	}
	if h.cfg.Policy.FinishOptions(w, r) {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.writeNotFound(w, r)
		return
	}
	path := assetPath(r.URL.Path)
	// NestJS mounts the swagger-ui-dist directory twice: at /docs and at
	// /docs/docs (swagger-module.js serveStatic(finalPath) plus
	// serveStatic(finalPath + "/" + urlLastSubdirectory)). The second mount is
	// what makes the relative "./docs/..." URLs work when the page is opened as
	// /docs/ or /docs/index.html. Mirror it: a /docs/docs/... request resolves
	// against the same asset table.
	if strings.HasPrefix(r.URL.Path, "/docs/docs/") {
		path = assetPath(strings.TrimPrefix(r.URL.Path, "/docs"))
	}
	if path == pageRootPath || path == pageSlashPath || path == pageIndexPath {
		h.writeAsset(w, r, h.page)
		return
	}
	file, ok := h.files[path]
	if !ok {
		h.writeNotFound(w, r)
		return
	}
	h.writeAsset(w, r, file)
}

// writeNotFound renders the NestJS unmatched-route 404. nestnotfound.Write also
// consults the CORS policy itself; that second call is idempotent for a request
// whose headers were already applied by ServeHTTP.
func (h *Handler) writeNotFound(w http.ResponseWriter, r *http.Request) {
	nestnotfound.Write(w, r, h.cfg.Policy, h.cfg.Recorder)
}

// writeAsset serves one embedded body with its ETag and cache policy. The
// caller has already restricted the method to GET/HEAD, so only the
// conditional-request branch and the body suppression remain.
func (h *Handler) writeAsset(w http.ResponseWriter, r *http.Request, file asset) {
	header := w.Header()
	header.Set("ETag", file.etag)
	header.Set("Cache-Control", string(file.cacheControl))
	if ifNoneMatchSatisfied(r.Header.Get("If-None-Match"), file.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	header.Set("Content-Type", string(file.mediaType))
	header.Set("Content-Length", strconv.Itoa(len(file.body)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(file.body)
}

// ifNoneMatchSatisfied reports whether an If-None-Match header value selects
// the given strong entity tag. The comparison is weak, as RFC 9110 §13.1.2
// requires for GET and HEAD: a "W/" prefix is ignored, the header may carry a
// comma-separated list, and a bare "*" matches every current representation.
func ifNoneMatchSatisfied(headerValue, etag string) bool {
	for _, candidate := range strings.Split(headerValue, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" {
			return true
		}
		if strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}
