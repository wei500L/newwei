package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

// wireSituationSignals registers the seven situation monitor signal routes.
// The rules are registered unconditionally; unmatched paths are answered with
// the Nest-shaped 404.
//
// It shares the process-wide MySQL pool, Redis client and Mongo client
// (opening the Mongo client on demand and handing it back through mongoConn
// for shutdown), so the takeover adds no second connection pool.
func wireSituationSignals(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn *mongodb.Client,
	authenticator *authhttp.Authenticator,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation monitor signals go takeover requires mysql, redis, and jwt")
	}

	mongoDatabase := mongoConn.Database()
	settings := situationsignals.NewSettingsReader(db, redisClient, os.LookupEnv)
	service := situationsignals.NewService(db, redisClient, mongoDatabase, settings)
	handler := situationsignals.NewHandler(situationsignals.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.SituationSignalsKey, func(w http.ResponseWriter, r *http.Request) {
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
