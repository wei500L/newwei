package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
)

// wireLlmLogs 只在开关为 go 时注册 LLM 请求日志三条只读 GET 的 handler；
// legacy（含空串）不注册，全部路径回落 NestJS。
//
// 与 War Map / personal-news 共用同一个 Mongo 客户端（mongoConn 为 nil
// 时按需打开并回填，由 main 在退出时关闭），不另开一套连接。
func wireLlmLogs(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	authenticator *authhttp.Authenticator,
	mongoConn *mongodb.Client,
) error {
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: llm logs go takeover requires mysql, jwt, and redis")
	}
	handler := llmlogs.NewHandler(authenticator, llmlogs.NewService(db, mongoConn.Database()))
	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.LlmLogsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: llm request logs takeover mode=%s", "go")
	return nil
}
