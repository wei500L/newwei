package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountdata"
	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
)

// wireAccountData registers the two remaining identity entries only for the
// switches that are go:
//
//	POST /api/auth/avatar/presigned-url  (API_GO_AVATAR_UPLOAD_MODE)
//	GET  /api/auth/data-export           (API_GO_USER_DATA_EXPORT_MODE)
//
// Authentication reuses the accountsecurity chain (human JWT, Redis
// revocation list, MySQL membership re-derivation and mtk_ machine tokens).
// The storage configuration reader is the same accountsecurity implementation
// the avatar URL check already uses, so the nine SystemSetting keys, the Redis
// cache and the secret decryption stay in one place. Mongo is opened only when
// the export is taken over and no other unit opened it already; the shared
// shutdown path closes it.
func wireAccountData(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
) error {
	avatarGo := true
	exportGo := true
	if !avatarGo && !exportGo {
		return nil
	}
	if db == nil || redisClient == nil {
		return fmt.Errorf("api-go: account data takeover requires mysql and redis")
	}

	storage := accountsecurity.NewService(db, redisClient, accountsecurity.Config{
		S3AccessKeyID:            cfg.S3AccessKeyID,
		S3SecretAccessKey:        cfg.S3SecretAccessKey,
		S3Region:                 cfg.S3Region,
		S3Bucket:                 cfg.S3Bucket,
		S3Endpoint:               cfg.S3Endpoint,
		S3PublicBaseURL:          cfg.S3PublicBaseURL,
		S3ForcePathStyle:         cfg.S3ForcePathStyle,
		S3PresignedURLTTLSeconds: cfg.S3PresignedURLTTLSeconds,
		EncryptionKeyRaw:         cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent:     cfg.SettingsEncryptionKeyPresent,
	})

	var behavior *newsbehavior.Service
	var assistantRuns accountdata.AssistantRunSource
	if exportGo {
		behavior = newsbehavior.NewService(db, redisClient)
		if mongoConn == nil || *mongoConn == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				return fmt.Errorf("api-go: API_GO_USER_DATA_EXPORT_MODE=go requires a valid MONGO_URI")
			}
			*mongoConn = conn
		}
		assistantRuns = accountdata.NewMongoAssistantRuns((*mongoConn).Database())
	}

	verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	blacklist := authn.NewRedisBlacklist(redisClient)
	authenticator := accountsecurity.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(db), db)
	service := accountdata.NewService(accountdata.Options{
		DB:            db,
		Redis:         redisClient,
		Storage:       storage,
		Behavior:      behavior,
		AssistantRuns: assistantRuns,
		Config: accountdata.Config{
			TrustProxy:        cfg.TrustProxy,
			RateLimitFailOpen: cfg.RateLimitFailOpen,
		},
	})
	handler := accountdata.NewHandler(authenticator, service)
	policy := cors.New(cfg.CorsOrigin)
	register := func(key string) {
		gateway.RegisterGoHandler(key, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
	}
	if avatarGo {
		register(legacyproxy.AvatarUploadKey)
	}
	if exportGo {
		register(legacyproxy.UserDataExportKey)
	}
	log.Printf("api-go: account data takeover avatar=%s export=%s", "go", "go")
	return nil
}
