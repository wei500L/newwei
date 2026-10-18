package main

import (
	"database/sql"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
)

// newInfrastructureSettingsService builds the single infrastructure settings
// service of the process: the seven configuration routes, the runtime storage
// configuration reader used by the crawl media signing paths and the storage
// diagnostics handler all share this one object (and therefore the same MySQL
// pool and Redis client, no extra connections).
//
// It only maps configuration onto the service; it performs no query, no Redis
// call and no S3 call at startup.
func newInfrastructureSettingsService(cfg config.Config, db *sql.DB, redisClient *redis.Client) *infrastructuresettings.Service {
	return infrastructuresettings.NewService(db, redisClient, infrastructuresettings.Config{
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
}
