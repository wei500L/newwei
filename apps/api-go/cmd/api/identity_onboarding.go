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
	"github.com/wei500L/newwei/apps/api-go/internal/identityonboarding"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireIdentityOnboarding registers the fourteen registration, invitation and
// registration-application routes only when
// API_GO_IDENTITY_ONBOARDING_MODE=go. Every other value (including the default
// legacy and the empty string) registers nothing, so the routes keep flowing
// through the NestJS proxy and rollback is a single variable change.
//
// The takeover needs the shared MySQL pool, the shared Redis client, the
// ordinary JWT authenticator and the SMTP_* transport (invitations and the two
// rejection paths deliver real mail synchronously). It opens no Mongo
// connection, starts no worker or scheduler and performs no startup network
// probe: the SMTP connection is established per message, inside the request that
// needs it.
func wireIdentityOnboarding(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if cfg.IdentityOnboardingMode != config.IdentityOnboardingModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: identity onboarding go takeover requires mysql, redis, and jwt")
	}

	mail := authlogin.NewMailSender(authlogin.SMTPConfig{
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
	})
	service := identityonboarding.NewService(db, redisClient, mail, identityonboarding.Config{
		BaseURL: cfg.NextAuthURL,
	})
	handler := identityonboarding.NewHandler(
		identityonboarding.NewAuthenticator(authenticator, db, redisClient),
		service,
	)

	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.IdentityOnboardingKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: identity onboarding takeover mode=%s", cfg.IdentityOnboardingMode)
	return nil
}
