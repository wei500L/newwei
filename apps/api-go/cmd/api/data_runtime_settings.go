package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireDataRuntimeSettings registers the nine data runtime settings and archive
// status routes only when API_GO_DATA_RUNTIME_SETTINGS_MODE=go. Every other value
// (including the default legacy and the empty string) registers nothing, so the
// routes keep flowing through the NestJS proxy and rollback is a single variable
// change.
//
// The takeover needs the shared MySQL pool, the shared Redis client and the
// ordinary JWT authenticator. It deliberately creates no OAuth, signal-collector,
// geocoding, embedding or model client and performs no startup network probe: the
// routes only read and write configuration and the derived archive status index.
func wireDataRuntimeSettings(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if cfg.DataRuntimeSettingsMode != config.DataRuntimeSettingsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: data runtime settings go takeover requires mysql, redis, and jwt")
	}
	env := cfg.DataRuntimeSettings
	service := dataruntimesettings.NewService(db, redisClient, dataruntimesettings.Config{
		RealtimeEnabled:                  env.RealtimeEnabled,
		RealtimeRequestTimeoutMs:         env.RealtimeRequestTimeoutMs,
		RealtimeMaxRetries:               env.RealtimeMaxRetries,
		RealtimeOpenskyEnabled:           env.RealtimeOpenskyEnabled,
		RealtimeOpenskyIntervalSec:       env.RealtimeOpenskyIntervalSec,
		RealtimeOpenskyDailyCreditBudget: env.RealtimeOpenskyDailyCreditBudget,
		RealtimeOpenskyDayIntervalSec:    env.RealtimeOpenskyDayIntervalSec,
		RealtimeOpenskyNightIntervalSec:  env.RealtimeOpenskyNightIntervalSec,
		RealtimeOpenskyDayStartHourHKT:   env.RealtimeOpenskyDayStartHourHKT,
		RealtimeOpenskyNightStartHourHKT: env.RealtimeOpenskyNightStartHourHKT,
		RealtimeOpenskyWarningRemaining:  env.RealtimeOpenskyWarningRemaining,
		RealtimeOpenskyCriticalRemaining: env.RealtimeOpenskyCriticalRemaining,
		RealtimeOpenskyBaseURL:           env.RealtimeOpenskyBaseURL,
		RealtimeOpenskyTokenURL:          env.RealtimeOpenskyTokenURL,
		RealtimeOpenskyClientID:          env.RealtimeOpenskyClientID,
		RealtimeOpenskyClientSecret:      env.RealtimeOpenskyClientSecret,
		RealtimeAisEnabled:               env.RealtimeAisEnabled,
		RealtimeAisIntervalSec:           env.RealtimeAisIntervalSec,
		RealtimeUnrestEnabled:            env.RealtimeUnrestEnabled,
		RealtimeUnrestIntervalSec:        env.RealtimeUnrestIntervalSec,
		RealtimeOutagesEnabled:           env.RealtimeOutagesEnabled,
		RealtimeOutagesIntervalSec:       env.RealtimeOutagesIntervalSec,
		RealtimeKeywordSpikeEnabled:      env.RealtimeKeywordSpikeEnabled,
		RealtimeKeywordSpikeIntervalSec:  env.RealtimeKeywordSpikeIntervalSec,
		RealtimePizzintEnabled:           env.RealtimePizzintEnabled,
		RealtimePizzintIntervalSec:       env.RealtimePizzintIntervalSec,
		RealtimeGdeltTensionEnabled:      env.RealtimeGdeltTensionEnabled,
		RealtimeGdeltTensionIntervalSec:  env.RealtimeGdeltTensionIntervalSec,
		RealtimePolymarketLeadsEnabled:   env.RealtimePolymarketLeadsEnabled,
		RealtimePolymarketIntervalSec:    env.RealtimePolymarketIntervalSec,
		RealtimeKeywordSpikeMinCount:     env.RealtimeKeywordSpikeMinCount,
		RealtimeKeywordSpikeMultiplier:   env.RealtimeKeywordSpikeMultiplier,
		RealtimePredictionShiftThreshold: env.RealtimePredictionShiftThreshold,
		RealtimePredictionNewsThreshold:  env.RealtimePredictionNewsThreshold,
		RealtimeAisBaseURL:               env.RealtimeAisBaseURL,
		RealtimeAisSharedSecret:          env.RealtimeAisSharedSecret,
		RealtimeAcledOauthUsername:       env.RealtimeAcledOauthUsername,
		RealtimeAcledOauthPassword:       env.RealtimeAcledOauthPassword,
		RealtimeAcledOauthClientID:       env.RealtimeAcledOauthClientID,
		RealtimeCloudflareAPIToken:       env.RealtimeCloudflareAPIToken,
		RealtimeWingbitsAPIKey:           env.RealtimeWingbitsAPIKey,
		RealtimePolymarketProxyURL:       env.RealtimePolymarketProxyURL,

		NominatimUserAgentDefault: env.NominatimUserAgentDefault,
		NominatimEmailDefault:     env.NominatimEmailDefault,

		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
		NodeEnv:              cfg.NodeEnv,
	})
	handler := dataruntimesettings.NewHandler(dataruntimesettings.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.DataRuntimeSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: data runtime settings takeover mode=%s", cfg.DataRuntimeSettingsMode)
	return nil
}
