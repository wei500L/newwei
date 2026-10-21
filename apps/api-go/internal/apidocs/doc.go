// Package apidocs serves the Swagger UI surface that NestJS owns until the
// /docs switch (C-7) moves to api-go.
//
// The HTTP contract mirrors SwaggerModule.setup("docs", app, document,
// {jsonDocumentUrl: "docs/json"}) in apps/api/src/main.ts:154-166:
//
//	GET/HEAD /docs, /docs/, /docs/index.html   -> Swagger UI page
//	GET/HEAD /docs/json                        -> OpenAPI 3.0.3 document
//	GET/HEAD /docs/swagger-ui-init.js          -> generated SwaggerUIBundle bootstrap
//	GET/HEAD /docs/swagger-ui.css
//	GET/HEAD /docs/swagger-ui-bundle.js
//	GET/HEAD /docs/swagger-ui-standalone-preset.js
//	GET/HEAD /docs/favicon-16x16.png
//	GET/HEAD /docs/favicon-32x32.png
//	GET/HEAD /docs/oauth2-redirect.html
//	GET/HEAD /docs/oauth2-redirect.js
//
// Everything else under /docs, every non-GET/HEAD method, and every /docs*
// request while SWAGGER_ENABLED is false is answered with the NestJS global
// exception filter's 404 (internal/nestnotfound), never with a Go-flavoured
// error.
//
// The OpenAPI document is a byte-identical copy of
// apps/api/tests/contract/openapi.snapshot.json vendored next to this file. It
// is served as-is so info.completeness and every other member keep their exact
// bytes. The Swagger UI files are the pruned swagger-ui-dist 5.29.4 copies in
// assets/ (provenance: assets/SOURCE.md); nothing is fetched from a CDN.
//
// Differences from the NestJS page are deliberate and limited to the file set:
// NestJS mounts the whole swagger-ui-dist directory (so it also serves source
// maps, the ES bundles, /docs/swagger-ui.js, /docs/index.css, ...) and the YAML
// document at /docs-yaml. api-go serves only the files the page loads plus
// /docs/json; every other path is an unmatched route, exactly like a file the
// NestJS static middleware would 404. The duplicated /docs/docs/* static mount
// is mirrored, so the relative "./docs/..." asset URLs also resolve when the
// page is opened as /docs/ or /docs/index.html.
package apidocs
