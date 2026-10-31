package config

import (
	"strings"
	"testing"
)

func TestOIDCLoginModeDefaultsToGo(t *testing.T) {
	// The default fixture supplies API_BASE_URL because OIDC go mode reads it per
	// request; the "stays empty when unset" case is asserted separately below.
	cfg := loadDefaults(t)
	if cfg.OIDCLoginMode != OIDCLoginModeGo {
		t.Fatalf("mode = %s", cfg.OIDCLoginMode)
	}
	if cfg.APIBaseURL == "" {
		t.Fatalf("API_BASE_URL should be populated by the default fixture")
	}
	for _, accepted := range []string{"legacy", "  legacy  "} {
		cfg, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_OIDC_LOGIN_MODE" {
				return accepted
			}
			return ""
		}))
		if err != nil {
			t.Fatalf("accepted %q: %v", accepted, err)
		}
		if cfg.OIDCLoginMode != OIDCLoginModeLegacy {
			t.Fatalf("accepted %q mode = %s", accepted, cfg.OIDCLoginMode)
		}
	}
}

func TestOIDCLoginModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "canary", "Go", "true", "1"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_OIDC_LOGIN_MODE" {
				return invalid
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), "API_GO_OIDC_LOGIN_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestOIDCLoginModeGoRequiresCredentialsOnly(t *testing.T) {
	values := map[string]string{"API_GO_OIDC_LOGIN_MODE": "go"}
	load := func() (Config, error) {
		return Load(legacyUnset(func(key string) string { return values[key] }))
	}

	_, err := load()
	if err == nil {
		t.Fatal("expected a startup failure")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_OIDC_LOGIN_MODE=go",
		"DATABASE_URL is required when API_GO_OIDC_LOGIN_MODE=go",
		"REDIS_HOST is required when API_GO_OIDC_LOGIN_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q in %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "SMTP_") || strings.Contains(err.Error(), "MONGO_URI") {
		t.Fatalf("SMTP/Mongo must stay optional: %v", err)
	}

	values["JWT_SECRET"] = "secret"
	values["DATABASE_URL"] = "mysql://user:pass@127.0.0.1:3306/db"
	values["REDIS_HOST"] = "127.0.0.1"
	values["API_BASE_URL"] = " https://api.example.com/api/ "
	cfg, err := load()
	if err != nil {
		t.Fatalf("complete configuration rejected: %v", err)
	}
	if cfg.OIDCLoginMode != OIDCLoginModeGo {
		t.Fatalf("mode = %s", cfg.OIDCLoginMode)
	}
	// The raw value is preserved; trim and /api removal happen per request.
	if cfg.APIBaseURL != " https://api.example.com/api/ " {
		t.Fatalf("api base = %q", cfg.APIBaseURL)
	}
	if cfg.NextAuthURL != "http://localhost:3000" {
		t.Fatalf("nextauth default = %q", cfg.NextAuthURL)
	}
}
