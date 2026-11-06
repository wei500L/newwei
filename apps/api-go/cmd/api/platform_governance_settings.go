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
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

// wirePlatformGovernanceSettings registers the sixteen platform governance
// settings routes. The rules are registered unconditionally; unmatched paths
// are answered with the Nest-shaped 404.
//
// The Mongo client is shared with the other Mongo-backed domains: mongoConn is
// nil when nothing has needed Mongo yet, in which case it is opened here and
// back-filled so main closes it once on exit.
func wirePlatformGovernanceSettings(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn *mongodb.Client,
	authenticator *authhttp.Authenticator,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: platform governance settings go takeover requires mysql, redis, and jwt")
	}
	service := platformgovernance.NewService(db, redisClient, mongoConn.Database(), platformgovernance.Env{
		AssistantGuardrailsEnabled:     cfg.PlatformGovernanceAssistantGuardrailsEnabled,
		AssistantGuardrails:            cfg.PlatformGovernanceAssistantGuardrailsRaw,
		AssistantOrgSubmitLimitPerHour: cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour,
		AssistantOrgMaxInFlight:        cfg.PlatformGovernanceAssistantOrgMaxInFlight,
		AssistantOrgMonthlyTokenBudget: cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget,
		TaskLogRetentionDays:           cfg.PlatformGovernanceTaskLogRetentionDays,
		EncryptionKeyRaw:               cfg.PlatformGovernanceEncryptionKeyRaw,
	})
	handler := platformgovernance.NewHandler(platformgovernance.NewAuthenticator(authenticator, db), service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.PlatformGovernanceSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: platform governance settings takeover mode=go")
	return nil
}
