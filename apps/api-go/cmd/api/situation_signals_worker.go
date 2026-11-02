package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings"
	"github.com/wei500L/newwei/apps/api-go/internal/situationsignalsworker"
	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// situationSignalsWorkerRuntime owns the migrated situation-monitor signals
// worker when API_GO_SITUATION_SIGNALS_WORKER_MODE=go: the repeat-schedule
// registration, the BullMQ consumer for situationMonitorSignals, the
// Telegram/OREF polls, the single-instance MTProto lease and the
// situation-monitor:signals:events:v1 realtime bridge.
//
// The runtime starts nothing while the switch is legacy, so the default
// deployment keeps the NestJS Worker and its repeat schedules untouched.
type situationSignalsWorkerRuntime struct {
	service *situationsignalsworker.Service
	queue   *situationsignalsworker.QueueWorker
	manager *telegramclient.Manager
	redis   *redis.Client
	sched   situationsignalsworker.RepeatablesConfig

	cancel context.CancelFunc
	done   chan struct{}
}

// wireSituationSignalsWorker builds the runtime when the switch is go. It
// validates the shared dependencies (MySQL for the settings row and the default
// OREF alert rules, Redis for the queue, cached state, lease and bridge) and
// returns nil in legacy mode. Nothing is claimed and no MTProto connection is
// dialed before Start.
func wireSituationSignalsWorker(cfg config.Config, db *sql.DB, redisClient *redis.Client) (*situationSignalsWorkerRuntime, error) {
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: API_GO_SITUATION_SIGNALS_WORKER_MODE=go requires mysql and redis")
	}

	settings := situationsettings.NewService(situationsettings.Options{
		DB:    db,
		Redis: redisClient,
		Env:   situationsettings.NewEnvFromLookup(os.LookupEnv),
	})
	env := situationsignalsworker.NewEnvFromLookup(os.LookupEnv)
	manager := telegramclient.NewManager(redisClient, telegramclient.DefaultLeaseKey, telegramclient.DefaultLeaseTTL)

	service, err := situationsignalsworker.New(situationsignalsworker.Options{
		DB:       db,
		Redis:    redisClient,
		Settings: settings,
		Telegram: manager,
		Alerts:   alertqueue.New(redisClient),
		Env:      env,
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: situation signals worker: %w", err)
	}
	queue, err := situationsignalsworker.NewQueueWorker(redisClient)
	if err != nil {
		return nil, fmt.Errorf("api-go: situation signals queue worker: %w", err)
	}

	return &situationSignalsWorkerRuntime{
		service: service,
		queue:   queue,
		manager: manager,
		redis:   redisClient,
		sched:   resolveSituationRepeatables(context.Background(), settings, env),
		done:    make(chan struct{}),
	}, nil
}

// resolveSituationRepeatables mirrors the NestJS processor's
// resolveTelegramPollSchedulerConfig: the stored settings win and an
// unreadable settings row falls back to the environment. The OREF interval is
// the same env clamp (300_000 default, 30_000 minimum).
func resolveSituationRepeatables(ctx context.Context, settings *situationsettings.Service, env situationsignalsworker.Env) situationsignalsworker.RepeatablesConfig {
	telegramEnabled := env.TelegramEnabled
	telegramInterval := env.TelegramPollIntervalMS
	if effective, err := settings.EffectiveSettings(ctx); err != nil {
		log.Printf("api-go: situation signals worker: read telegram settings, using env fallback: %v", err)
	} else {
		telegramEnabled = effective.TelegramEnabled
		telegramInterval = effective.TelegramPollIntervalMS
	}
	if telegramInterval < 15_000 {
		telegramInterval = 15_000
	}
	orefInterval := env.OrefPollIntervalMS
	if orefInterval < 30_000 {
		orefInterval = 30_000
	}
	return situationsignalsworker.RepeatablesConfig{
		TelegramEnabled:    telegramEnabled,
		TelegramIntervalMS: telegramInterval,
		OrefIntervalMS:     orefInterval,
	}
}

// Start registers the repeat schedules before claiming any job and then runs
// the clear-broadcast subscriber and the queue consumer. Registering the
// schedules first means a flip from the NestJS owner never leaves two
// schedulers or a scheduler behind a running consumer.
func (r *situationSignalsWorkerRuntime) Start(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if err := situationsignalsworker.EnsureRepeatables(ctx, r.redis, r.sched); err != nil {
		// Nothing was started, so close the done channel: the deferred Close in
		// main must not wait for loops that will never run.
		close(r.done)
		return fmt.Errorf("api-go: situation signals repeatables: %w", err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := r.service.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("api-go: situation signals clear subscriber stopped: %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		r.queue.Run(runCtx, r.service.HandleJob)
	}()
	go func() {
		wg.Wait()
		close(r.done)
	}()
	log.Printf("api-go: situation signals worker enabled mode=%s (telegram=%t interval=%dms orefInterval=%dms)",
		"go", r.sched.TelegramEnabled, r.sched.TelegramIntervalMS, r.sched.OrefIntervalMS)
	return nil
}

// Close stops claiming, waits for the two loops, then disconnects the leased
// MTProto session and releases the Redis lease while the shared client is still
// open. It is safe to call when Start failed.
func (r *situationSignalsWorkerRuntime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if r.cancel != nil {
		r.cancel()
	}
	select {
	case <-r.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	r.queue.Close()
	r.service.Close()
	r.manager.Close()
	return nil
}
