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
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

// wireSituationInsights registers GET /api/situation-monitor/insights only when
// API_GO_SITUATION_INSIGHTS_MODE=go. Every other value (including the default
// legacy) registers nothing, so rollback is a single variable change plus a
// restart.
//
// The takeover shares the process-wide MySQL pool, Redis client and Mongo
// client. It starts no worker, rebuilds no GDELT snapshot and dispatches no news
// collection.
func wireSituationInsights(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
	authenticator *authhttp.Authenticator,
) error {
	if cfg.SituationInsightsMode != config.SituationInsightsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation insights go takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: situation insights go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	var mongoDatabase *mongo.Database
	if *mongoConn != nil {
		mongoDatabase = (*mongoConn).Database()
	}
	settings := situationsignals.NewSettingsReader(db, redisClient, os.LookupEnv)
	service := situationsignals.NewInsightsService(db, redisClient, mongoDatabase, settings)
	handler := situationsignals.NewInsightsHandler(situationsignals.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.SituationInsightsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation monitor insights takeover mode=%s", cfg.SituationInsightsMode)
	return nil
}
