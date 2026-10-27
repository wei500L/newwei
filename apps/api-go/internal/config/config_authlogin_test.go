package config

import (
	"strings"
	"testing"
)

// TestAuthLoginModeDefaultsToLegacy locks the default, the empty value and the
// explicitly accepted legacy spelling.
func TestAuthLoginModeDefaultsToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.AuthLoginMode != AuthLoginModeGo {
		t.Fatalf("mode = %s", cfg.AuthLoginMode)
	}
	for _, accepted := range []string{"legacy", "  legacy  "} {
		cfg, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_AUTH_LOGIN_MODE" {
				return accepted
			}
			return ""
		}))
		if err != nil {
			t.Fatalf("accepted %q: %v", accepted, err)
		}
		if cfg.AuthLoginMode != AuthLoginModeLegacy {
			t.Fatalf("accepted %q mode = %s", accepted, cfg.AuthLoginMode)
		}
	}
}

// TestAuthLoginModeRejectsInvalid locks the startup failure: shadow and canary
// are not accepted by this unit, so a typo cannot silently degrade to NestJS.
func TestAuthLoginModeRejectsInvalid(t *testing.T) {
	for _, invalid := range []string{"shadow", "canary", "Go", "true", "1"} {
		_, err := Load(legacyUnset(func(key string) string {
			if key == "API_GO_AUTH_LOGIN_MODE" {
				return invalid
			}
			return ""
		}))
		if err == nil || !strings.Contains(err.Error(), "API_GO_AUTH_LOGIN_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

// TestAuthLoginModeGoRequiresCredentialsAndSMTP locks the startup resource set:
// JWT, MySQL, Redis and the SMTP quartet are mandatory, while Mongo and the
// settings-encryption key stay optional.
func TestAuthLoginModeGoRequiresCredentialsAndSMTP(t *testing.T) {
	values := map[string]string{"API_GO_AUTH_LOGIN_MODE": "go"}
	load := func() (Config, error) {
		return Load(legacyUnset(func(key string) string { return values[key] }))
	}

	_, err := load()
	if err == nil {
		t.Fatal("expected a startup failure")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_AUTH_LOGIN_MODE=go",
		"DATABASE_URL is required when API_GO_AUTH_LOGIN_MODE=go",
		"REDIS_HOST is required when API_GO_AUTH_LOGIN_MODE=go",
		"SMTP_HOST is required when API_GO_AUTH_LOGIN_MODE=go",
		"SMTP_PORT is required when API_GO_AUTH_LOGIN_MODE=go",
		"SMTP_USER is required when API_GO_AUTH_LOGIN_MODE=go",
		"SMTP_PASS is required when API_GO_AUTH_LOGIN_MODE=go",
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
	if cfg.AuthLoginMode != AuthLoginModeGo {
		t.Fatalf("mode = %s", cfg.AuthLoginMode)
	}
	// Reaching this point with neither MONGO_URI nor
	// SYSTEM_SETTINGS_ENCRYPTION_KEY set proves both stay optional.
	_ = cfg
	// SMTP defaults documented by Env.smtpConfig.
	if !cfg.SMTP.Secure || !cfg.SMTP.TLSRejectUnauthorized {
		t.Fatalf("smtp defaults = %+v", cfg.SMTP)
	}
	if cfg.SMTP.ConnectionTimeoutMs != 10_000 || cfg.SMTP.GreetingTimeoutMs != 10_000 || cfg.SMTP.SocketTimeoutMs != 30_000 {
		t.Fatalf("smtp timeouts = %+v", cfg.SMTP)
	}
	// SMTP_FROM falls back to the authenticated user.
	if cfg.SMTP.From != cfg.SMTP.User {
		t.Fatalf("smtp from = %q, want the user", cfg.SMTP.From)
	}
}

// TestAuthLoginDefaults locks the login-chain environment defaults the service
// falls back to when no SystemSetting row exists.
func TestAuthLoginDefaults(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.JWTAccessExpiresIn != "15m" || cfg.JWTRefreshExpiresIn != "7d" {
		t.Fatalf("jwt lifetimes = %q / %q", cfg.JWTAccessExpiresIn, cfg.JWTRefreshExpiresIn)
	}
	if cfg.AuthRefreshGraceSeconds != 10 || cfg.AuthMfaChallengeMaxAttempts != 5 {
		t.Fatalf("grace/attempts = %d / %d", cfg.AuthRefreshGraceSeconds, cfg.AuthMfaChallengeMaxAttempts)
	}
	if cfg.AuthEmailCodeTTLSeconds != 300 || cfg.AuthEmailCodeCooldownSeconds != 90 || cfg.AuthEmailCodeMaxAttempts != 3 {
		t.Fatalf("email code defaults = %d / %d / %d",
			cfg.AuthEmailCodeTTLSeconds, cfg.AuthEmailCodeCooldownSeconds, cfg.AuthEmailCodeMaxAttempts)
	}
	if cfg.NextAuthURL != "http://localhost:3000" {
		t.Fatalf("nextauth url = %q", cfg.NextAuthURL)
	}
	if !cfg.SMTP.Secure || cfg.SMTP.Pool {
		t.Fatalf("smtp defaults = %+v", cfg.SMTP)
	}
}
