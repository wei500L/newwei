package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
)

// wireAdminLogs 只在开关为 go 时注册管理端日志与异常读取 7 条 GET 的
// handler；legacy（含空串）不注册，全部路径回落 NestJS。Mongo 连接复用
// 已有的那一条（没有时按需打开，退出时由 main 统一关闭）。
func wireAdminLogs(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn *mongodb.Client,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: admin logs go takeover requires mysql, jwt, and redis")
	}
	handler := adminlogs.NewHandler(authenticator, adminlogs.NewService(db, mongoConn.Database()))
	policy := cors.New(cfg.CorsOrigin)
	gateway.Handle(httproute.AdminLogsKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: admin logs takeover mode=%s", "go")
	return nil
}
