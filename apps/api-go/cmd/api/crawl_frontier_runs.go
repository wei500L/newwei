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
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlFrontierRuns registers the eleven crawl frontier run monitoring and
// cancellation handlers only when API_GO_CRAWL_FRONTIER_RUNS_MODE=go. In
// legacy mode (including unset) nothing is registered and every path keeps
// proxying to NestJS.
func wireCrawlFrontierRuns(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl frontier runs go takeover requires mysql, jwt, and redis")
	}
	handler := crawlfrontierruns.NewHandler(authenticator, crawlfrontierruns.NewService(db))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlFrontierRunsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl frontier runs takeover mode=%s", "go")
	return nil
}
