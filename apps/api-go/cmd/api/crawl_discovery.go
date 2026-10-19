package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlstrategyruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// wireCrawlDiscovery registers the three crawl discovery entries when at least
// one of the two switches is go:
//
//	GET  /api/admin/news-sources/:id/preview          (API_GO_NEWS_SOURCE_PREVIEW_MODE)
//	POST /api/admin/crawl-frontier/workflows/:id/trial-run  (API_GO_CRAWL_WORKFLOW_TRIAL_MODE)
//	POST /api/admin/crawl-frontier/workflow-runs/:runId/replay (API_GO_CRAWL_WORKFLOW_TRIAL_MODE)
//
// Both default to legacy, in which case nothing is constructed and every path
// keeps proxying to NestJS.
//
// The crawl4ai client is always constructed: an empty CRAWL4AI_BASE_URL leaves it
// unconfigured, which makes deep discovery report SEED_DEEP_CRAWL4AI_UNAVAILABLE
// and list discovery fall back to raw HTML — the same degradation the NestJS
// client shows when the service is unreachable. The crawl client settings are
// read through the shared crawl_client:settings cache/SystemSetting row on every
// discovery pass, so a settings write in either runtime is visible immediately.
func wireCrawlDiscovery(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	metadataService *crawlmetadata.Service,
	authenticator *authhttp.Authenticator,
) error {
	if cfg.NewsSourcePreviewMode != config.NewsSourcePreviewModeGo &&
		cfg.CrawlWorkflowTrialMode != config.CrawlWorkflowTrialModeGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl discovery go takeover requires mysql, jwt, and redis")
	}
	if metadataService == nil {
		// The HTTP metadata entry may be legacy; the discovery chain still needs
		// the shared fetch/SSRF/extract service, so build it once here.
		metadataService = crawlmetadata.NewService(db, redisClient)
	}

	client := crawl4ai.New(crawl4ai.Options{
		BaseURL:          cfg.CrawlBaseURL,
		APIKey:           cfg.CrawlAPIKey,
		TimeoutMs:        cfg.CrawlTimeoutMs,
		HealthCheckTTLMs: cfg.CrawlHealthTTLMs,
		SSRFProxyURL:     cfg.CrawlSSRFProxyURL,
	})
	settings := func(ctx context.Context) crawl4ai.Settings {
		model := settingscrawl.LoadCrawlClientSettings(ctx, db, redisClient, settingscrawl.CrawlClientSettingsEnv{
			RequestTimeoutMs: cfg.CrawlTimeoutMs,
			HealthCheckTTLMs: cfg.CrawlHealthTTLMs,
		})
		return crawl4ai.Settings{
			RequestTimeoutNormalMs: model.RequestTimeoutNormalMs,
			HealthCheckTTLMs:       model.HealthCheckTTLMs,
		}
	}
	discovery := crawlmetadata.NewDiscovery(metadataService, client, settings)
	workflows := crawlworkflow.NewService(db)
	runs := crawlstrategyruns.NewService(crawlstrategyruns.Options{
		DB:        db,
		Discovery: discovery,
		Workflows: workflows,
	})
	preview := crawlmetadata.NewPreviewService(crawlmetadata.PreviewOptions{
		Metadata:           metadataService,
		Discovery:          discovery,
		Workflows:          workflows,
		InFlightLookbackMs: cfg.NewsSourceSchedulerInFlightLookbackMs,
	})

	handler := crawlstrategyruns.NewHandler(authenticator, runs, preview, metadataService)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.CrawlDiscoveryKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.ServeLegacy(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: crawl discovery takeover preview=%s trial=%s crawl4ai=%t",
		cfg.NewsSourcePreviewMode, cfg.CrawlWorkflowTrialMode, client.Configured())
	return nil
}
