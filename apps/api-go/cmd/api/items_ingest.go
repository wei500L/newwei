package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
)

// buildItemsIngestService wires the write service. The same instance serves the
// HTTP POST, the GraphQL mutations, immediate outbox delivery and the
// background replay owner.
func buildItemsIngestService(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
) *itemsingest.Service {
	producer := pipelineenqueue.New(pipelineenqueue.Options{
		Redis: redisClient,
		Mongo: mongoDatabase,
	})
	return itemsingest.NewService(itemsingest.Options{
		DB:       db,
		Mongo:    mongoDatabase,
		Enqueuer: itemPipelineEnqueuer{producer: producer},
		Hydrator: itemsreading.NewHydrator(db, mongoDatabase),
	})
}

// wireRawItemOutboxScheduler starts the replay owner only when the independent
// switch is go and SCHEDULE_ENABLED is not false. Legacy and disabled both
// leave the NestJS Cron (or nothing) as the owner.
func wireRawItemOutboxScheduler(
	cfg config.Config,
	service *itemsingest.Service,
	redisClient *redis.Client,
) *itemsingest.OutboxScheduler {
	if !cfg.ScheduleEnabled {
		return nil
	}
	if service == nil || redisClient == nil {
		return nil
	}
	return itemsingest.NewOutboxScheduler(service, userdigest.NewRedisDeliveryStore(redisClient), nil)
}

// registerItemsIngestHandler registers the POST dispatcher on the shared
// /api/items key. When the items reading switch is go, GET/OPTIONS continue to
// the existing read handler; every other method stays on NestJS.
func registerItemsIngestHandler(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	handler *itemsingest.Handler,
	readHandler *itemsreading.Handler,
) {
	corsPolicy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.ItemsIngestKey, func(w http.ResponseWriter, r *http.Request) {
		if corsPolicy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		if r.Method == http.MethodPost {
			handler.ServeHTTP(w, r)
			return
		}
		if readHandler != nil {
			readHandler.ServeHTTP(w, r)
			return
		}
		gateway.Reject(w, r)
	})
}

// validateItemsIngestResources fails startup instead of silently leaving a nil
// service in front of a go switch.
func validateItemsIngestResources(cfg config.Config, db *sql.DB, redisClient *redis.Client, authenticator *authhttp.Authenticator) error {
	if true && authenticator == nil {
		return fmt.Errorf("api-go: API_GO_ITEMS_INGEST_MODE=go requires the JWT authenticator")
	}
	if (true || true) &&
		(db == nil || redisClient == nil) {
		return fmt.Errorf("api-go: items ingest/outbox go mode requires mysql and redis")
	}
	return nil
}

// itemPipelineEnqueuer adapts the concrete producer to the itemsingest port so
// the write package does not depend on the queue package.
type itemPipelineEnqueuer struct {
	producer *pipelineenqueue.Producer
}

// EnqueueItem forwards the strongly typed enqueue metadata.
func (e itemPipelineEnqueuer) EnqueueItem(
	ctx context.Context,
	orgID, itemMetaID, rawItemID string,
	opts itemsingest.EnqueueOptions,
) (string, error) {
	return e.producer.EnqueueItem(ctx, orgID, itemMetaID, rawItemID, pipelineenqueue.EnqueueOptions{
		Priority:        opts.Priority,
		TraceID:         opts.TraceID,
		PipelineJobID:   opts.PipelineJobID,
		SourceID:        opts.SourceID,
		ProcessedItemID: "",
	})
}
