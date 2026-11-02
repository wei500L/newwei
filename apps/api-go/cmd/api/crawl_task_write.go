package main

import (
	"database/sql"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// newCrawlTaskWriteService builds the shared crawl task write service. It is
// constructed once when either API_GO_CRAWL_TASK_WRITE_MODE or
// API_GO_CRAWL_QUEUE_OPS_MODE is go; the producer reuses the shared Redis
// client and needs no separate close.
func newCrawlTaskWriteService(cfg config.Config, db *sql.DB, redisClient *redis.Client) *crawltaskwrite.Service {
	producer := crawlqueue.NewProducer(crawlqueue.Options{
		Redis: redisClient,
		DB:    db,
		Env: &crawlqueue.EnvDefaults{
			MaxConcurrency: cfg.CrawlMaxConcurrency,
			MaxRetries:     cfg.CrawlMaxRetries,
			RetryBackoffMs: cfg.CrawlRetryBackoffMs,
		},
	})
	return crawltaskwrite.NewService(crawltaskwrite.Options{
		DB:    db,
		Redis: redisClient,
		Queue: producer,
		Config: crawltaskwrite.Config{
			DefaultConcurrency:             cfg.CrawlMaxConcurrency,
			CrawlBaseURL:                   cfg.CrawlBaseURL,
			RateLimitFailOpen:              cfg.RateLimitFailOpen,
			RateLimitCrawlTaskCreate:       cfg.RateLimitCrawlTaskCreate,
			RateLimitCrawlTaskCreateWindow: cfg.RateLimitCrawlTaskCreateWindow,
		},
		Validator: crawloptions.NewURLValidator(),
	})
}

// wireCrawlTaskLifecycle registers the three crawl task write routes and the
// four queue administration routes on their own switches. Both handlers answer
// CORS preflight for their own paths and fall back to the legacy proxy for an
// OPTIONS request without preflight headers.
func wireCrawlTaskLifecycle(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	svc *crawltaskwrite.Service,
	authenticator *authhttp.Authenticator,
) {
	if svc == nil || authenticator == nil {
		return
	}
	policy := cors.New(cfg.CorsOrigin)
	register := func(key string, handler http.Handler) {
		gateway.RegisterGoHandler(key, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
	}
	if true {
		register(legacyproxy.CrawlTaskWriteKey,
			crawltaskwrite.NewHandler(authenticator, svc, cfg.TrustProxy))
	}
	if true {
		register(legacyproxy.CrawlQueueOpsKey, crawltaskwrite.NewQueueHandler(authenticator, svc))
	}
}
