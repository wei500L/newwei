package apidocs

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
)

// The embedded files are byte-identical copies of the vendored files in this
// package (see assets/SOURCE.md for the swagger-ui-dist 5.29.4 provenance).
//
// Every directive names exactly one file on purpose: a renamed or missing asset
// then fails the build instead of turning one /docs route into a runtime error.
// assets/LICENSE, assets/NOTICE and the two *.LICENSE.txt files stay outside
// the binary because NestJS answers /docs/LICENSE with 404 and nothing links to
// the other attribution files over HTTP.

//go:embed openapi.snapshot.json
var openapiSnapshot []byte

//go:embed assets/swagger-ui.css
var swaggerUICSS []byte

//go:embed assets/swagger-ui-bundle.js
var swaggerUIBundle []byte

//go:embed assets/swagger-ui-standalone-preset.js
var swaggerUIStandalonePreset []byte

//go:embed assets/favicon-16x16.png
var favicon16 []byte

//go:embed assets/favicon-32x32.png
var favicon32 []byte

//go:embed assets/oauth2-redirect.html
var oauth2RedirectHTML []byte

//go:embed assets/oauth2-redirect.js
var oauth2RedirectJS []byte

// mediaType is the Content-Type written for one embedded response body.
type mediaType string

const (
	// mediaTypeHTML is the page type. It is also the type Swagger UI expects for
	// the oauth2 redirect page.
	mediaTypeHTML mediaType = "text/html; charset=utf-8"
	// mediaTypeJSON is the OpenAPI document type NestJS sends for /docs/json.
	mediaTypeJSON mediaType = "application/json; charset=utf-8"
	// mediaTypeJavaScript is the type of the Swagger UI bundles and of the
	// generated bootstrap script.
	mediaTypeJavaScript mediaType = "application/javascript; charset=utf-8"
	// mediaTypeCSS is the Swagger UI stylesheet type.
	mediaTypeCSS mediaType = "text/css; charset=utf-8"
	// mediaTypePNG is the favicon type.
	mediaTypePNG mediaType = "image/png"
)

// cacheControl is the Cache-Control value of one response class.
type cacheControl string

const (
	// cacheControlStatic lets a browser reuse an embedded Swagger UI file for
	// five minutes without revalidating it; the bytes only change on deploy and
	// the ETag still guards a revalidation.
	cacheControlStatic cacheControl = "public, max-age=300"
	// cacheControlDocument keeps the OpenAPI document revalidated on every use,
	// so a redeployed snapshot is observed immediately and a conditional
	// request can still be answered with 304.
	cacheControlDocument cacheControl = "no-cache"
)

// asset is one servable response body with its immutable HTTP metadata. The
// ETag is computed once when the handler is built.
type asset struct {
	body         []byte
	mediaType    mediaType
	cacheControl cacheControl
	etag         string
}

// newAsset builds one asset and its entity tag.
func newAsset(body []byte, contentType mediaType, control cacheControl) asset {
	return asset{
		body:         body,
		mediaType:    contentType,
		cacheControl: control,
		etag:         contentETag(body),
	}
}

// contentETag returns the strong entity tag of one response body: the first 16
// hex digits of its SHA-256 digest, quoted as RFC 9110 requires. Sixteen hex
// digits keep the header short while still being collision-safe for the fixed
// set of embedded files.
func contentETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:8]) + `"`
}
