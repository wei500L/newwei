package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltemplate"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlTemplates 只在开关为 go 时注册采集模板编辑接口的 handler；
// legacy（含空串）不注册，全部路径回落 NestJS。
func wireCrawlTemplates(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl templates go takeover requires mysql, jwt, and redis")
	}
	handler := crawltemplate.NewHandler(authenticator, crawltemplate.NewService(db))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlTemplatesKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl templates takeover mode=%s", "go")
	return nil
}
