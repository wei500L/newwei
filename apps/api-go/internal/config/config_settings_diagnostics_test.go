package config

import (
	"strings"
	"testing"
)

// settingsDiagnosticsEnv returns an environment with the shared credentialed
// stack and, when smtp is true, the SMTP quartet the email routes need.
func settingsDiagnosticsEnv(extra map[string]string, smtp bool) func(string) string {
	return func(key string) string {
		if value, ok := extra[key]; ok {
			return value
		}
		switch key {
		case "JWT_SECRET":
			return "test-secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "SMTP_HOST":
			if !smtp {
				return ""
			}
			return "smtp.example.com"
		case "SMTP_PORT":
			if !smtp {
				return ""
			}
			return "465"
		case "SMTP_USER":
			if !smtp {
				return ""
			}
			return "mailer@example.com"
		case "SMTP_PASS":
			if !smtp {
				return ""
			}
			return "secret"
		default:
			return ""
		}
	}
}

func TestSettingsDiagnosticsModesDefaultGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.EmailSettingsMode != EmailSettingsModeGo {
		t.Fatalf("EmailSettingsMode = %q, want go", cfg.EmailSettingsMode)
	}
	if cfg.GeocodingMode != GeocodingModeGo {
		t.Fatalf("GeocodingMode = %q, want go", cfg.GeocodingMode)
	}
	if cfg.RuntimeDiagnosticsMode != RuntimeDiagnosticsModeGo {
		t.Fatalf("RuntimeDiagnosticsMode = %q, want go", cfg.RuntimeDiagnosticsMode)
	}
}

func TestSettingsDiagnosticsModesRejectInvalidValues(t *testing.T) {
	cases := map[string]string{
		"API_GO_EMAIL_SETTINGS_MODE":      "API_GO_EMAIL_SETTINGS_MODE must be one of legacy|go",
		"API_GO_GEOCODING_MODE":           "API_GO_GEOCODING_MODE must be one of legacy|go",
		"API_GO_RUNTIME_DIAGNOSTICS_MODE": "API_GO_RUNTIME_DIAGNOSTICS_MODE must be one of legacy|go",
	}
	for key, want := range cases {
		_, err := Load(func(name string) string {
			if name == key {
				return "sometimes"
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s invalid mode error = %v", key, err)
		}
	}
}

func TestEmailSettingsModeRequiresSMTP(t *testing.T) {
	_, err := Load(settingsDiagnosticsEnv(map[string]string{
		"API_GO_EMAIL_SETTINGS_MODE": "go",
	}, false))
	if err == nil {
		t.Fatal("expected a startup error without SMTP configuration")
	}
	for _, want := range []string{
		"SMTP_HOST is required when API_GO_EMAIL_SETTINGS_MODE=go",
		"SMTP_PORT is required when API_GO_EMAIL_SETTINGS_MODE=go",
		"SMTP_USER is required when API_GO_EMAIL_SETTINGS_MODE=go",
		"SMTP_PASS is required when API_GO_EMAIL_SETTINGS_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
}

func TestEmailSettingsModeAcceptsFullStack(t *testing.T) {
	cfg, err := Load(settingsDiagnosticsEnv(map[string]string{
		"API_GO_EMAIL_SETTINGS_MODE": "go",
	}, true))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EmailSettingsMode != EmailSettingsModeGo {
		t.Fatalf("EmailSettingsMode = %q, want go", cfg.EmailSettingsMode)
	}
	// The four pool/scheduling fields are part of the 14-field status
	// response and must keep the NestJS schema defaults.
	if cfg.SMTP.MaxConnections != 5 || cfg.SMTP.MaxMessages != 100 ||
		cfg.SMTP.RateDeltaMs != 1000 || cfg.SMTP.RateLimit != 10 {
		t.Fatalf("SMTP pool defaults = %d/%d/%d/%d", cfg.SMTP.MaxConnections,
			cfg.SMTP.MaxMessages, cfg.SMTP.RateDeltaMs, cfg.SMTP.RateLimit)
	}
	if cfg.SMTP.From != "mailer@example.com" {
		t.Fatalf("SMTP.From = %q, want the user fallback", cfg.SMTP.From)
	}
}

func TestGeocodingModeNeedsOnlyCredentialedStack(t *testing.T) {
	cfg, err := Load(settingsDiagnosticsEnv(map[string]string{
		"API_GO_GEOCODING_MODE": "go",
	}, false))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GeocodingMode != GeocodingModeGo {
		t.Fatalf("GeocodingMode = %q, want go", cfg.GeocodingMode)
	}
	if cfg.MongoURI != "" {
		t.Fatalf("MongoURI = %q, want empty", cfg.MongoURI)
	}
}

func TestRuntimeDiagnosticsModeRequiresMongo(t *testing.T) {
	_, err := Load(settingsDiagnosticsEnv(map[string]string{
		"API_GO_RUNTIME_DIAGNOSTICS_MODE": "go",
	}, false))
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_RUNTIME_DIAGNOSTICS_MODE=go") {
		t.Fatalf("missing Mongo error = %v", err)
	}
	cfg, err := Load(settingsDiagnosticsEnv(map[string]string{
		"API_GO_RUNTIME_DIAGNOSTICS_MODE": "go",
		"MONGO_URI":                       "mongodb://mongo:27017/app",
	}, false))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeDiagnosticsMode != RuntimeDiagnosticsModeGo {
		t.Fatalf("RuntimeDiagnosticsMode = %q, want go", cfg.RuntimeDiagnosticsMode)
	}
}
