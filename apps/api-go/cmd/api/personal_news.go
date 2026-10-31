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

// wirePersonalNews 装配订阅、行为画像、每日摘要读链以及摘要后台投递共用的
// 摘要服务。HTTP 开关只决定注册哪些精确路由；后台投递开关不注册 HTTP。
// 三个 HTTP 域共用已有的 MySQL、Redis，以及按需打开的一条 Mongo 连接。
// 返回值是摘要服务：HTTP 为 go 时交给 handler，后台投递为 go 时交给调度器，
// 两者同时开启时共用同一个实例和同一条 Mongo 连接。
func wirePersonalNews(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoConn **dashboardstats.Connection,
) (*userdigest.Service, error) {
	behaviorGo := true
	subsGo := true
	digestGo := true
	deliveryGo := true
	if !behaviorGo && !subsGo && !digestGo && !deliveryGo {
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: personal news go takeover requires mysql and redis")
	}
	if (behaviorGo || subsGo || digestGo) && authenticator == nil {
		return nil, fmt.Errorf("api-go: personal news HTTP takeover requires jwt")
	}

	var behaviorSvc *newsbehavior.Service
	if behaviorGo || subsGo {
		behaviorSvc = newsbehavior.NewService(db, redisClient)
	}

	var subsSvc *contentsubscriptions.Service
	if subsGo || digestGo || deliveryGo {
		if mongoConn == nil || *mongoConn == nil {
			conn, err := dashboardstats.Open(cfg.MongoURI)
			if err != nil {
				return nil, fmt.Errorf("api-go: personal news go takeover requires a valid MONGO_URI")
			}
			*mongoConn = conn
		}
		models := contentcatalog.NewModelClient(db)
		catalog := contentcatalog.NewService(db, redisClient, (*mongoConn).Database(), models)
		subsSvc = contentsubscriptions.NewService(db, catalog)
	}

	var digestSvc *userdigest.Service
	if digestGo || deliveryGo {
		searcher := userdigest.NewElasticsearchFromEnv()
		digestSvc = userdigest.NewService(db, (*mongoConn).Database(), subsSvc, searcher)
	}

	if behaviorGo || subsGo || digestGo {
		policy := cors.New(cfg.CorsOrigin)
		register := func(path string, handler http.Handler) {
			gateway.RegisterGoHandler(path, func(w http.ResponseWriter, r *http.Request) {
				if policy.FinishOptions(w, r) {
					return
				}
				if r.Method == http.MethodOptions {
					gateway.Reject(w, r)
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
			handler := userdigest.NewHandlerWithService(authenticator, digestSvc)
			register(userdigest.PreferencePath, handler)
			register(userdigest.DeliveryPath, handler)
			register(userdigest.DigestPath, handler)
		}
	}
	log.Printf("api-go: personal news takeover behavior=%s subscriptions=%s digest=%s delivery=%s",
		"go", "go", "go", "go")
	return digestSvc, nil
}
