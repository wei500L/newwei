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
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// wireVectorDiagnostics registers the exact GET
// /api/system-settings/vector-service/diagnostics only when
// API_GO_VECTOR_DIAGNOSTICS_MODE=go. Every other value (including the legacy
// default and the empty string) returns before touching the gateway, so the
// route keeps flowing through the NestJS proxy and rollback is one variable
// change.
//
// The handler needs the shared MySQL pool (the vector_service SystemSetting
// read), the shared Redis client (the vector_service:settings cache), the
// ordinary JWT authenticator with settings.manage and the process-wide
// vectorclient.Health shared with the search and upsert clients. It performs no
// startup query and opens no extra connection: the settings are read inside the
// request, exactly like the seven infrastructure settings routes.
func wireVectorDiagnostics(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	health *vectorclient.Health,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: vector diagnostics go takeover requires mysql, redis, and jwt")
	}
	if health == nil {
		health = &vectorclient.Health{}
	}
	service := newInfrastructureSettingsService(cfg, db, redisClient)
	handler := infrastructuresettings.NewVectorDiagnosticsHandler(
		service,
		infrastructuresettings.NewAuthenticator(authenticator, db),
		health,
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.VectorDiagnosticsHandlerKey, func(w http.ResponseWriter, r *http.Request) {
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
	log.Printf("api-go: vector service diagnostics takeover mode=%s", "go")
	return nil
}
