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
	if cfg.ShadowTimeoutMs <= 0 || cfg.ShadowMaxRequestBodyByte <= 0 || cfg.ShadowMaxInflight <= 0 || cfg.ShadowMaxPerMin <= 0 {
		t.Errorf("shadow budget defaults must be positive: %+v", cfg)
	}
	// 请求体与响应捕获必须是两个独立预算（命名与语义都不共享）。
	if cfg.ShadowMaxResponseCaptureByte <= 0 {
		t.Errorf("ShadowMaxResponseCaptureByte default = %d, want positive", cfg.ShadowMaxResponseCaptureByte)
	}
	// 差分正文默认不记录（只记 hash）。
	if cfg.ShadowDebugBodyLog {
		t.Error("ShadowDebugBodyLog default must be false")
	}
	if cfg.ShadowDebugBodyLogMaxBytes <= 0 {
		t.Errorf("ShadowDebugBodyLogMaxBytes default = %d, want positive", cfg.ShadowDebugBodyLogMaxBytes)
	}
	if cfg.CanaryPercent != 0 {
		t.Errorf("CanaryPercent default = %d, want 0 (canary 必须显式开启)", cfg.CanaryPercent)
	}
}

func TestLoadAcceptsIndependentShadowBudgets(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "SHADOW_MAX_REQUEST_BODY_BYTES":
			return "4096"
		case "SHADOW_MAX_RESPONSE_CAPTURE_BYTES":
			return "8192"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ShadowMaxRequestBodyByte != 4096 {
		t.Errorf("ShadowMaxRequestBodyByte = %d, want 4096", cfg.ShadowMaxRequestBodyByte)
	}
	if cfg.ShadowMaxResponseCaptureByte != 8192 {
		t.Errorf("ShadowMaxResponseCaptureByte = %d, want 8192", cfg.ShadowMaxResponseCaptureByte)
	}
}

func TestLoadRejectsInvalidShadowBudgets(t *testing.T) {
	for _, key := range []string{"SHADOW_MAX_REQUEST_BODY_BYTES", "SHADOW_MAX_RESPONSE_CAPTURE_BYTES"} {
		if _, err := Load(func(k string) string {
			if k == key {
				return "-1"
			}
			return ""
		}); err == nil {
			t.Fatalf("Load() should reject %s=-1", key)
		}
	}
}

func TestLoadDebugBodyLogFlag(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "SHADOW_DEBUG_BODY_LOG" {
			return "true"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.ShadowDebugBodyLog {
		t.Error("SHADOW_DEBUG_BODY_LOG=true must enable debug body logging")
	}

	for _, raw := range []string{"maybe", "yes-maybe"} {
		if _, err := Load(func(key string) string {
			if key == "SHADOW_DEBUG_BODY_LOG" {
				return raw
			}
			return ""
		}); err == nil {
			t.Fatalf("Load() should reject SHADOW_DEBUG_BODY_LOG=%q", raw)
		}
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
