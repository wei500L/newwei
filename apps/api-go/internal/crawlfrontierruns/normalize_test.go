package crawlfrontierruns

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// TestNormalizeConfigJSON verifies that the exported crawlprofile entry point
// used by the run detail response applies the shared normalization.
func TestNormalizeConfigJSON(t *testing.T) {
	normalized, err := crawlprofile.NormalizeConfigJSON(json.RawMessage(
		`{"keywords":["alpha"," beta ","","alpha",7],"hostScope":"Strict_Hosts","seedDiscovery":{"mode":"common_paths"}}`))
	if err != nil {
		t.Fatalf("NormalizeConfigJSON: %v", err)
	}
	var view struct {
		Keywords      []string `json:"keywords"`
		HostScope     string   `json:"hostScope"`
		SeedDiscovery struct {
			Mode string `json:"mode"`
		} `json:"seedDiscovery"`
	}
	if err := json.Unmarshal(normalized, &view); err != nil {
		t.Fatalf("decode normalized config: %v", err)
	}
	if !reflect.DeepEqual(view.Keywords, []string{"alpha", "beta"}) {
		t.Fatalf("keywords = %v", view.Keywords)
	}
	if view.HostScope != "strict_hosts" {
		t.Fatalf("hostScope = %q", view.HostScope)
	}
	if view.SeedDiscovery.Mode != "common_paths" {
		t.Fatalf("seedDiscovery.mode = %q", view.SeedDiscovery.Mode)
	}
}

// TestNormalizeConfigJSONRejectsLLMOptions verifies that the shared validation
// errors surface unchanged through the exported wrapper.
func TestNormalizeConfigJSONRejectsLLMOptions(t *testing.T) {
	if _, err := crawlprofile.NormalizeConfigJSON(json.RawMessage(`{"llmConfig":{}}`)); err == nil {
		t.Fatal("crawl4ai LLM options must be rejected")
	}
}
