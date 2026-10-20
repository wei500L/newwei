package main

import (
	"context"
	"database/sql"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesignals"
)

// realtimeSignalsUnit is the optional Go owner of the realtime signal collection
// cron (RealtimeSignalsService.refreshScheduled). It registers no HTTP route: it
// only starts and stops the minute scheduler.
//
// API_GO_REALTIME_SIGNALS_MODE=go hands the complete tick to this unit, including
// the global all-flight capture. The default (legacy) leaves the NestJS @Cron
// callback and its Redis tick gate untouched. Both owners use the same tick gate
// and organization leases, so a rolling flip still collects at most once per
// interval.
type realtimeSignalsUnit struct {
	service   *realtimesignals.Service
	scheduler *realtimesignals.Scheduler
}

// newRealtimeSignalsUnit builds the collector when
// API_GO_REALTIME_SIGNALS_MODE=go. It returns nil in the legacy default. Config
// validation guarantees MySQL, Redis and Mongo for go mode.
func newRealtimeSignalsUnit(cfg config.Config, db *sql.DB, redisClient *redis.Client, mongoConn *dashboardstats.Connection) *realtimeSignalsUnit {
	if cfg.RealtimeSignalsMode != config.RealtimeSignalsModeGo {
		return nil
	}
	if db == nil || redisClient == nil || mongoConn == nil {
		log.Printf("api-go: realtime signals collector not built (mysql, redis or mongo missing)")
		return nil
	}
	settings := dataruntimesettings.NewService(db, redisClient, dataRuntimeSettingsConfig(cfg))
	service := realtimesignals.NewService(realtimesignals.Options{
		Runtime: settings,
		Redis:   redisClient,
		DB:      db,
		Mongo:   mongoConn.Database(),
		Logger:  log.Default(),
	})
	return &realtimeSignalsUnit{service: service}
}

// Start launches the minute scheduler. It does not replay the minute boundary
// that elapsed before startup.
func (u *realtimeSignalsUnit) Start(cfg config.Config) {
	if u == nil || u.service == nil || cfg.RealtimeSignalsMode != config.RealtimeSignalsModeGo {
		return
	}
	u.scheduler = realtimesignals.NewScheduler(u.service)
	u.scheduler.Start(context.Background())
	log.Printf("api-go: realtime signals collector started (interval=1m)")
}

// Close stops new ticks and drains the in-flight round before the shared
// Redis/MySQL/Mongo handles close. A deadline returns the context error; the
// shared tick gate and org leases then expire on their own.
func (u *realtimeSignalsUnit) Close(ctx context.Context) error {
	if u == nil || u.scheduler == nil {
		return nil
	}
	return u.scheduler.Close(ctx)
}

// dataRuntimeSettingsConfig is the environment-derived settings this unit needs.
// It mirrors EnvService.realtimeSignalsConfig one-for-one; the collector shares
// the same defaults as the data runtime settings HTTP unit so a stored row is
// interpreted identically by both.
func dataRuntimeSettingsConfig(cfg config.Config) dataruntimesettings.Config {
	env := cfg.DataRuntimeSettings
	return dataruntimesettings.Config{
		RealtimeEnabled:                  env.RealtimeEnabled,
		RealtimeRequestTimeoutMs:         env.RealtimeRequestTimeoutMs,
		RealtimeMaxRetries:               env.RealtimeMaxRetries,
		RealtimeOpenskyEnabled:           env.RealtimeOpenskyEnabled,
		RealtimeOpenskyIntervalSec:       env.RealtimeOpenskyIntervalSec,
		RealtimeOpenskyDailyCreditBudget: env.RealtimeOpenskyDailyCreditBudget,
		RealtimeOpenskyDayIntervalSec:    env.RealtimeOpenskyDayIntervalSec,
		RealtimeOpenskyNightIntervalSec:  env.RealtimeOpenskyNightIntervalSec,
		RealtimeOpenskyDayStartHourHKT:   env.RealtimeOpenskyDayStartHourHKT,
		RealtimeOpenskyNightStartHourHKT: env.RealtimeOpenskyNightStartHourHKT,
		RealtimeOpenskyWarningRemaining:  env.RealtimeOpenskyWarningRemaining,
		RealtimeOpenskyCriticalRemaining: env.RealtimeOpenskyCriticalRemaining,
		RealtimeOpenskyBaseURL:           env.RealtimeOpenskyBaseURL,
		RealtimeOpenskyTokenURL:          env.RealtimeOpenskyTokenURL,
		RealtimeOpenskyClientID:          env.RealtimeOpenskyClientID,
		RealtimeOpenskyClientSecret:      env.RealtimeOpenskyClientSecret,
		RealtimeAisEnabled:               env.RealtimeAisEnabled,
		RealtimeAisIntervalSec:           env.RealtimeAisIntervalSec,
		RealtimeUnrestEnabled:            env.RealtimeUnrestEnabled,
		RealtimeUnrestIntervalSec:        env.RealtimeUnrestIntervalSec,
		RealtimeOutagesEnabled:           env.RealtimeOutagesEnabled,
		RealtimeOutagesIntervalSec:       env.RealtimeOutagesIntervalSec,
		RealtimeKeywordSpikeEnabled:      env.RealtimeKeywordSpikeEnabled,
		RealtimeKeywordSpikeIntervalSec:  env.RealtimeKeywordSpikeIntervalSec,
		RealtimePizzintEnabled:           env.RealtimePizzintEnabled,
		RealtimePizzintIntervalSec:       env.RealtimePizzintIntervalSec,
		RealtimeGdeltTensionEnabled:      env.RealtimeGdeltTensionEnabled,
		RealtimeGdeltTensionIntervalSec:  env.RealtimeGdeltTensionIntervalSec,
		RealtimePolymarketLeadsEnabled:   env.RealtimePolymarketLeadsEnabled,
		RealtimePolymarketIntervalSec:    env.RealtimePolymarketIntervalSec,
		RealtimeKeywordSpikeMinCount:     env.RealtimeKeywordSpikeMinCount,
		RealtimeKeywordSpikeMultiplier:   env.RealtimeKeywordSpikeMultiplier,
		RealtimePredictionShiftThreshold: env.RealtimePredictionShiftThreshold,
		RealtimePredictionNewsThreshold:  env.RealtimePredictionNewsThreshold,
		RealtimeAisBaseURL:               env.RealtimeAisBaseURL,
		RealtimeAisSharedSecret:          env.RealtimeAisSharedSecret,
		RealtimeAcledOauthUsername:       env.RealtimeAcledOauthUsername,
		RealtimeAcledOauthPassword:       env.RealtimeAcledOauthPassword,
		RealtimeAcledOauthClientID:       env.RealtimeAcledOauthClientID,
		RealtimeCloudflareAPIToken:       env.RealtimeCloudflareAPIToken,
		RealtimeWingbitsAPIKey:           env.RealtimeWingbitsAPIKey,
		RealtimePolymarketProxyURL:       env.RealtimePolymarketProxyURL,

		EncryptionKeyRaw:     cfg.SettingsEncryptionKeyRaw,
		EncryptionKeyPresent: cfg.SettingsEncryptionKeyPresent,
		NodeEnv:              cfg.NodeEnv,
	}
}
