package config

import (
	"strings"
	"testing"
)

func TestSituationInsightsModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.SituationInsightsMode != SituationInsightsModeGo {
		t.Fatalf("mode = %s", cfg.SituationInsightsMode)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_SITUATION_INSIGHTS_MODE" {
			return "legacy"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationInsightsMode != SituationInsightsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationInsightsMode)
	}
}

func TestSituationInsightsModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "canary", "Go", "true", "go\tshadow"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_SITUATION_INSIGHTS_MODE" {
				return invalid
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), "API_GO_SITUATION_INSIGHTS_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestSituationInsightsModeGoRequiresCredentials(t *testing.T) {
	full := map[string]string{
		"API_GO_SITUATION_INSIGHTS_MODE": "go",
		"JWT_SECRET":                     "secret",
		"DATABASE_URL":                   "mysql://user:pass@127.0.0.1:3306/app",
		"REDIS_HOST":                     "redis",
		"MONGO_URI":                      "mongodb://127.0.0.1:27017/app",
	}
	for missing, expected := range map[string]string{
		"JWT_SECRET":   "JWT_SECRET is required when API_GO_SITUATION_INSIGHTS_MODE=go",
		"DATABASE_URL": "DATABASE_URL is required when API_GO_SITUATION_INSIGHTS_MODE=go",
		"REDIS_HOST":   "REDIS_HOST is required when API_GO_SITUATION_INSIGHTS_MODE=go",
		"MONGO_URI":    "MONGO_URI is required when API_GO_SITUATION_INSIGHTS_MODE=go",
	} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == missing {
				return ""
			}
			return full[key]
		}))
		if err == nil || !strings.Contains(err.Error(), expected) {
			t.Fatalf("missing %s: %v", missing, err)
		}
	}
	cfg, err := Load(legacyUnset(func(key string) string { return full[key] }))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationInsightsMode != SituationInsightsModeGo {
		t.Fatalf("mode = %s", cfg.SituationInsightsMode)
	}
}
