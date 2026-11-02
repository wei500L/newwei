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
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlFrontierWrites registers the three crawl frontier write handlers only
// when API_GO_CRAWL_FRONTIER_WRITES_MODE=go. In legacy mode (including unset)
// nothing is registered and every path keeps proxying to NestJS.
//
// config.go guarantees that go implies API_GO_CRAWL_FRONTIER_RUNS_MODE=go, so
// the read handler owns GET /runs/:id and the write handler returns the same run
// detail. The producer is built here because createRun and the two retry routes
// enqueue crawl jobs, exactly like the NestJS service they replace.
func wireCrawlFrontierWrites(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl frontier writes go takeover requires mysql, jwt, and redis")
	}
	frontier := crawlfrontierllm.New(crawlfrontierllm.Options{
		DB:    db,
		Redis: redisClient,
		Enqueuer: crawlqueue.NewProducer(crawlqueue.Options{
			Redis: redisClient,
			DB:    db,
			Env: &crawlqueue.EnvDefaults{
				MaxConcurrency:   cfg.CrawlMaxConcurrency,
				MaxRetries:       cfg.CrawlMaxRetries,
				RetryBackoffMs:   cfg.CrawlRetryBackoffMs,
				RequestTimeoutMs: cfg.CrawlTimeoutMs,
			},
		}),
		Workflows: crawlworkflow.NewService(db),
	})
	handler := crawlfrontierruns.NewWriteHandler(authenticator, crawlfrontierruns.NewWriteService(db, frontier))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlFrontierWritesKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl frontier writes takeover mode=%s", "go")
	return nil
}
