package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlProfiles 只在开关为 go 时注册采集站点画像编辑接口的 handler；
// legacy（含空串）不注册，全部路径回落 NestJS。
func wireCrawlProfiles(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl profiles go takeover requires mysql, jwt, and redis")
	}
	handler := crawlprofile.NewHandler(authenticator, crawlprofile.NewService(db))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlProfilesKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl profiles takeover mode=%s", "go")
	return nil
}
