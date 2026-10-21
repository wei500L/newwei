package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignalsworker"
)

// wireSituationRefresh registers POST /api/situation-monitor/refresh only when
// API_GO_SITUATION_REFRESH_MODE=go. Every other value (including the default
// legacy and the empty string) registers nothing, so the route keeps flowing
// through the NestJS proxy and rollback is a single variable change.
//
// The two dependencies are the reason the switch has startup prerequisites
// (validated by config.Validate):
//
//   - the signals worker service owns the Telegram poll cycles. Only the process
//     holding the Redis MTProto lease may use the session; while NestJS still
//     holds it, a second connection raises AUTH_KEY_DUPLICATED. The worker also
//     performs the OREF poll and the cross-instance poll handover (B2).
//   - the news source scheduler dispatches the reordered sources immediately
//     under the shared cron:news-source-scheduler lease, and reports whether the
//     pass actually ran (B1).
//
// It reuses the process-wide MySQL pool, Redis client and JWT authenticator, and
// the shared Mongo handle when another unit already opened one (the refresh only
// needs Mongo because it constructs the same read-side Service as the signal
// routes; it issues no Mongo query).
func wireSituationRefresh(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn *dashboardstats.Connection,
	authenticator *authhttp.Authenticator,
	scheduler *newssourcescheduler.Scheduler,
	poller *situationsignalsworker.Service,
) error {
	if cfg.SituationRefreshMode != config.SituationRefreshModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation monitor refresh go takeover requires mysql, redis, and jwt")
	}
	if scheduler == nil {
		return fmt.Errorf("api-go: API_GO_SITUATION_REFRESH_MODE=go requires API_GO_NEWS_SOURCE_SCHEDULER_MODE=go")
	}
	if poller == nil {
		return fmt.Errorf("api-go: API_GO_SITUATION_REFRESH_MODE=go requires API_GO_SITUATION_SIGNALS_WORKER_MODE=go")
	}

	var mongoDatabase *mongo.Database
	if mongoConn != nil {
		mongoDatabase = mongoConn.Database()
	}
	settings := situationsignals.NewSettingsReader(db, redisClient, os.LookupEnv)
	core := situationsignals.NewService(db, redisClient, mongoDatabase, settings)
	service := situationsignals.NewRefreshService(core, poller, scheduler)
	handler := situationsignals.NewRefreshHandler(situationsignals.NewAuthenticator(authenticator, db), service)

	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.SituationRefreshKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation monitor refresh takeover mode=%s", cfg.SituationRefreshMode)
	return nil
}

// situationSignalsWorkerService exposes the poll entry points of the signals
// worker runtime, or nil when API_GO_SITUATION_SIGNALS_WORKER_MODE is legacy. The
// refresh switch requires the worker in go mode, so nil here is a startup error
// inside wireSituationRefresh.
func situationSignalsWorkerService(runtime *situationSignalsWorkerRuntime) *situationsignalsworker.Service {
	if runtime == nil {
		return nil
	}
	return runtime.service
}
