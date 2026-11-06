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
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
)

// wireInfrastructureSettings registers the seven infrastructure connection and
// crawl-credential settings routes. The rules are registered unconditionally;
// unmatched paths are answered with the Nest-shaped 404.
//
// The takeover needs the shared MySQL pool, the shared Redis client and the
// ordinary JWT authenticator. It deliberately creates no S3 or vector HTTP
// client and performs no startup network probe: the settings routes only read
// and write configuration.
func wireInfrastructureSettings(gateway *httproute.Router, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: infrastructure settings go takeover requires mysql, redis, and jwt")
	}
	service := newInfrastructureSettingsService(cfg, db, redisClient)
	handler := infrastructuresettings.NewHandler(infrastructuresettings.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.InfrastructureSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: infrastructure settings takeover mode=%s", "go")
	return nil
}
