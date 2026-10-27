package config

import (
	"strings"
	"testing"
)

func TestSituationSettingsModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.SituationSettingsMode != SituationSettingsModeGo {
		t.Fatalf("mode = %s", cfg.SituationSettingsMode)
	}
	cfg, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_SITUATION_SETTINGS_MODE" {
			return "legacy"
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSettingsMode != SituationSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationSettingsMode)
	}
}

func TestSituationSettingsModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "canary", "Go"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_SITUATION_SETTINGS_MODE" {
				return invalid
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), "API_GO_SITUATION_SETTINGS_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestSituationSettingsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SITUATION_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	}))
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_SITUATION_SETTINGS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	_, err = Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SITUATION_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "SYSTEM_SETTINGS_ENCRYPTION_KEY":
			return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		default:
			return ""
		}
	}))
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_SITUATION_SETTINGS_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}

	_, err = Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SITUATION_SETTINGS_MODE":
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
	if err == nil || !strings.Contains(err.Error(), "SYSTEM_SETTINGS_ENCRYPTION_KEY is required when API_GO_SITUATION_SETTINGS_MODE=go") {
		t.Fatalf("missing encryption key: %v", err)
	}

	cfg, err := Load(legacyUnset(func(key string) string {
		switch key {
		case "API_GO_SITUATION_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://127.0.0.1:27017/app"
		case "SYSTEM_SETTINGS_ENCRYPTION_KEY":
			return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		default:
			return ""
		}
	}))
	if err != nil {
		t.Fatalf("complete go stack: %v", err)
	}
	if cfg.SituationSettingsMode != SituationSettingsModeGo {
		t.Fatalf("mode = %s", cfg.SituationSettingsMode)
	}
}

// A legacy deployment keeps main's behavior even when the new mode's
// dependencies are absent.
func TestSituationSettingsLegacyNeedsNoExtraDependencies(t *testing.T) {
	cfg, err := Load(legacyUnset(func(key string) string {
		if key == "API_GO_SITUATION_SETTINGS_MODE" {
			return ""
		}
		return ""
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSettingsMode != SituationSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationSettingsMode)
	}
}
