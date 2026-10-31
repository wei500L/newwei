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
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlstrategyruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// The crawl discovery entries share one crawl4ai client, one metadata Service
// and one workflow Service. The preview GET and the crawl-strategy
// trial/replay POSTs are independent switches: each is only registered when its
// own switch is go, and neither requires the other.
const (
	crawlClientSettingsCacheKey = "crawl_client:settings"
	crawlClientSettingsRowKey   = "crawl_client_settings"
)

// wireCrawlDiscovery registers the two Go takeovers. legacy (including unset)
// registers nothing and every path keeps proxying to NestJS.
func wireCrawlDiscovery(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	metadataService *crawlmetadata.Service,
	authenticator *authhttp.Authenticator,
) error {
	previewGo := true
	trialGo := true
	if !previewGo && !trialGo {
		return nil
	}
	if db == nil || redisClient == nil || authenticator == nil {
		return fmt.Errorf("api-go: crawl discovery go takeover requires mysql, jwt, and redis")
	}
	if metadataService == nil {
		metadataService = crawlmetadata.NewService(db, redisClient)
	}

	// crawl4ai is optional, exactly like NestJS: without CRAWL4AI_BASE_URL the
	// client is unconfigured, deep discovery returns
	// SEED_DEEP_CRAWL4AI_UNAVAILABLE and list discovery falls back to raw HTML.
	client := crawl4ai.New(crawl4ai.Options{
		BaseURL:          cfg.CrawlBaseURL,
		APIKey:           cfg.CrawlAPIKey,
		TimeoutMs:        cfg.CrawlTimeoutMs,
		HealthCheckTTLMs: cfg.CrawlHealthTTLMs,
		SSRFProxyURL:     cfg.CrawlSSRFProxyURL,
		JSCodeEnabled:    cfg.CrawlJSCodeEnabled,
	})
	discovery := crawlmetadata.NewDiscovery(metadataService, client, crawlSettingsProvider(db, redisClient))
	workflows := crawlworkflow.NewService(db)
	runs := crawlfrontierruns.NewService(db)
	runtime := crawlstrategyruns.NewRuntime(db, discovery, workflows, runs)
	policy := cors.New(cfg.CorsOrigin)

	if previewGo {
		preview := crawlstrategyruns.NewPreviewService(db, redisClient, discovery, workflows, cfg.NewsSourceInFlightLookbackMs)
		handler := crawlstrategyruns.NewPreviewHandler(authenticator, runtime, preview)
		gateway.RegisterGoHandler(legacyproxy.NewsSourcePreviewKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: news source preview takeover mode=%s", "go")
	}

	if trialGo {
		handler := crawlstrategyruns.NewHandler(authenticator, runtime)
		gateway.RegisterGoHandler(legacyproxy.CrawlWorkflowTrialKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: crawl workflow trial/replay takeover mode=%s", "go")
	}
	return nil
}

// crawlSettingsProvider resolves CrawlClientSettings for one discovery request.
// It mirrors CrawlSettingsService.getSettings: the 30s Redis cache first, then
// the crawl_client_settings SystemSetting row, then the environment-derived
// fallback. A cache or database failure degrades to the fallback instead of
// failing the request, matching the NestJS warn-and-continue behaviour.
func crawlSettingsProvider(db *sql.DB, redisClient *redis.Client) crawlmetadata.SettingsProvider {
	return func(ctx context.Context) crawl4ai.Settings {
		fallback := settingscrawl.DefaultCrawlClientNormalized()
		if redisClient != nil {
			if cached, err := redisClient.Get(ctx, crawlClientSettingsCacheKey).Result(); err == nil && cached != "" {
				return settingsFromNormalized(settingscrawl.NormalizeCrawlClientSettingsDocument([]byte(cached), fallback))
			}
		}
		if db != nil {
			var raw []byte
			err := db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", crawlClientSettingsRowKey).Scan(&raw)
			if err == nil {
				return settingsFromNormalized(settingscrawl.NormalizeCrawlClientSettingsDocument(raw, fallback))
			}
			if err != sql.ErrNoRows {
				log.Printf("api-go: crawl client settings read failed, using fallback: %v", err)
			}
		}
		return settingsFromNormalized(fallback)
	}
}

func settingsFromNormalized(normalized settingscrawl.CrawlClientNormalized) crawl4ai.Settings {
	return crawl4ai.Settings{
		RequestTimeoutNormalMs: normalized.Settings.RequestTimeoutNormalMs,
		HealthCheckTTLMs:       normalized.Settings.HealthCheckTTLMs,
	}
}
