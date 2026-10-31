package schema

import "testing"

// TestEmbeddedSchemaVersionMatchesSource guards the embed/version invariant
// without depending on the legacy apps/api directory: Version must stay the
// SHA-256 of the exact embedded SDL, because response-cache keys are derived
// from it. The cross-source byte comparison with the Nest generator output is
// now a CI transition guard (the "Contract copies in sync" step), not a Go
// test, so this package keeps compiling after apps/api is removed.
func TestEmbeddedSchemaVersionMatchesSource(t *testing.T) {
	if Source() == "" {
		t.Fatal("embedded SDL is empty")
	}
	if Version != sha256Hex(Source()) {
		t.Fatalf("Version %q is not the SHA-256 of the embedded SDL", Version)
	}
	if len(Version) != 64 {
		t.Fatalf("Version %q is not a 64-char hex digest", Version)
	}
}

func TestSchemaLoads(t *testing.T) {
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"alertChannels",
		"alertEvents",
		"alertEventReplay",
		"alertRuleTuningSuggestion",
		"analysisResults",
		"assistantRuns",
		"assistantEconomicSeriesSuggestions",
		"assistantRuntimeCapabilities",
		"notifications",
		"unreadNotificationCount",
		"getEconomicData",
		"getEconomicDataWithInsights",
		"getEconomicDataInsights",
		"getEconomicDataPaginated",
		"economicDataFetchConfigs",
		"economicDataRefreshPresetStatus",
		"alertRules",
	} {
		if loaded.Query.Fields.ForName(name) == nil {
			t.Fatalf("Query.%s missing from embedded SDL", name)
		}
	}
}
