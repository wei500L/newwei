package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/exceptioningest"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// legacyRejectRecordTimeout bounds one best-effort exception event insert, so a
// slow or unreachable Mongo cannot keep the recorder goroutine alive for long.
const legacyRejectRecordTimeout = 5 * time.Second

// wireLegacyFallback installs the cutover C-9 legacy fallback mode on the
// gateway (API_GO_LEGACY_FALLBACK_MODE).
//
// Only reject mode does any work. The default proxy mode — including the empty
// string — returns immediately and must not change the process: rollback has to
// be a pure configuration change. The CORS policy and the exception recorder are
// built by main.go, which also serves the Go /docs 404 (C-7), so both Go-owned
// 404 paths write the same headers and the same exception event.
//
// In reject mode every former NestJS destination answers the NestJS-equivalent
// 404 (internal/nestnotfound) instead of being proxied.
func wireLegacyFallback(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	policy cors.Policy,
	recorder nestnotfound.Recorder,
) error {
	if cfg.LegacyFallbackMode != config.LegacyFallbackModeReject {
		return nil
	}
	if gateway == nil {
		return fmt.Errorf("api-go: legacy fallback reject mode requires a gateway")
	}
	gateway.SetLegacyFallback(string(cfg.LegacyFallbackMode), policy, recorder)
	log.Printf("api-go: legacy fallback mode=%s", cfg.LegacyFallbackMode)
	return nil
}

// newNestNotFoundRecorder returns the asynchronous exception event writer used
// by the Go-owned 404 paths (C-9 reject mode and the C-7 docs routes), or nil
// when Mongo is not configured or cannot be opened. The recorder never blocks
// the HTTP response: it snapshots the event and hands the insert to a goroutine
// with its own bounded context. Mongo insert failures are logged by
// exceptioningest and never reach the response.
func newNestNotFoundRecorder(
	cfg config.Config,
	mongoConn **dashboardstats.Connection,
	redisClient *redis.Client,
) nestnotfound.Recorder {
	if mongoConn == nil {
		log.Printf("api-go: nest-not-found event recording disabled: no Mongo connection handle")
		return nil
	}
	if *mongoConn == nil {
		if cfg.MongoURI == "" {
			log.Printf("api-go: nest-not-found event recording disabled: MONGO_URI is not configured")
			return nil
		}
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			// Best effort: the 404s must keep working even when Mongo is down.
			log.Printf("api-go: nest-not-found event recording disabled: %v", err)
			return nil
		}
		*mongoConn = conn
	}
	service := exceptioningest.NewService((*mongoConn).Database(), redisClient, exceptioningest.Config{
		UserRateLimit:          cfg.ObservabilityClientExceptionUserRateLimit,
		IPRateLimit:            cfg.ObservabilityClientExceptionIPRateLimit,
		RateLimitWindowSeconds: cfg.ObservabilityClientExceptionWindowSeconds,
		TrustProxy:             cfg.TrustProxy,
		InternalToken:          cfg.LiteLLMConfigInternalTokenRaw,
	})
	return func(r *http.Request, traceID, message string) {
		// The event mirrors the NestJS global exception filter's http record for
		// a NotFoundException raised by the unmatched-route handler.
		statusCode := http.StatusNotFound
		event := exceptioningest.ExceptionEvent{
			Kind:       "http",
			TraceID:    traceID,
			Timestamp:  time.Now().UTC(),
			StatusCode: &statusCode,
			Message:    message,
			Path:       r.URL.RequestURI(),
			Method:     r.Method,
			ErrorName:  "NotFoundException",
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), legacyRejectRecordTimeout)
			defer cancel()
			service.RecordInternal(ctx, event)
		}()
	}
}
