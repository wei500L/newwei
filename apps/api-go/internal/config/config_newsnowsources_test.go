package config

import (
	"strings"
	"testing"
)

// TestNewsnowSourcesModeDefaultsToLegacy pins the default and the empty-string
// compatibility: both keep the two public routes on NestJS.
func TestNewsnowSourcesModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowSourcesMode != NewsnowSourcesModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsnowSourcesMode)
	}

	cfg, err = Load(func(key string) string {
		if key == "API_GO_NEWSNOW_SOURCES_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowSourcesMode != NewsnowSourcesModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsnowSourcesMode)
	}
}

// TestNewsnowSourcesModeRejectsInvalid fails startup for any third value.
func TestNewsnowSourcesModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_NEWSNOW_SOURCES_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWSNOW_SOURCES_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

// TestNewsnowSourcesModeRequiresDatabaseAndRedis keeps the anonymous boundary:
// MySQL and Redis are required, JWT/Mongo are not.
func TestNewsnowSourcesModeRequiresDatabaseAndRedis(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_NEWSNOW_SOURCES_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL is required when API_GO_NEWSNOW_SOURCES_MODE=go") {
		t.Fatalf("missing database: %v", err)
	}
	if !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_NEWSNOW_SOURCES_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWSNOW_SOURCES_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@localhost:3306/db"
		case "REDIS_HOST":
			return "localhost"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("go mode must not require JWT/Mongo: %v", err)
	}
	if cfg.NewsnowSourcesMode != NewsnowSourcesModeGo {
		t.Fatalf("mode = %s", cfg.NewsnowSourcesMode)
	}
}
