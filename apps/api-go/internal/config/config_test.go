package config

import (
	"strconv"
	"strings"
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

// Go-批3B：API_GO_USER_SETTINGS_READ_MODE 的三值语义（空=兼容旧行为、
// shadow/go 合法、非法值启动失败）+ go 模式的依赖前置校验（合并表格）。
func TestUserSettingsReadMode(t *testing.T) {
	cases := []struct {
		name      string
		readMode  string
		extraEnv  map[string]string
		wantMode  string
		wantError bool
	}{
		{"empty keeps compat", "", nil, "", false},
		{"shadow accepted", "shadow", nil, "shadow", false},
		{"go accepted with deps", "go", map[string]string{
			"JWT_SECRET": "s", "DATABASE_URL": "mysql://u:p@h:3306/db", "REDIS_HOST": "h",
		}, "go", false},
		{"go without deps fails", "go", nil, "", true},
		{"invalid value rejected", "bogus", nil, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := Load(func(key string) string {
				if v, ok := tc.extraEnv[key]; ok {
					return v
				}
				if key == "API_GO_USER_SETTINGS_READ_MODE" {
					return tc.readMode
				}
				return ""
			})
			if tc.wantError {
				if err == nil {
					t.Fatalf("want error, got cfg %+v", cfg)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if string(cfg.UserSettingsReadMode) != tc.wantMode {
				t.Errorf("UserSettingsReadMode = %q, want %q", cfg.UserSettingsReadMode, tc.wantMode)
			}
			if cfg.UserSettingsWriteMode != UserSettingsWriteModeLegacy {
				t.Errorf("UserSettingsWriteMode = %q, want legacy by default", cfg.UserSettingsWriteMode)
			}
		})
	}
}

func TestUserSettingsWriteMode(t *testing.T) {
	deps := map[string]string{
		"JWT_SECRET": "s", "DATABASE_URL": "mysql://u:p@h:3306/db", "REDIS_HOST": "h",
	}
	cases := []struct {
		name      string
		writeMode string
		readMode  string
		withDeps  bool
		wantError bool
	}{
		{"default legacy", "", "", false, false},
		{"explicit legacy", "legacy", "", false, false},
		{"go requires read go", "go", "shadow", true, true},
		{"go requires read go when read unset", "go", "", true, true},
		{"go with read go", "go", "go", true, false},
		{"go with read go but missing deps", "go", "go", false, true},
		{"invalid", "both", "go", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := Load(func(key string) string {
				if tc.withDeps {
					if v, ok := deps[key]; ok {
						return v
					}
				}
				switch key {
				case "API_GO_USER_SETTINGS_WRITE_MODE":
					return tc.writeMode
				case "API_GO_USER_SETTINGS_READ_MODE":
					return tc.readMode
				default:
					return ""
				}
			})
			if tc.wantError {
				if err == nil {
					t.Fatalf("want error, got %+v", cfg.UserSettingsWriteMode)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := UserSettingsWriteModeLegacy
			if tc.writeMode == "go" {
				want = UserSettingsWriteModeGo
			}
			if cfg.UserSettingsWriteMode != want {
				t.Fatalf("write mode = %q, want %q", cfg.UserSettingsWriteMode, want)
			}
		})
	}
}

func TestPublicPortalMode(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicPortalMode != PublicPortalModeLegacy {
		t.Fatalf("mode = %q, want legacy", cfg.PublicPortalMode)
	}
	if _, err := Load(func(key string) string {
		if key == "API_GO_PUBLIC_PORTAL_MODE" {
			return "go"
		}
		return ""
	}); err == nil {
		t.Fatal("go mode without DATABASE_URL should fail")
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_PUBLIC_PORTAL_MODE":
			return "go"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicPortalMode != PublicPortalModeGo {
		t.Fatalf("mode = %q, want go", cfg.PublicPortalMode)
	}
}

func TestDashboardStatsMode(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardStatsMode != DashboardStatsModeLegacy {
		t.Fatalf("mode = %q, want legacy", cfg.DashboardStatsMode)
	}
	secret := "s3cret-password"
	err = func() error {
		_, loadErr := Load(func(key string) string {
			if key == "API_GO_DASHBOARD_STATS_MODE" {
				return "go"
			}
			if key == "MONGO_URI" {
				return "mongodb://user:" + secret + "@mongo:27017/app"
			}
			return ""
		})
		return loadErr
	}()
	if err == nil {
		t.Fatal("go mode without jwt/mysql/redis should fail")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "mongo:27017") {
		t.Fatalf("startup error leaked mongo target: %v", err)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_STATS_MODE":
			return "go"
		case "JWT_SECRET":
			return "test-secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://user:" + secret + "@mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardStatsMode != DashboardStatsModeGo {
		t.Fatalf("mode = %q, want go", cfg.DashboardStatsMode)
	}
}
