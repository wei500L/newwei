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
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newsindicator"
)

// wireNewsIndicators 只在开关为 go 时注册新闻指标关联分析的 3 条 HTTP；
// legacy（含空串）不注册，全部路径回落 NestJS。GraphQL 的两个只读 query
// 另由 API_GO_GRAPHQL_READ_MODE 与 API_GO_NEWS_INDICATORS_MODE 共同决定。
func wireNewsIndicators(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: news indicators go takeover requires mysql, jwt, and redis")
	}
	handler := newsindicator.NewHandler(authenticator, newsindicator.NewService(db, redisClient))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.NewsIndicatorsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: news indicator associations takeover mode=%s", "go")
	return nil
}
