package main

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/queueops"
)

// wireQueueOps registers the queue operations console when
// API_GO_QUEUE_OPS_MODE=go.
//
// The console is a new Go-only surface under /api/admin/queue-ops (NestJS never
// served it), so the switch only decides whether the gateway takes those paths
// over; in legacy mode no rule is registered and the requests keep falling
// through to NestJS, which answers 404.
//
// Every route needs MySQL (the membership/permission re-derivation, the
// platform-admin lookup and the audit row), Redis (all queue state) and JWT
// verification, so a go switch without one of them is a startup error rather
// than a route that fails per request.
//
// The handler answers CORS preflight for its own paths and forwards an OPTIONS
// request without preflight headers to the legacy proxy, exactly like the crawl
// task write and queue administration routes.
func wireQueueOps(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
) error {
	if cfg.QueueOpsMode != config.QueueOpsModeGo {
		return nil
	}
	if gateway == nil || db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: API_GO_QUEUE_OPS_MODE=go requires mysql, redis, and jwt")
	}
	platform := platformgovernance.NewAuthenticator(authenticator, db)
	// The replay producer shares the console's Redis client and needs no Mongo
	// handle: a replay never inserts a ProcessedItem.
	producer := pipelineenqueue.New(pipelineenqueue.Options{Redis: redisClient})
	service := queueops.NewService(queueops.Options{
		DB:       db,
		Redis:    redisClient,
		Producer: producer,
	})
	handler := queueops.NewHandler(authenticator, platform, service)

	corsPolicy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.QueueOpsKey, func(w http.ResponseWriter, r *http.Request) {
		if corsPolicy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	return nil
}
