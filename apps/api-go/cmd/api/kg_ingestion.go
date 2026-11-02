package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/kgingestion"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// kgIngestionRuntime is the wired scheduler plus the Mongo connection this wire
// helper opened when no other subsystem had one. Close owns both.
type kgIngestionRuntime struct {
	scheduler *kgingestion.Scheduler
	mongo     *dashboardstats.Connection
}

// Close stops the scheduler, waits for in-flight organizations and releases a
// connection this helper opened. A timed-out organization lock is left to
// expire naturally.
func (r *kgIngestionRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	var first error
	if r.scheduler != nil {
		if err := r.scheduler.Close(ctx); err != nil {
			first = err
		}
	}
	if r.mongo != nil {
		if err := r.mongo.Disconnect(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// wireKGIngestion builds the knowledge-graph ingestion scheduler when
// API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go. It registers no HTTP route and
// needs no JWT. The model completer reuses the public portal gateway profiles;
// LLM request logs reuse the existing llmlogs writer and stay best effort when
// Mongo is unavailable.
//
// mongoDatabase is an already-open shared connection (a dashboard/graphql
// subsystem may have one). When it is nil and MONGO_URI is set, this helper
// opens its own connection and owns it.
func wireKGIngestion(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
) (*kgIngestionRuntime, error) {
	if db == nil {
		return nil, fmt.Errorf("api-go: API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go requires mysql")
	}
	if redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE=go requires redis")
	}

	runtime := &kgIngestionRuntime{}
	if mongoDatabase == nil && cfg.MongoURI != "" {
		opened, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			// The request log is best effort; an invalid MONGO_URI must not
			// block the graph writes.
			log.Printf("api-go: knowledge graph LLM request logs disabled: invalid MONGO_URI")
		} else {
			runtime.mongo = opened
			mongoDatabase = opened.Database()
		}
	}

	logger := log.Default()
	completer := publicportal.NewKGCompleter(publicportal.NewMySQLStore(db), publicportal.GatewayEnv{
		EncryptionKey: cfg.SettingsEncryptionKey,
		APIBase:       cfg.LiteLLMAPIBase,
		APIKey:        cfg.LiteLLMAPIKey,
		TimeoutMs:     cfg.LiteLLMTimeoutMs,
		MaxRetries:    cfg.LiteLLMMaxRetries,
		TopP:          cfg.LLMGatewayTopP,
	})
	var observer publicportal.KGCompletionObserver
	if mongoDatabase != nil {
		observer = kgIngestionAttemptObserver{writer: llmlogs.NewKGCompletionWriter(db, mongoDatabase)}
	} else {
		log.Printf("api-go: knowledge graph LLM request logs disabled because mongo is not configured")
	}

	service := kgingestion.NewService(kgingestion.ServiceOptions{
		Store:    kgingestion.NewStore(db, nil),
		Settings: kgingestion.NewSettingsProvider(db, redisClient, logger),
		Failures: kgingestion.NewRedisFailureCounter(redisClient),
		Quality:  kgingestion.NewQuality(completer, observer, nil, logger),
		Graph:    kgingestion.NewGraphWriter(db, nil),
		Linker:   kgingestion.NewLinker(db, completer, observer, nil, logger),
		Logger:   logger,
	})
	runtime.scheduler = kgingestion.NewScheduler(kgingestion.SchedulerOptions{
		Repository: kgingestion.NewStore(db, nil),
		Store:      kgingestion.NewRedisStore(redisClient),
		Settings:   runtimesettings.NewService(db, redisClient, runtimesettings.Config{}),
		Processor:  service,
		Logger:     logger,
	})
	return runtime, nil
}

// sharedKGIngestionMongo returns the first already-open Mongo database, so the
// ingestion LLM request log reuses the shared connection instead of opening a
// second client.
func sharedKGIngestionMongo(connections ...*dashboardstats.Connection) *mongo.Database {
	for _, connection := range connections {
		if connection == nil {
			continue
		}
		if database := connection.Database(); database != nil {
			return database
		}
	}
	return nil
}

// kgIngestionAttemptObserver writes one llmrequestlogs row per real model
// attempt. A write failure is best effort and never fails the graph write.
type kgIngestionAttemptObserver struct {
	writer *llmlogs.KGCompletionWriter
}

// ObserveKGCompletionAttempt implements publicportal.KGCompletionObserver.
func (o kgIngestionAttemptObserver) ObserveKGCompletionAttempt(ctx context.Context, attempt publicportal.KGCompletionAttempt) {
	if o.writer == nil {
		return
	}
	status := "error"
	if attempt.Success {
		status = "success"
	}
	errorText := ""
	if attempt.Err != nil {
		errorText = attempt.Err.Error()
	}
	governanceApplied := attempt.GovernanceApplied
	entry := llmlogs.KGCompletionLogEntry{
		OrgID:   attempt.OrgID,
		Model:   attempt.Model,
		Status:  status,
		Error:   errorText,
		Latency: attempt.Latency,
		Usage: llmlogs.CompletionUsage{
			PromptTokens:     attempt.Usage.PromptTokens,
			CompletionTokens: attempt.Usage.CompletionTokens,
			TotalTokens:      attempt.Usage.TotalTokens,
			CostUSD:          attempt.Usage.CostUSD,
		},
		APISurface:                attempt.APISurface,
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         &governanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		Metadata: &llmlogs.KGCompletionMetadata{
			Task:      attempt.Metadata.Task,
			OrgID:     attempt.Metadata.OrgID,
			ArticleID: attempt.Metadata.ArticleID,
		},
	}
	if err := o.writer.WriteAttempt(ctx, entry); err != nil {
		log.Printf("api-go: knowledge graph LLM request log write failed")
	}
}
