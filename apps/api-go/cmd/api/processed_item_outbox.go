package main

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
	"github.com/wei500L/newwei/apps/api-go/internal/processeditemoutbox"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// wireProcessedItemOutbox builds the processed_item compensation owner only
// when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go and SCHEDULE_ENABLED is not false.
// It starts no HTTP route, verifies no JWT and leaves immediate delivery plus
// the in-process NestJS retry untouched.
//
// health is the process-wide vector circuit state shared with the itemPipeline
// worker. The compensation scanner keeps the upsertOrThrow contract: while the
// shared window is open, vectorclient.Client.Upsert returns
// VectorServiceUnavailableError and the delivery is retried/dead-lettered
// instead of hammering vector-go. A nil value is replaced by an empty state.
func wireProcessedItemOutbox(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
	health *vectorclient.Health,
) (*processeditemoutbox.Scheduler, error) {
	if !cfg.ScheduleEnabled {
		return nil, nil
	}
	if db == nil || redisClient == nil || mongoDatabase == nil {
		return nil, fmt.Errorf("api-go: API_GO_PROCESSED_ITEM_OUTBOX_MODE=go requires mysql, redis and mongo")
	}
	if health == nil {
		health = &vectorclient.Health{}
	}
	settings := newInfrastructureSettingsService(cfg, db, redisClient)
	service := processeditemoutbox.NewService(processeditemoutbox.Options{
		DB:           db,
		Mongo:        mongoDatabase,
		VectorConfig: processedItemVectorConfigSource{settings: settings},
		VectorWriter: &vectorclient.Client{Health: health},
		BatchSize:    cfg.ProcessedItemOutboxBatchSize,
		Concurrency:  cfg.ProcessedItemOutboxConcurrency,
		TickBudget:   time.Duration(cfg.ProcessedItemOutboxTickBudgetMs) * time.Millisecond,
	})
	return processeditemoutbox.NewScheduler(service, userdigest.NewRedisDeliveryStore(redisClient), nil), nil
}

// processedItemVectorConfigSource adapts the shared effective vector-service
// configuration to the outbox port. It deliberately reuses the same MySQL row,
// Redis cache and token decryption as the infrastructure settings read route.
type processedItemVectorConfigSource struct {
	settings *infrastructuresettings.Service
}

// EffectiveVectorConfig resolves the current vector settings.
func (s processedItemVectorConfigSource) EffectiveVectorConfig(ctx context.Context) (vectorclient.Config, error) {
	if s.settings == nil {
		return vectorclient.Config{}, fmt.Errorf("vector settings are not configured")
	}
	effective, err := s.settings.VectorRuntimeConfig(ctx)
	if err != nil {
		return vectorclient.Config{}, err
	}
	return vectorclient.Config{
		Enabled:    effective.Enabled,
		BaseURL:    effective.BaseURL,
		Token:      effective.Token,
		TimeoutMs:  effective.TimeoutMs,
		MaxRetries: effective.MaxRetries,
	}, nil
}
