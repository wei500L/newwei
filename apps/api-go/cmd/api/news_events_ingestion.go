package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/newseventsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// newsEventsIngestionRuntime is the wired scheduler plus the Mongo connection
// this helper opened when no other subsystem had one. Close owns both.
type newsEventsIngestionRuntime struct {
	scheduler *newseventsingest.Scheduler
	mongo     *dashboardstats.Connection
}

// Close stops the scheduler, waits for in-flight organizations and releases a
// connection this helper opened.
func (r *newsEventsIngestionRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var first error
	if r.scheduler != nil {
		if err := r.scheduler.Close(ctx); err != nil {
			first = err
		}
	}
	if r.mongo != nil {
		if err := r.mongo.Disconnect(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// wireNewsEventsIngestion builds the news-event ingestion scheduler when
// API_GO_NEWS_EVENTS_INGESTION_MODE=go. It registers no HTTP route and needs no
// JWT: the chain is a background Cron owner that reads MySQL, Redis and Mongo.
//
// mongoDatabase is an already-open shared connection. When it is nil this helper
// opens its own from MONGO_URI and owns it.
func wireNewsEventsIngestion(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
) (*newsEventsIngestionRuntime, error) {
	if cfg.NewsEventsIngestionMode != config.NewsEventsIngestionModeGo {
		return nil, nil
	}
	if db == nil {
		return nil, fmt.Errorf("api-go: API_GO_NEWS_EVENTS_INGESTION_MODE=go requires mysql")
	}
	if redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_NEWS_EVENTS_INGESTION_MODE=go requires redis")
	}

	runtime := &newsEventsIngestionRuntime{}
	if mongoDatabase == nil {
		if cfg.MongoURI == "" {
			return nil, fmt.Errorf("api-go: API_GO_NEWS_EVENTS_INGESTION_MODE=go requires mongo")
		}
		opened, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: news event ingestion mongo connection: %w", err)
		}
		runtime.mongo = opened
		mongoDatabase = opened.Database()
	}
	if mongoDatabase == nil {
		return nil, fmt.Errorf("api-go: API_GO_NEWS_EVENTS_INGESTION_MODE=go requires mongo")
	}

	// The model-service configuration is resolved through the same environment
	// projection the settings routes and the assistant use. An invalid
	// MODEL_SERVICE_* value fails startup here, matching the NestJS schema.
	modelSettingsConfig, err := modelaccesssettings.NewConfigFromEnv(modelaccesssettings.EnvInput{
		DatabaseURL:                   cfg.DatabaseURL,
		ModelServiceEnabledRaw:        cfg.ModelServiceEnabledRaw,
		ModelServiceBaseURLRaw:        cfg.ModelServiceBaseURLRaw,
		ModelServiceInternalTokenRaw:  cfg.ModelServiceInternalTokenRaw,
		ModelServiceTimeoutMsRaw:      cfg.ModelServiceTimeoutMsRaw,
		ModelServiceMaxRetriesRaw:     cfg.ModelServiceMaxRetriesRaw,
		LiteLLMConfigInternalTokenRaw: cfg.LiteLLMConfigInternalTokenRaw,
		SettingsEncryptionKeyRaw:      cfg.SystemSettingsEncryptionKeyRaw,
		NodeEnvRaw:                    cfg.NodeEnvRaw,
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: news event ingestion model service configuration: %w", err)
	}

	runtime.scheduler = newseventsingest.NewScheduler(newseventsingest.SchedulerOptions{
		DB:          db,
		RedisClient: redisClient,
		Mongo:       mongoDatabase,
		Settings: newseventsingest.ReadModelSettingsReader{
			Reader: settingscrawl.NewNewsEventsIngestSettingsReader(db),
		},
		Concurrency: runtimesettings.NewService(db, redisClient, runtimesettings.Config{}),
		Model:       newseventsingest.NewModelClient(modelaccesssettings.NewService(db, redisClient, modelSettingsConfig)),
		Vectors: newseventsingest.NewVectorSearcher(newseventsingest.VectorSearcherOptions{
			DB:                       db,
			Redis:                    redisClient,
			Enabled:                  cfg.VectorServiceEnabled,
			FallbackToMongo:          cfg.VectorServiceFallbackToMongo,
			BaseURL:                  cfg.VectorServiceBaseURL,
			Token:                    cfg.VectorInternalToken,
			TimeoutMs:                cfg.VectorServiceTimeoutMs,
			MaxRetries:               cfg.VectorServiceMaxRetries,
			SettingsEncryptionKeyRaw: cfg.SystemSettingsEncryptionKeyRaw,
		}),
		Settle: time.Duration(cfg.NewsEventsIngestionSettleMs) * time.Millisecond,
	})
	log.Printf("api-go: news event ingestion scheduler configured settle=%dms", cfg.NewsEventsIngestionSettleMs)
	return runtime, nil
}
