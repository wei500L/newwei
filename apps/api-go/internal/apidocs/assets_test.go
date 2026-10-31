package apidocs

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestEmbeddedSnapshotKeepsTheDocumentContract locks the OpenAPI version and
// the info.completeness block that must survive the copy unchanged.
func TestEmbeddedSnapshotKeepsTheDocumentContract(t *testing.T) {
	var document struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Title        string          `json:"title"`
			Completeness json.RawMessage `json:"completeness"`
		} `json:"info"`
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(openapiSnapshot, &document); err != nil {
		t.Fatalf("embedded snapshot is not JSON: %v", err)
	}
	if document.OpenAPI != "3.0.3" {
		t.Fatalf("openapi = %q, want 3.0.3", document.OpenAPI)
	}
	if document.Info.Title == "" {
		t.Fatal("info.title is empty")
	}
	if len(document.Info.Completeness) == 0 {
		t.Fatal("info.completeness is missing")
	}
	if !strings.Contains(string(document.Info.Completeness), `"routes"`) {
		t.Fatalf("info.completeness = %s", document.Info.Completeness)
	}
	if len(document.Paths) < 100 {
		t.Fatalf("paths = %d, want the full contract snapshot", len(document.Paths))
	}
}

// TestEmbeddedAssetsMatchTheVendoredFiles locks every go:embed directive
// against the file it names, so a partially updated copy fails the test instead
// of serving mismatched bytes.
func TestEmbeddedAssetsMatchTheVendoredFiles(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{"openapi.snapshot.json", openapiSnapshot},
		{"assets/swagger-ui.css", swaggerUICSS},
		{"assets/swagger-ui-bundle.js", swaggerUIBundle},
		{"assets/swagger-ui-standalone-preset.js", swaggerUIStandalonePreset},
		{"assets/favicon-16x16.png", favicon16},
		{"assets/favicon-32x32.png", favicon32},
		{"assets/oauth2-redirect.html", oauth2RedirectHTML},
		{"assets/oauth2-redirect.js", oauth2RedirectJS},
	}
	for _, tc := range cases {
		want, err := os.ReadFile(tc.name)
		if err != nil {
			t.Fatalf("read %s: %v", tc.name, err)
		}
		if len(tc.body) == 0 {
			t.Fatalf("%s embedded no bytes", tc.name)
		}
		if !bytes.Equal(tc.body, want) {
			t.Fatalf("embedded %s differs from the vendored file", tc.name)
		}
	}
}

// TestVendoredAttributionAndProvenanceFilesRemain locks the licensing material
// next to the assets even though it is never served over HTTP.
func TestVendoredAttributionAndProvenanceFilesRemain(t *testing.T) {
	for _, name := range []string{
		"assets/LICENSE",
		"assets/NOTICE",
		"assets/SOURCE.md",
		"assets/swagger-ui-bundle.js.LICENSE.txt",
		"assets/swagger-ui-standalone-preset.js.LICENSE.txt",
	} {
		if _, err := os.Stat(name); err != nil {
			t.Fatalf("vendored file %s: %v", name, err)
		}
	}
}
