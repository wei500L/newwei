package main

// This file wires the optional Go owner of the three crawl4ai BullMQ queues
// (`crawl4ai`, `crawl4ai-hot`, `crawl4ai-normal`). It registers no HTTP route
// and needs no JWT: the workers read and write MySQL/Mongo/Redis, call crawl4ai
// over HTTP and upload stored media to object storage.
//
// API_GO_CRAWL_WORKER_MODE=go makes NestJS create no crawl Worker, no QueueEvents
// listener and no C2 concurrency subscriber, so this process is the only owner
// of the queues. The two Frontier LLM queues keep their own switch
// (API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE) and are wired separately.
//
// The frontier_node jobs are executed through crawlworker.FrontierNodeProcessor,
// implemented by internal/crawlfrontiernode. That package is delivered by a
// separate window; until both changes are integrated this wiring passes nil, and
// go mode then fails startup instead of claiming jobs it cannot execute.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworker"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// errCrawlWorkerResources reports a missing shared handle in go mode.
var errCrawlWorkerResources = errors.New("api-go: crawl worker go takeover requires mysql, redis and mongo")

// crawlWorkerRuntime owns the three crawl queue consumers plus the process-local
// snapshot coalescer and notification relay they use.
//
// The runtime is nil in the legacy default, so no Redis connection, goroutine or
// timer is constructed. Close stops claiming first, drains the in-flight jobs
// while their locks keep renewing, flushes the coalesced snapshot refreshes and
// then releases the dedicated blocking connections; the shared command client
// stays owned by main.
type crawlWorkerRuntime struct {
	worker *crawlworker.Worker
	exec   *crawlexecution.Service
	relay  classificationrssops.NotificationRelayPublisher
}

// Start claims the three queues.
func (r *crawlWorkerRuntime) Start(ctx context.Context) error {
	if r == nil || r.worker == nil {
		return nil
	}
	return r.worker.Start(ctx)
}

// Close stops claiming, drains in-flight jobs, flushes the coalesced snapshot
// refreshes and closes the dedicated blocking connections.
func (r *crawlWorkerRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var errs []error
	if r.worker != nil {
		if err := r.worker.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if r.exec != nil {
		// O2 coalesces the news-source ops snapshot refreshes; the last change
		// must still be written after the in-flight jobs drain.
		r.exec.FlushSnapshots(ctx)
	}
	return errors.Join(errs...)
}

// wireCrawlWorker builds the Go crawl queue consumers when
// API_GO_CRAWL_WORKER_MODE=go and BULLMQ_WORKERS_ENABLED is not false. The legacy
// default returns (nil, nil) and claims nothing.
//
// frontier is the crawlfrontiernode implementation. go mode requires a non-nil
// value: without it frontier_node jobs could never run, so switching before both
// changes are integrated must fail startup.
func wireCrawlWorker(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	redisOptions *redis.Options,
	mongoConn **dashboardstats.Connection,
	frontier crawlworker.FrontierNodeProcessor,
) (*crawlWorkerRuntime, error) {
	if cfg.CrawlWorkerMode != config.CrawlWorkerModeGo {
		return nil, nil
	}
	if !cfg.BullMQWorkersEnabled {
		log.Printf("api-go: crawl worker requested by API_GO_CRAWL_WORKER_MODE=go but BULLMQ_WORKERS_ENABLED=false; no consumer started")
		return nil, nil
	}
	if frontier == nil {
		return nil, fmt.Errorf("api-go: API_GO_CRAWL_WORKER_MODE=go requires the crawlfrontiernode processor (internal/crawlfrontiernode) so frontier_node jobs have an executor; integrate both changes before switching")
	}
	if db == nil || redisClient == nil {
		return nil, errCrawlWorkerResources
	}
	mongoDatabase, err := sharedMongoDatabase(cfg.MongoURI, mongoConn)
	if err != nil {
		return nil, fmt.Errorf("api-go: crawl worker requires a valid MONGO_URI: %w", err)
	}
	if mongoDatabase == nil {
		return nil, errCrawlWorkerResources
	}
	if redisOptions == nil {
		redisOptions = newRedisOptions(cfg)
	}

	// The notification relay: every Notification row the Go crawl path writes is
	// published on notification:events:v1 without a socket-mode condition. The
	// NestJS generic subscriber consumes it in legacy socket mode and the api-go
	// notifications transport in go socket mode, so each connection receives the
	// event exactly once (B3).
	relay := classificationrssops.NewRedisNotificationRelayPublisher(redisClient)

	// News-source ops snapshots (O2) and the org-wide system notification writer
	// (B2) are the existing implementations the itemPipeline worker reuses: the
	// crawl path only calls RefreshSnapshot and NotifySystemGeneric, so no
	// scheduler cron is started here.
	schedulerService := newssourcescheduler.New(newssourcescheduler.Options{
		DB:    db,
		Redis: redisClient,
		Now:   time.Now,
	})

	// The storage settings reader resolves the crawl image storage provider and
	// the S3 snapshot the media branch uploads through. It is the same reader the
	// account-security avatar signer uses, so the storage:settings cache, the
	// database fallback and the secret decryption stay in one place.
	var storage objectstorage.ConfigReader
	if cfg.SettingsEncryptionKeyPresent {
		storage = accountsecurity.NewService(db, redisClient, accountsecurity.Config{
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
	}

	execution := crawlexecution.New(crawlexecution.Options{
		DB:      db,
		Mongo:   mongoDatabase,
		Redis:   redisClient,
		Storage: storage,
		Config: crawlexecution.Config{
			CrawlBaseURL:              cfg.CrawlBaseURL,
			CrawlAPIKey:               cfg.CrawlAPIKey,
			CrawlTimeoutMs:            cfg.CrawlTimeoutMs,
			CrawlHealthCheckTTLMs:     cfg.CrawlHealthTTLMs,
			CrawlSSRFProxyURL:         cfg.CrawlSSRFProxyURL,
			CrawlJSCodeEnabled:        cfg.CrawlJSCodeEnabled,
			MediaFetchTimeoutMs:       cfg.CrawlMediaFetchTimeoutMs,
			MediaMaxBytes:             cfg.CrawlMediaMaxBytes,
			MediaMaxPerResult:         cfg.CrawlMediaMaxPerResult,
			FailureRecoveryDelayMs:    cfg.NewsSourceSchedulerFailureRecoveryDelayMs,
			FailureMaxDelayMs:         cfg.NewsSourceSchedulerFailureMaxDelayMs,
			CircuitBreakerThreshold:   int(cfg.NewsSourceSchedulerCircuitBreakerThreshold),
			CircuitBreakerBaseDelayMs: cfg.NewsSourceSchedulerCircuitBreakerBaseDelayMs,
			CircuitBreakerMaxDelayMs:  cfg.NewsSourceSchedulerCircuitBreakerMaxDelayMs,
			AutoDisableThreshold:      int(cfg.NewsSourceSchedulerAutoDisableThreshold),
		},
		Now:       time.Now,
		Items:     buildItemsIngestService(cfg, db, redisClient, mongoDatabase),
		Relay:     crawlexecution.NotificationRelayPublisher(relay),
		Scheduler: schedulerService,
	})

	settings := crawlqueue.NewSettingsReader(db, redisClient, &crawlqueue.EnvDefaults{
		MaxConcurrency:   cfg.CrawlMaxConcurrency,
		MaxRetries:       cfg.CrawlMaxRetries,
		RetryBackoffMs:   cfg.CrawlRetryBackoffMs,
		RequestTimeoutMs: cfg.CrawlTimeoutMs,
	})
	activity := crawlqueue.NewActivity(redisClient)

	worker, err := crawlworker.New(crawlworker.Options{
		Client:            redisClient,
		NewBlockingClient: func() *redis.Client { return redis.NewClient(redisOptions) },
		DB:                db,
		Execution:         execution,
		Frontier:          frontier,
		Settings:          settings,
		Activity:          activity,
		Snapshots:         schedulerService,
		Now:               time.Now,
		Logger:            log.Printf,
		Config: crawlworker.Config{
			MaxConcurrency:   cfg.CrawlMaxConcurrency,
			DefaultTimeoutMs: cfg.CrawlTimeoutMs,
			SettingsTTL:      5 * time.Second,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: crawl worker: %w", err)
	}
	log.Printf("api-go: crawl queue workers owned by Go (API_GO_CRAWL_WORKER_MODE=go, queues=%s,%s,%s)",
		crawlqueue.QueueHot, crawlqueue.QueueNormal, crawlqueue.QueueLegacy)
	return &crawlWorkerRuntime{worker: worker, exec: execution, relay: relay}, nil
}
