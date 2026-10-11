package schema

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEmbeddedSchemaMatchesAPI(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	apiSchema := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "api", "schema.gql"))
	raw, err := os.ReadFile(apiSchema)
	if err != nil {
		t.Fatalf("read %s: %v", apiSchema, err)
	}
	if string(raw) != Source() {
		t.Fatalf("embedded SDL drifted from %s", apiSchema)
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
