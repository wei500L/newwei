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
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/emailsettings"
	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayops"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimediagnostics"
)

// wireEmailSettings registers the three email settings routes only when
// API_GO_EMAIL_SETTINGS_MODE=go. The unit talks to the real SMTP transport, so it
// needs the shared MySQL/Redis/JWT stack and the SMTP_* configuration; it starts
// no worker and opens no second pool.
func wireEmailSettings(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: email settings go takeover requires mysql, redis, and jwt")
	}
	service := emailsettings.NewService(emailsettings.NewDB(db), redisClient, emailsettings.Config{
		SMTP: emailsettings.SMTPConfig{
			Host:                  cfg.SMTP.Host,
			Port:                  cfg.SMTP.Port,
			Secure:                cfg.SMTP.Secure,
			User:                  cfg.SMTP.User,
			Pass:                  cfg.SMTP.Pass,
			From:                  cfg.SMTP.From,
			Pool:                  cfg.SMTP.Pool,
			MaxConnections:        cfg.SMTP.MaxConnections,
			MaxMessages:           cfg.SMTP.MaxMessages,
			RateDeltaMs:           cfg.SMTP.RateDeltaMs,
			RateLimit:             cfg.SMTP.RateLimit,
			ConnectionTimeoutMs:   cfg.SMTP.ConnectionTimeoutMs,
			GreetingTimeoutMs:     cfg.SMTP.GreetingTimeoutMs,
			SocketTimeoutMs:       cfg.SMTP.SocketTimeoutMs,
			TLSRejectUnauthorized: cfg.SMTP.TLSRejectUnauthorized,
		},
		AuthCodeTTLSeconds:      cfg.AuthEmailCodeTTLSeconds,
		AuthCodeCooldownSeconds: cfg.AuthEmailCodeCooldownSeconds,
		AuthCodeMaxAttempts:     cfg.AuthEmailCodeMaxAttempts,
	})
	handler := emailsettings.NewHandler(platformgovernance.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.EmailSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: email settings takeover mode=%s", "go")
	return nil
}

// wireGeocoding registers the two geocoding routes only when
// API_GO_GEOCODING_MODE=go. It shares the geo:geocode:v1 cache, the
// rate:geocode:nominatim limiter and the geo_nominatim_identity row with NestJS.
func wireGeocoding(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: geocoding go takeover requires mysql, redis, and jwt")
	}
	client := newGeocodingClient(cfg, db, redisClient)
	handler := geocoding.NewHandler(platformgovernance.NewAuthenticator(authenticator, db), client)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.GeocodingKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: geocoding takeover mode=%s", "go")
	return nil
}

// wireRuntimeDiagnostics registers the two read-only diagnostics routes only when
// API_GO_RUNTIME_DIAGNOSTICS_MODE=go. The realtime half reuses the data runtime
// settings normalization and the shared Redis/MySQL/Mongo connections; the
// assistant safety half reuses the platform governance / model access / LLM
// gateway readers and performs three real LiteLLM probes.
func wireRuntimeDiagnostics(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: runtime diagnostics go takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: runtime diagnostics go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	profiles := newLLMGatewayProfilesService(cfg, db, redisClient, nil)
	ops := llmgatewayops.NewService(db, redisClient, profiles, nil, llmgatewayops.Config{
		MasterKey: cfg.LiteLLMMasterKey,
	})
	platform := platformgovernance.NewService(db, redisClient, mongoDatabase, platformgovernance.Env{
		AssistantGuardrailsEnabled: cfg.PlatformGovernanceAssistantGuardrailsEnabled,
		AssistantGuardrails:        cfg.PlatformGovernanceAssistantGuardrailsRaw,
		EncryptionKeyRaw:           cfg.SettingsEncryptionKeyRaw,
	})
	modelAccess := newModelAccessSettingsService(cfg, db, redisClient)
	safety := runtimediagnostics.NewSafetyService(profiles, ops, platform, modelAccess,
		cfg.LiteLLMAPIBase, cfg.LiteLLMAPIKey)

	realtimeSettings := newDataRuntimeSettingsService(cfg, db, redisClient)
	realtime := runtimediagnostics.NewRealtimeService(realtimeSettings, redisClient, db, mongoDatabase)

	handler := runtimediagnostics.NewHandler(platformgovernance.NewAuthenticator(authenticator, db), safety, realtime)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.RuntimeDiagnosticsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: runtime diagnostics takeover mode=%s", "go")
	return nil
}

// newModelAccessSettingsService builds the shared model-access service with the
// same environment projection the settings routes use.
func newModelAccessSettingsService(cfg config.Config, db *sql.DB, redisClient *redis.Client) *modelaccesssettings.Service {
	settingsConfig, err := modelaccesssettings.NewConfigFromEnv(modelaccesssettings.EnvInput{
		DatabaseURL:                   cfg.DatabaseURL,
		ModelServiceEnabledRaw:        cfg.ModelServiceEnabledRaw,
		ModelServiceBaseURLRaw:        cfg.ModelServiceBaseURLRaw,
		ModelServiceInternalTokenRaw:  cfg.ModelServiceInternalTokenRaw,
		ModelServiceTimeoutMsRaw:      cfg.ModelServiceTimeoutMsRaw,
		ModelServiceMaxRetriesRaw:     cfg.ModelServiceMaxRetriesRaw,
		LiteLLMConfigInternalTokenRaw: cfg.LiteLLMConfigInternalTokenRaw,
		SettingsEncryptionKeyRaw:      cfg.SystemSettingsEncryptionKeyRaw,
		NodeEnvRaw:                    cfg.NodeEnvRaw,
	})
	if err != nil {
		// The diagnostics only read the public projection; invalid optional
		// environment values fall back to the schema defaults the config layer
		// already applied for the other switches.
		settingsConfig = modelaccesssettings.Config{}
	}
	return modelaccesssettings.NewService(db, redisClient, settingsConfig)
}

// newDataRuntimeSettingsService builds the shared data runtime settings service
// with the same environment defaults the nine settings routes use.
func newDataRuntimeSettingsService(cfg config.Config, db *sql.DB, redisClient *redis.Client) *dataruntimesettings.Service {
	env := cfg.DataRuntimeSettings
	return dataruntimesettings.NewService(db, redisClient, dataruntimesettings.Config{
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
}
