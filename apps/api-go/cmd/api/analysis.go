package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/analysisboards"
	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/analysistasks"
	"github.com/wei500L/newwei/apps/api-go/internal/analysisthreads"
	"github.com/wei500L/newwei/apps/api-go/internal/analysisviews"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireAnalysisCollaboration 按三个 HTTP 开关注册分析工作台。
// 开关只决定路由。视图删除清理讨论、讨论校验主体，都不看另一个开关。
func wireAnalysisCollaboration(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	viewsGo := cfg.AnalysisViewsMode == config.AnalysisViewsModeGo
	boardsGo := cfg.AnalysisBoardsMode == config.AnalysisBoardsModeGo
	threadsGo := cfg.AnalysisThreadsMode == config.AnalysisThreadsModeGo
	if !viewsGo && !boardsGo && !threadsGo {
		return nil
	}
	if db == nil || authenticator == nil {
		return fmt.Errorf("api-go: analysis collaboration go takeover requires mysql, jwt, and redis")
	}
	store := analysiscollab.NewStore(db)
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

	if viewsGo {
		handler := analysisviews.NewHandler(authenticator, analysisviews.NewService(store))
		register(legacyproxy.AnalysisViewsKey, handler)
		log.Printf("api-go: analysis views under go takeover")
	}
	if threadsGo {
		handler := analysisthreads.NewHandler(authenticator, analysisthreads.NewService(store))
		register(legacyproxy.AnalysisThreadsKey, handler)
		register(legacyproxy.AnalysisCommentsKey, handler)
		log.Printf("api-go: analysis threads under go takeover")
	}
	if boardsGo {
		boards := analysisboards.NewHandler(authenticator, analysisboards.NewService(store))
		register(legacyproxy.AnalysisBoardsKey, boards)
		register(legacyproxy.AnalysisColumnsKey, boards)
		tasks := analysistasks.NewHandler(authenticator, analysistasks.NewService(store, boards.Service()))
		register(legacyproxy.AnalysisTasksKey, tasks)
		log.Printf("api-go: analysis boards and tasks under go takeover")
	}
	return nil
}
