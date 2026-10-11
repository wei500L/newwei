package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/contentcatalog"
	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
)

// wirePersonalNews 装配订阅、行为画像和每日摘要。
// HTTP 开关只决定注册哪些精确路由。摘要开启时仍直接调用 Go 订阅服务，
// 推荐开启时仍直接调用 Go 画像服务，即使对应 HTTP 开关是 legacy。
// 三个域共用已有的 MySQL、Redis，以及按需打开的一条 Mongo 连接。
func wirePersonalNews(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) error {
	behaviorGo := cfg.UserNewsBehaviorMode == config.UserNewsBehaviorModeGo
	subsGo := cfg.ContentSubscriptionsMode == config.ContentSubscriptionsModeGo
	digestGo := cfg.UserDigestMode == config.UserDigestModeGo
	if !behaviorGo && !subsGo && !digestGo {
		return nil
	}
	if db == nil || authenticator == nil || redisClient == nil {
		return fmt.Errorf("api-go: personal news go takeover requires mysql, jwt, and redis")
	}

	var behaviorSvc *newsbehavior.Service
	if behaviorGo || subsGo {
		behaviorSvc = newsbehavior.NewService(db, redisClient)
	}

	var subsSvc *contentsubscriptions.Service
	if subsGo || digestGo {
		if mongoConn == nil || *mongoConn == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				return fmt.Errorf("api-go: personal news go takeover requires a valid MONGO_URI")
			}
			*mongoConn = conn
		}
		models := contentcatalog.NewModelClient(db)
		catalog := contentcatalog.NewService(db, redisClient, (*mongoConn).Database(), models)
		subsSvc = contentsubscriptions.NewService(db, catalog)
	}

	policy := cors.New(cfg.CorsOrigin)
	register := func(path string, handler http.Handler) {
		gateway.RegisterGoHandler(path, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
	}

	if behaviorGo {
		handler := newsbehavior.NewHandler(authenticator, behaviorSvc)
		register(newsbehavior.RecordPath, handler)
		register(newsbehavior.ProfilePath, handler)
	}
	if subsGo {
		handler := contentsubscriptions.NewHandler(authenticator, subsSvc, behaviorSvc)
		for _, path := range []string{
			contentsubscriptions.ListPath,
			contentsubscriptions.BatchUpsertPath,
			contentsubscriptions.BatchDeletePath,
			contentsubscriptions.CatalogPath,
			contentsubscriptions.RecommendationsPath,
			contentsubscriptions.LookupPath,
			contentsubscriptions.RelatedTopicsPath,
		} {
			register(path, handler)
		}
	}
	if digestGo {
		searcher := userdigest.NewElasticsearchFromEnv()
		handler := userdigest.NewHandler(authenticator, db, (*mongoConn).Database(), subsSvc, searcher)
		register(userdigest.PreferencePath, handler)
		register(userdigest.DeliveryPath, handler)
		register(userdigest.DigestPath, handler)
	}
	log.Printf("api-go: personal news takeover behavior=%s subscriptions=%s digest=%s",
		cfg.UserNewsBehaviorMode, cfg.ContentSubscriptionsMode, cfg.UserDigestMode)
	return nil
}
