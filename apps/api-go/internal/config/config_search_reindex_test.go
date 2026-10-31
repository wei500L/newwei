package config

import (
	"strings"
	"testing"
)

// TestSearchReindexModeDefaultsToLegacy pins the default: an unset variable and
// the explicit "legacy" value both keep the two reindex routes on NestJS.
func TestSearchReindexModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.SearchReindexMode != SearchReindexModeGo {
		t.Fatalf("mode = %s", cfg.SearchReindexMode)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_SEARCH_REINDEX_MODE" {
			return "legacy"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SearchReindexMode != SearchReindexModeLegacy {
		t.Fatalf("mode = %s", cfg.SearchReindexMode)
	}
}

// TestSearchReindexModeRejectsInvalid keeps the switch fail-closed.
func TestSearchReindexModeRejectsInvalid(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_SEARCH_REINDEX_MODE" {
			return "shadow"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_SEARCH_REINDEX_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

// TestSearchReindexModeGoRequiresCredentials covers the JWT/MySQL/Redis chain
// plus MONGO_URI, which the item read model needs.
func TestSearchReindexModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SEARCH_REINDEX_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	}))
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_SEARCH_REINDEX_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SEARCH_REINDEX_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	}))
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_SEARCH_REINDEX_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SEARCH_REINDEX_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/app"
		default:
			return ""
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SearchReindexMode != SearchReindexModeGo {
		t.Fatalf("mode = %s", cfg.SearchReindexMode)
	}
}
