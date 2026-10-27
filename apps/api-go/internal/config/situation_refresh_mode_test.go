package config

import (
	"strings"
	"testing"
)

// situationRefreshEnv is the smallest environment that satisfies every
// requirement of API_GO_SITUATION_REFRESH_MODE=go: the credentialed stack plus
// the two prerequisite switches.
func situationRefreshEnv(overrides map[string]string) func(string) string {
	values := map[string]string{
		"JWT_SECRET":                           "test-secret",
		"DATABASE_URL":                         "mysql://root:secret@127.0.0.1:3306/app",
		"REDIS_HOST":                           "127.0.0.1",
		"API_GO_SITUATION_REFRESH_MODE":        "go",
		"API_GO_SITUATION_SIGNALS_WORKER_MODE": "go",
		"API_GO_NEWS_SOURCE_SCHEDULER_MODE":    "go",
	}
	for key, value := range overrides {
		if value == "" {
			delete(values, key)
			continue
		}
		values[key] = value
	}
	return func(key string) string { return values[key] }
}

func TestLoadSituationRefreshModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.SituationRefreshMode != SituationRefreshModeGo {
		t.Fatalf("SituationRefreshMode = %q, want go", cfg.SituationRefreshMode)
	}
}

func TestLoadSituationRefreshModeAcceptsLegacyAndGo(t *testing.T) {
	cfg, err := Load(situationRefreshEnv(map[string]string{"API_GO_SITUATION_REFRESH_MODE": "legacy"}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SituationRefreshMode != SituationRefreshModeLegacy {
		t.Fatalf("SituationRefreshMode = %q, want legacy", cfg.SituationRefreshMode)
	}

	cfg, err = Load(situationRefreshEnv(nil))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.SituationRefreshMode != SituationRefreshModeGo {
		t.Fatalf("SituationRefreshMode = %q, want go", cfg.SituationRefreshMode)
	}
}

func TestLoadRejectsUnknownSituationRefreshMode(t *testing.T) {
	for _, value := range []string{"canary", "GO", "true"} {
		_, err := Load(situationRefreshEnv(map[string]string{"API_GO_SITUATION_REFRESH_MODE": value}))
		if err == nil {
			t.Fatalf("Load() accepted API_GO_SITUATION_REFRESH_MODE=%q", value)
		}
		if !strings.Contains(err.Error(), "API_GO_SITUATION_REFRESH_MODE must be one of legacy|go") {
			t.Fatalf("error = %v", err)
		}
	}
}

// TestLoadSituationRefreshModeRequiresPrerequisites pins A2: the refresh switch
// needs the Go signals worker (only the lease owner may use the Telegram session)
// and the Go news source scheduler (the dispatch entry point).
func TestLoadSituationRefreshModeRequiresPrerequisites(t *testing.T) {
	_, err := Load(situationRefreshEnv(map[string]string{
		"API_GO_SITUATION_SIGNALS_WORKER_MODE": "legacy",
	}))
	if err == nil {
		t.Fatal("Load() accepted refresh=go without the Go signals worker")
	}
	if !strings.Contains(err.Error(), "API_GO_SITUATION_SIGNALS_WORKER_MODE=go is required when API_GO_SITUATION_REFRESH_MODE=go") {
		t.Fatalf("error = %v", err)
	}

	_, err = Load(situationRefreshEnv(map[string]string{
		"API_GO_NEWS_SOURCE_SCHEDULER_MODE": "legacy",
	}))
	if err == nil {
		t.Fatal("Load() accepted refresh=go without the Go news source scheduler")
	}
	if !strings.Contains(err.Error(), "API_GO_NEWS_SOURCE_SCHEDULER_MODE=go is required when API_GO_SITUATION_REFRESH_MODE=go") {
		t.Fatalf("error = %v", err)
	}
}

func TestLoadSituationRefreshModeRequiresCredentialedStack(t *testing.T) {
	for _, missing := range []string{"JWT_SECRET", "DATABASE_URL", "REDIS_HOST"} {
		_, err := Load(situationRefreshEnv(map[string]string{missing: ""}))
		if err == nil {
			t.Fatalf("Load() accepted refresh=go without %s", missing)
		}
		if !strings.Contains(err.Error(), missing+" is required when API_GO_SITUATION_REFRESH_MODE=go") {
			t.Fatalf("%s error = %v", missing, err)
		}
	}
}
