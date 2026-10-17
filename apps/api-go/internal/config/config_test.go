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
