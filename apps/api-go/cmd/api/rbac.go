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
	"github.com/wei500L/newwei/apps/api-go/internal/rbacapi"
)

// wireRbac 只在开关为 go 时注册组织访问控制六条 HTTP 的 handler；
// legacy（含空串）不注册，全部路径回落 NestJS。
func wireRbac(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if cfg.RbacMode != config.RbacModeGo {
		return nil
	}
	if db == nil || authenticator == nil || redisClient == nil {
		return fmt.Errorf("api-go: rbac go takeover requires mysql, jwt, and redis")
	}
	handler := rbacapi.NewHandler(authenticator, rbacapi.NewService(db, redisClient))
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.RbacKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: rbac takeover mode=%s", cfg.RbacMode)
	return nil
}
