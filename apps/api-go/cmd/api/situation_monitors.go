package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/situationmonitors"
)

func wireSituationMonitors(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	if cfg.SituationMonitorsMode != config.SituationMonitorsModeGo {
		return nil
	}
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: situation monitors go takeover requires mysql, jwt, and redis")
	}
	handler := situationmonitors.NewHandler(authenticator, situationmonitors.NewService(db))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.SituationMonitorsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation monitors takeover mode=%s", cfg.SituationMonitorsMode)
	return nil
}
