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
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireAdminLogs 只在开关为 go 时注册管理端日志与异常读取 7 条 GET 的
// handler；legacy（含空串）不注册，全部路径回落 NestJS。Mongo 连接复用
// 已有的那一条（没有时按需打开，退出时由 main 统一关闭）。
func wireAdminLogs(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: admin logs go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: admin logs go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	handler := adminlogs.NewHandler(authenticator, adminlogs.NewService(db, (*mongoConn).Database()))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.AdminLogsKey, func(w http.ResponseWriter, r *http.Request) {
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
