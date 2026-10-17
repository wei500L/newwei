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

// wireInfrastructureSettings registers the seven infrastructure connection and
// crawl-credential settings routes only when
// API_GO_INFRASTRUCTURE_SETTINGS_MODE=go. Every other value (including the
// default legacy and the empty string) registers nothing, so the routes keep
// flowing through the NestJS proxy and rollback is a single variable change.
//
// The takeover needs the shared MySQL pool, the shared Redis client and the
// ordinary JWT authenticator. It deliberately creates no S3 or vector HTTP
// client and performs no startup network probe: the settings routes only read
// and write configuration.
func wireInfrastructureSettings(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if cfg.InfrastructureSettingsMode != config.InfrastructureSettingsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: infrastructure settings go takeover requires mysql, redis, and jwt")
	}
	service := infrastructuresettings.NewService(db, redisClient, infrastructuresettings.Config{
		VectorEnabled:         cfg.VectorServiceEnabled,
		VectorFallbackToMongo: cfg.VectorServiceFallbackToMongo,
		VectorBaseURL:         cfg.VectorServiceBaseURL,
		VectorToken:           cfg.VectorInternalToken,
		VectorTimeoutMs:       cfg.VectorServiceTimeoutMs,
		VectorMaxRetries:      cfg.VectorServiceMaxRetries,

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
		NodeEnv:              cfg.NodeEnv,
	})
	handler := infrastructuresettings.NewHandler(infrastructuresettings.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.InfrastructureSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: infrastructure settings takeover mode=%s", cfg.InfrastructureSettingsMode)
	return nil
}
