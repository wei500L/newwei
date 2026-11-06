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
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/identityonboarding"
)

// wireIdentityOnboarding registers the sixteen registration, invitation and
// registration-application routes. The rules are registered unconditionally;
// unmatched paths are answered with the Nest-shaped 404.
//
// The takeover needs the shared MySQL pool, the shared Redis client, the
// ordinary JWT authenticator and the SMTP_* transport (invitations and the two
// rejection paths deliver real mail synchronously). It opens no Mongo
// connection, starts no worker or scheduler and performs no startup network
// probe: the SMTP connection is established per message, inside the request
// that needs it.
func wireIdentityOnboarding(gateway *httproute.Router, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
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
	gateway.Handle(httproute.IdentityOnboardingKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: identity onboarding takeover mode=%s", "go")
	return nil
}
