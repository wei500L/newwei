package main

// Wiring for the Go realtime Socket.IO transport (five namespaces) and the
// classification quality alert scheduler.
//
// The transport owns only the dedicated /socket.io-realtime Engine.IO path.
// Event sources live in internal/realtimeevents: the Socket.IO Redis adapter
// broadcast channel (newsnow), the situation-monitor event bridge and the
// BullMQ queue event streams (queue/ops/quality). The classification scheduler
// is an independent five-minute cron that shares its tick gate and
// per-organization lease with NestJS.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationalert"
	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimeevents"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignals"
)

var (
	// errRealtimeSocketResources mirrors the notifications transport contract:
	// go mode verifies JWTs, re-derives membership in MySQL and reads Redis.
	errRealtimeSocketResources = errors.New("api-go: API_GO_REALTIME_SOCKET_MODE=go requires mysql, jwt, and redis")
	// errClassificationAlertResources documents the scheduler's real stack: the
	// summary reads classification documents from Mongo and the matcher tables
	// from MySQL, while the tick gate and organization leases live in Redis.
	errClassificationAlertResources = errors.New("api-go: API_GO_CLASSIFICATION_QUALITY_ALERT_MODE=go requires mysql, redis, and a valid MONGO_URI")
)

// realtimeSocketUnit groups the five-namespace transport with its event
// sources so main can start them in a fixed order and stop the sources before
// the live sockets during teardown.
type realtimeSocketUnit struct {
	runtime *realtimesocket.Runtime
	sources *realtimeevents.Sources
}

// Start boots the event sources. The transport's Runtime.Start is a no-op; the
// sources are the only background unit.
func (u *realtimeSocketUnit) Start(ctx context.Context) error {
	if u == nil {
		return nil
	}
	if err := u.runtime.Start(ctx); err != nil {
		return err
	}
	return u.sources.Start(ctx, u.runtime)
}

// Close stops every event source, releases the dedicated Redis connections it
// owns and then disconnects the live sockets. The shared Redis/MySQL handles
// stay owned by main.
func (u *realtimeSocketUnit) Close(ctx context.Context) error {
	if u == nil {
		return nil
	}
	var closeErr error
	if err := u.sources.Close(); err != nil {
		closeErr = err
	}
	if err := u.runtime.Close(ctx); err != nil && closeErr == nil {
		closeErr = err
	}
	return closeErr
}

// wireRealtimeSocket builds the transport and its sources.
//
// Mongo is optional here: only the analysis/assistant orgId fallbacks read it
// (the primary path is the BullMQ job data). When MONGO_URI is configured the
// shared dashboard connection is reused or opened once so every unit shares the
// same client.
func wireRealtimeSocket(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	redisOptions *redis.Options,
	mongoConn **dashboardstats.Connection,
) (*realtimeSocketUnit, error) {
	if db == nil || redisClient == nil || redisOptions == nil {
		return nil, errRealtimeSocketResources
	}
	mongoDatabase, err := sharedMongoDatabase(cfg.MongoURI, mongoConn)
	if err != nil {
		return nil, fmt.Errorf("api-go: realtime socket event sources require a valid MONGO_URI: %w", err)
	}

	var augmenter realtimeevents.SituationAugmenter
	if mongoDatabase != nil {
		augmenter = situationsignals.NewRealtimeAugmenter(db, redisClient, mongoDatabase)
	}

	sources, err := realtimeevents.New(realtimeevents.Options{
		Redis:            redisClient,
		RedisOptions:     redisOptions,
		AdapterKey:       cfg.WSRedisAdapterKey,
		DB:               db,
		Mongo:            mongoDatabase,
		Situation:        augmenter,
		NewsnowSourcesGo: cfg.NewsnowSourcesMode == config.NewsnowSourcesModeGo,
		// The browser's active-source list is validated against the same
		// generated source registry the NestJS gateway uses, so an unknown id
		// cannot make the transport track a source that never fetches.
		KnownSource: func(sourceID string) bool {
			_, known := newsnowclusteringops.LookupSourceMetadata(sourceID)
			return known
		},
	})
	if err != nil {
		return nil, err
	}

	runtime, err := realtimesocket.New(realtimesocket.Options{
		DB:                    db,
		Verifier:              authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience),
		Blacklist:             authn.NewRedisBlacklist(redisClient),
		Authz:                 authz.NewMySQLRepository(db),
		Redis:                 redisClient,
		CORS:                  cors.New(cfg.CorsOrigin),
		TrustProxy:            strings.TrimSpace(cfg.TrustProxy) != "",
		MaxConnectionsPerUser: cfg.WSMaxConnectionsPerUser,
		MaxConnectionsPerIP:   cfg.WSMaxConnectionsPerIP,
		ConnectLimitPerIP:     cfg.WSConnectRateLimitPerIP,
		ConnectLimitPerUser:   cfg.WSConnectRateLimitPerUser,
		ConnectWindowSeconds:  cfg.WSConnectRateLimitWindowSeconds,
		ClientEvents:          sources,
	})
	if err != nil {
		return nil, err
	}
	return &realtimeSocketUnit{runtime: runtime, sources: sources}, nil
}

// wireClassificationAlert builds the Go owner of the five-minute classification
// quality alert evaluation. The summary service is the same one the quality
// worker uses, so the notification rows it writes stay identical.
//
// In notification-socket go mode the service also publishes the identifiers-only
// notification:events:v1 relay after a row is committed; that reproduces the
// NestJS NotificationsService.notify go-mode branch and lets the alert reach the
// browser through the Go notifications transport. In legacy mode no relay is
// installed, exactly like the NestJS dispatcher branch.
func wireClassificationAlert(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
) (*classificationalert.Scheduler, error) {
	if db == nil || redisClient == nil {
		return nil, errClassificationAlertResources
	}
	mongoDatabase, err := sharedMongoDatabase(cfg.MongoURI, mongoConn)
	if err != nil {
		return nil, fmt.Errorf("api-go: classification quality alert scheduler requires a valid MONGO_URI: %w", err)
	}
	if mongoDatabase == nil {
		return nil, errClassificationAlertResources
	}
	summary := classificationrssops.NewService(db, mongoDatabase, redisClient)
	if cfg.NotificationsSocketMode == config.NotificationsSocketModeGo {
		summary.SetNotificationRelayPublisher(classificationrssops.NewRedisNotificationRelayPublisher(redisClient))
	}
	return classificationalert.NewScheduler(classificationalert.Options{
		DB:      db,
		Redis:   redisClient,
		Summary: summary,
	})
}

// sharedMongoDatabase returns the process-wide Mongo database, opening it on
// first use when MONGO_URI is configured. An already-open connection is reused
// even when the URI is empty (every opener uses the same cfg.MongoURI); an
// unparsable URI is reported to the caller.
func sharedMongoDatabase(mongoURI string, mongoConn **dashboardstats.Connection) (*mongo.Database, error) {
	if mongoConn != nil && *mongoConn != nil {
		return (*mongoConn).Database(), nil
	}
	if strings.TrimSpace(mongoURI) == "" || mongoConn == nil {
		return nil, nil
	}
	conn, err := dashboardstats.Open(mongoURI)
	if err != nil {
		return nil, err
	}
	*mongoConn = conn
	return (*mongoConn).Database(), nil
}
