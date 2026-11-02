package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authfactors"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireAuthFactors registers the seven authenticated MFA management and
// organization OIDC configuration routes only when API_GO_AUTH_FACTORS_MODE=go.
// Every other value (including the default legacy and the empty string)
// registers nothing, so the routes keep flowing through the NestJS proxy and
// rollback is a single variable change.
//
// The takeover needs the shared MySQL pool, the shared Redis client and the
// ordinary JWT authenticator. It deliberately creates no HTTP client and
// performs no startup network probe: the OIDC routes only read and write local
// configuration and never contact an identity provider.
func wireAuthFactors(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: auth factors go takeover requires mysql, redis, and jwt")
	}
	service := authfactors.NewService(db, redisClient, authfactors.Config{
		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
		NodeEnv:              cfg.NodeEnv,
	})
	handler := authfactors.NewHandler(authfactors.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.AuthFactorsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: auth factors takeover mode=%s", "go")
	return nil
}
