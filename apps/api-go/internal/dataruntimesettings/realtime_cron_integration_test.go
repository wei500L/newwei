//go:build integration

// The exported cron runtime must resolve the stored settings row exactly like
// RealtimeSignalsSettingsService.getRuntimeConfig: source toggles, intervals,
// thresholds, endpoint overrides and credentials. This runs against the real
// MySQL/Redis CI services created by the ACLED integration helper.
package dataruntimesettings

import (
	"context"
	"testing"
	"time"
)

func TestEffectiveRealtimeCronRuntimeIntegration(t *testing.T) {
	service, db, _ := openAcledIntegration(t)
	service.cfg = Config{
		RealtimeEnabled:                  true,
		RealtimeRequestTimeoutMs:         12_000,
		RealtimeMaxRetries:               2,
		RealtimeOpenskyEnabled:           true,
		RealtimeOpenskyIntervalSec:       900,
		RealtimeOpenskyDailyCreditBudget: 4000,
		RealtimeOpenskyDayIntervalSec:    600,
		RealtimeOpenskyNightIntervalSec:  1800,
		RealtimeOpenskyDayStartHourHKT:   8,
		RealtimeOpenskyNightStartHourHKT: 22,
		RealtimeOpenskyWarningRemaining:  20,
		RealtimeOpenskyCriticalRemaining: 10,
		RealtimeAisEnabled:               true,
		RealtimeAisIntervalSec:           600,
		RealtimeUnrestEnabled:            true,
		RealtimeUnrestIntervalSec:        600,
		RealtimeOutagesEnabled:           true,
		RealtimeOutagesIntervalSec:       600,
		RealtimeKeywordSpikeEnabled:      true,
		RealtimeKeywordSpikeIntervalSec:  600,
		RealtimePizzintEnabled:           true,
		RealtimePizzintIntervalSec:       600,
		RealtimeGdeltTensionEnabled:      true,
		RealtimeGdeltTensionIntervalSec:  600,
		RealtimePolymarketLeadsEnabled:   true,
		RealtimePolymarketIntervalSec:    600,
		RealtimeKeywordSpikeMinCount:     5,
		RealtimeKeywordSpikeMultiplier:   3,
		RealtimePredictionShiftThreshold: 5,
		RealtimePredictionNewsThreshold:  3,
		NodeEnv:                          "test",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stored := `{
		"enabled": true,
		"requestTimeoutMs": 9000,
		"maxRetries": 1,
		"openskyEnabled": true,
		"openskyIntervalSec": 300,
		"aisEnabled": true,
		"aisIntervalSec": 120,
		"unrestEnabled": false,
		"outagesEnabled": true,
		"outagesIntervalSec": 600,
		"keywordSpikeEnabled": true,
		"keywordSpikeIntervalSec": 600,
		"pizzintEnabled": true,
		"pizzintIntervalSec": 600,
		"gdeltTensionEnabled": true,
		"gdeltTensionIntervalSec": 600,
		"polymarketLeadsEnabled": true,
		"polymarketLeadsIntervalSec": 600,
		"keywordSpikeMinCount": 7,
		"keywordSpikeMultiplier": 4.5,
		"predictionShiftThreshold": 6,
		"predictionNewsActivityThreshold": 2,
		"aisRelayBaseUrl": "http://relay.test/",
		"openskyBaseUrl": "http://opensky.test/api/",
		"openskyTokenUrl": "http://opensky.test/token/",
		"openskyClientId": "client-id",
		"openskyClientSecret": "client-secret",
		"polymarketProxyUrl": "http://polymarket.test/"
	}`
	now := nowMillis()
	if _, err := db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt) "+
			"VALUES ('realtime_signals_settings', ?, 0, NULL, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE value = new_row.value",
		stored, now, now); err != nil {
		t.Fatalf("seed realtime settings: %v", err)
	}

	runtime, err := service.EffectiveRealtimeCronRuntime(ctx, false)
	if err != nil {
		t.Fatalf("effective runtime: %v", err)
	}
	if !runtime.Enabled || runtime.RequestTimeoutMs != 9000 || runtime.MaxRetries != 1 {
		t.Fatalf("runtime header = %+v", runtime)
	}
	if runtime.Sources.Opensky.IntervalSec != 300 || runtime.Sources.Ais.IntervalSec != 120 {
		t.Fatalf("source intervals = %+v", runtime.Sources)
	}
	if runtime.Sources.Unrest.Enabled {
		t.Fatal("stored unrestEnabled=false was not applied")
	}
	if runtime.Thresholds.KeywordSpikeMinCount != 7 || runtime.Thresholds.KeywordSpikeMultiplier != 4.5 ||
		runtime.Thresholds.PredictionShiftThreshold != 6 || runtime.Thresholds.PredictionNewsActivityThreshold != 2 {
		t.Fatalf("thresholds = %+v", runtime.Thresholds)
	}
	if runtime.AisRelay.BaseURL != "http://relay.test" {
		t.Fatalf("ais relay base = %q", runtime.AisRelay.BaseURL)
	}
	if runtime.Opensky.BaseURL != "http://opensky.test/api" || runtime.Opensky.TokenURL != "http://opensky.test/token" {
		t.Fatalf("opensky urls = %+v", runtime.Opensky)
	}
	if runtime.Opensky.ClientID != "client-id" || runtime.Opensky.ClientSecret != "client-secret" {
		t.Fatalf("opensky credentials = %q/%q", runtime.Opensky.ClientID, runtime.Opensky.ClientSecret)
	}
	if runtime.Polymarket.ProxyURL != "http://polymarket.test" {
		t.Fatalf("polymarket proxy = %q", runtime.Polymarket.ProxyURL)
	}
	if runtime.Capabilities.AcledAPIEnabled {
		t.Fatal("ACLED must stay disabled")
	}
	if runtime.Credentials.AcledAccessToken != "" {
		t.Fatal("a disabled ACLED policy must not expose a token")
	}

	envRuntime := service.EnvRealtimeCronRuntime()
	if envRuntime == nil || !envRuntime.Enabled || envRuntime.Sources.Opensky.IntervalSec != 900 {
		t.Fatalf("env fallback = %+v", envRuntime)
	}
}
