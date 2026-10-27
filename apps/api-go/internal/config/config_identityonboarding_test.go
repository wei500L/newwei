package config

import (
	"strings"
	"testing"
)

// TestIdentityOnboardingModeDefaultsToLegacy locks the default, the empty value
// and the explicitly accepted legacy spelling.
func TestIdentityOnboardingModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.IdentityOnboardingMode != IdentityOnboardingModeGo {
		t.Fatalf("mode = %s", cfg.IdentityOnboardingMode)
	}
	for _, accepted := range []string{"legacy", "  legacy  "} {
		cfg, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_IDENTITY_ONBOARDING_MODE" {
				return accepted
			}
			return ""
		}))
		if err != nil {
			t.Fatalf("accepted %q: %v", accepted, err)
		}
		if cfg.IdentityOnboardingMode != IdentityOnboardingModeLegacy {
			t.Fatalf("accepted %q mode = %s", accepted, cfg.IdentityOnboardingMode)
		}
	}
}

// TestIdentityOnboardingModeRejectsInvalid locks the startup failure: shadow and
// canary are not accepted by this unit.
func TestIdentityOnboardingModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "canary", "Go", "true", "1"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_IDENTITY_ONBOARDING_MODE" {
				return invalid
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), "API_GO_IDENTITY_ONBOARDING_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

// TestIdentityOnboardingModeGoRequiresCredentialsAndSMTP locks the startup
// resource set: JWT, MySQL, Redis and the SMTP quartet are mandatory, while Mongo
// and every other migration switch stay untouched.
func TestIdentityOnboardingModeGoRequiresCredentialsAndSMTP(t *testing.T) {
	values := map[string]string{"API_GO_IDENTITY_ONBOARDING_MODE": "go"}
	load := func() (Config, error) {
		return Load(legacyUnset(func(key string) string { return values[key] }))
	}

	_, err := load()
	if err == nil {
		t.Fatal("expected a startup failure")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
		"DATABASE_URL is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
		"REDIS_HOST is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
		"SMTP_HOST is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
		"SMTP_PORT is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
		"SMTP_USER is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
		"SMTP_PASS is required when API_GO_IDENTITY_ONBOARDING_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("missing %q in %v", want, err)
		}
	}

	values["JWT_SECRET"] = "secret"
	values["DATABASE_URL"] = "mysql://user:pass@127.0.0.1:3306/db"
	values["REDIS_HOST"] = "127.0.0.1"
	values["SMTP_HOST"] = "smtp.example.com"
	values["SMTP_PORT"] = "465"
	values["SMTP_USER"] = "mailer@example.com"
	values["SMTP_PASS"] = "hunter2"

	cfg, err := load()
	if err != nil {
		t.Fatalf("complete configuration rejected: %v", err)
	}
	if cfg.IdentityOnboardingMode != IdentityOnboardingModeGo {
		t.Fatalf("mode = %s", cfg.IdentityOnboardingMode)
	}
	// Reaching this point with neither MONGO_URI nor the other migration switches
	// set proves the unit is independent of them.
	if cfg.AuthLoginMode != AuthLoginModeLegacy || cfg.AuthFactorsMode != AuthFactorsModeLegacy ||
		cfg.AccountSecurityMode != AccountSecurityModeLegacy || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("neighbour switches changed: %s/%s/%s/%s", cfg.AuthLoginMode, cfg.AuthFactorsMode,
			cfg.AccountSecurityMode, cfg.GraphQLReadMode)
	}
}
