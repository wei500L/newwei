package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelinerecovery"
	"github.com/wei500L/newwei/apps/api-go/internal/qualityqueue"
)

// qualityOpsRuntime owns the background classification quality consumer so main
// can stop it before the shared Redis and Mongo connections are closed.
type qualityOpsRuntime struct {
	worker *qualityqueue.Worker
}

// Close stops claiming new jobs and waits for in-flight jobs to finish.
func (r *qualityOpsRuntime) Close(ctx context.Context) error {
	if r == nil || r.worker == nil {
		return nil
	}
	return r.worker.Stop(ctx)
}

// wireQualityOps wires the three independent switches of this batch.
//
//   - API_GO_CLASSIFICATION_REPORTS_MODE=go registers only
//     POST /api/admin/quality/classification/reports;
//   - API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go starts the
//     classification_quality consumer (no HTTP route);
//   - API_GO_PIPELINE_RECOVERY_MODE=go registers only
//     GET /api/admin/quality/pipeline/runs.
//
// Replay and rollback are not registered: they need the item pipeline producer
// (pipelineenqueue) that is not on main, so both routes keep proxying to NestJS.
//
// The report POST and the worker share one classificationrssops.Service: the
// POST writes the ClassificationReportJob document and enqueues, the worker
// builds the result into the same collections the NestJS GET already reads.
func wireQualityOps(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) (*qualityOpsRuntime, error) {
	reportsGo := cfg.ClassificationReportsMode == config.ClassificationReportsModeGo
	workerGo := cfg.ClassificationQualityWorkerMode == config.ClassificationQualityWorkerModeGo
	recoveryGo := cfg.PipelineRecoveryMode == config.PipelineRecoveryModeGo
	if !reportsGo && !workerGo && !recoveryGo {
		return nil, nil
	}

	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: quality ops takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	database := (*mongoConn).Database()

	runtime := &qualityOpsRuntime{}
	policy := cors.New(cfg.CorsOrigin)

	var classification *classificationrssops.Service
	if reportsGo || workerGo {
		if db == nil || redisClient == nil {
			return nil, fmt.Errorf("api-go: classification quality takeover requires mysql and redis")
		}
		classification = classificationrssops.NewService(db, database, redisClient)
	}

	if reportsGo {
		if authenticator == nil {
			return nil, fmt.Errorf("api-go: classification reports go takeover requires jwt")
		}
		handler := classificationrssops.NewHandler(authenticator, classification)
		gateway.RegisterGoHandler(legacyproxy.ClassificationReportsKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: classification report creation takeover mode=%s", cfg.ClassificationReportsMode)
	}

	if workerGo {
		worker := qualityqueue.NewWorker(
			qualityqueue.NewQueue(redisClient),
			func(ctx context.Context, job qualityqueue.Job) error {
				return classification.HandleQualityJob(ctx, job.Data)
			},
			qualityqueue.WorkerOptions{
				Concurrency: cfg.QualityWorkerConcurrency(),
				// The name lands in the job "processedBy" field, so an operator
				// can tell a Go run from a NestJS run in Bull Board.
				Name:            "api-go:classification-quality",
				LockDuration:    30 * time.Second,
				StalledInterval: 30 * time.Second,
				MaxStalledCount: 1,
			},
		)
		worker.Start(context.Background())
		runtime.worker = worker
		log.Printf("api-go: classification quality worker enabled mode=%s concurrency=%d",
			cfg.ClassificationQualityWorkerMode, cfg.QualityWorkerConcurrency())
	}

	if recoveryGo {
		if db == nil || authenticator == nil {
			return nil, fmt.Errorf("api-go: pipeline recovery go takeover requires mysql and jwt")
		}
		service := pipelinerecovery.NewService(db, database)
		handler := pipelinerecovery.NewHandler(authenticator, service)
		gateway.RegisterGoHandler(legacyproxy.PipelineRecoveryKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: pipeline recovery takeover mode=%s", cfg.PipelineRecoveryMode)
	}

	return runtime, nil
}
