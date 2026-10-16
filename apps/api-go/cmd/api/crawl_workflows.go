package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlWorkflows 只在开关为 go 时注册采集策略工作流编辑接口的
// handler；legacy（含空串）不注册，全部路径回落 NestJS。
func wireCrawlWorkflows(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	if cfg.CrawlWorkflowsMode != config.CrawlWorkflowsModeGo {
		return nil
	}
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl workflows go takeover requires mysql, jwt, and redis")
	}
	handler := crawlworkflow.NewHandler(authenticator, crawlworkflow.NewService(db))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlWorkflowsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl workflows takeover mode=%s", cfg.CrawlWorkflowsMode)
	return nil
}
