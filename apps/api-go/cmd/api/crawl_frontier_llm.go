package main

// This file wires the optional Go owner of the two Frontier LLM BullMQ queues.
// It registers no HTTP route and needs no JWT: the workers read MySQL and Redis
// and call the LiteLLM gateway resolved from the shared gateway profile.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// wireCrawlFrontierLlmWorker builds the two LLM queue consumers when
// API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE=go. The three crawl4ai queues stay on
// NestJS; this unit only claims frontier-llm-judge and frontier-llm-learn.
func wireCrawlFrontierLlmWorker(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	redisOptions *redis.Options,
	mongoDatabase *mongo.Database,
) (*crawlfrontierllm.Runtime, error) {
	if cfg.CrawlFrontierLlmWorkerMode != config.CrawlFrontierLlmWorkerModeGo {
		return nil, nil
	}
	if !cfg.BullMQWorkersEnabled {
		log.Printf("api-go: frontier LLM worker owner is go but BULLMQ_WORKERS_ENABLED=false; no consumer starts")
		return nil, nil
	}
	if db == nil {
		return nil, fmt.Errorf("api-go: API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE=go requires mysql")
	}
	if redisOptions == nil {
		redisOptions = newRedisOptions(cfg)
	}
	var ownedMongo *dashboardstats.Connection
	if mongoDatabase == nil && cfg.MongoURI != "" {
		connection, openErr := dashboardstats.Open(cfg.MongoURI)
		if openErr != nil {
			// The request log is best effort in Nest as well: a Mongo outage
			// must not stop judge/learn processing.
			log.Printf("api-go: frontier LLM request log disabled (invalid MONGO_URI): %v", openErr)
		} else {
			ownedMongo = connection
			mongoDatabase = connection.Database()
		}
	}
	var sink crawlfrontierllm.RequestLogSink
	if mongoDatabase != nil {
		sink = frontierLogSink{writer: llmlogs.NewFrontierWriter(db, mongoDatabase)}
	}
	runtime, err := crawlfrontierllm.NewRuntime(crawlfrontierllm.RuntimeOptions{
		DB:           db,
		Redis:        redisClient,
		RedisOptions: redisOptions,
		Logs:         sink,
		Workflows:    crawlworkflow.NewService(db),
		Mongo:        ownedMongo,
		Env: crawlfrontierllm.LLMGatewayEnv{
			APIBase:       cfg.LiteLLMAPIBase,
			APIKey:        cfg.LiteLLMAPIKey,
			EncryptionKey: cfg.SystemSettingsEncryptionKeyRaw,
			TimeoutMs:     cfg.LiteLLMTimeoutMs,
			MaxRetries:    cfg.LiteLLMMaxRetries,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: frontier LLM worker: %w", err)
	}
	log.Printf("api-go: frontier LLM worker enabled mode=%s (queues=%s,%s concurrency=1 limiter=1/1000ms)",
		cfg.CrawlFrontierLlmWorkerMode, crawlfrontierllm.JudgeQueueName, crawlfrontierllm.LearnQueueName)
	return runtime, nil
}

// frontierLogSink adapts the ordered metadata of one model attempt to the
// llmrequestlogs writer. Nest writes one row per real attempt, including the
// failed ones.
type frontierLogSink struct {
	writer *llmlogs.FrontierWriter
}

func (s frontierLogSink) WriteFrontierLog(ctx context.Context, entry crawlfrontierllm.RequestLogEntry) error {
	metadata := make([]llmlogs.FrontierMetadataEntry, 0)
	if entry.Metadata != nil {
		for _, key := range entry.Metadata.Keys() {
			raw, ok := entry.Metadata.Raw(key)
			if !ok {
				continue
			}
			var text string
			if err := json.Unmarshal(raw, &text); err == nil {
				value := text
				metadata = append(metadata, llmlogs.FrontierMetadataEntry{Key: key, Text: &value})
				continue
			}
			var number float64
			if err := json.Unmarshal(raw, &number); err == nil {
				value := number
				metadata = append(metadata, llmlogs.FrontierMetadataEntry{Key: key, Number: &value})
			}
		}
	}
	var governance *bool
	if entry.GovernanceApplied != nil {
		value := *entry.GovernanceApplied
		governance = &value
	}
	return s.writer.WriteAttempt(ctx, llmlogs.FrontierLogEntry{
		OrgID: entry.OrgID, RequestType: entry.RequestType, Model: entry.Model,
		Status: entry.Status, Error: entry.Error, Latency: entry.Latency,
		Usage: llmlogs.CompletionUsage{
			PromptTokens: entry.Usage.PromptTokens, CompletionTokens: entry.Usage.CompletionTokens,
			TotalTokens: entry.Usage.TotalTokens, CostUSD: entry.Usage.CostUSD,
		},
		Feature: entry.Feature, GatewayProfileID: entry.GatewayProfileID,
		GovernanceApplied: governance, AuthMode: entry.AuthMode,
		GovernanceTargetProfileID: entry.GovernanceTargetProfileID,
		APISurface:                entry.APISurface, Metadata: metadata, OccurredAt: entry.OccurredAt,
	})
}

// frontierMongoDatabase reuses an already-open Mongo connection for the LLM
// request log; nil keeps the log best-effort-off (Nest's logRequest is also
// best effort when Mongo is unavailable).
func frontierMongoDatabase(graphqlConnection, dashboardConnection *dashboardstats.Connection) *mongo.Database {
	if graphqlConnection != nil {
		return graphqlConnection.Database()
	}
	if dashboardConnection != nil {
		return dashboardConnection.Database()
	}
	return nil
}
