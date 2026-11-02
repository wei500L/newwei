package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireAuthLogin registers the eleven POST /api/auth login, session, email-code
// and password-recovery routes only when API_GO_AUTH_LOGIN_MODE=go. Every other
// value (including the default legacy and the empty string) registers nothing,
// so the routes keep flowing through the NestJS proxy and rollback is a single
// variable change.
//
// The takeover needs the shared MySQL pool, the shared Redis client, the
// ordinary JWT authenticator and the SMTP_* transport (four routes deliver real
// mail synchronously). It deliberately opens no Mongo connection, starts no
// worker or scheduler and performs no startup network probe: the SMTP connection
// is established per message, inside the request that needs it.
func wireAuthLogin(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: auth login go takeover requires mysql, redis, and jwt")
	}

	service := authlogin.NewService(db, redisClient, authlogin.Config{
		JWTSecret:        cfg.JWTSecret,
		JWTIssuer:        cfg.JWTIssuer,
		JWTAudience:      cfg.JWTAudience,
		AccessExpiresIn:  cfg.JWTAccessExpiresIn,
		RefreshExpiresIn: cfg.JWTRefreshExpiresIn,

		AuthRefreshGraceSeconds:     cfg.AuthRefreshGraceSeconds,
		AuthMfaChallengeMaxAttempts: cfg.AuthMfaChallengeMaxAttempts,

		AuthEmailCodeTTLSeconds:      cfg.AuthEmailCodeTTLSeconds,
		AuthEmailCodeCooldownSeconds: cfg.AuthEmailCodeCooldownSeconds,
		AuthEmailCodeMaxAttempts:     cfg.AuthEmailCodeMaxAttempts,

		RateLimitLogin:       cfg.RateLimitLogin,
		RateLimitLoginWindow: cfg.RateLimitLoginWindow,
		RateLimitFailOpen:    cfg.RateLimitFailOpen,

		NextAuthURL: cfg.NextAuthURL,
		TrustProxy:  cfg.TrustProxy,

		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
		NodeEnv:              cfg.NodeEnv,

		SMTP: authlogin.SMTPConfig{
			Host:                  cfg.SMTP.Host,
			Port:                  cfg.SMTP.Port,
			Secure:                cfg.SMTP.Secure,
			User:                  cfg.SMTP.User,
			Pass:                  cfg.SMTP.Pass,
			From:                  cfg.SMTP.From,
			Pool:                  cfg.SMTP.Pool,
			ConnectionTimeoutMs:   cfg.SMTP.ConnectionTimeoutMs,
			GreetingTimeoutMs:     cfg.SMTP.GreetingTimeoutMs,
			SocketTimeoutMs:       cfg.SMTP.SocketTimeoutMs,
			TLSRejectUnauthorized: cfg.SMTP.TLSRejectUnauthorized,
		},
	})
	handler := authlogin.NewHandler(authenticator, service)

	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.AuthLoginKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: auth login takeover mode=%s", "go")
	return nil
}
