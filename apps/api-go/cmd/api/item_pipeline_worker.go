package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/itempipeline"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
	"github.com/wei500L/newwei/apps/api-go/internal/newspipeline"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/processeditemoutbox"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// itemPipelineRuntime owns the itemPipeline BullMQ consumer and its dedicated
// blocking Redis client. Every field is nil in legacy mode.
//
// The process-local components (immediate processed_item delivery, snapshot
// coalescing) are owned by the processor; Close drains the in-flight jobs
// before the shared Redis/MySQL/Mongo handles are closed by main.
type itemPipelineRuntime struct {
	worker   *itempipeline.Worker
	blocking *redis.Client
}

// Start claims the queue.
func (r *itemPipelineRuntime) Start(ctx context.Context) error {
	if r == nil || r.worker == nil {
		return nil
	}
	return r.worker.Start(ctx)
}

// Close stops claiming, drains in-flight jobs while their locks keep renewing,
// and closes the dedicated blocking client.
func (r *itemPipelineRuntime) Close(ctx context.Context) error {
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

// wireItemPipelineWorker constructs the itemPipeline consumer only when
// API_GO_ITEM_PIPELINE_WORKER_MODE=go and BULLMQ_WORKERS_ENABLED is not false.
// The legacy default returns (nil, nil) and claims nothing.
//
// health is the process-wide vector circuit state shared with the
// processed-item outbox scanner; both the immediate-delivery upsert client and
// the dedupe searcher of this pipeline are wired to it. A nil value is replaced
// by an empty state so an unwired caller still gets one shared window instead of
// two independent ones.
func wireItemPipelineWorker(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
	health *vectorclient.Health,
) (*itemPipelineRuntime, error) {
	if !cfg.BullMQWorkersEnabled {
		log.Printf("api-go: item pipeline worker requested by API_GO_ITEM_PIPELINE_WORKER_MODE=go but BULLMQ_WORKERS_ENABLED=false; no consumer started")
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: item pipeline worker go takeover requires mysql and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: item pipeline worker go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()
	if health == nil {
		health = &vectorclient.Health{}
	}

	// Shared LLM client: same gateway profile resolution, guardrails, retry
	// policy and llmrequestlogs writer as the archived/classifier packages.
	models := litellmcompat.NewClient(db, llmlogs.NewModelRequestWriter(db, mongoDatabase), litellmcompat.Config{
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

	// In-process crawl execution for the pipeline's crawl branch. The three
	// crawl queues stay on NestJS; this service is called synchronously.
	crawlService := crawlexecution.New(crawlexecution.Options{
		DB:    db,
		Mongo: mongoDatabase,
		Redis: redisClient,
		Config: crawlexecution.Config{
			CrawlBaseURL:              cfg.CrawlBaseURL,
			CrawlAPIKey:               cfg.CrawlAPIKey,
			CrawlTimeoutMs:            cfg.CrawlTimeoutMs,
			CrawlHealthCheckTTLMs:     cfg.CrawlHealthTTLMs,
			CrawlSSRFProxyURL:         cfg.CrawlSSRFProxyURL,
			CrawlJSCodeEnabled:        cfg.CrawlJSCodeEnabled,
			FailureRecoveryDelayMs:    cfg.NewsSourceSchedulerFailureRecoveryDelayMs,
			FailureMaxDelayMs:         cfg.NewsSourceSchedulerFailureMaxDelayMs,
			CircuitBreakerThreshold:   int(cfg.NewsSourceSchedulerCircuitBreakerThreshold),
			CircuitBreakerBaseDelayMs: cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs,
			CircuitBreakerMaxDelayMs:  cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs,
		},
		Now:   time.Now,
		Items: buildItemsIngestService(cfg, db, redisClient, mongoDatabase),
	})

	// #116 immediate processed_item delivery. The same service instance is used
	// by the compensation scanner when API_GO_PROCESSED_ITEM_OUTBOX_MODE=go; the
	// shared CAS claim makes the two owners mutually exclusive.
	settings := newInfrastructureSettingsService(cfg, db, redisClient)
	outboxService := processeditemoutbox.NewService(processeditemoutbox.Options{
		DB:           db,
		Mongo:        mongoDatabase,
		VectorConfig: processedItemVectorConfigSource{settings: settings},
		VectorWriter: &vectorclient.Client{Health: health},
		BatchSize:    cfg.ProcessedItemOutboxBatchSize,
		Concurrency:  cfg.ProcessedItemOutboxConcurrency,
		TickBudget:   time.Duration(cfg.ProcessedItemOutboxTickBudgetMs) * time.Millisecond,
	})

	// News-source ops snapshot refresh (reused, not reimplemented) and the
	// org-wide system notification writer (circuit-open/auto-disable relays).
	schedulerService := newssourcescheduler.New(newssourcescheduler.Options{
		DB:    db,
		Redis: redisClient,
		Now:   time.Now,
	})

	workingDir, err := os.Getwd()
	if err != nil {
		workingDir = "."
	}
	pipelineConfig := newspipeline.LoadConfig(os.Getenv, workingDir)

	classifierSession := newsclassifier.NewSession(newsclassifier.Deps{
		Client:         models,
		Settings:       newsclassifier.NewSettingsStore(db, redisClient),
		SourcePolicies: newsclassifier.NewSourcePolicyStore(db, redisClient),
		Now:            time.Now,
		Warn:           log.Printf,
	})

	searcher := vectorclient.NewSearcher(vectorclient.SearcherOptions{
		DB:     db,
		Redis:  redisClient,
		Health: health,
		Env: vectorclient.SearcherEnv{
			Enabled:         cfg.VectorServiceEnabled,
			FallbackToMongo: cfg.VectorServiceFallbackToMongo,
			BaseURL:         cfg.VectorServiceBaseURL,
			Token:           cfg.VectorInternalToken,
			TimeoutMS:       cfg.VectorServiceTimeoutMs,
			MaxRetries:      cfg.VectorServiceMaxRetries,
			EncryptionKey:   cfg.SettingsEncryptionKeyRaw,
		},
		Now: time.Now,
	})

	pipelineService := newspipeline.New(newspipeline.Options{
		DB:         db,
		Mongo:      mongoDatabase,
		Redis:      redisClient,
		Config:     pipelineConfig,
		Models:     models,
		Crawl:      crawlService,
		Vector:     searcher,
		Outbox:     outboxService,
		Snapshots:  pipelineSnapshotAdapter{service: schedulerService},
		Classifier: classifierSession,
		Now:        time.Now,
		Logger:     log.Printf,
	})

	processor, err := itempipeline.NewProcessor(itempipeline.ProcessorOptions{
		DB:        db,
		Mongo:     mongoDatabase,
		Redis:     redisClient,
		Pipeline:  pipelineService,
		Snapshots: itempipeline.NewSchedulerSnapshotRefresher(schedulerService),
		Notifier:  schedulerService,
		SourceFailure: itempipeline.SourceFailureConfig{
			CircuitBreakerThreshold:   cfg.NewsSourceSchedulerCircuitBreakerThreshold,
			AutoDisableThreshold:      cfg.NewsSourceSchedulerAutoDisableThreshold,
			FailureRecoveryDelayMs:    cfg.NewsSourceSchedulerFailureRecoveryDelayMs,
			FailureMaxDelayMs:         cfg.NewsSourceSchedulerFailureMaxDelayMs,
			CircuitBreakerBaseDelayMs: cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs,
			CircuitBreakerMaxDelayMs:  cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs,
		},
		Now: time.Now,
	})
	if err != nil {
		return nil, err
	}

	concurrency := cfg.NewsProcessQueueConcurrency
	if concurrency <= 0 {
		concurrency = 3
	}
	blocking := redis.NewClient(redisClient.Options())
	worker, err := itempipeline.NewWorker(redisClient, blocking, itempipeline.WorkerOptions{
		Concurrency: concurrency,
		Processor:   processor.Handle,
		OnFailure:   processor.HandleFailure,
		Logger:      log.Printf,
	})
	if err != nil {
		_ = blocking.Close()
		return nil, err
	}
	log.Printf("api-go: item pipeline worker owned by Go (API_GO_ITEM_PIPELINE_WORKER_MODE=go, concurrency=%d)", concurrency)
	return &itemPipelineRuntime{worker: worker, blocking: blocking}, nil
}

// pipelineSnapshotAdapter adapts the scheduler service to the newspipeline
// snapshot port.
type pipelineSnapshotAdapter struct {
	service *newssourcescheduler.Service
}

// RefreshNewsSourceSnapshot refreshes one news source ops snapshot.
func (a pipelineSnapshotAdapter) RefreshNewsSourceSnapshot(ctx context.Context, orgID, sourceID string) error {
	if a.service == nil {
		return nil
	}
	return a.service.RefreshSnapshot(ctx, orgID, sourceID)
}
