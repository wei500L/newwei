package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
)

func wireNewsSources(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || authenticator == nil || redisClient == nil {
		return fmt.Errorf("api-go: news sources go takeover requires mysql, jwt, and redis")
	}
	// The list backfills the current page's missing ops snapshots with the
	// scheduler's own aggregation. Build the narrow refresh capability from the
	// shared DB and Redis here, before the scheduler is constructed later in the
	// startup, so the list route never serves a nil refresher in production.
	// This only rebuilds missing rows; it starts no cron or worker and performs
	// no crawl dispatch, queue job or external call.
	snapshotRefresher := newssourcescheduler.New(newssourcescheduler.Options{DB: db, Redis: redisClient})
	handler := newssources.NewHandler(authenticator, newssources.NewServiceWithSnapshots(db, redisClient, snapshotRefresher))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.NewsSourcesKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: news sources takeover mode=%s", "go")
	return nil
}
