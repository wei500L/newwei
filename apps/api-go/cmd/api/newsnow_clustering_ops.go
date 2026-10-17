package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
)

// wireNewsnowClusteringOps registers the nine NewsNow local-computation and
// news-event clustering failure handlers only when the switch is go. In legacy
// (including the empty value) nothing is registered and all nine paths fall
// back to NestJS. The Mongo connection is shared with the other takeovers; the
// Redis connection is the gateway-wide one.
func wireNewsnowClusteringOps(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if cfg.NewsnowClusteringOpsMode != config.NewsnowClusteringOpsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: newsnow clustering ops go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: newsnow clustering ops go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}

	// The personalized-ordering endpoint reuses the same behavior profile the
	// /api/user-news-behavior takeover serves. It only reads Redis, so passing
	// the shared handle keeps both paths on one connection.
	behavior := newsbehavior.NewService(db, redisClient)
	service := newsnowclusteringops.NewService(newsnowclusteringops.ServiceConfig{
		ModelServiceEnabled: newsnowEnvBool("MODEL_SERVICE_ENABLED", false),
		ModelServiceBaseURL: os.Getenv("MODEL_SERVICE_BASE_URL"),
		ModelServiceToken:   os.Getenv("MODEL_SERVICE_INTERNAL_TOKEN"),
		EncryptionKey:       os.Getenv("SYSTEM_SETTINGS_ENCRYPTION_KEY"),
	}, db, (*mongoConn).Database(), redisClient, behavior)

	handler := newsnowclusteringops.NewHandler(authenticator, service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.NewsnowClusteringOpsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: newsnow clustering ops takeover mode=%s", cfg.NewsnowClusteringOpsMode)
	return nil
}

// newsnowEnvBool reads a boolean environment variable. The NestJS env schema
// treats "true"/"1"/"yes"/"on" as true and everything else as false.
func newsnowEnvBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	default:
		return fallback
	}
}
