package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// wireNewsSourceScheduler builds the Go owner of the news-source cron and the
// four operations POSTs. Each switch is independent:
//
//	API_GO_NEWS_SOURCE_SCHEDULER_MODE=go  the 30-second tick (no HTTP route)
//	API_GO_NEWS_SOURCE_OPS_MODE=go        the four POST routes
//
// Both need MySQL and Redis; the HTTP switch also needs the JWT authenticator.
// RSS seeds and pipeline retries write the raw_item outbox and a ProcessedItem
// document, so Mongo is required whenever either switch is go; the outbox row is
// claimed transactionally, so sharing the items-ingest service is safe.
func wireNewsSourceScheduler(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	itemsService *itemsingest.Service,
	crawlTaskService *crawltaskwrite.Service,
	mongoConn **dashboardstats.Connection,
) (*newssourcescheduler.Scheduler, error) {
	schedulerGo := cfg.NewsSourceSchedulerMode == config.NewsSourceSchedulerModeGo
	opsGo := cfg.NewsSourceOpsMode == config.NewsSourceOpsModeGo
	if !schedulerGo && !opsGo {
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: news source scheduler/ops go mode requires mysql and redis")
	}
	if opsGo && authenticator == nil {
		return nil, fmt.Errorf("api-go: API_GO_NEWS_SOURCE_OPS_MODE=go requires the JWT authenticator")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: news source scheduler/ops go mode requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	pipeline := pipelineenqueue.New(pipelineenqueue.Options{Redis: redisClient, Mongo: mongoDatabase})
	if itemsService == nil {
		itemsService = itemsingest.NewService(itemsingest.Options{
			DB:       db,
			Mongo:    mongoDatabase,
			Enqueuer: itemPipelineEnqueuer{producer: pipeline},
			Hydrator: itemsreading.NewHydrator(db, mongoDatabase),
		})
	}
	if crawlTaskService == nil {
		crawlTaskService = newCrawlTaskWriteService(cfg, db, redisClient)
	}

	// crawl4ai stays optional, exactly like NestJS: without CRAWL4AI_BASE_URL,
	// deep discovery reports SEED_DEEP_CRAWL4AI_UNAVAILABLE and list discovery
	// falls back to raw HTML.
	client := crawl4ai.New(crawl4ai.Options{
		BaseURL:          cfg.CrawlBaseURL,
		APIKey:           cfg.CrawlAPIKey,
		TimeoutMs:        cfg.CrawlTimeoutMs,
		HealthCheckTTLMs: cfg.CrawlHealthTTLMs,
		SSRFProxyURL:     cfg.CrawlSSRFProxyURL,
		JSCodeEnabled:    cfg.CrawlJSCodeEnabled,
	})
	metadataService := crawlmetadata.NewService(db, redisClient)
	discovery := crawlmetadata.NewDiscovery(metadataService, client, crawlSettingsProvider(db, redisClient))

	service := newssourcescheduler.New(newssourcescheduler.Options{
		DB:        db,
		Redis:     redisClient,
		Discovery: discovery,
		Queue: crawlqueue.NewProducer(crawlqueue.Options{
			Redis: redisClient,
			DB:    db,
			Env: &crawlqueue.EnvDefaults{
				MaxConcurrency: cfg.CrawlMaxConcurrency,
				MaxRetries:     cfg.CrawlMaxRetries,
				RetryBackoffMs: cfg.CrawlRetryBackoffMs,
			},
		}),
		Workflows:       crawlworkflow.NewService(db),
		Items:           itemsService,
		Pipeline:        pipeline,
		CrawlTasks:      crawlTaskService,
		Settings:        schedulerSettingsFromConfig(cfg),
		CrawlDefaults:   crawlDefaultsFromEnv(),
		ScheduleEnabled: cfg.ScheduleEnabled,
		TrustProxy:      cfg.TrustProxy,
	})

	if opsGo {
		handler := newssourcescheduler.NewHandler(authenticator, service)
		policy := cors.New(cfg.CorsOrigin)
		gateway.RegisterGoHandler(legacyproxy.NewsSourceOpsKey, func(w http.ResponseWriter, r *http.Request) {
			if policy.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.ServeLegacy(w, r)
				return
			}
			handler.ServeHTTP(w, r)
		})
		log.Printf("api-go: news source operations takeover mode=%s", cfg.NewsSourceOpsMode)
	}
	if !schedulerGo {
		return nil, nil
	}
	log.Printf("api-go: news source scheduler enabled mode=%s concurrency=%d",
		cfg.NewsSourceSchedulerMode, cfg.NewsSourceScheduler.SourceConcurrency)
	return newssourcescheduler.NewScheduler(service), nil
}

// schedulerSettingsFromConfig converts the environment struct.
func schedulerSettingsFromConfig(cfg config.Config) newssourcescheduler.Settings {
	values := cfg.NewsSourceScheduler
	millis := func(value int) time.Duration {
		return time.Duration(value) * time.Millisecond
	}
	return newssourcescheduler.Settings{
		Enabled:                    values.Enabled,
		BatchSize:                  values.BatchSize,
		LockTTL:                    millis(values.LockTTLMs),
		InFlightLookback:           millis(values.InFlightLookbackMs),
		InFlightRescheduleDelay:    millis(values.InFlightRescheduleDelayMs),
		JitterMax:                  millis(values.JitterMaxMs),
		MaxEnqueuePerTick:          values.MaxEnqueuePerTick,
		BackpressureMaxPendingJobs: values.BackpressureMaxPendingJobs,
		BackpressureDelay:          millis(values.BackpressureDelayMs),
		FailureRecoveryDelay:       millis(values.FailureRecoveryDelayMs),
		FailureMaxDelay:            millis(values.FailureMaxDelayMs),
		CircuitBreakerThreshold:    values.CircuitBreakerThreshold,
		CircuitBreakerBaseDelay:    millis(values.CircuitBreakerBaseDelayMs),
		CircuitBreakerMaxDelay:     millis(values.CircuitBreakerMaxDelayMs),
		SourceConcurrency:          values.SourceConcurrency,
	}
}

// crawlDefaultsFromEnv reads the five NEWS_SOURCE_CRAWL_* defaults the NestJS
// scheduler applies to every CrawlTask config, with the same fallbacks.
func crawlDefaultsFromEnv() newssourcescheduler.CrawlDefaults {
	return newssourcescheduler.CrawlDefaults{
		AutoExpandDetails:       envBooleanDefault("NEWS_SOURCE_CRAWL_AUTO_EXPAND_DETAILS", true),
		QualityProfile:          envStringDefault("NEWS_SOURCE_CRAWL_QUALITY_PROFILE", "quality_first"),
		DetailMaxURLs:           envIntDefault("NEWS_SOURCE_CRAWL_DETAIL_MAX_URLS", 12),
		DetailMinRelevanceScore: envFloatDefault("NEWS_SOURCE_CRAWL_DETAIL_MIN_RELEVANCE_SCORE", 0.35),
		DetailRequireSameDomain: envBooleanDefault("NEWS_SOURCE_CRAWL_DETAIL_REQUIRE_SAME_DOMAIN", true),
	}
}

func envBooleanDefault(key string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "true", "1", "yes", "y", "on":
		return true
	case "false", "0", "no", "n", "off":
		return false
	default:
		return fallback
	}
}

func envStringDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envIntDefault(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envFloatDefault(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}
