package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// wireAssistantRuns builds the assistant run service shared by the four write
// mutations and the BullMQ worker. Only the components the enabled switches
// need are constructed; Mongo is opened by main before this call.
func wireAssistantRuns(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoConn *dashboardstats.Connection,
) (*assistantruns.Service, error) {
	if db == nil || redisClient == nil || mongoConn == nil {
		return nil, fmt.Errorf("api-go: assistant requires mysql, redis, and mongo")
	}
	settingsConfig, err := modelaccesssettings.NewConfigFromEnv(modelaccesssettings.EnvInput{
		DatabaseURL:                   cfg.DatabaseURL,
		ModelServiceEnabledRaw:        cfg.ModelServiceEnabledRaw,
		ModelServiceBaseURLRaw:        cfg.ModelServiceBaseURLRaw,
		ModelServiceInternalTokenRaw:  cfg.ModelServiceInternalTokenRaw,
		ModelServiceTimeoutMsRaw:      cfg.ModelServiceTimeoutMsRaw,
		ModelServiceMaxRetriesRaw:     cfg.ModelServiceMaxRetriesRaw,
		LiteLLMConfigInternalTokenRaw: cfg.LiteLLMConfigInternalTokenRaw,
		SettingsEncryptionKeyRaw:      cfg.SystemSettingsEncryptionKeyRaw,
		NodeEnvRaw:                    cfg.NodeEnvRaw,
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: assistant model access environment is invalid: %w", err)
	}
	modelAccess := modelaccesssettings.NewService(db, redisClient, settingsConfig)
	governance := platformgovernance.NewService(db, redisClient, mongoConn.Database(), platformgovernance.Env{
		AssistantGuardrailsEnabled:     cfg.PlatformGovernanceAssistantGuardrailsEnabled,
		AssistantGuardrails:            cfg.PlatformGovernanceAssistantGuardrailsRaw,
		AssistantOrgSubmitLimitPerHour: cfg.PlatformGovernanceAssistantOrgSubmitLimitPerHour,
		AssistantOrgMaxInFlight:        cfg.PlatformGovernanceAssistantOrgMaxInFlight,
		AssistantOrgMonthlyTokenBudget: cfg.PlatformGovernanceAssistantOrgMonthlyTokenBudget,
		TaskLogRetentionDays:           cfg.PlatformGovernanceTaskLogRetentionDays,
		EncryptionKeyRaw:               cfg.PlatformGovernanceEncryptionKeyRaw,
	})
	items := itemsreading.NewService(itemsreading.Options{
		DB:                    db,
		Mongo:                 mongoConn.Database(),
		Redis:                 redisClient,
		ReadModelEnabled:      cfg.ItemsReadModelEnabled,
		VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
	})
	llm := publicportal.NewAssistantLLM(publicportal.NewMySQLStore(db), publicportal.AssistantGatewayEnv{
		GatewayEnv: publicportal.GatewayEnv{
			EncryptionKey: cfg.SettingsEncryptionKey,
			APIBase:       cfg.LiteLLMAPIBase,
			APIKey:        cfg.LiteLLMAPIKey,
			TimeoutMs:     cfg.LiteLLMTimeoutMs,
			MaxRetries:    cfg.LiteLLMMaxRetries,
			TopP:          cfg.LLMGatewayTopP,
		},
		Temperature:     cfg.LLMGatewayTemperature,
		MaxOutputTokens: cfg.LLMGatewayMaxOutputTokens,
	})
	return assistantruns.NewService(assistantruns.Options{
		Store:        assistantruns.NewStore(mongoConn.Database()),
		Queue:        assistantqueue.NewProducer(redisClient),
		Redis:        redisClient,
		LLM:          llm,
		Items:        items,
		Series:       assistantruns.NewSeriesReader(db),
		Capabilities: assistantruns.NewCapabilityReader(db, redisClient),
		Governance:   governance,
		ModelAccess:  modelAccess,
		Forecaster:   assistantruns.NewModelServiceClient(modelAccess),
		Publisher:    assistantruns.NewRedisPublisher(redisClient),
		Observer:     assistantruns.NewLLMLogObserver(llmlogs.NewCompletionWriter(db, mongoConn.Database())),
		Env: assistantruns.Env{
			QueueConcurrency: cfg.AssistantQueueConcurrency,
			MaxRetries:       cfg.AssistantMaxRetries,
			LLMTimeout:       time.Duration(cfg.AssistantLLMTimeoutMs) * time.Millisecond,
			StreamFlushChars: cfg.AssistantStreamFlushChars,
			StreamFlushMs:    cfg.AssistantStreamFlushMs,
		},
	}), nil
}

// startAssistantWorker starts the BullMQ consumer when the worker switch is go.
// Returning nil leaves the queue to the NestJS AssistantProcessor.
func startAssistantWorker(cfg config.Config, service *assistantruns.Service, redisClient *redis.Client) *assistantqueue.Worker {
	if cfg.AssistantWorkerMode != "go" {
		return nil
	}
	if service == nil || redisClient == nil {
		log.Printf("api-go: assistant worker not started (service or redis is missing)")
		return nil
	}
	worker := assistantqueue.NewWorker(redisClient, assistantqueue.DefaultWorkerConfig(cfg.AssistantQueueConcurrency), service.Process)
	worker.Start(context.Background())
	log.Printf("api-go: assistant worker started (queue=assistant, concurrency=%d)", cfg.AssistantQueueConcurrency)
	return worker
}
