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
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

// wireModelAccessSettings registers the ten model access settings routes only when
// API_GO_MODEL_ACCESS_SETTINGS_MODE=go. Every other value (including the default
// legacy and the empty string) registers nothing, so the routes keep flowing
// through the NestJS proxy and rollback is a single variable change.
//
// go mode requires the shared MySQL pool, the shared Redis client and the ordinary
// JWT authenticator. It deliberately does NOT require:
//
//   - LITELLM_CONFIG_INTERNAL_TOKEN: a missing token is the 403 contract of the
//     two internal endpoints, never a startup failure;
//   - SYSTEM_SETTINGS_ENCRYPTION_KEY: its absence selects the fail-closed
//     production policy at write time;
//   - MONGO_URI: this batch reads no Mongo collection;
//   - any model upstream client: there is no outbound model HTTP call, no startup
//     probe and no model API request in this batch.
func wireModelAccessSettings(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
) error {
	if cfg.ModelAccessSettingsMode != config.ModelAccessSettingsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: model access settings go takeover requires mysql, redis, and jwt")
	}
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
		return fmt.Errorf("api-go: model access settings environment is invalid: %w", err)
	}
	service := modelaccesssettings.NewService(db, redisClient, settingsConfig)
	handler := modelaccesssettings.NewHandler(
		modelaccesssettings.NewAuthenticator(authenticator, db),
		service,
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.ModelAccessSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			// A non-preflight OPTIONS keeps the previous proxy destination.
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: model access settings takeover mode=%s", cfg.ModelAccessSettingsMode)
	return nil
}
