package main

// Dashboard assembly: the stats, chart, war-map, spacetime, stream and
// authenticated health handlers all reuse the process-wide MySQL, Redis and
// Mongo clients opened once by main. They share one dashboard stats handler and
// one each of the chart, war-map and spacetime services, so a single Mongo
// client and a single Redis limiter serve every route.

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardspacetime"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstream"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
	"github.com/wei500L/newwei/apps/api-go/internal/health"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
)

// wireDashboard registers GET /api/dashboard/stats, the chart GETs, the war-map
// GETs, the spacetime GETs, the dashboard SSE stream and the authenticated
// /api/healthz handler. It returns the stream handler (for the /__go/healthz
// introspection counters) and the ready handler (closed during teardown).
func wireDashboard(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoClient *mongodb.Client,
) (*dashboardstream.Handler, *health.ReadyHandler, error) {
	if db == nil || authenticator == nil || redisClient == nil || mongoClient == nil {
		return nil, nil, fmt.Errorf("api-go: dashboard assembly requires mysql, jwt, redis, and mongo")
	}

	// GET /api/dashboard/stats. Read-only MySQL/Mongo/Redis; starts no queue
	// worker. The War Map and spacetime units reuse the same Mongo client.
	statsHandler := dashboardstats.Connect(authenticator, db, redisClient, mongoClient)
	statsCORS := cors.New(cfg.CorsOrigin)
	gateway.Handle(dashboardstats.Path, func(w http.ResponseWriter, r *http.Request) {
		if statsCORS.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		statsHandler.ServeHTTP(w, r)
	})
	log.Printf("api-go: GET /api/dashboard/stats under go takeover")

	// The three chart GETs. Heatmap and candlestick read MySQL economic series;
	// GeoJSON is compiled into the binary. No Mongo, no NestJS. The stream handler
	// also reuses chartsHandler.ReadForStream.
	chartsHandler := dashboardcharts.NewHandler(authenticator, dashboardcharts.NewMySQLStore(db))
	chartsCORS := cors.New(cfg.CorsOrigin)
	for _, path := range dashboardcharts.Paths {
		gateway.Handle(path, func(w http.ResponseWriter, r *http.Request) {
			if chartsCORS.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			chartsHandler.ServeHTTP(w, r)
		})
	}
	log.Printf("api-go: dashboard chart GETs under go takeover")

	// war map: events/news-markers, transport-detail, layers.
	warHandler := dashboardwarmap.NewHandler(authenticator, db, redisClient, mongoClient.Database(), dashboardwarmap.Runtime{
		NominatimBaseURL:        cfg.NominatimBaseURL,
		NominatimUserAgent:      cfg.NominatimUserAgent,
		NominatimEmail:          cfg.NominatimEmail,
		NominatimAcceptLanguage: cfg.NominatimAcceptLanguage,
		GeocodeTimeout:          time.Duration(cfg.GeocodeTimeoutMs) * time.Millisecond,
		GeocodeCacheTTL:         time.Duration(cfg.GeocodeCacheTTLSeconds) * time.Second,
		GeocodeNegativeTTL:      time.Duration(cfg.GeocodeNegativeTTLSeconds) * time.Second,
		GeocodeRatePerSecond:    cfg.GeocodeRatePerSecond,
		TranslationEnabled:      cfg.TranslationAPIEnabled,
		TranslationBaseURL:      cfg.TranslationAPIBaseURL,
		TranslationTimeout:      time.Duration(cfg.TranslationTimeoutMs) * time.Millisecond,
		TranslationMaxRetries:   cfg.TranslationMaxRetries,
		TranslationFallback:     cfg.TranslationFallbackEnabled,
		TranslationFallbackURL:  cfg.TranslationFallbackBaseURL,
		SettingsEncryptionKey:   cfg.SettingsEncryptionKey,
		SignalsEnabled:          cfg.RealtimeSignalsEnabled,
		SignalsTimeoutMs:        cfg.RealtimeSignalsTimeoutMs,
		OpenskyEnabled:          cfg.OpenskyEnabled,
		OpenskyDailyBudget:      cfg.OpenskyDailyCreditBudget,
		OpenskyDayIntervalSec:   cfg.OpenskyDayIntervalSec,
		OpenskyNightIntervalSec: cfg.OpenskyNightIntervalSec,
		OpenskyDayStartHour:     cfg.OpenskyDayStartHourHKT,
		OpenskyNightStartHour:   cfg.OpenskyNightStartHourHKT,
		OpenskyWarningPct:       cfg.OpenskyWarningRemainingPct,
		OpenskyCriticalPct:      cfg.OpenskyCriticalRemainingPct,
		OpenskyBaseURL:          cfg.OpenskyBaseURL,
		OpenskyTokenURL:         cfg.OpenskyTokenURL,
		OpenskyClientID:         cfg.OpenskyClientID,
		OpenskyClientSecret:     cfg.OpenskyClientSecret,
	})
	warCORS := cors.New(cfg.CorsOrigin)
	registerWar := func(path string) {
		gateway.Handle(path, func(w http.ResponseWriter, r *http.Request) {
			if warCORS.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			warHandler.ServeHTTP(w, r)
		})
	}
	for _, path := range dashboardwarmap.Paths {
		registerWar(path)
	}
	registerWar(dashboardwarmap.TransportPath)
	registerWar(dashboardwarmap.LayersPath)
	log.Printf("api-go: war map events, news-markers, transport-detail and layers under go takeover")

	// spacetime heatmap and propagation.
	spacetimeHandler := dashboardspacetime.NewHandler(authenticator, db, redisClient, mongoClient.Database(), dashboardwarmap.PlaceConfig{
		BaseURL:        cfg.NominatimBaseURL,
		UserAgent:      cfg.NominatimUserAgent,
		Email:          cfg.NominatimEmail,
		AcceptLanguage: cfg.NominatimAcceptLanguage,
		Timeout:        time.Duration(cfg.GeocodeTimeoutMs) * time.Millisecond,
		CacheTTL:       time.Duration(cfg.GeocodeCacheTTLSeconds) * time.Second,
		NegativeTTL:    time.Duration(cfg.GeocodeNegativeTTLSeconds) * time.Second,
		RatePerSecond:  cfg.GeocodeRatePerSecond,
	})
	spacetimeCORS := cors.New(cfg.CorsOrigin)
	registerSpacetime := func(path string) {
		gateway.Handle(path, func(w http.ResponseWriter, r *http.Request) {
			if spacetimeCORS.FinishOptions(w, r) {
				return
			}
			if r.Method == http.MethodOptions {
				gateway.Reject(w, r)
				return
			}
			spacetimeHandler.ServeHTTP(w, r)
		})
	}
	for _, path := range dashboardspacetime.GeoPaths {
		registerSpacetime(path)
	}
	for _, path := range dashboardspacetime.PropagationPaths {
		registerSpacetime(path)
	}
	log.Printf("api-go: spacetime heatmap and propagation under go takeover")

	// SSE stream reuses the same three services.
	streamCORS := cors.New(cfg.CorsOrigin)
	streamHandler := dashboardstream.NewHandler(authenticator, warHandler, chartsHandler, spacetimeHandler, streamCORS)
	gateway.Handle(dashboardstream.Path, func(w http.ResponseWriter, r *http.Request) {
		if streamCORS.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		streamHandler.ServeHTTP(w, r)
	})
	log.Printf("api-go: GET /api/dashboard/stream under go takeover")

	// Authenticated healthz. Probes run per request, never at startup.
	readyHandler := health.NewReadyHandler(authenticator, health.Deps{
		DB:           db,
		Redis:        redisClient,
		Mongo:        mongoClient.Database(),
		MongoURI:     cfg.MongoURI,
		CrawlBase:    cfg.CrawlBaseURL,
		CrawlKey:     cfg.CrawlAPIKey,
		CrawlTimeout: time.Duration(cfg.CrawlTimeoutMs) * time.Millisecond,
		CrawlTTL:     time.Duration(cfg.CrawlHealthTTLMs) * time.Millisecond,
		ProxyURL:     cfg.CrawlSSRFProxyURL,
		RerankNeed:   cfg.ItemsSearchRerankEnabled,
	})
	gateway.Handle(health.ReadyPath, readyHandler.ServeHTTP)
	log.Printf("api-go: GET /api/healthz under go takeover")

	return streamHandler, readyHandler, nil
}
