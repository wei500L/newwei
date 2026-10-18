package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	rssgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/rsstranslation"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/rsstranslation"
)

// registerGraphQLRssTranslation registers the single translateRssItems mutation
// when API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go. It is independent of every read
// and write switch: only this mutation and its two payload models are added, so
// the old items queries stay on NestJS and no other HTTP surface is opened.
//
// The caller owns the JWT/MySQL/Redis stack and the Mongo connection lifecycle;
// this helper only builds the request-time clients. Provider URLs, keys and the
// encryption key keep their request-time semantics and are never probed here.
func registerGraphQLRssTranslation(
	reg *contract.Registry,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	mongoDatabase *mongo.Database,
) error {
	if cfg.GraphQLRssTranslationMode != "go" {
		return nil
	}
	if reg == nil {
		return fmt.Errorf("api-go: API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go requires a GraphQL registry")
	}
	if db == nil || redisClient == nil {
		return fmt.Errorf("api-go: API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go requires mysql and redis")
	}
	if mongoDatabase == nil {
		return fmt.Errorf("api-go: API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go requires a valid MONGO_URI")
	}

	settings := itemsreading.NewService(itemsreading.Options{DB: db, Redis: redisClient})
	completion := publicportal.NewRssTranslationCompleter(publicportal.NewMySQLStore(db), publicportal.GatewayEnv{
		EncryptionKey: cfg.SettingsEncryptionKey,
		APIBase:       cfg.LiteLLMAPIBase,
		APIKey:        cfg.LiteLLMAPIKey,
		TimeoutMs:     cfg.LiteLLMTimeoutMs,
		MaxRetries:    cfg.LiteLLMMaxRetries,
		TopP:          cfg.LLMGatewayTopP,
	})
	service := rsstranslation.NewService(rsstranslation.Options{
		DB:         db,
		Mongo:      mongoDatabase,
		Redis:      redisClient,
		Settings:   settings,
		Completion: completion,
		Observer:   rssTranslationAttemptObserver{writer: llmlogs.NewRssTranslationWriter(db, mongoDatabase)},
	})
	rssgraphql.Register(reg, service)
	log.Printf("api-go: GraphQL RSS translation registered (translateRssItems; deeplx/llm, outer and inner caches, daily metrics, LLM request logs)")
	return nil
}

// rssTranslationAttemptObserver writes one llmrequestlogs row per real model
// attempt. A write failure is best effort and never fails the translation.
type rssTranslationAttemptObserver struct {
	writer *llmlogs.RssTranslationWriter
}

// ObserveRssTranslationAttempt implements publicportal.RssTranslationObserver.
func (o rssTranslationAttemptObserver) ObserveRssTranslationAttempt(ctx context.Context, attempt publicportal.RssTranslationAttempt) {
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
	entry := llmlogs.RssTranslationLogEntry{
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
		Feature:                   "rss_translation",
		APISurface:                attempt.APISurface,
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         &governanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		Metadata: &llmlogs.RssTranslationMetadata{
			Source:         attempt.Metadata.Source,
			TargetLanguage: attempt.Metadata.TargetLanguage,
		},
		OccurredAt: time.Now(),
	}
	if err := o.writer.WriteAttempt(ctx, entry); err != nil {
		log.Printf("api-go: RSS translation LLM request log write failed")
	}
}
