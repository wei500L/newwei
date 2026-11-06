package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
)

// wireAccountSecurity registers the eight account/session/machine-token
// routes. The rules are registered unconditionally; unmatched paths are
// answered with the Nest-shaped 404.
//
// The takeover needs the shared MySQL pool, the shared Redis client and JWT
// verification. It deliberately opens no Mongo connection and performs no
// startup network probe: the eight routes read and write MySQL and Redis only.
// It reuses the same JWTAudience/JWTIssuer/JWTSecret configuration as the
// ordinary authhttp chain but keeps its own authenticator because the machine
// (mtk_) token path and the verified jti/exp metadata are specific to this
// unit.
func wireAccountSecurity(gateway *httproute.Router, cfg config.Config, db *sql.DB, redisClient *redis.Client, auth *authhttp.Authenticator) error {
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

	handler := accountsecurity.NewHandler(
		accountsecurity.NewAuthenticator(auth),
		service,
	)

	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.AccountSecurityKey, func(w http.ResponseWriter, r *http.Request) {
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
