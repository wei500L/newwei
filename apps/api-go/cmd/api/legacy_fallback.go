package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/exceptioningest"
	"github.com/wei500L/newwei/apps/api-go/internal/nestnotfound"
)

// legacyRejectRecordTimeout bounds one best-effort exception event insert, so a
// slow or unreachable Mongo cannot keep the recorder goroutine alive for long.
const legacyRejectRecordTimeout = 5 * time.Second

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
