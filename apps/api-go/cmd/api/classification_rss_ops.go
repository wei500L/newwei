package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireClassificationRssOps registers the handler for the classification quality
// workbench, the RSS chain diagnostics and the RSS translation metrics only when
// API_GO_CLASSIFICATION_RSS_OPS_MODE=go. In legacy mode (including the empty
// string) nothing is registered and every path keeps proxying to NestJS.
//
// The takeover needs MySQL, Redis, the JWT authenticator and Mongo: the five
// classification* collections, processeditems and tasklogs all live in Mongo,
// while the RSS diagnostics come from MySQL plus the ObservabilitySnapshot
// table. The existing Mongo connection is reused; when it is not open yet the
// handler opens it through the same helper the quality overview uses.
func wireClassificationRssOps(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if cfg.ClassificationRssOpsMode != config.ClassificationRssOpsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: classification/rss ops go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: classification/rss ops go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	handler := classificationrssops.NewHandler(authenticator,
		classificationrssops.NewService(db, (*mongoConn).Database(), redisClient))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.ClassificationRssOpsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: classification/rss ops takeover mode=%s", cfg.ClassificationRssOpsMode)
	return nil
}
