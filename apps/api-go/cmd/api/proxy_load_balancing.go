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

// wireProxyLoadBalancing registers the four LiteLLM proxy load balancing routes
// only when API_GO_PROXY_LOAD_BALANCING_MODE=go. Every other value (including the
// default legacy and the empty string) registers nothing, so the routes keep
// flowing through the NestJS proxy and rollback is a single variable change.
//
// The switch is independent of API_GO_MODEL_ACCESS_SETTINGS_MODE. It reuses the
// existing modelaccesssettings service (the same MySQL pool, the same Redis
// client, the same encryption policy and the same OpenAI key reader), but it
// neither requires nor enables the model access takeover: with load balancing
// "go" and model access "legacy", the LB routes still read the real OpenAI key
// configuration straight out of MySQL.
//
// go mode requires the shared MySQL pool, the shared Redis client and the
// ordinary JWT authenticator. It deliberately does NOT require:
//
//   - LITELLM_CONFIG_INTERNAL_TOKEN: a missing token is the 403 contract of the
//     internal snapshot route, never a startup failure;
//   - SYSTEM_SETTINGS_ENCRYPTION_KEY: its absence selects the fail-closed
//     production policy at write time;
//   - MONGO_URI: this batch reads no Mongo collection;
//   - any model upstream client: there is no outbound model HTTP call and no
//     request routing in Go — LiteLLM keeps executing the four routing
//     strategies.
func wireProxyLoadBalancing(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: proxy load balancing go takeover requires mysql, redis, and jwt")
	}
	settingsConfig := modelaccesssettings.NewProxyLoadBalancingConfigFromEnv(modelaccesssettings.EnvInput{
		DatabaseURL:                   cfg.DatabaseURL,
		LiteLLMConfigInternalTokenRaw: cfg.LiteLLMConfigInternalTokenRaw,
		SettingsEncryptionKeyRaw:      cfg.SystemSettingsEncryptionKeyRaw,
		NodeEnvRaw:                    cfg.NodeEnvRaw,
	})
	service := modelaccesssettings.NewService(db, redisClient, settingsConfig)
	handler := modelaccesssettings.NewHandler(
		modelaccesssettings.NewAuthenticator(authenticator, db),
		service,
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.ProxyLoadBalancingKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			// A non-preflight OPTIONS keeps the previous proxy destination.
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: proxy load balancing takeover mode=%s", "go")
	return nil
}
