package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlMetadata 只在 API_GO_CRAWL_METADATA_MODE=go 时注册
// POST /api/crawl-tasks/metadata 的精确路由与 handler；legacy（含空串）
// 不注册，该 POST 继续回落 NestJS。service 由 main 构造并与 GraphQL
// crawlMetadata root 共享，二者不重复初始化 HTTP 连接或 Redis 客户端。
func wireCrawlMetadata(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	service *crawlmetadata.Service,
	authenticator *authhttp.Authenticator,
) error {
	if service == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl metadata go takeover requires mysql, jwt, and redis")
	}
	handler := crawlmetadata.NewHandler(authenticator, service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlMetadataKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl metadata takeover mode=%s", "go")
	return nil
}
