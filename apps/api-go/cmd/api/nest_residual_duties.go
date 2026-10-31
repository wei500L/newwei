package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/bullmqcleanup"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationreviewseed"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelinerecovery"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/qualityqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/searchreindex"
	"github.com/wei500L/newwei/apps/api-go/internal/startupreconcile"
)

// residualDutiesRuntime owns the background units this batch starts so main can
// stop them before the shared Redis/Mongo connections close.
type residualDutiesRuntime struct {
	cleanup    *bullmqcleanup.Scheduler
	reviewSeed *reviewSeedRuntime
	startup    *startupreconcile.Reconciler
}

// Close stops the review-seed reader, the startup reconciliation and the
// cleanup scheduler in that order.
func (r *residualDutiesRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if r.reviewSeed != nil {
		if err := r.reviewSeed.Close(ctx); err != nil {
			return err
		}
	}
	if r.startup != nil {
		if err := r.startup.Close(ctx); err != nil {
			return err
		}
	}
	if r.cleanup != nil {
		if err := r.cleanup.Close(ctx); err != nil {
			return err
		}
	}
	return nil
}

// startResidualDuties wires the five residual-duty owners. The HTTP routes were
// already added to the gateway rules; this function registers their handlers
// and starts the three background units. Legacy (or empty) switches register and
// start nothing.
func startResidualDuties(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	redisOptions *redis.Options,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
	graphqlRuntime *graphqlsubscriptions.Runtime,
) (*residualDutiesRuntime, error) {
	runtime := &residualDutiesRuntime{}
	if err := wirePipelineRecoveryWrites(gateway, cfg, db, redisClient, authenticator, mongoConn); err != nil {
		return nil, err
	}
	if err := wireMetricsTakeover(gateway, cfg, db, redisClient, authenticator); err != nil {
		return nil, err
	}
	cleanup, err := startBullmqCleanup(cfg, redisClient)
	if err != nil {
		return nil, err
	}
	runtime.cleanup = cleanup
	reviewSeed, err := startClassificationReviewSeed(cfg, redisClient, redisOptions, graphqlRuntime)
	if err != nil {
		return nil, err
	}
	runtime.reviewSeed = reviewSeed
	startup, err := startStartupReconcile(cfg, db, redisClient, mongoConn)
	if err != nil {
		return nil, err
	}
	runtime.startup = startup
	if runtime.startup != nil {
		runtime.startup.Start(context.Background())
	}
	return runtime, nil
}

// startBullmqCleanup starts the leased retained-job cleanup when
// API_GO_BULLMQ_CLEANUP_MODE=go. The scheduler runs one cycle immediately and
// then hourly; the lease makes exactly one replica perform each cycle (B1).
func startBullmqCleanup(cfg config.Config, redisClient *redis.Client) (*bullmqcleanup.Scheduler, error) {
	if redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_BULLMQ_CLEANUP_MODE=go requires redis")
	}
	scheduler := bullmqcleanup.NewScheduler(
		bullmqcleanup.NewCleaner(redisClient),
		cronlock.New(redisClient),
	)
	scheduler.Start(context.Background())
	log.Printf("api-go: BullMQ retained-job cleanup owned by Go (mode=%s, lease=cron:bullmq-retained-cleanup)",
		"go")
	return scheduler, nil
}

// reviewSeedRuntime owns the review-seed consumer. observer is set only when
// this unit created the reader; when the GraphQL subscription runtime supplied
// it, that runtime closes it instead.
type reviewSeedRuntime struct {
	observer    *graphqlsubscriptions.QueueObserver
	owned       bool
	unsubscribe func()
}

// Close detaches the handler and closes the reader this unit owns.
func (r *reviewSeedRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if r.unsubscribe != nil {
		r.unsubscribe()
	}
	if r.owned && r.observer != nil {
		return r.observer.Close(ctx)
	}
	return nil
}

// startClassificationReviewSeed attaches the review-seed consumer to the
// process-wide itemPipeline events reader when
// API_GO_CLASSIFICATION_REVIEW_SEED_MODE=go.
//
// When the GraphQL subscription runtime is active it already owns the single
// XREAD loop, so the consumer is attached there (O2). Otherwise this unit owns
// one observer and starts it. Either way one process has one read loop.
func startClassificationReviewSeed(
	cfg config.Config,
	redisClient *redis.Client,
	redisOptions *redis.Options,
	graphqlRuntime *graphqlsubscriptions.Runtime,
) (*reviewSeedRuntime, error) {
	if redisClient == nil || redisOptions == nil {
		return nil, fmt.Errorf("api-go: API_GO_CLASSIFICATION_REVIEW_SEED_MODE=go requires redis")
	}
	seed := classificationreviewseed.New(qualityqueue.NewQueue(redisClient))
	observer := graphqlRuntime.QueueObserver()
	owned := false
	if observer == nil {
		observer = graphqlsubscriptions.NewRedisQueueObserver(redisOptions, redisClient)
		owned = true
	}
	unsubscribe := observer.AddPipelineCompletedHandler(func(ctx context.Context, event graphqlsubscriptions.PipelineCompleted) {
		seed.HandleCompleted(ctx, event.JobID, event.OrgID, event.Data)
	})
	if owned {
		observer.Start(context.Background())
	}
	log.Printf("api-go: classification review seed trigger owned by Go (mode=%s, shared reader=%t)",
		"go", !owned)
	return &reviewSeedRuntime{observer: observer, owned: owned, unsubscribe: unsubscribe}, nil
}

// wirePipelineRecoveryWrites registers the two pipeline recovery writes when
// API_GO_PIPELINE_RECOVERY_WRITE_MODE=go. The runs read keeps its own switch.
func wirePipelineRecoveryWrites(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: API_GO_PIPELINE_RECOVERY_WRITE_MODE=go requires mysql, redis, and jwt")
	}
	if mongoConn == nil {
		return fmt.Errorf("api-go: API_GO_PIPELINE_RECOVERY_WRITE_MODE=go requires mongo")
	}
	if *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: API_GO_PIPELINE_RECOVERY_WRITE_MODE=go requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	database := (*mongoConn).Database()
	producer := pipelineenqueue.New(pipelineenqueue.Options{Redis: redisClient, Mongo: database})
	service := pipelinerecovery.NewServiceWithProducer(db, database, producer)
	handler := pipelinerecovery.NewHandler(authenticator, service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.PipelineRecoveryWriteKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: pipeline recovery writes owned by Go (mode=%s)", "go")
	return nil
}

// wireMetricsTakeover registers GET /api/metrics when API_GO_METRICS_MODE=go.
func wireMetricsTakeover(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: API_GO_METRICS_MODE=go requires mysql, redis, and jwt")
	}
	handler := metrics.NewHandler(authenticator, db, metrics.Default())
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.MetricsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: Prometheus metrics endpoint owned by Go (mode=%s)", "go")
	return nil
}

// startStartupReconcile builds the asynchronous startup alignment when
// API_GO_STARTUP_RECONCILE_MODE=go. Every missing resource is a warning: the
// reconciliation must never block startup.
func startStartupReconcile(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
) (*startupreconcile.Reconciler, error) {
	if redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_STARTUP_RECONCILE_MODE=go requires redis")
	}
	var settings *platformgovernance.Service
	if db == nil {
		log.Printf("api-go: startup reconcile: mysql is not configured, skipping TTL alignment")
	} else if mongoConn == nil {
		log.Printf("api-go: startup reconcile: mongo handle is not configured, skipping TTL alignment")
	} else {
		if *mongoConn == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				log.Printf("api-go: startup reconcile: mongo is not available, skipping TTL alignment")
			} else {
				*mongoConn = conn
			}
		}
		if *mongoConn != nil {
			settings = platformgovernance.NewService(db, redisClient, (*mongoConn).Database(), platformgovernance.Env{
				TaskLogRetentionDays: cfg.PlatformGovernanceTaskLogRetentionDays,
			})
		}
	}
	searchIndex := searchreindex.NewElasticsearchFromEnv()
	if settings == nil && searchIndex == nil {
		log.Printf("api-go: startup reconcile: no TTL or Elasticsearch target is configured")
		return nil, nil
	}
	log.Printf("api-go: startup reconciliation owned by Go (mode=%s, lease=startup:reconcile)",
		"go")
	return startupreconcile.New(startupreconcile.Deps{
		Settings: settings,
		Search:   searchIndex,
		Lock:     cronlock.New(redisClient),
	}), nil
}
