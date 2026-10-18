package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authfactors"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/oidclogin"
)

// wireOIDCLogin registers the three public organization-SSO routes only when
// API_GO_OIDC_LOGIN_MODE=go. Every other value (including the default legacy and
// the empty string) registers nothing, so the routes keep flowing through the
// NestJS proxy and rollback is one variable change.
//
// The takeover needs the shared MySQL pool and Redis client: the trusted-login
// core re-derives the user/membership/MFA state from MySQL and signs the local
// session, while Redis holds the state/discovery/JWKS caches. It deliberately
// does not require MONGO_URI, SMTP delivery, AUTH_LOGIN/AUTH_FACTORS go modes or
// a GraphQL executor. The reused authlogin service is constructed with the same
// configuration the login batch uses, but this unit only calls the trusted
// login entry, which never sends mail.
func wireOIDCLogin(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client) error {
	if cfg.OIDCLoginMode != config.OIDCLoginModeGo {
		return nil
	}
	if db == nil || redisClient == nil {
		return fmt.Errorf("api-go: oidc login go takeover requires mysql and redis")
	}

	loginService := authlogin.NewService(db, redisClient, authlogin.Config{
		JWTSecret:        cfg.JWTSecret,
		JWTIssuer:        cfg.JWTIssuer,
		JWTAudience:      cfg.JWTAudience,
		AccessExpiresIn:  cfg.JWTAccessExpiresIn,
		RefreshExpiresIn: cfg.JWTRefreshExpiresIn,

		AuthRefreshGraceSeconds:     cfg.AuthRefreshGraceSeconds,
		AuthMfaChallengeMaxAttempts: cfg.AuthMfaChallengeMaxAttempts,

		NextAuthURL: cfg.NextAuthURL,
		TrustProxy:  cfg.TrustProxy,

		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
		NodeEnv:              cfg.NodeEnv,
	})
	secrets := authfactors.NewService(db, redisClient, authfactors.Config{
		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
		NodeEnv:              cfg.NodeEnv,
	})
	service := oidclogin.NewService(db, redisClient, oidclogin.Config{
		NextAuthURL: cfg.NextAuthURL,
		APIBaseURL:  cfg.APIBaseURL,
		TrustProxy:  cfg.TrustProxy,
	}, loginService, secrets)
	handler := oidclogin.NewHandler(service)

	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.OIDCLoginKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: oidc login takeover mode=%s", cfg.OIDCLoginMode)
	return nil
}
