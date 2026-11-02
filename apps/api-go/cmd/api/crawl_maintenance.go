package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmaintenance"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// crawlMaintenanceRuntime owns the five maintenance schedulers enabled by the
// two ownership switches. Every field is nil when its switch is legacy.
type crawlMaintenanceRuntime struct {
	janitor  *crawlmaintenance.JanitorScheduler
	cleanup  *crawlmaintenance.CleanupOutboxScheduler
	adaptive *crawlmaintenance.AdaptiveScheduler
	quality  *crawlmaintenance.QualitySnapshotScheduler
	audit    *crawlmaintenance.AuditRetentionScheduler
}

// Start launches every configured loop. Each loop aligns its first tick to the
// wall clock; no catch-up tick runs for intervals that elapsed before startup.
func (r *crawlMaintenanceRuntime) Start(ctx context.Context) {
	if r == nil {
		return
	}
	if r.janitor != nil {
		r.janitor.Start(ctx)
	}
	if r.cleanup != nil {
		r.cleanup.Start(ctx)
	}
	if r.adaptive != nil {
		r.adaptive.Start(ctx)
	}
	if r.quality != nil {
		r.quality.Start(ctx)
	}
	if r.audit != nil {
		r.audit.Start(ctx)
	}
}

// Close stops new ticks and drains the in-flight ticks before the caller closes
// the shared Redis/MySQL/Mongo handles.
func (r *crawlMaintenanceRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var errs []error
	if r.janitor != nil {
		if err := r.janitor.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if r.cleanup != nil {
		if err := r.cleanup.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if r.adaptive != nil {
		if err := r.adaptive.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if r.quality != nil {
		if err := r.quality.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if r.audit != nil {
		if err := r.audit.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// wireCrawlMaintenance constructs only the schedulers whose ownership switch is
// go. legacy (including unset) returns (nil, nil) and starts nothing. The
// function registers no HTTP route and needs no JWT. SCHEDULE_ENABLED=false
// stops the chains in both processes, so Go also starts nothing.
func wireCrawlMaintenance(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
) (*crawlMaintenanceRuntime, error) {
	maintenanceGo := true
	auditGo := true
	if !maintenanceGo && !auditGo {
		return nil, nil
	}
	if !cfg.ScheduleEnabled {
		log.Printf("api-go: crawl maintenance schedulers not started (SCHEDULE_ENABLED=false)")
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_CRAWL_MAINTENANCE_MODE/API_GO_AUDIT_LOG_RETENTION_MODE=go requires mysql and redis")
	}

	runtime := &crawlMaintenanceRuntime{}
	if auditGo {
		runtime.audit = crawlmaintenance.NewAuditRetentionScheduler(crawlmaintenance.AuditRetentionDeps{
			DB:        db,
			Redis:     redisClient,
			Retention: runtimesettings.NewAuditLogRetentionReader(db, redisClient, cfg.AuditLogRetentionDays),
			Logf:      log.Printf,
		})
	}
	if !maintenanceGo {
		return runtime, nil
	}

	// The janitor writes TaskLog documents, the outbox replay deletes Mongo
	// content and the quality refresh rolls Mongo aggregates, so the shared
	// connection is required. An existing dashboard/graphql handle is reused and
	// stays owned by the caller's teardown.
	if mongoConn == nil {
		return nil, fmt.Errorf("api-go: crawl maintenance requires a mongo connection holder")
	}
	if *mongoConn == nil {
		connection, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: crawl maintenance requires a valid MONGO_URI: %w", err)
		}
		*mongoConn = connection
	}
	mongoDatabase := (*mongoConn).Database()

	producer := crawlqueue.NewProducer(crawlqueue.Options{
		Redis: redisClient,
		DB:    db,
		Env: &crawlqueue.EnvDefaults{
			MaxConcurrency: cfg.CrawlMaxConcurrency,
			MaxRetries:     cfg.CrawlMaxRetries,
			RetryBackoffMs: cfg.CrawlRetryBackoffMs,
		},
	})
	activity := crawlqueue.NewActivity(redisClient)
	janitorConfig := crawlmaintenance.JanitorConfig{
		Enabled:          cfg.CrawlTaskJanitorEnabled,
		RunningTimeoutMs: cfg.CrawlTaskRunningTimeoutMs,
		QueuedTimeoutMs:  cfg.CrawlTaskQueuedTimeoutMs,
		BatchSize:        cfg.CrawlTaskJanitorBatchSize,
		QueueScanLimit:   cfg.CrawlTaskJanitorQueueScanLimit,
		LockTTLMs:        cfg.CrawlTaskJanitorLockTTLMs,
	}
	runtime.janitor = crawlmaintenance.NewJanitorScheduler(crawlmaintenance.JanitorDeps{
		DB:       db,
		Redis:    redisClient,
		Mongo:    mongoDatabase,
		Activity: activity,
		Queue:    producer,
		Config:   janitorConfig,
		Logf:     log.Printf,
	})
	runtime.cleanup = crawlmaintenance.NewCleanupOutboxScheduler(crawlmaintenance.CleanupOutboxDeps{
		DB:    db,
		Redis: redisClient,
		Mongo: mongoDatabase,
		Logf:  log.Printf,
	})
	runtime.adaptive = crawlmaintenance.NewAdaptiveScheduler(crawlmaintenance.AdaptiveDeps{
		DB:       db,
		Redis:    redisClient,
		Settings: settingswrite.NewCrawlSettingsPort(db, redisClient),
		Activity: activity,
		Queue:    producer,
		Logf:     log.Printf,
	})
	runtime.quality = crawlmaintenance.NewQualitySnapshotScheduler(crawlmaintenance.QualitySnapshotDeps{
		DB:          db,
		Redis:       redisClient,
		Mongo:       mongoDatabase,
		Snapshots:   crawlreadtelemetry.NewService(db, redisClient, mongoDatabase, "", nil),
		Concurrency: runtimesettings.NewCrawlQualitySnapshotSettings(db, redisClient),
		Logf:        log.Printf,
	})
	log.Printf("api-go: crawl maintenance crons owned by Go (janitor=%t runningTimeoutMs=%d queuedTimeoutMs=%d batchSize=%d queueScanLimit=%d)",
		janitorConfig.Enabled, janitorConfig.RunningTimeoutMs, janitorConfig.QueuedTimeoutMs,
		janitorConfig.BatchSize, janitorConfig.QueueScanLimit)
	return runtime, nil
}
