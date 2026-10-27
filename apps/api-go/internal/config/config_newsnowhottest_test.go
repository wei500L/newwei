package config

import (
	"strings"
	"testing"
)

// TestNewsnowHottestModesDefaultToLegacy pins the empty-string compatibility:
// both switches keep the current NestJS owners.
func TestNewsnowHottestModesDefaultToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.NewsnowHottestMode != NewsnowHottestModeGo {
		t.Fatalf("hottest mode = %s", cfg.NewsnowHottestMode)
	}
	if cfg.NewsnowBackgroundMode != NewsnowBackgroundModeGo {
		t.Fatalf("background mode = %s", cfg.NewsnowBackgroundMode)
	}
}

// TestNewsnowHottestModesAcceptGo checks both switches independently.
func TestNewsnowHottestModesAcceptGo(t *testing.T) {
	env := func(key string) string {
		switch key {
		case "API_GO_NEWSNOW_HOTTEST_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://root:secret@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "127.0.0.1"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/app"
		default:
			return ""
		}
	}
	cfg, err := Load(legacyUnset(env))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowHottestMode != NewsnowHottestModeGo {
		t.Fatalf("hottest mode = %s", cfg.NewsnowHottestMode)
	}

	cfg, err = Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWSNOW_BACKGROUND_MODE" {
			return "go"
		}
		return env(key)
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowBackgroundMode != NewsnowBackgroundModeGo {
		t.Fatalf("background mode = %s", cfg.NewsnowBackgroundMode)
	}
}

// TestNewsnowHottestModesRejectInvalid fails startup for any third value.
func TestNewsnowHottestModesRejectInvalid(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWSNOW_HOTTEST_MODE" {
			return "shadow"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWSNOW_HOTTEST_MODE must be one of legacy|go") {
		t.Fatalf("invalid hottest mode: %v", err)
	}

	_, err = Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWSNOW_BACKGROUND_MODE" {
			return "canary"
		}
		return ""
	}))
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWSNOW_BACKGROUND_MODE must be one of legacy|go") {
		t.Fatalf("invalid background mode: %v", err)
	}
}

// TestNewsnowHottestModeRequiresFullStack requires JWT, MySQL, Redis and Mongo.
func TestNewsnowHottestModeRequiresFullStack(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWSNOW_HOTTEST_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("expected startup error")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_NEWSNOW_HOTTEST_MODE=go",
		"DATABASE_URL is required when API_GO_NEWSNOW_HOTTEST_MODE=go",
		"REDIS_HOST is required when API_GO_NEWSNOW_HOTTEST_MODE=go",
		"MONGO_URI is required when API_GO_NEWSNOW_HOTTEST_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q in %v", want, err)
		}
	}
}

// TestNewsnowBackgroundModeRequiresStores keeps the background owner free of
// JWT while requiring its three stores.
func TestNewsnowBackgroundModeRequiresStores(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_NEWSNOW_BACKGROUND_MODE" {
			return "go"
		}
		return ""
	}))
	if err == nil {
		t.Fatal("expected startup error")
	}
	for _, want := range []string{
		"DATABASE_URL is required when API_GO_NEWSNOW_BACKGROUND_MODE=go",
		"REDIS_HOST is required when API_GO_NEWSNOW_BACKGROUND_MODE=go",
		"MONGO_URI is required when API_GO_NEWSNOW_BACKGROUND_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q in %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "JWT_SECRET is required when API_GO_NEWSNOW_BACKGROUND_MODE=go") {
		t.Fatalf("background mode must not require jwt: %v", err)
	}
}
