package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/archivepreparation"
	"github.com/wei500L/newwei/apps/api-go/internal/archivepreparationworker"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// archivePreparationRuntime owns the archivePreparation BullMQ consumer and its
// dedicated blocking Redis client. Every field is nil in legacy mode.
type archivePreparationRuntime struct {
	worker   *archivepreparationworker.Worker
	blocking *redis.Client
}

// Start claims the queue. It starts before any producer tick can enqueue a job.
func (r *archivePreparationRuntime) Start(ctx context.Context) error {
	if r == nil || r.worker == nil {
		return nil
	}
	return r.worker.Start(ctx)
}

// Close stops new claims, drains the in-flight job while its lock keeps renewing,
// and closes the dedicated blocking client. The shared command client stays
// owned by main.
func (r *archivePreparationRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var errs []error
	if r.worker != nil {
		if err := r.worker.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	} else if r.blocking != nil {
		if err := r.blocking.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	r.blocking = nil
	return errors.Join(errs...)
}

// wireArchivePreparationWorker constructs the worker only when
// API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go. The legacy default returns
// (nil, nil) and registers/claims nothing.
func wireArchivePreparationWorker(cfg config.Config, db *sql.DB, redisClient *redis.Client, mongoConn **dashboardstats.Connection) (*archivePreparationRuntime, error) {
	if cfg.ArchivePreparationWorkerMode != config.ArchivePreparationWorkerModeGo {
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: archive preparation worker go takeover requires mysql and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: archive preparation worker go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	database := (*mongoConn).Database()

	settingsService := dataruntimesettings.NewService(db, redisClient, dataruntimesettings.Config{})
	models := litellmcompat.NewClient(db, llmlogs.NewModelRequestWriter(db, database), litellmcompat.Config{
		EncryptionKey:              cfg.SettingsEncryptionKeyRaw,
		APIBase:                    cfg.LiteLLMAPIBase,
		APIKey:                     cfg.LiteLLMAPIKey,
		Timeout:                    time.Duration(cfg.LiteLLMTimeoutMs) * time.Millisecond,
		MaxRetries:                 cfg.LiteLLMMaxRetries,
		DefaultModel:               cfg.LLMGatewayModel,
		DefaultTemperature:         cfg.LLMGatewayTemperature,
		DefaultTopP:                cfg.LLMGatewayTopP,
		DefaultMaxOutputTokens:     cfg.LLMGatewayMaxOutputTokens,
		DefaultFallbackModels:      cfg.LLMGatewayFallbackModels,
		AssistantGuardrailsEnabled: cfg.PlatformGovernanceAssistantGuardrailsEnabled,
		AssistantGuardrailsRaw:     cfg.PlatformGovernanceAssistantGuardrailsRaw,
		Logger:                     log.Printf,
	})
	processor := archivepreparationworker.NewProcessor(archivepreparationworker.ProcessorDeps{
		DB:       db,
		Redis:    redisClient,
		Mongo:    database,
		Models:   models,
		Settings: settingsService,
		Warn:     log.Printf,
	})
	producer := archivepreparation.NewProducer(redisClient)
	consumer := archivepreparationworker.NewConsumer(processor, producer)
	blocking := redis.NewClient(redisClient.Options())
	worker, err := archivepreparationworker.NewWorker(redisClient, blocking, archivepreparationworker.WorkerOptions{
		Concurrency: 1,
		Processor:   consumer.Handle,
		OnFailure:   consumer.OnFailure,
		Logger:      log.Printf,
	})
	if err != nil {
		_ = blocking.Close()
		return nil, err
	}
	log.Printf("api-go: archive preparation worker owned by Go (API_GO_ARCHIVE_PREPARATION_WORKER_MODE=go)")
	return &archivePreparationRuntime{worker: worker, blocking: blocking}, nil
}
