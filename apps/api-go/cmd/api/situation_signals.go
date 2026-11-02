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

// wireSituationSignals registers the seven situation monitor signal routes only
// when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go. Every other value (including the
// default legacy and the empty string) registers nothing, so the routes keep
// flowing through the NestJS proxy and rollback is a single variable change.
//
// It shares the process-wide MySQL pool, Redis client and Mongo client (opening
// the Mongo client on demand and handing it back through mongoConn for shutdown),
// so the takeover adds no second connection pool.
func wireSituationSignals(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
	authenticator *authhttp.Authenticator,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation monitor signals go takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: situation monitor signals go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}

	var mongoDatabase *mongo.Database
	if *mongoConn != nil {
		mongoDatabase = (*mongoConn).Database()
	}
	settings := situationsignals.NewSettingsReader(db, redisClient, os.LookupEnv)
	service := situationsignals.NewService(db, redisClient, mongoDatabase, settings)
	handler := situationsignals.NewHandler(situationsignals.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.SituationSignalsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation monitor signals takeover mode=%s", "go")
	return nil
}
