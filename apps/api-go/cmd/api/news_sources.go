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
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

func wireNewsSources(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	if cfg.NewsSourcesMode != config.NewsSourcesModeGo {
		return nil
	}
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: news sources go takeover requires mysql, jwt, and redis")
	}
	handler := newssources.NewHandler(authenticator, newssources.NewService(db))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.NewsSourcesKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: news sources takeover mode=%s", cfg.NewsSourcesMode)
	return nil
}
