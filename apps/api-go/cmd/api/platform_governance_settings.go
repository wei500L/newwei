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
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

// wirePlatformGovernanceSettings registers the sixteen platform governance
// settings routes only when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go. Every
// other value (including the default legacy and the empty string) registers
// nothing, so the routes keep flowing through the NestJS proxy and rollback is a
// single variable change.
//
// The Mongo client is shared with the other Mongo-backed domains: mongoConn is
// nil when nothing has needed Mongo yet, in which case it is opened here and
// back-filled so main closes it once on exit.
func wirePlatformGovernanceSettings(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
	authenticator *authhttp.Authenticator,
) error {
	if cfg.PlatformGovernanceSettingsMode != config.PlatformGovernanceSettingsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: platform governance settings go takeover requires mysql, redis, and jwt")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: platform governance settings go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	service := platformgovernance.NewService(db, redisClient, (*mongoConn).Database(), platformgovernance.Env{
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
	gateway.RegisterGoHandler(legacyproxy.PlatformGovernanceSettingsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: platform governance settings takeover mode=go")
	return nil
}
