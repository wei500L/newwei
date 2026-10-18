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
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayops"
	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// wireLLMGatewayOps registers the twelve governance/diagnostics routes only when
// API_GO_LLM_GATEWAY_OPS_MODE=go.
//
// Infrastructure footprint: MySQL (the governance row and the profile document),
// Redis (the 30 second governance envelope and the 60 second model-info cache),
// the shared JWT/machine authenticator, and Mongo (one llmrequestlogs row per
// real probe attempt). It deliberately does NOT require any other API_GO_* mode:
// the profile service is built read-only here, the LLM log writer is created
// locally, and no model upstream is contacted at startup.
//
// The Mongo connection is shared through mongoConn (opened on demand and closed
// by main), so enabling only this mode still provides a working log writer.
func wireLLMGatewayOps(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if cfg.LLMGatewayOpsMode != config.LLMGatewayOpsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: llm gateway ops go takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: llm gateway ops go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	// Read-only profile port: no lock pool, no write path.
	profiles := newLLMGatewayProfilesService(cfg, db, redisClient, nil)
	logs := llmlogs.NewProbeWriter(db, mongoDatabase)
	service := llmgatewayops.NewService(db, redisClient, profiles, logs, llmgatewayops.Config{
		MasterKey: cfg.LiteLLMMasterKey,
	})
	handler := llmgatewayops.NewHandler(
		llmgatewayprofiles.NewAuthenticator(authenticator, db),
		service,
	)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.LLMGatewayOpsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: llm gateway governance/diagnostics takeover mode=%s", cfg.LLMGatewayOpsMode)
	return nil
}
