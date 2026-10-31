package config

import (
	"strings"
	"testing"
)

// TestOpsEntrypointModesDefaultToGo pins the repository defaults of the
// C-1/C-5/C-7/C-9 batch. The cutover flipped every one of them: healthz/live
// used to be the shadow exception because NestJS still answered it, but the web
// container now gates its startup on Go answering that route, and the fallback
// is reject so an unmatched route fails loudly instead of reaching a backend the
// default stack no longer runs.
func TestOpsEntrypointModesDefaultToGo(t *testing.T) {
	cfg := loadDefaults(t)
	if cfg.HealthzLiveMode != HealthzLiveModeGo {
		t.Errorf("HealthzLiveMode = %q, want go", cfg.HealthzLiveMode)
	}
	if cfg.LegacyFallbackMode != LegacyFallbackModeReject {
		t.Errorf("LegacyFallbackMode = %q, want reject", cfg.LegacyFallbackMode)
	}
	if cfg.DocsMode != DocsModeGo {
		t.Errorf("DocsMode = %q, want go", cfg.DocsMode)
	}
	if cfg.VectorDiagnosticsMode != VectorDiagnosticsModeGo {
		t.Errorf("VectorDiagnosticsMode = %q, want go", cfg.VectorDiagnosticsMode)
	}
}

func TestOpsEntrypointModesAcceptValidValues(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
		get  func(Config) string
	}{
		{
			name: "healthz live shadow",
			env:  map[string]string{"API_GO_HEALTHZ_LIVE_MODE": "shadow"},
			want: "shadow",
			get:  func(cfg Config) string { return string(cfg.HealthzLiveMode) },
		},
		{
			name: "healthz live legacy",
			env:  map[string]string{"API_GO_HEALTHZ_LIVE_MODE": "legacy"},
			want: "legacy",
			get:  func(cfg Config) string { return string(cfg.HealthzLiveMode) },
		},
		{
			name: "healthz live go",
			env:  map[string]string{"API_GO_HEALTHZ_LIVE_MODE": "go"},
			want: "go",
			get:  func(cfg Config) string { return string(cfg.HealthzLiveMode) },
		},
		{
			name: "legacy fallback proxy",
			env:  map[string]string{"API_GO_LEGACY_FALLBACK_MODE": "proxy"},
			want: "proxy",
			get:  func(cfg Config) string { return string(cfg.LegacyFallbackMode) },
		},
		{
			name: "docs go",
			env:  map[string]string{"API_GO_DOCS_MODE": "go"},
			want: "go",
			get:  func(cfg Config) string { return string(cfg.DocsMode) },
		},
		{
			name: "vector diagnostics go",
			env: map[string]string{
				"API_GO_VECTOR_DIAGNOSTICS_MODE": "go",
				"JWT_SECRET":                     "test-secret",
				"DATABASE_URL":                   "mysql://cutover:placeholder@mysql:3306/newwei",
				"REDIS_HOST":                     "redis",
			},
			want: "go",
			get:  func(cfg Config) string { return string(cfg.VectorDiagnosticsMode) },
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			// Unnamed switches keep the rollback baseline so only this case is go.
			cfg, err := Load(legacyUnset(func(key string) string { return testCase.env[key] }))
			if err != nil {
				t.Fatalf("Load rejected a valid value: %v", err)
			}
			if got := testCase.get(cfg); got != testCase.want {
				t.Fatalf("mode = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestOpsEntrypointModesRejectInvalidValues(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want string
	}{
		{
			env:  map[string]string{"API_GO_HEALTHZ_LIVE_MODE": "canary"},
			want: "API_GO_HEALTHZ_LIVE_MODE must be one of shadow|legacy|go",
		},
		{
			env:  map[string]string{"API_GO_LEGACY_FALLBACK_MODE": "off"},
			want: "API_GO_LEGACY_FALLBACK_MODE must be one of proxy|reject",
		},
		{
			env:  map[string]string{"API_GO_DOCS_MODE": "shadow"},
			want: "API_GO_DOCS_MODE must be one of legacy|go",
		},
		{
			env:  map[string]string{"API_GO_VECTOR_DIAGNOSTICS_MODE": "canary"},
			want: "API_GO_VECTOR_DIAGNOSTICS_MODE must be one of legacy|go",
		},
	}
	for _, testCase := range cases {
		_, err := Load(func(key string) string { return testCase.env[key] })
		if err == nil {
			t.Fatalf("Load accepted %v, want a startup failure", testCase.env)
		}
		if !strings.Contains(err.Error(), testCase.want) {
			t.Fatalf("error %q does not contain %q", err, testCase.want)
		}
	}
}

// TestLegacyRejectRequiresEveryModeGo starts from the default configuration
// (which is now reject with every switch go) and flips one switch at a time.
// This is the meaningful form after the cutover: the reject rule has to hold for
// the defaults, not only for an explicit all-go fixture. The aggregated error
// must name every unsatisfied switch.
func TestLegacyRejectRequiresEveryModeGo(t *testing.T) {
	loadDefaults := func(t *testing.T, mutate func(map[string]string)) (Config, error) {
		t.Helper()
		env := defaultResources(t)
		if mutate != nil {
			mutate(env)
		}
		return Load(func(key string) string { return env[key] })
	}

	cfg, err := loadDefaults(t, nil)
	if err != nil {
		t.Fatalf("the default configuration must load with reject: %v", err)
	}
	if cfg.LegacyFallbackMode != LegacyFallbackModeReject {
		t.Fatalf("LegacyFallbackMode = %q, want reject", cfg.LegacyFallbackMode)
	}

	// A single legacy HTTP switch blocks reject mode.
	_, err = loadDefaults(t, func(env map[string]string) { env["API_GO_DOCS_MODE"] = "legacy" })
	if err == nil {
		t.Fatal("reject mode accepted API_GO_DOCS_MODE=legacy")
	}
	if !strings.Contains(err.Error(), "API_GO_LEGACY_FALLBACK_MODE=reject requires every API_GO_*_MODE switch to be go") {
		t.Fatalf("error %q misses the reject-mode rule", err)
	}
	if !strings.Contains(err.Error(), "API_GO_DOCS_MODE=legacy") {
		t.Fatalf("error %q does not name the unsatisfied switch", err)
	}

	// healthz/live must be go as well: shadow is not enough.
	_, err = loadDefaults(t, func(env map[string]string) { env["API_GO_HEALTHZ_LIVE_MODE"] = "shadow" })
	if err == nil {
		t.Fatal("reject mode accepted API_GO_HEALTHZ_LIVE_MODE=shadow")
	}
	if !strings.Contains(err.Error(), "API_GO_HEALTHZ_LIVE_MODE=shadow") {
		t.Fatalf("error %q does not name API_GO_HEALTHZ_LIVE_MODE", err)
	}

	// The aggregated error lists every unsatisfied switch in one message.
	_, err = loadDefaults(t, func(env map[string]string) {
		env["API_GO_DOCS_MODE"] = "legacy"
		env["API_GO_VECTOR_DIAGNOSTICS_MODE"] = "legacy"
	})
	if err == nil {
		t.Fatal("reject mode accepted two legacy switches")
	}
	for _, want := range []string{"API_GO_DOCS_MODE=legacy", "API_GO_VECTOR_DIAGNOSTICS_MODE=legacy"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
}

// TestLegacyRejectAllowsEmptyLegacyAPIURL pins the documented difference from
// proxy mode: reject never opens an upstream connection, so an operator may drop
// LEGACY_API_URL. The loader still fills the historical default, which keeps the
// URL validation satisfied without contacting it.
func TestLegacyRejectAllowsEmptyLegacyAPIURL(t *testing.T) {
	env := defaultResources(t)
	delete(env, "LEGACY_API_URL")
	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("reject mode without LEGACY_API_URL must load: %v", err)
	}
	if cfg.LegacyAPIURL != defaultLegacy {
		t.Fatalf("LegacyAPIURL = %q, want the historical default %q", cfg.LegacyAPIURL, defaultLegacy)
	}
}

// TestLegacyRejectExemptionIsOnlyTheFallbackSwitch keeps the exemption table
// honest: adding an exemption requires changing this test and documenting why
// that execution unit does not have to be owned by Go.
func TestLegacyRejectExemptionIsOnlyTheFallbackSwitch(t *testing.T) {
	if len(legacyRejectExemptModes) != 1 {
		t.Fatalf("legacyRejectExemptModes has %d entries, want only LegacyFallbackMode: %v",
			len(legacyRejectExemptModes), legacyRejectExemptModes)
	}
	if _, ok := legacyRejectExemptModes["LegacyFallbackMode"]; !ok {
		t.Fatalf("LegacyFallbackMode is not exempt: %v", legacyRejectExemptModes)
	}
}

func TestModeSwitchEnvNames(t *testing.T) {
	cases := map[string]string{
		"HealthzLiveMode":          "API_GO_HEALTHZ_LIVE_MODE",
		"LegacyFallbackMode":       "API_GO_LEGACY_FALLBACK_MODE",
		"DocsMode":                 "API_GO_DOCS_MODE",
		"VectorDiagnosticsMode":    "API_GO_VECTOR_DIAGNOSTICS_MODE",
		"GraphQLReadMode":          "API_GO_GRAPHQL_READ_MODE",
		"GraphQLSubscriptionsMode": "API_GO_GRAPHQL_SUBSCRIPTIONS_MODE",
		"OIDCLoginMode":            "API_GO_OIDC_LOGIN_MODE",
		"LLMGatewayProfilesMode":   "API_GO_LLM_GATEWAY_PROFILES_MODE",
		"GdeltSnapshotMode":        "API_GO_GDELT_SNAPSHOT_MODE",
		// The one field whose environment variable does not follow the
		// mechanical conversion.
		"SituationSignalsMode": "API_GO_SITUATION_MONITOR_SIGNALS_MODE",
	}
	for field, want := range cases {
		if got := modeSwitchEnvName(field); got != want {
			t.Errorf("modeSwitchEnvName(%q) = %q, want %q", field, got, want)
		}
	}
}
