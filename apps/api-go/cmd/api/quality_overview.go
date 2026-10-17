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
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/qualityoverview"
)

// wireQualityOverview 只在开关为 go 时注册管理端质量面板 5 条 GET 的
// handler；legacy（含空串）不注册，全部路径回落 NestJS。Mongo 连接复用
// 已有的那一条（没有时按需打开，退出时由 main 统一关闭）；Redis 复用
// 网关的共享连接（快照锁与质量总览缓存）。
func wireQualityOverview(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	if cfg.QualityOverviewMode != config.QualityOverviewModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: quality overview go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return fmt.Errorf("api-go: quality overview go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	handler := qualityoverview.NewHandler(authenticator, qualityoverview.NewService(db, (*mongoConn).Database(), redisClient))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.QualityOverviewKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: quality overview takeover mode=%s", cfg.QualityOverviewMode)
	return nil
}
