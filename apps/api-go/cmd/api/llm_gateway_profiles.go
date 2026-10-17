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
	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// wireLLMGatewayProfiles registers the seven LLM gateway configuration-control
// routes only when API_GO_LLM_GATEWAY_PROFILES_MODE=go. Every other value
// (including the default legacy and the empty string) registers nothing, so the
// routes keep flowing through the NestJS proxy and rollback is a single variable
// change.
//
// The takeover needs MySQL (settings, governance and security rows), Redis (the
// read cache) and the JWT authenticator. It does not need Mongo, an outbound
// model HTTP client or any model upstream probe.
func wireLLMGatewayProfiles(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if cfg.LLMGatewayProfilesMode != config.LLMGatewayProfilesModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: llm gateway profiles go takeover requires mysql, redis, and jwt")
	}
	// The lock pool is separate from the shared pool and retains no idle
	// connections, so releasing a lock connection always closes the physical
	// MySQL session.
	lockDB, err := usersettings.OpenMySQLFromURL(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("api-go: llm gateway profiles lock pool: %w", err)
	}
	lockDB.SetMaxIdleConns(0)

	service := llmgatewayprofiles.NewService(db, lockDB, redisClient, llmgatewayprofiles.Config{
		Env: llmgatewayprofiles.EnvDefaults{
			Model:           cfg.LLMGatewayModel,
			APIBase:         cfg.LiteLLMAPIBase,
			TimeoutMs:       float64(cfg.LiteLLMTimeoutMs),
			Temperature:     cfg.LLMGatewayTemperature,
			TopP:            cfg.LLMGatewayTopP,
			MaxOutputTokens: float64(cfg.LLMGatewayMaxOutputTokens),
			MaxRetries:      float64(cfg.LLMGatewayMaxRetries),
			FallbackModels:  cfg.LLMGatewayFallbackModels,
		},
		SettingsEncryptionKey: cfg.LLMGatewaySettingsEncryptionKey,
		Production:            cfg.NodeEnvProduction,
		LockTimeoutSeconds:    10,
	})
	handler := llmgatewayprofiles.NewHandler(
		llmgatewayprofiles.NewAuthenticator(authenticator, db),
		service,
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.LLMGatewayProfilesKey, func(w http.ResponseWriter, r *http.Request) {
		// Unmigrated static paths are forwarded before authentication, body
		// decoding and CORS handling, so PUT/DELETE /proxy-governance and
		// /proxy-load-balancing can never be mistaken for a profile id. Their
		// OPTIONS requests take the same path, so this batch's preflight
		// handling never claims them.
		if llmgatewayprofiles.IsUnmigratedStaticPath(r.URL.Path) {
			gateway.ServeLegacy(w, r)
			return
		}
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: llm gateway profiles takeover mode=%s", cfg.LLMGatewayProfilesMode)
	return nil
}
