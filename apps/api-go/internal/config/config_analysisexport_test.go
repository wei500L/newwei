package config

import (
	"strings"
	"testing"
)

// TestAnalysisExportModeDefaultsToLegacy locks the default, the empty value and
// the explicitly accepted legacy spelling.
func TestAnalysisExportModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AnalysisExportMode != AnalysisExportModeLegacy {
		t.Fatalf("mode = %s", cfg.AnalysisExportMode)
	}
	for _, accepted := range []string{"", "legacy", "  legacy  "} {
		cfg, err := Load(func(key string) string {
			if key == "API_GO_ANALYSIS_EXPORT_MODE" {
				return accepted
			}
			return ""
		})
		if err != nil {
			t.Fatalf("accepted %q: %v", accepted, err)
		}
		if cfg.AnalysisExportMode != AnalysisExportModeLegacy {
			t.Fatalf("accepted %q mode = %s", accepted, cfg.AnalysisExportMode)
		}
	}
}

// TestAnalysisExportModeRejectsInvalid locks the startup failure and that the
// message names the variable and echoes the rejected value.
func TestAnalysisExportModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "canary", "Go", "true", "1"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_ANALYSIS_EXPORT_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_ANALYSIS_EXPORT_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

// TestAnalysisExportModeGoRequiresCredentialsAndMongo locks the startup resource
// set: JWT, MySQL, Redis and Mongo are mandatory, while the neighbouring
// analysis and item switches stay legacy.
func TestAnalysisExportModeGoRequiresCredentialsAndMongo(t *testing.T) {
	values := map[string]string{"API_GO_ANALYSIS_EXPORT_MODE": "go"}
	load := func() (Config, error) {
		return Load(func(key string) string { return values[key] })
	}

	_, err := load()
	if err == nil {
		t.Fatal("expected a startup failure")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_ANALYSIS_EXPORT_MODE=go",
		"DATABASE_URL is required when API_GO_ANALYSIS_EXPORT_MODE=go",
		"REDIS_HOST is required when API_GO_ANALYSIS_EXPORT_MODE=go",
		"MONGO_URI is required when API_GO_ANALYSIS_EXPORT_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q in %v", want, err)
		}
	}

	values["JWT_SECRET"] = "secret"
	values["DATABASE_URL"] = "mysql://user:pass@127.0.0.1:3306/db"
	values["REDIS_HOST"] = "127.0.0.1"
	values["MONGO_URI"] = "mongodb://127.0.0.1:27017/app"

	cfg, err := load()
	if err != nil {
		t.Fatalf("complete configuration rejected: %v", err)
	}
	if cfg.AnalysisExportMode != AnalysisExportModeGo {
		t.Fatalf("mode = %s", cfg.AnalysisExportMode)
	}
	// The export unit initializes its own readers, so none of the neighbouring
	// switches may be turned on implicitly.
	if cfg.AnalysisViewsMode != AnalysisViewsModeLegacy ||
		cfg.AnalysisBoardsMode != AnalysisBoardsModeLegacy ||
		cfg.AnalysisThreadsMode != AnalysisThreadsModeLegacy ||
		cfg.ItemsReadingMode != ItemsReadingModeLegacy ||
		cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("neighbour switches changed: %s/%s/%s/%s/%s", cfg.AnalysisViewsMode,
			cfg.AnalysisBoardsMode, cfg.AnalysisThreadsMode, cfg.ItemsReadingMode, cfg.GraphQLReadMode)
	}
}
