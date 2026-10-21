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
// implemented by internal/crawlfrontiernode. That processor is built here from
// the same MySQL/Mongo/Redis handles, the same crawl_client:settings reader, the
// same workflow compiler and the same crawlexecution.Service the ordinary task
// path uses, so a Frontier result write stores media and relays notifications
// exactly like a normal crawl when the site profile enables storeMedia. The
// item ingestor travels with the shared service but the Frontier path keeps
// ingestToItems=false, like NestJS persistFrontierResponse. A nil processor
// still fails go mode at startup as a defence in depth.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontiernode"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworker"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// errCrawlWorkerResources reports a missing shared handle in go mode.
var errCrawlWorkerResources = errors.New("api-go: crawl worker go takeover requires mysql, redis and mongo")

// errCrawlWorkerFrontierProcessor reports a missing Frontier node executor in go
// mode. wireCrawlWorker builds the processor itself, so this is a defence in
// depth: claiming frontier_node jobs without an executor would fail every one of
// them at run time instead of at startup.
var errCrawlWorkerFrontierProcessor = errors.New("api-go: API_GO_CRAWL_WORKER_MODE=go requires the crawlfrontiernode processor (internal/crawlfrontiernode) so frontier_node jobs have an executor")

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
// The Frontier node processor is built here instead of being passed in, so it can
// share the crawlexecution.Service the ordinary task path uses. go mode requires a
// non-nil processor: without it frontier_node jobs could never run, so a failed or
// empty construction fails startup.
func wireCrawlWorker(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	redisOptions *redis.Options,
	mongoConn **dashboardstats.Connection,
) (*crawlWorkerRuntime, error) {
	if cfg.CrawlWorkerMode != config.CrawlWorkerModeGo {
		return nil, nil
	}
	if !cfg.BullMQWorkersEnabled {
		log.Printf("api-go: crawl worker requested by API_GO_CRAWL_WORKER_MODE=go but BULLMQ_WORKERS_ENABLED=false; no consumer started")
		return nil, nil
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

	// The crawl_client:settings reader shared by the queue consumers and the
	// Frontier node executor: one resolution order (Redis cache → SystemSetting →
	// env defaults) for both paths.
	settings := crawlqueue.NewSettingsReader(db, redisClient, &crawlqueue.EnvDefaults{
		MaxConcurrency:   cfg.CrawlMaxConcurrency,
		MaxRetries:       cfg.CrawlMaxRetries,
		RetryBackoffMs:   cfg.CrawlRetryBackoffMs,
		RequestTimeoutMs: cfg.CrawlTimeoutMs,
	})

	// The frontier_node executor. It reuses `execution` as its
	// crawlexecution.Service, so a Frontier result write uploads media through the
	// same object storage reader and relays notifications through the same
	// publisher as a normal crawl. The item ingestor travels with the shared
	// service too, but the Frontier path keeps ingestToItems=false exactly like
	// NestJS persistFrontierResponse, so nothing is ingested. The package would
	// otherwise build its own service without any of them and silently drop the
	// media files NestJS stores.
	frontier, err := newCrawlFrontierNodeProcessor(cfg, db, redisClient, mongoDatabase, execution, settings)
	if err != nil {
		return nil, err
	}
	if frontier == nil {
		// Defence in depth: newCrawlFrontierNodeProcessor never returns (nil, nil),
		// but a frontier_node job must never be claimed without an executor.
		return nil, errCrawlWorkerFrontierProcessor
	}

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

// newCrawlFrontierNodeProcessor builds the frontier_node executor the three
// crawl queues carry. processQueuedNode runs inside the crawl worker's attempt,
// so every dependency is taken from the objects the crawl worker already owns:
//
//   - MySQL/Mongo/Redis are the shared handles.
//   - Crawl is the same crawl4ai client configuration the crawl discovery and the
//     news source scheduler use; Settings comes from the crawl worker's own
//     crawl_client:settings reader, so a request-scoped timeout change applies to
//     both paths and healthCheckTtlMs keeps the stored override.
//   - LLM is built exactly like the Frontier LLM worker
//     (crawl_frontier_llm.go): one LLMClient over the shared MySQL handle plus the
//     #125 request log sink when Mongo is available. There is no startup-time
//     "LLM is not configured" signal — the gateway profile is resolved per request
//     from SystemSetting (crawlfrontierllm llm_profile.go resolveGatewayProfile) —
//     and NestJS always injects CrawlFrontierLlmService, so passing a real client
//     is what keeps the deferred judge branch identical to NestJS. A nil LLM stays
//     supported and means the same as a NestJS without the service.
//   - Workflows is the workflow compiler that turns the profile overlay into a
//     layered plan.
//   - Enqueuer is the crawlqueue producer, so deferred child nodes land on the
//     same BullMQ queues the crawl worker owns.
//   - Exec is the crawl worker's crawlexecution.Service, not a fresh one: it is
//     the instance that carries the object storage reader, the item ingestor, the
//     notification relay and the news source scheduler. A package-local service
//     would drop Frontier result media on the floor.
//
// A construction failure fails startup: go mode must not claim frontier_node jobs
// it cannot execute.
func newCrawlFrontierNodeProcessor(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
	execution *crawlexecution.Service,
	settings *crawlqueue.SettingsReader,
) (crawlworker.FrontierNodeProcessor, error) {
	client := crawl4ai.New(crawl4ai.Options{
		BaseURL:          cfg.CrawlBaseURL,
		APIKey:           cfg.CrawlAPIKey,
		TimeoutMs:        cfg.CrawlTimeoutMs,
		HealthCheckTTLMs: cfg.CrawlHealthTTLMs,
		SSRFProxyURL:     cfg.CrawlSSRFProxyURL,
		JSCodeEnabled:    cfg.CrawlJSCodeEnabled,
	})

	// The node package takes a per-request crawl4ai Settings provider. Reuse the
	// crawl worker's reader through the shared projection, so both paths read the
	// same Redis cache document and the same SystemSetting row.
	settingsView := func(ctx context.Context) crawl4ai.Settings {
		return settingsFromNormalized(settings.ReadNormalized(ctx))
	}

	var sink crawlfrontierllm.RequestLogSink
	if mongoDatabase != nil {
		sink = frontierLogSink{writer: llmlogs.NewFrontierWriter(db, mongoDatabase)}
	}
	llm := crawlfrontierllm.NewLLMClient(crawlfrontierllm.LLMClientOptions{
		DB: db,
		Env: crawlfrontierllm.LLMGatewayEnv{
			APIBase:       cfg.LiteLLMAPIBase,
			APIKey:        cfg.LiteLLMAPIKey,
			EncryptionKey: cfg.SystemSettingsEncryptionKeyRaw,
			TimeoutMs:     cfg.LiteLLMTimeoutMs,
			MaxRetries:    cfg.LiteLLMMaxRetries,
		},
		Sink: sink,
	})

	producer := crawlqueue.NewProducer(crawlqueue.Options{
		Redis: redisClient,
		DB:    db,
		Env: &crawlqueue.EnvDefaults{
			MaxConcurrency:   cfg.CrawlMaxConcurrency,
			MaxRetries:       cfg.CrawlMaxRetries,
			RetryBackoffMs:   cfg.CrawlRetryBackoffMs,
			RequestTimeoutMs: cfg.CrawlTimeoutMs,
		},
	})

	processor, err := crawlfrontiernode.New(crawlfrontiernode.Options{
		DB:        db,
		Mongo:     mongoDatabase,
		Redis:     redisClient,
		Crawl:     client,
		Settings:  settingsView,
		LLM:       llm,
		Workflows: crawlworkflow.NewService(db),
		Enqueuer:  producer,
		Now:       time.Now,
		Exec:      execution,
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: crawl frontier node processor: %w", err)
	}
	return processor, nil
}
