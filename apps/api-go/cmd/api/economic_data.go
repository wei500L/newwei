package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/economicqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// economicRuntime owns the Go consumer and its dedicated blocking Redis client.
type economicRuntime struct {
	service     *economicdata.Service
	worker      *economicqueue.Worker
	workerRedis *redis.Client
	cancel      context.CancelFunc
	finished    chan struct{}
}

// Start synchronizes the catalog and repeat jobs before the first claim. A
// failure here is a startup failure, matching NestJS onModuleInit.
func (r *economicRuntime) Start(ctx context.Context) error {
	if r == nil || r.worker == nil {
		return nil
	}
	if err := r.service.EnsureCatalog(ctx); err != nil {
		return err
	}
	if err := r.service.EnsureRepeatableJobs(ctx); err != nil {
		return err
	}
	workerCtx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.finished = make(chan struct{})
	go func() {
		defer close(r.finished)
		r.worker.Run(workerCtx)
	}()
	return nil
}

// Close stops new claims and waits for in-flight fetches before the shared
// MySQL/Mongo/Redis clients close.
func (r *economicRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if r.cancel != nil {
		r.cancel()
	}
	var err error
	if r.worker != nil {
		err = r.worker.Close(ctx)
	}
	if r.workerRedis != nil {
		if closeErr := r.workerRedis.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}
	return err
}

// wireEconomicData registers the request-side HTTP routes and constructs the
// worker without starting it. The caller starts the runtime after installing
// its ordered shutdown defer.
func wireEconomicData(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongo **dashboardstats.Connection,
) (*economicdata.Service, *economicRuntime, error) {
	requestGo := true
	workerGo := true
	if !requestGo && !workerGo {
		return nil, nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, nil, fmt.Errorf("api-go: economic-data takeover requires mysql and redis")
	}
	if requestGo && authenticator == nil {
		return nil, nil, fmt.Errorf("api-go: API_GO_ECONOMIC_DATA_MODE=go requires jwt")
	}
	var mongoConn *dashboardstats.Connection
	if mongo != nil {
		mongoConn = *mongo
	}
	if workerGo && mongoConn == nil {
		opened, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, nil, fmt.Errorf("api-go: API_GO_ECONOMIC_DATA_WORKER_MODE=go requires a valid MONGO_URI")
		}
		if mongo != nil {
			*mongo = opened
		}
		mongoConn = opened
	}
	service := economicdata.NewService(economicdata.Options{
		DB:    db,
		Redis: redisClient,
		Env: economicdata.Env{
			AkshareEnabled:        cfg.AkshareEnabled,
			AkshareBaseURL:        cfg.AkshareBaseURL,
			AkshareTimeout:        time.Duration(cfg.AkshareTimeoutMs) * time.Millisecond,
			AkshareMaxRetries:     cfg.AkshareMaxRetries,
			AkshareAdminToken:     cfg.AkshareAdminToken,
			QueueConcurrency:      cfg.AkshareQueueConcurrency,
			ScheduleSmoothing:     cfg.AkshareScheduleSmoothing,
			SkipUnchangedLatest:   cfg.AkshareSkipUnchangedLatest,
			SettingsEncryptionKey: cfg.SettingsEncryptionKey,
			RateLimitFailOpen:     cfg.RateLimitFailOpen,
		},
	})
	if mongoConn != nil {
		service.SetMongo(mongoConn.Database())
	}
	if requestGo {
		handler := economicdata.NewAdminHandler(authenticator, service)
		policy := cors.New(cfg.CorsOrigin)
		gateway.RegisterGoHandler(legacyproxy.EconomicDataKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: economic-data request routes under go takeover")
	}
	runtime := &economicRuntime{service: service}
	if workerGo {
		workerRedis := redis.NewClient(&redis.Options{
			Addr:     redisClient.Options().Addr,
			Username: redisClient.Options().Username,
			Password: redisClient.Options().Password,
			DB:       redisClient.Options().DB,
			Protocol: 2,
		})
		handler := func(ctx context.Context, job economicqueue.Job) error {
			var data economicqueue.JobData
			if err := json.Unmarshal(job.Data, &data); err != nil {
				return fmt.Errorf("invalid akshare job payload: %w", err)
			}
			if data.TraceID != "" {
				log.Printf("economicdata: job=%s slug=%s trace=%s", job.ID, data.DataItemID, data.TraceID)
			}
			_, err := service.FetchAndPersist(ctx, data.DataItemID)
			return err
		}
		runtime.workerRedis = workerRedis
		runtime.worker = economicqueue.NewWorker(workerRedis, handler, economicqueue.WorkerOptions{
			Concurrency: cfg.AkshareQueueConcurrency,
		})
		log.Printf("api-go: economic-data worker under go takeover (concurrency=%d)", cfg.AkshareQueueConcurrency)
	}
	return service, runtime, nil
}

// economicRequestIP mirrors resolveRequestIp: X-Forwarded-For first, then the
// socket address. It is used only for the preset audit row.
func economicRequestIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		value := strings.TrimSpace(strings.Split(forwarded, ",")[0])
		if value != "" {
			return value
		}
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	return strings.TrimPrefix(host, "::ffff:")
}
