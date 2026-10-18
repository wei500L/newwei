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
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// wireCrawlReadTelemetry registers the seven crawl read / media / telemetry
// handlers only when API_GO_CRAWL_READ_TELEMETRY_MODE=go. Legacy (including the
// empty value) registers nothing, so every path keeps proxying to NestJS.
//
// The Mongo connection reuses the shared one and is opened on demand; the Redis
// client is the gateway's shared connection (telemetry counters and the quality
// snapshot lock). storageConfig is the shared runtime storage configuration
// reader used to presign S3 media URLs.
func wireCrawlReadTelemetry(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	storageConfig objectstorage.ConfigReader,
	mongoConn **dashboardstats.Connection,
) error {
	if cfg.CrawlReadTelemetryMode != config.CrawlReadTelemetryModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil || cfg.JWTSecret == "" {
		return fmt.Errorf("api-go: crawl read telemetry go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: crawl read telemetry go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	handler := crawlreadtelemetry.NewHandler(
		authenticator,
		crawlreadtelemetry.NewService(db, redisClient, (*mongoConn).Database(), cfg.JWTSecret, storageConfig),
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlReadTelemetryKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl read telemetry takeover mode=%s", cfg.CrawlReadTelemetryMode)
	return nil
}
