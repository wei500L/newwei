package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireAccountSecurity registers the eight account/session/machine-token routes
// only when API_GO_ACCOUNT_SECURITY_MODE=go. Every other value (including the
// default legacy and the empty string) registers nothing, so the routes keep
// flowing through the NestJS proxy and rollback is a single variable change.
//
// The takeover needs the shared MySQL pool, the shared Redis client and JWT
// verification. It deliberately opens no Mongo connection and performs no
// startup network probe: the eight routes read and write MySQL and Redis only.
// It reuses the same JWTAudience/JWTIssuer/JWTSecret configuration as the
// ordinary authhttp chain but keeps its own authenticator because the machine
// (mtk_) token path and the verified jti/exp metadata are specific to this unit.
func wireAccountSecurity(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client) error {
	if db == nil || redisClient == nil {
		return fmt.Errorf("api-go: account security go takeover requires mysql and redis")
	}

	service := accountsecurity.NewService(db, redisClient, accountsecurity.Config{
		AuthProfileCacheTTLSeconds:   cfg.AuthProfileCacheTTLSeconds,
		AuthProfileCacheLockTTLMs:    cfg.AuthProfileCacheLockTTLMs,
		AuthProfileCacheMaxWaitMs:    cfg.AuthProfileCacheMaxWaitMs,
		AuthProfileCacheRetryDelayMs: cfg.AuthProfileCacheRetryDelayMs,

		S3AccessKeyID:            cfg.S3AccessKeyID,
		S3SecretAccessKey:        cfg.S3SecretAccessKey,
		S3Region:                 cfg.S3Region,
		S3Bucket:                 cfg.S3Bucket,
		S3Endpoint:               cfg.S3Endpoint,
		S3PublicBaseURL:          cfg.S3PublicBaseURL,
		S3ForcePathStyle:         cfg.S3ForcePathStyle,
		S3PresignedURLTTLSeconds: cfg.S3PresignedURLTTLSeconds,

		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
	})

	verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	blacklist := authn.NewRedisBlacklist(redisClient)
	handler := accountsecurity.NewHandler(
		accountsecurity.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(db), db),
		service,
	)

	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.AccountSecurityKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: account security takeover mode=%s", "go")
	return nil
}
