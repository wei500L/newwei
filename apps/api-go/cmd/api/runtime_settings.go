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
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// wireRuntimeSettings registers the eighteen runtime/governance settings routes
// only when API_GO_RUNTIME_SETTINGS_MODE=go. Every other value (including the
// default legacy and the empty string) registers nothing, so the routes keep
// flowing through the NestJS proxy and rollback is a single variable change.
func wireRuntimeSettings(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if cfg.RuntimeSettingsMode != config.RuntimeSettingsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: runtime settings go takeover requires mysql, redis, and jwt")
	}
	service := runtimesettings.NewService(db, redisClient, runtimesettings.Config{
		RateLimitLogin:                   cfg.RateLimitLogin,
		RateLimitLoginWindow:             cfg.RateLimitLoginWindow,
		RateLimitCrawlTaskCreate:         cfg.RateLimitCrawlTaskCreate,
		RateLimitCrawlTaskCreateWindow:   cfg.RateLimitCrawlTaskCreateWindow,
		RateLimitRbacWrite:               cfg.RateLimitRbacWrite,
		RateLimitRbacWriteWindow:         cfg.RateLimitRbacWriteWindow,
		RateLimitSettingsCacheTTLSeconds: cfg.RateLimitSettingsCacheTTLSeconds,
		AuthProfileCacheTTLSeconds:       cfg.AuthProfileCacheTTLSeconds,
		AuthProfileCacheLockTTLMs:        cfg.AuthProfileCacheLockTTLMs,
		AuthProfileCacheMaxWaitMs:        cfg.AuthProfileCacheMaxWaitMs,
		AuthProfileCacheRetryDelayMs:     cfg.AuthProfileCacheRetryDelayMs,
		AuditLogRetentionDays:            cfg.AuditLogRetentionDays,
	})
	handler := runtimesettings.NewHandler(runtimesettings.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.RuntimeSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: runtime settings takeover mode=%s", cfg.RuntimeSettingsMode)
	return nil
}
