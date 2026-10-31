package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/clusteringrecoveryqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbackfilljobs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/newsindicator"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// newsBackfillRuntime owns the components enabled by the four news backfill
// switches. Every field is nil when its switch is legacy.
type newsBackfillRuntime struct {
	worker      *clusteringrecoveryqueue.Worker
	blocking    *redis.Client
	scan        *newsbackfilljobs.ScanScheduler
	association *newsbackfilljobs.AssociationScheduler
}

// Start starts the worker first (so a scan tick can never enqueue a job with no
// owner), then the two schedulers.
func (r *newsBackfillRuntime) Start(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if r.worker != nil {
		if err := r.worker.Start(ctx); err != nil {
			return err
		}
	}
	if r.scan != nil {
		r.scan.Start(ctx)
	}
	if r.association != nil {
		r.association.Start(ctx)
	}
	return nil
}

// Close stops new ticks, drains the worker's in-flight jobs, then stops the
// schedulers. The blocking client is owned by the worker when it started; a
// worker that never started is closed here.
func (r *newsBackfillRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var errs []error
	if r.scan != nil {
		if err := r.scan.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if r.association != nil {
		if err := r.association.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
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

// wireNewsBackfillJobs constructs only the components whose switch is go. In
// the legacy default it returns (nil, nil) and registers nothing.
func wireNewsBackfillJobs(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) (*newsBackfillRuntime, error) {
	manualGo := true
	workerGo := true
	cronGo := true
	if !manualGo && !workerGo && !cronGo {
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: news backfill jobs require mysql and redis")
	}
	runtime := &newsBackfillRuntime{}

	if manualGo || workerGo {
		if mongoConn == nil || *mongoConn == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				return nil, fmt.Errorf("api-go: news backfill jobs require a valid MONGO_URI")
			}
			*mongoConn = conn
		}
		mongoDatabase := (*mongoConn).Database()
		clusteringService := newsnowclusteringops.NewService(newsnowclusteringops.ServiceConfig{
			ModelServiceEnabled: newsnowEnvBool("MODEL_SERVICE_ENABLED", false),
			ModelServiceBaseURL: os.Getenv("MODEL_SERVICE_BASE_URL"),
			ModelServiceToken:   os.Getenv("MODEL_SERVICE_INTERNAL_TOKEN"),
			EncryptionKey:       cfg.SettingsEncryptionKeyRaw,
		}, db, mongoDatabase, redisClient, newsbehavior.NewService(db, redisClient))

		producer, err := clusteringrecoveryqueue.NewProducer(redisClient, "")
		if err != nil {
			return nil, err
		}

		var completer publicportal.ClusteringDecisionCompleter
		var vectors *newsbackfilljobs.VectorSearcher
		var logs *llmlogs.CompletionWriter
		if workerGo {
			// The effective vector configuration is read through the existing
			// infrastructure settings cache, token decryption and env defaults.
			vectorSettings := newInfrastructureSettingsService(cfg, db, redisClient)
			vectors = newsbackfilljobs.NewVectorSearcher(vectorSettings)
			completer = publicportal.NewClusteringDecisionCompleter(
				publicportal.NewMySQLStore(db),
				publicportal.GatewayEnv{
					EncryptionKey: cfg.SettingsEncryptionKeyRaw,
					APIBase:       cfg.LiteLLMAPIBase,
					APIKey:        cfg.LiteLLMAPIKey,
					TimeoutMs:     cfg.LiteLLMTimeoutMs,
					MaxRetries:    cfg.LiteLLMMaxRetries,
					TopP:          cfg.LLMGatewayTopP,
				},
			)
			logs = llmlogs.NewCompletionWriter(db, mongoDatabase)
		}

		service, err := newsbackfilljobs.NewService(newsbackfilljobs.Options{
			Clustering: clusteringService,
			Queue:      producer,
			Completer:  completer,
			Vectors:    vectors,
			Logs:       logs,
			Logger:     log.Printf,
		})
		if err != nil {
			return nil, err
		}

		if manualGo {
			if authenticator == nil {
				return nil, fmt.Errorf("api-go: manual LLM backfill requires the JWT authenticator")
			}
			handler := newsbackfilljobs.NewHandler(authenticator, clusteringService, service)
			policy := cors.New(cfg.CorsOrigin)
			gateway.RegisterGoHandler(legacyproxy.NewsClusteringLlmBackfillKey, func(w http.ResponseWriter, r *http.Request) {
				if policy.FinishOptions(w, r) {
					return
				}
				if r.Method == http.MethodOptions {
					gateway.Reject(w, r)
					return
				}
				handler.ServeHTTP(w, r)
			})
			log.Printf("api-go: manual news clustering LLM backfill route takeover")
		}

		if workerGo {
			blocking := redis.NewClient(redisClient.Options())
			worker, err := service.NewWorker(redisClient, blocking, cfg.NewsProcessQueueConcurrency)
			if err != nil {
				_ = blocking.Close()
				return nil, err
			}
			runtime.worker = worker
			runtime.blocking = blocking
			runtime.scan = newsbackfilljobs.NewScanScheduler(service, redisClient)
			log.Printf("api-go: news clustering recovery worker takeover concurrency=%d", cappedNewsWorkerConcurrency(cfg.NewsProcessQueueConcurrency))
		}
	}

	if cronGo {
		runtime.association = newsbackfilljobs.NewAssociationScheduler(
			db,
			redisClient,
			newsindicator.NewService(db, redisClient),
			runtimesettings.NewService(db, redisClient, runtimesettings.Config{}),
			log.Printf,
		)
		log.Printf("api-go: news indicator association six-hour refresh takeover")
	}
	return runtime, nil
}

// cappedNewsWorkerConcurrency mirrors the processor clamp for the startup log.
func cappedNewsWorkerConcurrency(configured int) int {
	if configured < 1 {
		return 1
	}
	if configured > 2 {
		return 2
	}
	return configured
}
