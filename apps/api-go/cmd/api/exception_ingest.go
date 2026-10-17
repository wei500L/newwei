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
	"github.com/wei500L/newwei/apps/api-go/internal/exceptioningest"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireExceptionIngest registers the two migrated exception-report POST endpoints
// only when the switch is go; legacy (including the empty string) registers
// nothing and both POSTs keep falling through to NestJS. The Mongo connection
// reuses the one the other takeovers already opened (opened on demand here when
// this is the only Mongo-backed takeover).
func wireExceptionIngest(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if cfg.ExceptionIngestMode != config.ExceptionIngestModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: exception ingest go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: exception ingest go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	service := exceptioningest.NewService((*mongoConn).Database(), redisClient, exceptioningest.Config{
		UserRateLimit:          cfg.ObservabilityClientExceptionUserRateLimit,
		IPRateLimit:            cfg.ObservabilityClientExceptionIPRateLimit,
		RateLimitWindowSeconds: cfg.ObservabilityClientExceptionWindowSeconds,
		TrustProxy:             cfg.TrustProxy,
		InternalToken:          cfg.LiteLLMConfigInternalTokenRaw,
	})
	handler := exceptioningest.NewHandler(authenticator, service)
	policy := cors.New(cfg.CorsOrigin)
	serve := func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			// A non-preflight OPTIONS keeps the previous proxy destination.
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	}
	gateway.RegisterGoHandler(legacyproxy.ExceptionIngestClientKey, serve)
	gateway.RegisterGoHandler(legacyproxy.ExceptionIngestInternalKey, serve)
	log.Printf("api-go: exception ingest takeover mode=%s", cfg.ExceptionIngestMode)
	return nil
}
