package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/analysisexport"
	"github.com/wei500L/newwei/apps/api-go/internal/archivepreparation"
	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
)

// wireArchiveReadingHTTP assembles the archive read service and registers the
// exact search export route when API_GO_ARCHIVE_READING_MODE=go. The service is
// returned so the GraphQL registration uses the same caches and model client.
// The three GraphQL roots themselves are registered in main.go because they
// share the single GraphQL handler.
func wireArchiveReadingHTTP(
	gateway *legacyproxy.Gateway,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn **dashboardstats.Connection,
) (*archivereading.Service, error) {
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: archive reading go takeover requires mysql, jwt, and redis")
	}
	if mongoConn == nil || *mongoConn == nil {
		conn, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: archive reading go takeover requires a valid MONGO_URI")
		}
		*mongoConn = conn
	}
	mongoDatabase := (*mongoConn).Database()

	verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	blacklist := authn.NewRedisBlacklist(redisClient)
	authenticator := accountsecurity.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(db), db)

	itemService := itemsreading.NewService(itemsreading.Options{
		DB:                    db,
		Mongo:                 mongoDatabase,
		Redis:                 redisClient,
		ReadModelEnabled:      cfg.ItemsReadModelEnabled,
		VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
		Personalization:       newsbehavior.NewService(db, redisClient),
	})
	itemsExport := analysisexport.NewService(itemService, newsevents.NewExporter(db))

	producer := archivepreparation.NewProducer(redisClient)
	service := archivereading.NewService(archivereading.Options{
		DB:          db,
		Mongo:       mongoDatabase,
		Redis:       archiveReadingRedis{client: redisClient},
		Models:      llmembed.NewClient(db),
		Vector:      itemsreading.NewArchiveVectorClient(),
		Preparation: archivePreparationPort{producer: producer},
		Attempts:    archiveAttemptPort{writer: llmlogs.NewArchiveSearchWriter(db, mongoDatabase)},
	})
	searchService := analysisexport.NewSearchService(itemsExport, service)

	policy := cors.New(cfg.CorsOrigin)
	handler := analysisexport.NewSearchHandler(authenticator, searchService)
	gateway.RegisterGoHandler(legacyproxy.ArchiveReadingSearchKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: archive reading takeover (3 GraphQL queries, POST /api/analysis/exports/search; NestJS keeps the preparation consumer)")
	return service, nil
}

// archiveReadingRedis adapts the shared Redis client to the narrow cache/metric
// port. Every operation is best effort at the caller.
type archiveReadingRedis struct {
	client *redis.Client
}

func (a archiveReadingRedis) Get(ctx context.Context, key string) ([]byte, bool, error) {
	value, err := a.client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

func (a archiveReadingRedis) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return a.client.Set(ctx, key, value, ttl).Err()
}

func (a archiveReadingRedis) IncrBy(ctx context.Context, key, field string, delta int64) error {
	return a.client.HIncrBy(ctx, key, field, delta).Err()
}

func (a archiveReadingRedis) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return a.client.Expire(ctx, key, ttl).Err()
}

// archivePreparationPort adapts the BullMQ producer to the read service.
type archivePreparationPort struct {
	producer *archivepreparation.Producer
}

func (a archivePreparationPort) EnsureDigestCoverage(ctx context.Context, orgID, anchorDate string) error {
	return a.producer.EnsureDigestCoverage(ctx, orgID, anchorDate)
}

func (a archivePreparationPort) EnsureCalendarCoverage(ctx context.Context, orgID, month string) error {
	return a.producer.EnsureCalendarCoverage(ctx, orgID, month)
}

func (a archivePreparationPort) ReadStatus(ctx context.Context, scope, orgID, scopeValue string) (*archivereading.PreparationRecord, error) {
	status, err := a.producer.ReadStatus(ctx, scope, orgID, scopeValue)
	if err != nil || status == nil {
		return nil, err
	}
	return &archivereading.PreparationRecord{
		State:        status.State,
		UpdatedAt:    status.UpdatedAt,
		ErrorMessage: status.ErrorMessage,
	}, nil
}

// archiveAttemptPort adapts the Mongo log writer to the read service.
type archiveAttemptPort struct {
	writer *llmlogs.ArchiveSearchWriter
}

func (a archiveAttemptPort) WriteArchiveAttempt(ctx context.Context, attempt archivereading.ModelAttempt) error {
	return a.writer.WriteArchiveSearchAttempt(ctx, llmlogs.ArchiveSearchEntry{
		OrgID:       attempt.OrgID,
		RequestType: attempt.RequestType,
		Model:       attempt.Model,
		Status:      attempt.Status,
		Error:       attempt.Error,
		Latency:     attempt.Latency,
		Usage: llmlogs.ArchiveSearchUsage{
			PromptTokens:     attempt.Usage.PromptTokens,
			CompletionTokens: attempt.Usage.CompletionTokens,
			TotalTokens:      attempt.Usage.TotalTokens,
			CostUSD:          attempt.Usage.CostUSD,
		},
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         boolPointer(attempt.GovernanceApplied),
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		APISurface:                attempt.APISurface,
		Metadata:                  &llmlogs.ArchiveSearchMetadata{OrgID: attempt.OrgID, Source: attempt.MetadataSource},
		OccurredAt:                attempt.OccurredAt,
	})
}

func boolPointer(value bool) *bool {
	return &value
}
