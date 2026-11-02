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
)

// wireStorageDiagnostics registers POST /api/admin/settings/storage/test only
// when API_GO_STORAGE_DIAGNOSTICS_MODE=go. Every other value (including the
// legacy default and the empty string) registers nothing, so the route keeps
// flowing through the NestJS proxy and rollback is one variable change.
//
// The handler needs the shared MySQL pool (the real SELECT 1 and the settings
// read), the shared Redis client (the storage settings cache), the ordinary JWT
// authenticator with settings.manage and the shared storage configuration
// reader. It deliberately builds no S3 client at startup and performs no probe:
// the diagnostics run only inside a request.
func wireStorageDiagnostics(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: storage diagnostics go takeover requires mysql, redis, and jwt")
	}
	service := newInfrastructureSettingsService(cfg, db, redisClient)
	handler := infrastructuresettings.NewStorageDiagnosticsHandler(
		infrastructuresettings.NewAuthenticator(authenticator, db),
		service,
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.StorageDiagnosticsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: storage diagnostics takeover mode=%s", "go")
	return nil
}
