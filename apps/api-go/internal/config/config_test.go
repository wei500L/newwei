package config

import "testing"

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
