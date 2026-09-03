package config

import (
	"strconv"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Port != 4020 {
		t.Errorf("Port = %d, want 4020", cfg.Port)
	}
	if cfg.LegacyAPIURL != "http://localhost:4000" {
		t.Errorf("LegacyAPIURL = %q, want default", cfg.LegacyAPIURL)
	}
}

func TestLoadRejectsRelativeLegacyURL(t *testing.T) {
	if _, err := Load(func(key string) string {
		if key == "LEGACY_API_URL" {
			return "localhost:4000"
		}
		return ""
	}); err == nil {
		t.Fatal("Load() should reject a non-absolute LEGACY_API_URL")
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	if _, err := Load(func(key string) string {
		if key == "PORT" {
			return "-1"
		}
		return ""
	}); err == nil {
		t.Fatal("Load() should reject PORT=-1")
	}
}

func TestLoadAcceptsExplicitConfig(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "PORT":
			return "8080"
		case "LEGACY_API_URL":
			return "http://api:4000"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Port != 8080 || cfg.LegacyAPIURL != "http://api:4000" {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestShadowDefaultsGuardResourceBudget(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ShadowTimeoutMs <= 0 || cfg.ShadowMaxBodyByte <= 0 || cfg.ShadowMaxInflight <= 0 || cfg.ShadowMaxPerMin <= 0 {
		t.Errorf("shadow budget defaults must be positive: %+v", cfg)
	}
	if cfg.CanaryPercent != 0 {
		t.Errorf("CanaryPercent default = %d, want 0 (canary 必须显式开启)", cfg.CanaryPercent)
	}
}

func TestLoadRejectsInvalidCanaryPercent(t *testing.T) {
	for _, raw := range []string{"-1", "101", "abc"} {
		if _, err := Load(func(key string) string {
			if key == "CANARY_PERCENT" {
				return raw
			}
			return ""
		}); err == nil {
			t.Fatalf("Load() should reject CANARY_PERCENT=%q", raw)
		}
	}
}

func TestLoadAcceptsCanaryBounds(t *testing.T) {
	for _, raw := range []string{"0", "1", "50", "100"} {
		cfg, err := Load(func(key string) string {
			if key == "CANARY_PERCENT" {
				return raw
			}
			return ""
		})
		if err != nil {
			t.Fatalf("Load(CANARY_PERCENT=%q) error = %v", raw, err)
		}
		if got := cfg.CanaryPercent; got != mustAtoi(t, raw) {
			t.Errorf("CANARY_PERCENT=%q → %d, want %d", raw, got, mustAtoi(t, raw))
		}
	}
}

func mustAtoi(t *testing.T, raw string) int {
	t.Helper()
	value, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("bad fixture %q: %v", raw, err)
	}
	return value
}
