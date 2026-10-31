package main

import (
	"database/sql"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker"
	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/providers"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

// wireAlertWorker builds the alerts-queue consumer when
// API_GO_ALERT_WORKER_MODE=go. It registers no HTTP route and needs no JWT: the
// worker reads MySQL, Redis and Mongo, sends through the real SMTP transport and
// publishes the alertEvents / alert notification bridges on the shared Redis
// client.
//
// The returned service is started by main and closed before the shared Redis and
// Mongo connections are closed.
func wireAlertWorker(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	graphqlMongo **dashboardstats.Connection,
	dashboardMongo **dashboardstats.Connection,
) (*alertworker.Service, error) {
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_ALERT_WORKER_MODE=go requires mysql and redis")
	}
	if cfg.MongoURI == "" {
		return nil, fmt.Errorf("api-go: API_GO_ALERT_WORKER_MODE=go requires a valid MONGO_URI")
	}
	mongoConnection := *graphqlMongo
	if mongoConnection == nil {
		mongoConnection = *dashboardMongo
	}
	if mongoConnection == nil {
		opened, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: API_GO_ALERT_WORKER_MODE=go requires a valid MONGO_URI: %w", err)
		}
		*graphqlMongo = opened
		mongoConnection = opened
	}

	mail := authlogin.NewMailSender(authlogin.SMTPConfig{
		Host:                  cfg.SMTP.Host,
		Port:                  cfg.SMTP.Port,
		Secure:                cfg.SMTP.Secure,
		User:                  cfg.SMTP.User,
		Pass:                  cfg.SMTP.Pass,
		From:                  cfg.SMTP.From,
		Pool:                  cfg.SMTP.Pool,
		ConnectionTimeoutMs:   cfg.SMTP.ConnectionTimeoutMs,
		GreetingTimeoutMs:     cfg.SMTP.GreetingTimeoutMs,
		SocketTimeoutMs:       cfg.SMTP.SocketTimeoutMs,
		TLSRejectUnauthorized: cfg.SMTP.TLSRejectUnauthorized,
	})

	// The model service is optional: a disabled service, a missing token or an
	// unparsable environment value leaves the economic anomaly provider on its
	// local fallback instead of blocking startup.
	forecastConfig := forecastClientConfigFromEnv(cfg)
	forecast := providers.NewForecastHTTPClient(forecastConfig, nil)

	service, err := alertworker.New(alertworker.Options{
		DB:       db,
		Redis:    redisClient,
		Mongo:    mongoConnection.Database(),
		Mail:     mail,
		Forecast: forecast,
		Config: alertworker.Config{
			QueueConcurrency:     cfg.AlertQueueConcurrency,
			WebhookTimeoutMs:     cfg.AlertWebhookTimeoutMs,
			ScanIntervalMs:       cfg.AlertScanIntervalMs,
			NotifyGlobalPerSec:   cfg.AlertNotifyGlobalPerSec,
			NotifyEmailPerSec:    cfg.AlertNotifyEmailPerSec,
			NotifyWebhookPerSec:  cfg.AlertNotifyWebhookPerSec,
			NotifyPerChannelPSec: cfg.AlertNotifyPerChannelPSec,
			NotifyLimiterTTLMs:   cfg.AlertNotifyLimiterTTLMs,
			BullMQNamespace:      cfg.BullMQNamespace,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: alert worker: %w", err)
	}
	log.Printf("api-go: alert worker enabled mode=%s (concurrency=%d, scan interval=%dms, forecast enabled=%t)",
		"go", cfg.AlertQueueConcurrency, cfg.AlertScanIntervalMs, forecastConfig.Enabled)
	return service, nil
}

// forecastClientConfigFromEnv resolves the MODEL_SERVICE_* raw values with the
// JavaScript env semantics modelaccesssettings already implements. An invalid
// value disables the client instead of failing startup, because the model
// service is not part of the alerts contract.
func forecastClientConfigFromEnv(cfg config.Config) providers.ForecastHTTPConfig {
	parsed, err := modelaccesssettings.NewConfigFromEnv(modelaccesssettings.EnvInput{
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
		log.Printf("api-go: alert worker model service config ignored: %v", err)
		return providers.ForecastHTTPConfig{}
	}
	return providers.ForecastHTTPConfig{
		Enabled:       parsed.ModelServiceEnabled,
		BaseURL:       parsed.ModelServiceBaseURL,
		InternalToken: parsed.ModelServiceInternalToken,
		TimeoutMs:     parsed.ModelServiceTimeoutMs,
		MaxRetries:    parsed.ModelServiceMaxRetries,
	}
}
