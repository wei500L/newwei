package config

import (
	"math"
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

func TestDashboardChartsModeIsIndependentOfStats(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardChartsMode != DashboardChartsModeLegacy {
		t.Fatalf("mode = %q, want legacy", cfg.DashboardChartsMode)
	}
	secret := "charts-jwt-secret"
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_CHARTS_MODE":
			return "go"
		case "JWT_SECRET":
			return secret
		default:
			return ""
		}
	})
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("go mode without mysql/redis should fail without leaking the secret: %v", err)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_DASHBOARD_CHARTS_MODE" {
			return "pilot"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_DASHBOARD_CHARTS_MODE") {
		t.Fatalf("invalid mode = %v", err)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_CHARTS_MODE":
			return "go"
		case "JWT_SECRET":
			return "test-secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardChartsMode != DashboardChartsModeGo {
		t.Fatalf("mode = %q, want go", cfg.DashboardChartsMode)
	}
	if cfg.DashboardStatsMode != DashboardStatsModeLegacy {
		t.Fatalf("stats mode = %q, want legacy", cfg.DashboardStatsMode)
	}
	if cfg.DashboardWarMapMode != DashboardWarMapModeLegacy {
		t.Fatalf("war map mode = %q, want legacy", cfg.DashboardWarMapMode)
	}
}

func TestDashboardWarMapModeRequiresMongo(t *testing.T) {
	secret := "war-map-secret"
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_WAR_MAP_MODE":
			return "go"
		case "JWT_SECRET":
			return secret
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "MONGO_URI") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_WAR_MAP_MODE":
			return "go"
		case "JWT_SECRET":
			return secret
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardWarMapMode != DashboardWarMapModeGo || cfg.DashboardChartsMode != DashboardChartsModeLegacy {
		t.Fatalf("war=%s charts=%s", cfg.DashboardWarMapMode, cfg.DashboardChartsMode)
	}
	if cfg.DashboardWarMapTransportMode != DashboardWarMapTransportModeLegacy || cfg.DashboardWarMapLayersMode != DashboardWarMapLayersModeLegacy {
		t.Fatalf("transport=%s layers=%s", cfg.DashboardWarMapTransportMode, cfg.DashboardWarMapLayersMode)
	}
}

func TestWarMapTransportAndLayersModesAreIndependent(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI") || strings.Contains(err.Error(), "API_GO_DASHBOARD_WAR_MAP_MODE") {
		t.Fatalf("transport mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardWarMapLayersMode != DashboardWarMapLayersModeGo || cfg.DashboardWarMapMode != DashboardWarMapModeLegacy || cfg.DashboardWarMapTransportMode != DashboardWarMapTransportModeLegacy {
		t.Fatalf("layers=%s war=%s transport=%s", cfg.DashboardWarMapLayersMode, cfg.DashboardWarMapMode, cfg.DashboardWarMapTransportMode)
	}
}

func TestSpacetimeModesAreIndependent(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardSpacetimeGeoMode != DashboardSpacetimeGeoModeLegacy || cfg.DashboardSpacetimePropagationMode != DashboardSpacetimePropagationModeLegacy {
		t.Fatalf("geo=%s propagation=%s", cfg.DashboardSpacetimeGeoMode, cfg.DashboardSpacetimePropagationMode)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_DASHBOARD_SPACETIME_GEO_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_DASHBOARD_SPACETIME_GEO_MODE=go") || strings.Contains(err.Error(), "API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE") {
		t.Fatalf("geo dependencies: %v", err)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardSpacetimePropagationMode != DashboardSpacetimePropagationModeGo || cfg.DashboardSpacetimeGeoMode != DashboardSpacetimeGeoModeLegacy || cfg.DashboardWarMapMode != DashboardWarMapModeLegacy {
		t.Fatalf("propagation=%s geo=%s war=%s", cfg.DashboardSpacetimePropagationMode, cfg.DashboardSpacetimeGeoMode, cfg.DashboardWarMapMode)
	}
}

func TestStreamAndHealthzModesAreIndependent(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardStreamMode != DashboardStreamModeLegacy || cfg.HealthzMode != HealthzModeLegacy {
		t.Fatalf("stream=%s healthz=%s", cfg.DashboardStreamMode, cfg.HealthzMode)
	}
	if !cfg.ItemsSearchRerankEnabled || cfg.CrawlHealthTTLMs != 60_000 {
		t.Fatalf("rerank=%v ttl=%d", cfg.ItemsSearchRerankEnabled, cfg.CrawlHealthTTLMs)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_DASHBOARD_STREAM_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_DASHBOARD_STREAM_MODE=go") {
		t.Fatalf("stream dependencies: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_HEALTHZ_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_DASHBOARD_STREAM_MODE":
			return "go"
		case "API_GO_HEALTHZ_MODE":
			return "legacy"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DashboardStreamMode != DashboardStreamModeGo || cfg.HealthzMode != HealthzModeLegacy || cfg.DashboardSpacetimeGeoMode != DashboardSpacetimeGeoModeLegacy {
		t.Fatalf("stream=%s healthz=%s geo=%s", cfg.DashboardStreamMode, cfg.HealthzMode, cfg.DashboardSpacetimeGeoMode)
	}
	if _, err := Load(func(key string) string {
		if key == "API_GO_HEALTHZ_MODE" {
			return "shadow"
		}
		return ""
	}); err == nil || !strings.Contains(err.Error(), "API_GO_HEALTHZ_MODE") {
		t.Fatalf("invalid healthz mode: %v", err)
	}
}

func TestPersonalNewsModesAreIndependent(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ContentSubscriptionsMode != ContentSubscriptionsModeLegacy ||
		cfg.UserNewsBehaviorMode != UserNewsBehaviorModeLegacy ||
		cfg.UserDigestMode != UserDigestModeLegacy {
		t.Fatalf("subs=%s behavior=%s digest=%s", cfg.ContentSubscriptionsMode, cfg.UserNewsBehaviorMode, cfg.UserDigestMode)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_USER_NEWS_BEHAVIOR_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET is required when API_GO_USER_NEWS_BEHAVIOR_MODE=go") || strings.Contains(err.Error(), "MONGO_URI") {
		t.Fatalf("behavior dependencies: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_CONTENT_SUBSCRIPTIONS_MODE":
			return "go"
		case "JWT_SECRET", "DATABASE_URL", "REDIS_HOST":
			return "set"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_CONTENT_SUBSCRIPTIONS_MODE=go") {
		t.Fatalf("subscription dependencies: %v", err)
	}
	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_USER_DIGEST_MODE":
			return "go"
		case "API_GO_CONTENT_SUBSCRIPTIONS_MODE", "API_GO_USER_NEWS_BEHAVIOR_MODE":
			return "legacy"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		case "MONGO_URI":
			return "mongodb://mongo:27017/app"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UserDigestMode != UserDigestModeGo || cfg.ContentSubscriptionsMode != ContentSubscriptionsModeLegacy || cfg.UserNewsBehaviorMode != UserNewsBehaviorModeLegacy {
		t.Fatalf("digest=%s subs=%s behavior=%s", cfg.UserDigestMode, cfg.ContentSubscriptionsMode, cfg.UserNewsBehaviorMode)
	}
}

func TestGraphQLReadModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("GraphQLReadMode = %q, want legacy", cfg.GraphQLReadMode)
	}
}

func TestNewsSourcesModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsSourcesMode != NewsSourcesModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsSourcesMode)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_NEWS_SOURCES_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWS_SOURCES_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_NEWS_SOURCES_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET is required when API_GO_NEWS_SOURCES_MODE=go") {
		t.Fatalf("go dependencies: %v", err)
	}
}

func TestSituationMonitorsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationMonitorsMode != SituationMonitorsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationMonitorsMode)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_SITUATION_MONITORS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_SITUATION_MONITORS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
	_, err = Load(func(key string) string {
		if key == "API_GO_SITUATION_MONITORS_MODE" {
			return "go"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET is required when API_GO_SITUATION_MONITORS_MODE=go") {
		t.Fatalf("go dependencies: %v", err)
	}
}

func TestGraphQLReadModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_READ_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_READ_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLNewsEventsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLNewsEventsMode != "legacy" || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("news=%q read=%q", cfg.GraphQLNewsEventsMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLNewsEventsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_NEWS_EVENTS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_NEWS_EVENTS_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLNewsEventsModeGoDoesNotRequireCredentialsUntilReadModeIsGo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_NEWS_EVENTS_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLReadMode != "legacy" || cfg.GraphQLNewsEventsMode != "go" {
		t.Fatalf("read=%q news=%q", cfg.GraphQLReadMode, cfg.GraphQLNewsEventsMode)
	}
}

func TestGraphQLBothGoStillRequireMongoFromReadMode(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_READ_MODE", "API_GO_GRAPHQL_NEWS_EVENTS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_GRAPHQL_READ_MODE=go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLKnowledgeGraphModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLKnowledgeGraphMode != "legacy" {
		t.Fatalf("knowledge graph mode = %q", cfg.GraphQLKnowledgeGraphMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLKnowledgeGraphMode != "legacy" {
		t.Fatalf("explicit legacy = %q", cfg.GraphQLKnowledgeGraphMode)
	}
}

func TestGraphQLKnowledgeGraphModeRejectsInvalid(t *testing.T) {
	for _, value := range []string{"shadow", "on", "GO"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE" {
				return value
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE must be one of legacy|go") {
			t.Fatalf("%q Load() error = %v", value, err)
		}
	}
}

func TestGraphQLKnowledgeGraphModeGoDoesNotRequireCredentialsUntilReadModeIsGo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLReadMode != "legacy" || cfg.GraphQLKnowledgeGraphMode != "go" {
		t.Fatalf("read=%q knowledge=%q", cfg.GraphQLReadMode, cfg.GraphQLKnowledgeGraphMode)
	}
}

func TestGraphQLKnowledgeGraphBothGoStillRequireMongoFromReadMode(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_GRAPHQL_READ_MODE", "API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_GRAPHQL_READ_MODE=go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestCrawlWorkflowsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlWorkflowsMode != CrawlWorkflowsModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlWorkflowsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_WORKFLOWS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlWorkflowsMode != CrawlWorkflowsModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlWorkflowsMode)
	}
}

func TestCrawlWorkflowsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_WORKFLOWS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_WORKFLOWS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestCrawlWorkflowsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_WORKFLOWS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CRAWL_WORKFLOWS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_WORKFLOWS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlWorkflowsMode != CrawlWorkflowsModeGo {
		t.Fatalf("mode = %s", cfg.CrawlWorkflowsMode)
	}
}

func TestCrawlProfilesModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlProfilesMode != CrawlProfilesModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlProfilesMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_PROFILES_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlProfilesMode != CrawlProfilesModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlProfilesMode)
	}
}

func TestCrawlProfilesModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_PROFILES_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_PROFILES_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestCrawlProfilesModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_PROFILES_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CRAWL_PROFILES_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_PROFILES_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlProfilesMode != CrawlProfilesModeGo {
		t.Fatalf("mode = %s", cfg.CrawlProfilesMode)
	}
}

func TestCrawlTemplatesModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTemplatesMode != CrawlTemplatesModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlTemplatesMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_TEMPLATES_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTemplatesMode != CrawlTemplatesModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlTemplatesMode)
	}
}

func TestCrawlTemplatesModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_TEMPLATES_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_TEMPLATES_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestCrawlTemplatesModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_TEMPLATES_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CRAWL_TEMPLATES_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_TEMPLATES_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlTemplatesMode != CrawlTemplatesModeGo {
		t.Fatalf("mode = %s", cfg.CrawlTemplatesMode)
	}
}

func TestAdminLogsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AdminLogsMode != AdminLogsModeLegacy {
		t.Fatalf("mode = %s", cfg.AdminLogsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_ADMIN_LOGS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AdminLogsMode != AdminLogsModeLegacy {
		t.Fatalf("mode = %s", cfg.AdminLogsMode)
	}
}

func TestAdminLogsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_ADMIN_LOGS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_ADMIN_LOGS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestAdminLogsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_ADMIN_LOGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_ADMIN_LOGS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_ADMIN_LOGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_ADMIN_LOGS_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_ADMIN_LOGS_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AdminLogsMode != AdminLogsModeGo {
		t.Fatalf("mode = %s", cfg.AdminLogsMode)
	}
}

func TestQualityOverviewModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.QualityOverviewMode != QualityOverviewModeLegacy {
		t.Fatalf("mode = %s", cfg.QualityOverviewMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_QUALITY_OVERVIEW_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.QualityOverviewMode != QualityOverviewModeLegacy {
		t.Fatalf("mode = %s", cfg.QualityOverviewMode)
	}
}

func TestQualityOverviewModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_QUALITY_OVERVIEW_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_QUALITY_OVERVIEW_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestQualityOverviewModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_QUALITY_OVERVIEW_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_QUALITY_OVERVIEW_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_QUALITY_OVERVIEW_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_QUALITY_OVERVIEW_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_QUALITY_OVERVIEW_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.QualityOverviewMode != QualityOverviewModeGo {
		t.Fatalf("mode = %s", cfg.QualityOverviewMode)
	}
}

func TestCrawlReadTelemetryModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlReadTelemetryMode != CrawlReadTelemetryModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlReadTelemetryMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_READ_TELEMETRY_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlReadTelemetryMode != CrawlReadTelemetryModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlReadTelemetryMode)
	}
}

func TestCrawlReadTelemetryModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_READ_TELEMETRY_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_READ_TELEMETRY_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestCrawlReadTelemetryModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_READ_TELEMETRY_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CRAWL_READ_TELEMETRY_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_READ_TELEMETRY_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_CRAWL_READ_TELEMETRY_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_READ_TELEMETRY_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlReadTelemetryMode != CrawlReadTelemetryModeGo {
		t.Fatalf("mode = %s", cfg.CrawlReadTelemetryMode)
	}
}

// TestNewsnowClusteringOpsModeDefaultsToLegacy pins the default: an unset
// variable and the explicit "legacy" value both keep the nine routes on NestJS.
func TestNewsnowClusteringOpsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowClusteringOpsMode != NewsnowClusteringOpsModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsnowClusteringOpsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_NEWSNOW_CLUSTERING_OPS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowClusteringOpsMode != NewsnowClusteringOpsModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsnowClusteringOpsMode)
	}
}

// TestNewsnowClusteringOpsModeRejectsInvalid forbids shadow: this batch has no
// shadow execution and any unknown value must fail startup instead of silently
// downgrading to legacy.
func TestNewsnowClusteringOpsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_NEWSNOW_CLUSTERING_OPS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWSNOW_CLUSTERING_OPS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

// TestNewsnowClusteringOpsModeGoRequiresCredentials walks the go-mode
// preconditions one missing variable at a time: Redis, then Mongo, then the
// fully satisfied configuration.
func TestNewsnowClusteringOpsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWSNOW_CLUSTERING_OPS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_NEWSNOW_CLUSTERING_OPS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWSNOW_CLUSTERING_OPS_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsnowClusteringOpsMode != NewsnowClusteringOpsModeGo {
		t.Fatalf("mode = %s", cfg.NewsnowClusteringOpsMode)
	}
}

// TestClassificationRssOpsModeDefaultsToLegacy asserts that the switch is
// legacy both when the variable is unset and when it is explicitly "legacy".
func TestClassificationRssOpsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClassificationRssOpsMode != ClassificationRssOpsModeLegacy {
		t.Fatalf("mode = %s", cfg.ClassificationRssOpsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_CLASSIFICATION_RSS_OPS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClassificationRssOpsMode != ClassificationRssOpsModeLegacy {
		t.Fatalf("mode = %s", cfg.ClassificationRssOpsMode)
	}
}

// TestClassificationRssOpsModeRejectsInvalid asserts that any value other than
// the empty string, legacy or go fails startup with the variable name in the
// error text.
func TestClassificationRssOpsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CLASSIFICATION_RSS_OPS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CLASSIFICATION_RSS_OPS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

// TestClassificationRssOpsModeGoRequiresCredentials asserts the go mode needs
// JWT_SECRET, DATABASE_URL, REDIS_HOST and MONGO_URI, and that supplying all
// four resolves the mode to go.
func TestClassificationRssOpsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_CLASSIFICATION_RSS_OPS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CLASSIFICATION_RSS_OPS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_CLASSIFICATION_RSS_OPS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_CLASSIFICATION_RSS_OPS_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CLASSIFICATION_RSS_OPS_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClassificationRssOpsMode != ClassificationRssOpsModeGo {
		t.Fatalf("mode = %s", cfg.ClassificationRssOpsMode)
	}
}

func TestLlmLogsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LlmLogsMode != LlmLogsModeLegacy {
		t.Fatalf("mode = %s", cfg.LlmLogsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_LLM_LOGS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LlmLogsMode != LlmLogsModeLegacy {
		t.Fatalf("mode = %s", cfg.LlmLogsMode)
	}
}

func TestLlmLogsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_LLM_LOGS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_LLM_LOGS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestLlmLogsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_LLM_LOGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_LLM_LOGS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	_, err = Load(func(key string) string {
		switch key {
		case "API_GO_LLM_LOGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_LLM_LOGS_MODE=go") {
		t.Fatalf("missing mongo: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_LLM_LOGS_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LlmLogsMode != LlmLogsModeGo {
		t.Fatalf("mode = %s", cfg.LlmLogsMode)
	}
}

func TestNewsIndicatorsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsIndicatorsMode != NewsIndicatorsModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsIndicatorsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_NEWS_INDICATORS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsIndicatorsMode != NewsIndicatorsModeLegacy {
		t.Fatalf("mode = %s", cfg.NewsIndicatorsMode)
	}
}

func TestNewsIndicatorsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_NEWS_INDICATORS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_NEWS_INDICATORS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestNewsIndicatorsModeGoRequiresCredentialsButNotMongo(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWS_INDICATORS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_NEWS_INDICATORS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWS_INDICATORS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NewsIndicatorsMode != NewsIndicatorsModeGo {
		t.Fatalf("mode = %s", cfg.NewsIndicatorsMode)
	}
	if cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("read mode = %s, want legacy", cfg.GraphQLReadMode)
	}
}

func TestNewsIndicatorsModeGoDoesNotRequireMongo(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_NEWS_INDICATORS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("news indicators go must not require MONGO_URI: %v", err)
	}
}

func TestGraphQLKgImpactModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLKgImpactMode != "legacy" || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("kg=%q read=%q", cfg.GraphQLKgImpactMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLKgImpactModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KG_IMPACT_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_KG_IMPACT_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLKgImpactModeGoDoesNotRequireCredentialsUntilReadModeIsGo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_KG_IMPACT_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLReadMode != "legacy" || cfg.GraphQLKgImpactMode != "go" {
		t.Fatalf("read=%q kg=%q", cfg.GraphQLReadMode, cfg.GraphQLKgImpactMode)
	}
}

func TestGraphQLWorkspaceReadModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLWorkspaceReadMode != "legacy" || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("workspace=%q read=%q", cfg.GraphQLWorkspaceReadMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLWorkspaceReadModeAcceptsExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_READ_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLWorkspaceReadMode != "legacy" {
		t.Fatalf("explicit legacy = %q", legacy.GraphQLWorkspaceReadMode)
	}
	goMode, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_READ_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if goMode.GraphQLWorkspaceReadMode != "go" {
		t.Fatalf("go = %q", goMode.GraphQLWorkspaceReadMode)
	}
}

func TestGraphQLWorkspaceReadModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_READ_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_WORKSPACE_READ_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLWorkspaceReadModeGoDoesNotRequireCredentialsUntilReadModeIsGo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_WORKSPACE_READ_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLReadMode != "legacy" || cfg.GraphQLWorkspaceReadMode != "go" {
		t.Fatalf("read=%q workspace=%q", cfg.GraphQLReadMode, cfg.GraphQLWorkspaceReadMode)
	}
}

func TestGraphQLSettingsCrawlReadModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLSettingsCrawlReadMode != "legacy" || cfg.GraphQLReadMode != "legacy" {
		t.Fatalf("settingsCrawl=%q read=%q", cfg.GraphQLSettingsCrawlReadMode, cfg.GraphQLReadMode)
	}
}

func TestGraphQLSettingsCrawlReadModeAcceptsExplicitLegacyAndGo(t *testing.T) {
	legacy, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if legacy.GraphQLSettingsCrawlReadMode != "legacy" {
		t.Fatalf("explicit legacy = %q", legacy.GraphQLSettingsCrawlReadMode)
	}
	goMode, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if goMode.GraphQLSettingsCrawlReadMode != "go" {
		t.Fatalf("go = %q", goMode.GraphQLSettingsCrawlReadMode)
	}
}

func TestGraphQLSettingsCrawlReadModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE must be one of legacy|go") {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestGraphQLSettingsCrawlReadModeGoDoesNotRequireCredentialsUntilReadModeIsGo(t *testing.T) {
	cfg, err := Load(func(key string) string {
		if key == "API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE" {
			return "go"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GraphQLReadMode != "legacy" || cfg.GraphQLSettingsCrawlReadMode != "go" {
		t.Fatalf("read=%q settingsCrawl=%q", cfg.GraphQLReadMode, cfg.GraphQLSettingsCrawlReadMode)
	}
}

func TestRuntimeSettingsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeSettingsMode != RuntimeSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.RuntimeSettingsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_RUNTIME_SETTINGS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeSettingsMode != RuntimeSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.RuntimeSettingsMode)
	}
}

func TestRuntimeSettingsModeRejectsInvalid(t *testing.T) {
	// shadow and canary are explicitly not accepted: this unit is
	// legacy-or-go only, so a typo in the switch fails startup.
	for _, invalid := range []string{"shadow", "canary", "Go"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_RUNTIME_SETTINGS_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_RUNTIME_SETTINGS_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestRuntimeSettingsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_RUNTIME_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_RUNTIME_SETTINGS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	// Mongo is not a startup dependency of this unit.
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_RUNTIME_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeSettingsMode != RuntimeSettingsModeGo {
		t.Fatalf("mode = %s", cfg.RuntimeSettingsMode)
	}
}

// platformGovernanceEnvEntry is one environment override for the
// platformGovernanceEnv getenv seam.
type platformGovernanceEnvEntry struct {
	key   string
	value string
}

// platformGovernanceEnv returns a getenv seam that serves the four credentials
// the go-mode startup validation always requires, plus the caller's platform
// governance overrides.
func platformGovernanceEnv(overrides ...platformGovernanceEnvEntry) func(string) string {
	return func(key string) string {
		for _, entry := range overrides {
			if entry.key == key {
				return entry.value
			}
		}
		switch key {
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
	}
}

func TestPlatformGovernanceSettingsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PlatformGovernanceSettingsMode != PlatformGovernanceSettingsModeLegacy {
		t.Fatalf("mode = %q, want legacy", cfg.PlatformGovernanceSettingsMode)
	}
}

func TestPlatformGovernanceSettingsModeAcceptsExplicitValues(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want PlatformGovernanceSettingsMode
	}{
		{"", PlatformGovernanceSettingsModeLegacy},
		{"legacy", PlatformGovernanceSettingsModeLegacy},
		{"go", PlatformGovernanceSettingsModeGo},
	} {
		env := platformGovernanceEnv(platformGovernanceEnvEntry{"API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE", tc.raw})
		cfg, err := Load(env)
		if err != nil {
			t.Fatalf("Load(%q) error = %v", tc.raw, err)
		}
		if cfg.PlatformGovernanceSettingsMode != tc.want {
			t.Fatalf("mode for %q = %q, want %q", tc.raw, cfg.PlatformGovernanceSettingsMode, tc.want)
		}
	}
}

func TestPlatformGovernanceSettingsModeRejectsInvalid(t *testing.T) {
	for _, raw := range []string{"GO", "shadow", "canary", "true"} {
		_, err := Load(platformGovernanceEnv(platformGovernanceEnvEntry{"API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE", raw}))
		if err == nil {
			t.Fatalf("Load() should reject mode %q", raw)
		}
		want := "API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE must be one of legacy|go"
		if err.Error() != want {
			t.Fatalf("error = %q, want %q", err.Error(), want)
		}
	}
}

func TestPlatformGovernanceSettingsModeGoRequiresMongo(t *testing.T) {
	env := platformGovernanceEnv(
		platformGovernanceEnvEntry{"API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE", "go"},
		platformGovernanceEnvEntry{"MONGO_URI", ""},
	)
	_, err := Load(env)
	if err == nil {
		t.Fatal("Load() should require MONGO_URI in go mode")
	}
	if !strings.Contains(err.Error(), "MONGO_URI is required when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go") {
		t.Fatalf("error = %v", err)
	}
}

func TestPlatformGovernanceDefaultsMatchNestSchema(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.PlatformGovernanceAssistantGuardrailsEnabled {
		t.Error("ASSISTANT_GUARDRAILS_ENABLED default = false, want true")
	}
	if cfg.PlatformGovernanceAssistantGuardrailsRaw != "openai-moderation-pre" {
		t.Errorf("ASSISTANT_GUARDRAILS default = %q", cfg.PlatformGovernanceAssistantGuardrailsRaw)
	}
	if cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour != 30 {
		t.Errorf("ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR default = %d, want 30", cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour)
	}
	if cfg.PlatformGovernanceAssistantOrgMaxInFlight != 2 {
		t.Errorf("ASSISTANT_ORG_MAX_IN_FLIGHT default = %d, want 2", cfg.PlatformGovernanceAssistantOrgMaxInFlight)
	}
	if cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget != 2_000_000 {
		t.Errorf("ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET default = %d, want 2000000", cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget)
	}
	if cfg.PlatformGovernanceTaskLogRetentionDays != 14 {
		t.Errorf("TASK_LOG_RETENTION_DAYS default = %d, want 14", cfg.PlatformGovernanceTaskLogRetentionDays)
	}
	if cfg.PlatformGovernanceEncryptionKeyRaw != "" {
		t.Errorf("SYSTEM_SETTINGS_ENCRYPTION_KEY default = %q, want empty", cfg.PlatformGovernanceEncryptionKeyRaw)
	}
}

func TestPlatformGovernanceDefaultsAcceptValidValues(t *testing.T) {
	cfg, err := Load(platformGovernanceEnv(
		platformGovernanceEnvEntry{"API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE", "go"},
		platformGovernanceEnvEntry{"ASSISTANT_GUARDRAILS_ENABLED", "off"},
		platformGovernanceEnvEntry{"ASSISTANT_GUARDRAILS", " openai-moderation-pre , custom "},
		platformGovernanceEnvEntry{"ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR", " 100 "},
		platformGovernanceEnvEntry{"ASSISTANT_ORG_MAX_IN_FLIGHT", "0x64"},
		platformGovernanceEnvEntry{"ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET", "1e6"},
		platformGovernanceEnvEntry{"TASK_LOG_RETENTION_DAYS", "30"},
		platformGovernanceEnvEntry{"SYSTEM_SETTINGS_ENCRYPTION_KEY", "  "},
	))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PlatformGovernanceAssistantGuardrailsEnabled {
		t.Error("ASSISTANT_GUARDRAILS_ENABLED=off should be false")
	}
	if cfg.PlatformGovernanceAssistantGuardrailsRaw != " openai-moderation-pre , custom " {
		t.Errorf("ASSISTANT_GUARDRAILS raw = %q", cfg.PlatformGovernanceAssistantGuardrailsRaw)
	}
	if cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour != 100 {
		t.Errorf("submit limit = %d, want 100", cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour)
	}
	// Number("0x64") === 100.
	if cfg.PlatformGovernanceAssistantOrgMaxInFlight != 100 {
		t.Errorf("max in flight = %d, want 100", cfg.PlatformGovernanceAssistantOrgMaxInFlight)
	}
	if cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget != 1_000_000 {
		t.Errorf("monthly budget = %d, want 1000000", cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget)
	}
	if cfg.PlatformGovernanceTaskLogRetentionDays != 30 {
		t.Errorf("retention days = %d, want 30", cfg.PlatformGovernanceTaskLogRetentionDays)
	}
	// The key keeps its whitespace: present-but-empty must stay distinguishable.
	if cfg.PlatformGovernanceEncryptionKeyRaw != "  " {
		t.Errorf("encryption key raw = %q, want two spaces", cfg.PlatformGovernanceEncryptionKeyRaw)
	}
}

func TestPlatformGovernanceDefaultsRejectInvalidValuesInGoMode(t *testing.T) {
	for _, tc := range []struct {
		key   string
		value string
	}{
		{"ASSISTANT_GUARDRAILS_ENABLED", "maybe"},
		{"ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR", "abc"},
		{"ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR", "1.5"},
		{"ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR", "10001"},
		{"ASSISTANT_ORG_MAX_IN_FLIGHT", "-1"},
		{"ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET", "1000000000001"},
		{"TASK_LOG_RETENTION_DAYS", "0"},
		{"TASK_LOG_RETENTION_DAYS", "nan"},
	} {
		env := platformGovernanceEnv(
			platformGovernanceEnvEntry{"API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE", "go"},
			platformGovernanceEnvEntry{tc.key, tc.value},
		)
		if _, err := Load(env); err == nil {
			t.Fatalf("Load() should reject %s=%q in go mode", tc.key, tc.value)
		}
	}
}

func TestPlatformGovernanceDefaultsIgnoredInLegacyMode(t *testing.T) {
	// Invalid values must not break a legacy deployment: behaviour stays
	// identical to main until the switch is flipped to go.
	cfg, err := Load(func(key string) string {
		switch key {
		case "TASK_LOG_RETENTION_DAYS":
			return "not-a-number"
		case "ASSISTANT_GUARDRAILS_ENABLED":
			return "maybe"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PlatformGovernanceSettingsMode != PlatformGovernanceSettingsModeLegacy {
		t.Fatalf("mode = %q", cfg.PlatformGovernanceSettingsMode)
	}
	if cfg.PlatformGovernanceTaskLogRetentionDays != 14 {
		t.Errorf("retention days = %d, want the 14 fallback", cfg.PlatformGovernanceTaskLogRetentionDays)
	}
	if !cfg.PlatformGovernanceAssistantGuardrailsEnabled {
		t.Error("invalid boolean should fall back to true in legacy mode")
	}
}

func TestJSEnvNumberSemantics(t *testing.T) {
	nanValues := []string{"nan", "inf", "1_000", "0x1p3", "0x", "1,5", "  12 3 ", "0x1g"}
	for _, raw := range nanValues {
		if got := jsEnvNumber(raw); !math.IsNaN(got) {
			t.Errorf("jsEnvNumber(%q) = %v, want NaN", raw, got)
		}
	}
	if got := jsEnvNumber("Infinity"); !math.IsInf(got, 1) {
		t.Errorf("jsEnvNumber(Infinity) = %v, want +Inf", got)
	}
	if got := jsEnvNumber("INFINITY"); !math.IsInf(got, 1) {
		t.Errorf("jsEnvNumber(INFINITY) = %v, want +Inf", got)
	}
	if got := jsEnvNumber("-Infinity"); !math.IsInf(got, -1) {
		t.Errorf("jsEnvNumber(-Infinity) = %v, want -Inf", got)
	}
	for _, tc := range []struct {
		raw  string
		want float64
	}{
		{"", 0},
		{"   ", 0},
		{"30", 30},
		{" 30 ", 30},
		{"+30", 30},
		{"-30", -30},
		{".5", 0.5},
		{"5.", 5},
		{"1e3", 1000},
		{"1E+3", 1000},
		{"0x1f", 31},
		{"0X1F", 31},
		{"0o17", 15},
		{"0b101", 5},
	} {
		if got := jsEnvNumber(tc.raw); got != tc.want {
			t.Errorf("jsEnvNumber(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestInfrastructureSettingsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.InfrastructureSettingsMode != InfrastructureSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.InfrastructureSettingsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_INFRASTRUCTURE_SETTINGS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.InfrastructureSettingsMode != InfrastructureSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.InfrastructureSettingsMode)
	}
}

func TestInfrastructureSettingsModeRejectsInvalid(t *testing.T) {
	// shadow and canary are explicitly not accepted: this unit is
	// legacy-or-go only, so a typo in the switch fails startup.
	for _, invalid := range []string{"shadow", "canary", "Go"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_INFRASTRUCTURE_SETTINGS_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_INFRASTRUCTURE_SETTINGS_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestInfrastructureSettingsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_INFRASTRUCTURE_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_INFRASTRUCTURE_SETTINGS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	// Mongo, the encryption key and the vector/S3 upstreams are not startup
	// requirements of this unit: an encryption key that is missing or invalid
	// is handled per read/write by the documented fallback and 400 contracts.
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_INFRASTRUCTURE_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("go mode must not require Mongo or an encryption key: %v", err)
	}
	if cfg.InfrastructureSettingsMode != InfrastructureSettingsModeGo {
		t.Fatalf("mode = %s", cfg.InfrastructureSettingsMode)
	}
}

func TestInfrastructureSettingsEnvDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.VectorServiceEnabled || !cfg.VectorServiceFallbackToMongo {
		t.Fatalf("vector booleans = %v %v", cfg.VectorServiceEnabled, cfg.VectorServiceFallbackToMongo)
	}
	if cfg.VectorServiceBaseURL != "" || cfg.VectorInternalToken != "" {
		t.Fatalf("vector url/token = %q %q", cfg.VectorServiceBaseURL, cfg.VectorInternalToken)
	}
	if cfg.VectorServiceTimeoutMs != 5000 || cfg.VectorServiceMaxRetries != 2 {
		t.Fatalf("vector timings = %d %d", cfg.VectorServiceTimeoutMs, cfg.VectorServiceMaxRetries)
	}
	if cfg.S3AccessKeyID != "" || cfg.S3SecretAccessKey != "" || cfg.S3Bucket != "" || cfg.S3Endpoint != "" {
		t.Fatalf("s3 defaults = %+v", cfg)
	}
	if cfg.S3Region != "us-east-1" || cfg.S3ForcePathStyle || cfg.S3PresignedURLTTLSeconds != 300 {
		t.Fatalf("s3 scalars = %q %v %d", cfg.S3Region, cfg.S3ForcePathStyle, cfg.S3PresignedURLTTLSeconds)
	}
	if cfg.SettingsEncryptionKeyPresent || cfg.SettingsEncryptionKeyRaw != "" {
		t.Fatalf("encryption key presence = %v %q", cfg.SettingsEncryptionKeyPresent, cfg.SettingsEncryptionKeyRaw)
	}

	cfg, err = Load(func(key string) string {
		switch key {
		case "VECTOR_SERVICE_ENABLED":
			return " Yes "
		case "VECTOR_SERVICE_FALLBACK_TO_MONGO":
			return "off"
		case "VECTOR_SERVICE_TIMEOUT_MS":
			return "9000"
		case "VECTOR_SERVICE_MAX_RETRIES":
			return "0"
		case "S3_FORCE_PATH_STYLE":
			return "true"
		case "S3_PRESIGNED_URL_TTL_SECONDS":
			return "600"
		case "SYSTEM_SETTINGS_ENCRYPTION_KEY":
			return "not-a-real-key"
		case "NODE_ENV":
			return "production"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.VectorServiceEnabled || cfg.VectorServiceFallbackToMongo {
		t.Fatalf("vector booleans = %v %v", cfg.VectorServiceEnabled, cfg.VectorServiceFallbackToMongo)
	}
	if cfg.VectorServiceTimeoutMs != 9000 || cfg.VectorServiceMaxRetries != 0 {
		t.Fatalf("vector timings = %d %d", cfg.VectorServiceTimeoutMs, cfg.VectorServiceMaxRetries)
	}
	if !cfg.S3ForcePathStyle || cfg.S3PresignedURLTTLSeconds != 600 {
		t.Fatalf("s3 scalars = %v %d", cfg.S3ForcePathStyle, cfg.S3PresignedURLTTLSeconds)
	}
	// The raw (untrimmed) value decides presence, mirroring the NestJS
	// `if (!raw)` test performed before the key is decoded.
	if !cfg.SettingsEncryptionKeyPresent || cfg.SettingsEncryptionKeyRaw != "not-a-real-key" {
		t.Fatalf("encryption key presence = %v %q", cfg.SettingsEncryptionKeyPresent, cfg.SettingsEncryptionKeyRaw)
	}
	if cfg.NodeEnv != "production" {
		t.Fatalf("node env = %q", cfg.NodeEnv)
	}
}

// modelAccessEnv builds a getenv function that answers from a map.
func modelAccessEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

// TestModelAccessSettingsModeVocabulary pins the switch's accepted values and the
// exact error text, mirroring the other migration switches.
func TestModelAccessSettingsModeVocabulary(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		want    ModelAccessSettingsMode
		wantErr bool
	}{
		{name: "unset defaults to legacy", value: "", want: ModelAccessSettingsModeLegacy},
		{name: "explicit legacy", value: "legacy", want: ModelAccessSettingsModeLegacy},
		{name: "go", value: "go", want: ModelAccessSettingsModeGo},
		{name: "whitespace tolerated", value: "  go  ", want: ModelAccessSettingsModeGo},
		{name: "shadow is rejected", value: "shadow", wantErr: true},
		{name: "canary is rejected", value: "canary", wantErr: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			env := map[string]string{
				"API_GO_MODEL_ACCESS_SETTINGS_MODE": testCase.value,
				// go mode requires the auth stack, which is not what this test is
				// about; supplying it keeps the mode the only variable.
				"JWT_SECRET":   "secret",
				"DATABASE_URL": "mysql://root:secret@127.0.0.1:3306/app",
				"REDIS_HOST":   "127.0.0.1",
			}
			cfg, err := Load(modelAccessEnv(env))
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("expected an error")
				}
				if !strings.Contains(err.Error(), "API_GO_MODEL_ACCESS_SETTINGS_MODE must be one of legacy|go") {
					t.Fatalf("error = %q", err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if cfg.ModelAccessSettingsMode != testCase.want {
				t.Fatalf("mode = %q, want %q", cfg.ModelAccessSettingsMode, testCase.want)
			}
		})
	}
}

// TestModelAccessSettingsGoRequiresAuthStack proves the startup requirements.
func TestModelAccessSettingsGoRequiresAuthStack(t *testing.T) {
	_, err := Load(modelAccessEnv(map[string]string{"API_GO_MODEL_ACCESS_SETTINGS_MODE": "go"}))
	if err == nil {
		t.Fatalf("go mode without the auth stack must fail startup")
	}
	for _, want := range []string{
		"JWT_SECRET is required when API_GO_MODEL_ACCESS_SETTINGS_MODE=go",
		"DATABASE_URL is required when API_GO_MODEL_ACCESS_SETTINGS_MODE=go",
		"REDIS_HOST is required when API_GO_MODEL_ACCESS_SETTINGS_MODE=go",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q is missing %q", err.Error(), want)
		}
	}
	if strings.Contains(err.Error(), "MONGO_URI is required when API_GO_MODEL_ACCESS_SETTINGS_MODE=go") {
		t.Fatalf("this batch reads no Mongo collection: %q", err.Error())
	}
	// The encryption key and the internal token are never startup requirements.
	if strings.Contains(err.Error(), "SYSTEM_SETTINGS_ENCRYPTION_KEY") || strings.Contains(err.Error(), "LITELLM_CONFIG_INTERNAL_TOKEN") {
		t.Fatalf("runtime-only secrets must not block startup: %q", err.Error())
	}
}

// TestModelAccessSettingsGoAcceptsTheAuthStack proves go mode starts with the auth
// stack and without either runtime secret.
func TestModelAccessSettingsGoAcceptsTheAuthStack(t *testing.T) {
	cfg, err := Load(modelAccessEnv(map[string]string{
		"API_GO_MODEL_ACCESS_SETTINGS_MODE": "go",
		"JWT_SECRET":                        "secret",
		"DATABASE_URL":                      "mysql://root:secret@127.0.0.1:3306/app",
		"REDIS_HOST":                        "127.0.0.1",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ModelAccessSettingsMode != ModelAccessSettingsModeGo {
		t.Fatalf("mode = %q", cfg.ModelAccessSettingsMode)
	}
}

// TestModelAccessSettingsRawEnvIsCapturedUntrimmed proves the raw reads.
func TestModelAccessSettingsRawEnvIsCapturedUntrimmed(t *testing.T) {
	cfg, err := Load(modelAccessEnv(map[string]string{
		"MODEL_SERVICE_ENABLED":          " yes ",
		"MODEL_SERVICE_BASE_URL":         " http://model-service:8090 ",
		"MODEL_SERVICE_INTERNAL_TOKEN":   " tok ",
		"MODEL_SERVICE_TIMEOUT_MS":       "12000",
		"MODEL_SERVICE_MAX_RETRIES":      "3",
		"LITELLM_CONFIG_INTERNAL_TOKEN":  " litellm-token ",
		"SYSTEM_SETTINGS_ENCRYPTION_KEY": " key ",
		"NODE_ENV":                       "production",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ModelServiceEnabledRaw != " yes " {
		t.Fatalf("ModelServiceEnabledRaw = %q", cfg.ModelServiceEnabledRaw)
	}
	if cfg.ModelServiceBaseURLRaw != " http://model-service:8090 " {
		t.Fatalf("ModelServiceBaseURLRaw = %q", cfg.ModelServiceBaseURLRaw)
	}
	if cfg.ModelServiceInternalTokenRaw != " tok " {
		t.Fatalf("ModelServiceInternalTokenRaw = %q", cfg.ModelServiceInternalTokenRaw)
	}
	if cfg.ModelServiceTimeoutMsRaw != "12000" || cfg.ModelServiceMaxRetriesRaw != "3" {
		t.Fatalf("numeric raw values = %q / %q", cfg.ModelServiceTimeoutMsRaw, cfg.ModelServiceMaxRetriesRaw)
	}
	if cfg.LiteLLMConfigInternalTokenRaw != " litellm-token " {
		t.Fatalf("LiteLLMConfigInternalTokenRaw = %q", cfg.LiteLLMConfigInternalTokenRaw)
	}
	if cfg.NodeEnvRaw != "production" {
		t.Fatalf("NodeEnvRaw = %q", cfg.NodeEnvRaw)
	}
	// The pre-existing trimmed field keeps its own semantics.
	if cfg.SettingsEncryptionKey != "key" {
		t.Fatalf("SettingsEncryptionKey = %q, want the trimmed value", cfg.SettingsEncryptionKey)
	}
	if cfg.SystemSettingsEncryptionKeyRaw != " key " {
		t.Fatalf("SystemSettingsEncryptionKeyRaw = %q, want the raw value", cfg.SystemSettingsEncryptionKeyRaw)
	}
}

// TestLegacyModeIgnoresInvalidModelAccessValues proves a legacy deployment is
// unaffected by the new environment handling.
func TestLegacyModeIgnoresInvalidModelAccessValues(t *testing.T) {
	for _, mode := range []string{"", "legacy"} {
		cfg, err := Load(modelAccessEnv(map[string]string{
			"API_GO_MODEL_ACCESS_SETTINGS_MODE": mode,
			"MODEL_SERVICE_ENABLED":             "maybe",
			"MODEL_SERVICE_TIMEOUT_MS":          "abc",
		}))
		if err != nil {
			t.Fatalf("legacy mode must not validate the new values: %v", err)
		}
		if cfg.ModelAccessSettingsMode != ModelAccessSettingsModeLegacy {
			t.Fatalf("mode = %q", cfg.ModelAccessSettingsMode)
		}
	}
}

func TestCrawlFrontierRunsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlFrontierRunsMode != CrawlFrontierRunsModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlFrontierRunsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_CRAWL_FRONTIER_RUNS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlFrontierRunsMode != CrawlFrontierRunsModeLegacy {
		t.Fatalf("mode = %s", cfg.CrawlFrontierRunsMode)
	}
}

func TestCrawlFrontierRunsModeRejectsInvalid(t *testing.T) {
	_, err := Load(func(key string) string {
		if key == "API_GO_CRAWL_FRONTIER_RUNS_MODE" {
			return "shadow"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "API_GO_CRAWL_FRONTIER_RUNS_MODE must be one of legacy|go") {
		t.Fatalf("invalid mode: %v", err)
	}
}

func TestCrawlFrontierRunsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_FRONTIER_RUNS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_CRAWL_FRONTIER_RUNS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	// Mongo is not a startup dependency of this unit.
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_CRAWL_FRONTIER_RUNS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CrawlFrontierRunsMode != CrawlFrontierRunsModeGo {
		t.Fatalf("mode = %s", cfg.CrawlFrontierRunsMode)
	}
}

func TestDataRuntimeSettingsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataRuntimeSettingsMode != DataRuntimeSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.DataRuntimeSettingsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_DATA_RUNTIME_SETTINGS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataRuntimeSettingsMode != DataRuntimeSettingsModeLegacy {
		t.Fatalf("mode = %s", cfg.DataRuntimeSettingsMode)
	}
}

func TestDataRuntimeSettingsModeRejectsInvalid(t *testing.T) {
	// shadow and canary are explicitly not accepted: this unit is legacy-or-go
	// only, so a typo in the switch fails startup.
	for _, invalid := range []string{"shadow", "canary", "Go"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_DATA_RUNTIME_SETTINGS_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_DATA_RUNTIME_SETTINGS_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestDataRuntimeSettingsModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_DATA_RUNTIME_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_DATA_RUNTIME_SETTINGS_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	// Mongo and the encryption key are not startup requirements of this unit: a
	// missing or invalid key is handled per read and write by the documented
	// fallback and 400 contracts.
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_DATA_RUNTIME_SETTINGS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("go mode must not require Mongo or an encryption key: %v", err)
	}
	if cfg.DataRuntimeSettingsMode != DataRuntimeSettingsModeGo {
		t.Fatalf("mode = %s", cfg.DataRuntimeSettingsMode)
	}
}

func TestDataRuntimeSettingsEnvDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	env := cfg.DataRuntimeSettings
	if !env.RealtimeEnabled || env.RealtimeRequestTimeoutMs != 12_000 || env.RealtimeMaxRetries != 2 {
		t.Fatalf("realtime scalars = %+v", env)
	}
	if !env.RealtimeOpenskyEnabled || env.RealtimeOpenskyIntervalSec != 900 ||
		env.RealtimeOpenskyDailyCreditBudget != 4000 || env.RealtimeOpenskyDayIntervalSec != 600 ||
		env.RealtimeOpenskyNightIntervalSec != 1800 || env.RealtimeOpenskyDayStartHourHKT != 8 ||
		env.RealtimeOpenskyNightStartHourHKT != 22 || env.RealtimeOpenskyWarningRemaining != 20 ||
		env.RealtimeOpenskyCriticalRemaining != 10 {
		t.Fatalf("opensky defaults = %+v", env)
	}
	if env.RealtimeOpenskyBaseURL != "https://opensky-network.org/api" {
		t.Fatalf("opensky base url = %q", env.RealtimeOpenskyBaseURL)
	}
	if env.RealtimeAisIntervalSec != 600 || env.RealtimeUnrestIntervalSec != 600 ||
		env.RealtimeOutagesIntervalSec != 600 || env.RealtimeKeywordSpikeIntervalSec != 600 ||
		env.RealtimePizzintIntervalSec != 600 || env.RealtimeGdeltTensionIntervalSec != 600 ||
		env.RealtimePolymarketIntervalSec != 600 {
		t.Fatalf("interval defaults = %+v", env)
	}
	if env.RealtimeKeywordSpikeMinCount != 5 || env.RealtimeKeywordSpikeMultiplier != 3 ||
		env.RealtimePredictionShiftThreshold != 5 || env.RealtimePredictionNewsThreshold != 3 {
		t.Fatalf("threshold defaults = %+v", env)
	}
	if env.RealtimeOpenskyClientID != "" || env.RealtimeOpenskyClientSecret != "" ||
		env.RealtimeAisBaseURL != "" || env.RealtimeAisSharedSecret != "" ||
		env.RealtimeAcledOauthUsername != "" || env.RealtimeAcledOauthPassword != "" ||
		env.RealtimeAcledOauthClientID != "" || env.RealtimeCloudflareAPIToken != "" ||
		env.RealtimeWingbitsAPIKey != "" || env.RealtimePolymarketProxyURL != "" {
		t.Fatalf("optional strings must default to empty: %+v", env)
	}
	if env.NominatimUserAgentDefault != "modular-api" || env.NominatimEmailDefault != "" {
		t.Fatalf("nominatim defaults = %+v", env)
	}
}

func TestDataRuntimeSettingsEnvPassThrough(t *testing.T) {
	cfg, err := Load(func(key string) string {
		switch key {
		case "REALTIME_SIGNALS_ENABLED":
			return " off "
		case "REALTIME_SIGNALS_REQUEST_TIMEOUT_MS":
			return "9000"
		case "REALTIME_SIGNALS_MAX_RETRIES":
			return "0"
		// The OpenSky schema defaults win, so the ADSB aliases never apply.
		case "REALTIME_SIGNALS_OPENSKY_ENABLED":
			return ""
		case "REALTIME_SIGNALS_ADSB_ENABLED":
			return "false"
		case "REALTIME_SIGNALS_ADSB_INTERVAL_SEC":
			return "45"
		case "REALTIME_SIGNALS_OPENSKY_INTERVAL_SEC":
			return "120"
		case "REALTIME_SIGNALS_AIS_BASE_URL":
			return ""
		case "REALTIME_SIGNALS_RELAY_BASE_URL":
			return "https://relay.example"
		case "REALTIME_SIGNALS_AIS_SHARED_SECRET":
			return ""
		case "AIS_RELAY_SHARED_SECRET":
			return "relay-secret"
		case "REALTIME_SIGNALS_KEYWORD_SPIKE_MULTIPLIER":
			return "2.5"
		case "REALTIME_SIGNALS_PREDICTION_SHIFT_THRESHOLD":
			return "4.5"
		case "REALTIME_SIGNALS_POLYMARKET_PROXY_URL":
			return "https://proxy.example"
		case "GEO_NOMINATIM_USER_AGENT":
			return "custom-agent"
		case "GEO_NOMINATIM_EMAIL":
			return "geocoder@example.com"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	env := cfg.DataRuntimeSettings
	if env.RealtimeEnabled || env.RealtimeRequestTimeoutMs != 9000 || env.RealtimeMaxRetries != 0 {
		t.Fatalf("realtime scalars = %+v", env)
	}
	// ADSB_ENABLED=false and ADSB_INTERVAL_SEC=45 are unreachable because the
	// OpenSky names keep their schema defaults.
	if !env.RealtimeOpenskyEnabled || env.RealtimeOpenskyIntervalSec != 120 {
		t.Fatalf("opensky precedence = %+v", env)
	}
	if env.RealtimeAisBaseURL != "https://relay.example" || env.RealtimeAisSharedSecret != "relay-secret" {
		t.Fatalf("ais fallbacks = %+v", env)
	}
	if env.RealtimeKeywordSpikeMultiplier != 2.5 || env.RealtimePredictionShiftThreshold != 4.5 {
		t.Fatalf("float thresholds = %+v", env)
	}
	if env.RealtimePolymarketProxyURL != "https://proxy.example" {
		t.Fatalf("proxy url = %q", env.RealtimePolymarketProxyURL)
	}
	if env.NominatimUserAgentDefault != "custom-agent" || env.NominatimEmailDefault != "geocoder@example.com" {
		t.Fatalf("nominatim = %+v", env)
	}
}

func TestAccountSecurityModeDefaultsToLegacy(t *testing.T) {
	// Unset and the empty string both mean legacy: the default deployment keeps
	// every request on the NestJS proxy.
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AccountSecurityMode != AccountSecurityModeLegacy {
		t.Fatalf("mode = %s", cfg.AccountSecurityMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_ACCOUNT_SECURITY_MODE" {
			return ""
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AccountSecurityMode != AccountSecurityModeLegacy {
		t.Fatalf("empty mode = %s", cfg.AccountSecurityMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_ACCOUNT_SECURITY_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AccountSecurityMode != AccountSecurityModeLegacy {
		t.Fatalf("legacy mode = %s", cfg.AccountSecurityMode)
	}
}

func TestAccountSecurityModeRejectsInvalid(t *testing.T) {
	// Only legacy and go are accepted; shadow/canary and any typo fail startup
	// with the exact error text.
	for _, invalid := range []string{"shadow", "canary", "Go", "GO "} {
		_, err := Load(func(key string) string {
			if key == "API_GO_ACCOUNT_SECURITY_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_ACCOUNT_SECURITY_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestAccountSecurityModeGoRequiresCredentials(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_ACCOUNT_SECURITY_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_ACCOUNT_SECURITY_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	// Mongo is deliberately not a startup dependency of this unit: it reads and
	// writes MySQL and Redis only.
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_ACCOUNT_SECURITY_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("go mode must not require Mongo: %v", err)
	}
	if cfg.AccountSecurityMode != AccountSecurityModeGo {
		t.Fatalf("mode = %s", cfg.AccountSecurityMode)
	}
}

func TestSituationSignalsModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSignalsMode != SituationSignalsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationSignalsMode)
	}
	// The empty string is explicitly legacy, not "unset but different".
	cfg, err = Load(func(key string) string {
		if key == "API_GO_SITUATION_MONITOR_SIGNALS_MODE" {
			return ""
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSignalsMode != SituationSignalsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationSignalsMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_SITUATION_MONITOR_SIGNALS_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSignalsMode != SituationSignalsModeLegacy {
		t.Fatalf("mode = %s", cfg.SituationSignalsMode)
	}
}

func TestSituationSignalsModeRejectsInvalid(t *testing.T) {
	// shadow and canary are explicitly not accepted: this unit is
	// legacy-or-go only, so a typo in the switch fails startup.
	for _, invalid := range []string{"shadow", "canary", "Go", "true", "go\tshadow"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_SITUATION_MONITOR_SIGNALS_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_SITUATION_MONITOR_SIGNALS_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestSituationSignalsModeGoRequiresCredentials(t *testing.T) {
	full := map[string]string{
		"API_GO_SITUATION_MONITOR_SIGNALS_MODE": "go",
		"JWT_SECRET":                            "secret",
		"DATABASE_URL":                          "mysql://user:pass@127.0.0.1:3306/app",
		"REDIS_HOST":                            "redis",
		"MONGO_URI":                             "mongodb://127.0.0.1:27017/app",
	}
	for missing, expected := range map[string]string{
		"JWT_SECRET":   "JWT_SECRET is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go",
		"DATABASE_URL": "DATABASE_URL is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go",
		"REDIS_HOST":   "REDIS_HOST is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go",
		"MONGO_URI":    "MONGO_URI is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go",
	} {
		_, err := Load(func(key string) string {
			if key == missing {
				return ""
			}
			return full[key]
		})
		if err == nil || !strings.Contains(err.Error(), expected) {
			t.Fatalf("missing %s: %v", missing, err)
		}
	}

	cfg, err := Load(func(key string) string { return full[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSignalsMode != SituationSignalsModeGo {
		t.Fatalf("mode = %s", cfg.SituationSignalsMode)
	}
}

func TestSituationSignalsModeIsIndependentOfSituationMonitorsMode(t *testing.T) {
	// The monitors switch owns the five /monitors** routes; the signals switch
	// owns seven different paths. Neither one may turn the other on.
	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_SITUATION_MONITOR_SIGNALS_MODE":
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
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationMonitorsMode != SituationMonitorsModeLegacy {
		t.Fatalf("monitors mode = %s", cfg.SituationMonitorsMode)
	}
	if cfg.SituationSignalsMode != SituationSignalsModeGo {
		t.Fatalf("signals mode = %s", cfg.SituationSignalsMode)
	}

	cfg, err = Load(func(key string) string {
		switch key {
		case "API_GO_SITUATION_MONITORS_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SituationSignalsMode != SituationSignalsModeLegacy {
		t.Fatalf("signals mode = %s", cfg.SituationSignalsMode)
	}
}

func TestLLMGatewayProfilesModeDefaultsToLegacy(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayProfilesMode != LLMGatewayProfilesModeLegacy {
		t.Fatalf("mode = %s", cfg.LLMGatewayProfilesMode)
	}
	cfg, err = Load(func(key string) string {
		if key == "API_GO_LLM_GATEWAY_PROFILES_MODE" {
			return "legacy"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayProfilesMode != LLMGatewayProfilesModeLegacy {
		t.Fatalf("mode = %s", cfg.LLMGatewayProfilesMode)
	}
}

func TestLLMGatewayProfilesModeRejectsInvalid(t *testing.T) {
	// shadow and canary are explicitly not accepted: this unit is
	// legacy-or-go only, so a typo in the switch fails startup.
	for _, invalid := range []string{"shadow", "canary", "Go"} {
		_, err := Load(func(key string) string {
			if key == "API_GO_LLM_GATEWAY_PROFILES_MODE" {
				return invalid
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "API_GO_LLM_GATEWAY_PROFILES_MODE must be one of legacy|go") {
			t.Fatalf("invalid mode %q: %v", invalid, err)
		}
	}
}

func TestLLMGatewayProfilesModeGoRequiresCredentialsButNotMongo(t *testing.T) {
	_, err := Load(func(key string) string {
		switch key {
		case "API_GO_LLM_GATEWAY_PROFILES_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "REDIS_HOST is required when API_GO_LLM_GATEWAY_PROFILES_MODE=go") {
		t.Fatalf("missing redis: %v", err)
	}

	cfg, err := Load(func(key string) string {
		switch key {
		case "API_GO_LLM_GATEWAY_PROFILES_MODE":
			return "go"
		case "JWT_SECRET":
			return "secret"
		case "DATABASE_URL":
			return "mysql://user:pass@127.0.0.1:3306/app"
		case "REDIS_HOST":
			return "redis"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayProfilesMode != LLMGatewayProfilesModeGo {
		t.Fatalf("mode = %s", cfg.LLMGatewayProfilesMode)
	}
	// Mongo and a model upstream are not startup dependencies of this unit.
	if cfg.MongoURI != "" {
		t.Fatalf("mongo uri = %q", cfg.MongoURI)
	}
}

func TestLLMGatewayProfileEnvProjectionDefaults(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayModel != "openai/gpt-4o-mini" {
		t.Fatalf("model = %q", cfg.LLMGatewayModel)
	}
	if cfg.LiteLLMAPIBase != "http://localhost:4001" {
		t.Fatalf("apiBase = %q", cfg.LiteLLMAPIBase)
	}
	if cfg.LiteLLMTimeoutMs != 60_000 {
		t.Fatalf("timeoutMs = %d", cfg.LiteLLMTimeoutMs)
	}
	if cfg.LLMGatewayTemperature != 0.2 {
		t.Fatalf("temperature = %v", cfg.LLMGatewayTemperature)
	}
	if cfg.LLMGatewayTopP != 0.9 {
		t.Fatalf("topP = %v", cfg.LLMGatewayTopP)
	}
	if cfg.LLMGatewayMaxOutputTokens != 2048 {
		t.Fatalf("maxOutputTokens = %d", cfg.LLMGatewayMaxOutputTokens)
	}
	if cfg.LLMGatewayMaxRetries != 3 {
		t.Fatalf("maxRetries = %d", cfg.LLMGatewayMaxRetries)
	}
	if len(cfg.LLMGatewayFallbackModels) != 0 {
		t.Fatalf("fallbackModels = %v", cfg.LLMGatewayFallbackModels)
	}
	if cfg.NodeEnvProduction {
		t.Fatal("NODE_ENV unset must not be production")
	}
}

func TestLLMGatewayProfileEnvProjectionPriorities(t *testing.T) {
	// LITELLM_MAX_TOKENS has a schema default in NestJS, so setting only
	// LITELLM_MAX_OUTPUT_TOKENS can never win. The Go projection must agree.
	cfg, err := Load(func(key string) string {
		if key == "LITELLM_MAX_OUTPUT_TOKENS" {
			return "777"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayMaxOutputTokens != 2048 {
		t.Fatalf("maxOutputTokens = %d, want the MAX_TOKENS schema default", cfg.LLMGatewayMaxOutputTokens)
	}

	// The same rule applies to LITELLM_MAX_RETRIES.
	cfg, err = Load(func(key string) string {
		if key == "LITELLM_MAX_RETRIES" {
			return "9"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewayMaxRetries != 3 {
		t.Fatalf("maxRetries = %d, want the RETRY_ATTEMPTS schema default", cfg.LLMGatewayMaxRetries)
	}

	cfg, err = Load(func(key string) string {
		switch key {
		case "LITELLM_API_URL":
			return "http://primary:1"
		case "LITELLM_API_BASE":
			return "http://secondary:2"
		case "LITELLM_MAX_TOKENS":
			return "4096"
		case "LITELLM_RETRY_ATTEMPTS":
			return "5"
		case "LITELLM_TEMPERATURE":
			return "1.25"
		case "LITELLM_TOP_P":
			return "0.25"
		case "LITELLM_MODEL":
			return "openai/gpt-4o"
		case "LITELLM_FALLBACK_MODELS":
			return " a , ,b, a "
		case "NODE_ENV":
			return "production"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LiteLLMAPIBase != "http://primary:1" {
		t.Fatalf("apiBase = %q, want LITELLM_API_URL to win", cfg.LiteLLMAPIBase)
	}
	if cfg.LLMGatewayMaxOutputTokens != 4096 || cfg.LLMGatewayMaxRetries != 5 {
		t.Fatalf("maxima = %d/%d", cfg.LLMGatewayMaxOutputTokens, cfg.LLMGatewayMaxRetries)
	}
	if cfg.LLMGatewayTemperature != 1.25 || cfg.LLMGatewayTopP != 0.25 {
		t.Fatalf("sampling = %v/%v", cfg.LLMGatewayTemperature, cfg.LLMGatewayTopP)
	}
	if cfg.LLMGatewayModel != "openai/gpt-4o" {
		t.Fatalf("model = %q", cfg.LLMGatewayModel)
	}
	// The env projection keeps the literal comma split (trim + drop empty, no
	// de-duplication); de-duplication only happens when a profile list is
	// normalized.
	if strings.Join(cfg.LLMGatewayFallbackModels, ",") != "a,b,a" {
		t.Fatalf("fallbackModels = %v", cfg.LLMGatewayFallbackModels)
	}
	if !cfg.NodeEnvProduction {
		t.Fatal("NODE_ENV=production must be reported")
	}
}

func TestLLMGatewaySettingsEncryptionKeyKeepsRawValue(t *testing.T) {
	// The NestJS presence check is a JavaScript truthiness test on the raw
	// value, so a whitespace-only key must count as present-but-invalid and the
	// raw value must survive the config load.
	cfg, err := Load(func(key string) string {
		if key == "SYSTEM_SETTINGS_ENCRYPTION_KEY" {
			return "   "
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMGatewaySettingsEncryptionKey != "   " {
		t.Fatalf("key = %q, want the raw value", cfg.LLMGatewaySettingsEncryptionKey)
	}
}
