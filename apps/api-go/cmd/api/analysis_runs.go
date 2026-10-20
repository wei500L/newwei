package main

// This file wires the analysis request Mutations and the optional Go owner of
// the analysis BullMQ consumer. Both switches are independent of the GraphQL
// read and collaboration switches.

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net"
	"strconv"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/analysisqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/analysisruns"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	analysisrunsgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/analysisruns"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// registerAnalysisRunMutations adds the three analysis run Mutations when
// API_GO_ANALYSIS_RUNS_MODE=go. It is independent of API_GO_GRAPHQL_READ_MODE:
// only /graphql and the three roots are added, and the read roots stay on
// NestJS. The producer inserts the pending Mongo document first and then adds
// the BullMQ job; a failed enqueue is returned so the mutation fails.
func registerAnalysisRunMutations(
	reg *contract.Registry,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
) error {
	if cfg.AnalysisRunsMode != config.AnalysisRunsModeGo {
		return nil
	}
	if reg == nil {
		return fmt.Errorf("api-go: API_GO_ANALYSIS_RUNS_MODE=go requires a GraphQL registry")
	}
	if db == nil || redisClient == nil {
		return fmt.Errorf("api-go: API_GO_ANALYSIS_RUNS_MODE=go requires mysql and redis")
	}
	if mongoDatabase == nil {
		return fmt.Errorf("api-go: API_GO_ANALYSIS_RUNS_MODE=go requires a valid MONGO_URI")
	}
	producer, err := analysisqueue.NewProducer(redisClient, analysisqueue.DefaultPrefix, cfg.AnalysisMaxRetries)
	if err != nil {
		return err
	}
	submitter := analysisruns.NewSubmitter(analysisruns.NewStore(mongoDatabase), producer)
	analysisrunsgraphql.Register(reg, submitter)
	log.Printf("api-go: GraphQL analysis run mutations registered (requestCorrelationAnalysis, requestAnomalyExplanation, requestGeoTransportAnalysis)")
	return nil
}

// startAnalysisWorker starts the Go owner of the analysis BullMQ consumer when
// API_GO_ANALYSIS_WORKER_MODE=go and BULLMQ_WORKERS_ENABLED is true.
//
// It needs MySQL (notifications and LLM log metadata policy), Redis (queue,
// GraphQL event bus and notification relay) and Mongo (results, transport
// reads and LLM request logs), but no JWT. If the caller did not already open a
// Mongo connection, the returned connection is owned by this worker and must be
// disconnected by main after Close.
func startAnalysisWorker(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	existingMongo *dashboardstats.Connection,
) (*analysisqueue.Worker, *dashboardstats.Connection, error) {
	if cfg.AnalysisWorkerMode != config.AnalysisWorkerModeGo {
		return nil, nil, nil
	}
	if !cfg.BullMQWorkersEnabled {
		log.Printf("api-go: analysis worker owner is go but BULLMQ_WORKERS_ENABLED=false; no consumer starts")
		return nil, nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, nil, fmt.Errorf("api-go: API_GO_ANALYSIS_WORKER_MODE=go requires mysql and redis")
	}
	var mongoConnection *dashboardstats.Connection
	if existingMongo == nil {
		opened, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, nil, fmt.Errorf("api-go: API_GO_ANALYSIS_WORKER_MODE=go requires a valid MONGO_URI")
		}
		mongoConnection = opened
		existingMongo = opened
	}
	mongoDatabase := existingMongo.Database()

	streamer := publicportal.NewAnalysisStreamer(publicportal.NewMySQLStore(db), publicportal.GatewayEnv{
		EncryptionKey:   cfg.SettingsEncryptionKey,
		APIBase:         cfg.LiteLLMAPIBase,
		APIKey:          cfg.LiteLLMAPIKey,
		TimeoutMs:       cfg.LiteLLMTimeoutMs,
		MaxRetries:      cfg.LiteLLMMaxRetries,
		TopP:            cfg.LLMGatewayTopP,
		Temperature:     cfg.LLMGatewayTemperature,
		MaxOutputTokens: cfg.LLMGatewayMaxOutputTokens,
	})
	handler, err := analysisruns.NewHandler(analysisruns.HandlerOptions{
		Store:         analysisruns.NewStore(mongoDatabase),
		Geo:           analysisruns.NewGeoBuilder(mongoDatabase),
		Streamer:      streamer,
		Prompts:       newAnalysisPromptBuilder(cfg.AnalysisPrompts),
		Events:        analysisruns.NewEventPublisher(redisClient),
		Notifications: analysisruns.NewNotificationWriter(db, redisClient),
		Logs:          llmlogs.NewAnalysisStreamWriter(db, mongoDatabase),
		FlushChars:    cfg.AnalysisStreamFlushChars,
		FlushMs:       cfg.AnalysisStreamFlushMs,
		TimeoutMs:     cfg.AnalysisLLMTimeoutMs,
	})
	if err != nil {
		if mongoConnection != nil {
			_ = mongoConnection.Disconnect(context.Background())
		}
		return nil, nil, err
	}
	blocking := redis.NewClient(&redis.Options{
		Addr:     net.JoinHostPort(cfg.RedisHost, strconv.Itoa(cfg.RedisPort)),
		Username: cfg.RedisUsername,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
		Protocol: 2,
	})
	worker, err := analysisqueue.NewWorker(redisClient, blocking, analysisqueue.WorkerOptions{
		Concurrency: cfg.AnalysisQueueConcurrency,
		Prefix:      analysisqueue.DefaultPrefix,
		Processor:   handler.Handle,
		Logger:      log.Printf,
	})
	if err != nil {
		_ = blocking.Close()
		if mongoConnection != nil {
			_ = mongoConnection.Disconnect(context.Background())
		}
		return nil, nil, err
	}
	if err := worker.Start(context.Background()); err != nil {
		_ = worker.Close(context.Background())
		if mongoConnection != nil {
			_ = mongoConnection.Disconnect(context.Background())
		}
		return nil, nil, err
	}
	log.Printf("api-go: analysis BullMQ worker started (queue=analysis, concurrency=%d, maxStalledCount=%d)", cfg.AnalysisQueueConcurrency, analysisqueue.MaxStalledCount)
	return worker, mongoConnection, nil
}

func newAnalysisPromptBuilder(overrides config.AnalysisPromptOverrides) *analysisruns.PromptBuilder {
	return analysisruns.NewPromptBuilder(analysisruns.PromptOverrides{
		CorrelationSystem:  overrides.CorrelationSystem,
		CorrelationUser:    overrides.CorrelationUser,
		AnomalySystem:      overrides.AnomalySystem,
		AnomalyUser:        overrides.AnomalyUser,
		GeoTransportSystem: overrides.GeoTransportSystem,
		GeoTransportUser:   overrides.GeoTransportUser,
	})
}
