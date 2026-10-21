package apidocs

import (
	"strings"
	"testing"
)

// TestSwaggerPageUsesTheNestRelativeBase locks the page resources: they are
// relative to the "./docs/" base NestJS passes to its template, and no remote
// URL or integrity hash points at a CDN.
func TestSwaggerPageUsesTheNestRelativeBase(t *testing.T) {
	page := string(buildSwaggerUIPage())
	for _, want := range []string{
		`href="./docs/swagger-ui.css"`,
		`href="./docs/favicon-32x32.png"`,
		`href="./docs/favicon-16x16.png"`,
		`src="./docs/swagger-ui-bundle.js"`,
		`src="./docs/swagger-ui-standalone-preset.js"`,
		`src="./docs/swagger-ui-init.js"`,
		`<div id="swagger-ui"></div>`,
		"<title>Swagger UI</title>",
		documentURL,
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("page is missing %q:\n%s", want, page)
		}
	}
	for _, unwanted := range []string{"http://", "https://", "cdn.", "unpkg", "integrity="} {
		if strings.Contains(page, unwanted) {
			t.Fatalf("page must not load remote resources, found %q:\n%s", unwanted, page)
		}
	}
}

// TestSwaggerInitScriptBootstrapsTheEmbeddedDocument locks the generated
// bootstrap line required by the takeover contract.
func TestSwaggerInitScriptBootstrapsTheEmbeddedDocument(t *testing.T) {
	script := string(buildSwaggerInitJS())
	want := `window.onload = function(){ window.ui = SwaggerUIBundle({url: "/docs/json", dom_id: "#swagger-ui", deepLinking: true, presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], plugins: [SwaggerUIBundle.plugins.DownloadUrl], layout: "StandaloneLayout"}); };`
	if !strings.Contains(script, want) {
		t.Fatalf("init script = %q, want it to contain %q", script, want)
	}
	if strings.Contains(script, "http://") || strings.Contains(script, "https://") {
		t.Fatalf("init script must not reference a CDN: %q", script)
	}
}
