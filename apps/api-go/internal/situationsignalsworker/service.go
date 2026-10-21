package situationsignalsworker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/situationsettings"
	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// clearBroadcastVersion is the only accepted version of the clear broadcast.
const clearBroadcastVersion = 1

// SettingsProvider is the effective situation-monitor settings reader
// (situationsettings.Service implements it).
type SettingsProvider interface {
	EffectiveSettings(ctx context.Context) (situationsettings.EffectiveSettings, error)
}

// TelegramOwner is the Telegram connection owner (telegramclient.Manager
// implements it).
//
// WithLease runs fn only on the process that owns the single-instance Redis
// lease and keeps the long-lived client; a process without the lease must not
// dial. Disconnect releases the lease and drops the connection but leaves the
// owner reusable, which is what the Telegram clear broadcast needs. Close is
// the final process-shutdown hook.
type TelegramOwner interface {
	WithLease(ctx context.Context, cfg telegramclient.Options, fingerprint string, fn func(ctx context.Context, client telegramclient.PollClient) error) (owned bool, err error)
	Disconnect(ctx context.Context) error
	Close()
}

// AlertEnqueuer enqueues one alert-rule evaluation
// (alertqueue.Producer.EnqueueRuleCheck implements it).
type AlertEnqueuer interface {
	EnqueueRuleCheck(ctx context.Context, ruleID, orgID, traceID string) error
}

// Options is the worker dependency set. Every field except Redis is optional
// only in the sense that New validates what the enabled pollers need.
type Options struct {
	// DB is the shared MySQL handle, used for the OREF default alert rules.
	DB *sql.DB
	// Redis is the shared go-redis client (state cache, OREF lock, pub/sub,
	// event bridge). Required.
	Redis *redis.Client
	// Settings resolves the effective Telegram runtime configuration.
	// Required.
	Settings SettingsProvider
	// Telegram owns the MTProto connection and the single-instance lease.
	// Required.
	Telegram TelegramOwner
	// Oref, when non-nil, is used verbatim for OREF HTTP requests (tests inject
	// an httptest server client). Production leaves it nil and the worker builds
	// a proxied client per poll.
	Oref *http.Client
	// Alerts enqueues OREF alert-rule evaluations. Optional.
	Alerts AlertEnqueuer
	// Dispatcher publishes realtime events. When nil, a Redis publisher on
	// Redis is used.
	Dispatcher EventPublisher
	// Env is the environment-derived configuration (see NewEnvFromLookup).
	Env Env
	// Logger defaults to log.Printf. Never pass secrets through it.
	Logger func(format string, args ...any)
}

// Service is the situation-monitor signals worker.
//
// B1: the Telegram and OREF state fields below are a per-job scratch buffer.
// They are rebuilt from the Redis documents at the start of every job and the
// process never treats them as authoritative between jobs.
type Service struct {
	db       *sql.DB
	redis    *redis.Client
	store    stateStore
	locker   cycleLocker
	settings SettingsProvider
	telegram TelegramOwner
	alerts   AlertEnqueuer
	eventBus EventPublisher
	// pollBus hands a Telegram cycle to the process that owns the single-instance
	// lease (B2). Nil keeps the historical "skip on a foreign lease" behavior; the
	// production constructor always wires the Redis transport.
	pollBus  pollHandover
	orefHTTP *http.Client
	env      Env
	logger   func(format string, args ...any)
	clock    func() time.Time

	serviceStartedAt time.Time

	// mu guards the Telegram scratch state, the clear-broadcast application and one
	// Telegram poll cycle per process (in addition to the queue's concurrency of
	// one).
	mu sync.Mutex
	// orefMu guards the OREF scratch state. It is a second lock rather than a
	// share of mu so the manual refresh can run the Telegram and OREF cycles
	// concurrently (O1) without the two states interleaving.
	orefMu  sync.Mutex
	closing atomic.Bool

	telegramState               telegramState
	telegramPermanentlyDisabled bool

	orefState                orefState
	orefBootstrapped         bool
	orefEnsureRulesAt        time.Time
	lastOrefAlertRuleCheckAt time.Time

	pubsubMu sync.Mutex
	pubsub   *redis.PubSub
}

// New builds the worker. It validates the dependencies the pollers cannot run
// without; a nil Dispatcher is replaced with the Redis event publisher so the
// production wiring only injects real dependencies.
func New(opts Options) (*Service, error) {
	if opts.Redis == nil {
		return nil, fmt.Errorf("situationsignalsworker: redis client is required")
	}
	if opts.Settings == nil {
		return nil, fmt.Errorf("situationsignalsworker: settings provider is required")
	}
	if opts.Telegram == nil {
		return nil, fmt.Errorf("situationsignalsworker: telegram owner is required")
	}
	dispatcher := opts.Dispatcher
	if dispatcher == nil {
		dispatcher = NewRedisEventPublisher(opts.Redis)
	}
	return newService(serviceDeps{
		db:         opts.DB,
		redis:      opts.Redis,
		store:      redisStateStore{client: opts.Redis},
		locker:     redisCycleLocker{client: opts.Redis},
		settings:   opts.Settings,
		telegram:   opts.Telegram,
		alerts:     opts.Alerts,
		dispatcher: dispatcher,
		handover:   newRedisPollHandover(opts.Redis),
		httpClient: opts.Oref,
		env:        opts.Env,
		logger:     opts.Logger,
		clock:      time.Now,
	}), nil
}

// serviceDeps is the concrete dependency set; the package tests substitute an
// in-memory stateStore and a fake TelegramOwner here instead of going through
// New (which requires a live Redis client).
type serviceDeps struct {
	db         *sql.DB
	redis      *redis.Client
	store      stateStore
	locker     cycleLocker
	settings   SettingsProvider
	telegram   TelegramOwner
	alerts     AlertEnqueuer
	dispatcher EventPublisher
	handover   pollHandover
	httpClient *http.Client
	env        Env
	logger     func(format string, args ...any)
	clock      func() time.Time
}

// newService assembles a Service from already-constructed dependencies.
func newService(deps serviceDeps) *Service {
	env := deps.env.applyDefaults()
	logger := deps.logger
	if logger == nil {
		logger = log.Printf
	}
	clock := deps.clock
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		db:               deps.db,
		redis:            deps.redis,
		store:            deps.store,
		locker:           deps.locker,
		settings:         deps.settings,
		telegram:         deps.telegram,
		alerts:           deps.alerts,
		eventBus:         deps.dispatcher,
		pollBus:          deps.handover,
		orefHTTP:         deps.httpClient,
		env:              env,
		logger:           logger,
		clock:            clock,
		serviceStartedAt: clock(),
		telegramState:    emptyTelegramState(),
		orefState:        emptyOrefState(),
	}
}

// HandleJob is the queue callback: it runs one poll cycle for source.
//
// The cycle is serialized with a local mutex; poll failures are logged and do
// not fail the job (the NestJS processor has the same posture). The OREF cycle
// additionally runs under the Redis lease situation-monitor:signals:oref:poll
// (B1): a process that loses the race skips the cycle entirely.
//
// A Telegram cycle that this process may not run because another instance owns
// the lease is handed over instead of skipped (B2).
func (s *Service) HandleJob(ctx context.Context, source PollSource) error {
	switch source {
	case SourceTelegram:
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closing.Load() {
			return nil
		}
		if _, err := s.pollTelegram(ctx, telegramPollAsync); err != nil {
			s.logf("situationsignalsworker: telegram poll failed: %v", err)
		}
		return nil
	case SourceOref:
		s.orefMu.Lock()
		defer s.orefMu.Unlock()
		if s.closing.Load() {
			return nil
		}
		s.runOrefCycle(ctx)
		return nil
	default:
		return fmt.Errorf("situationsignalsworker: unsupported poll source %q", source)
	}
}

// runOrefCycle runs one OREF poll under the Redis lease.
func (s *Service) runOrefCycle(ctx context.Context) {
	if s.locker == nil {
		s.logf("situationsignalsworker: skipped OREF poll because no Redis locker is configured")
		return
	}
	var pollErr error
	acquired, err := s.locker.WithLock(ctx, orefPollLockKey, orefPollLockTTL, func(lockCtx context.Context) error {
		pollErr = s.pollOref(lockCtx)
		return nil
	})
	if err != nil {
		s.logf("situationsignalsworker: OREF poll lease failed: %v", err)
		return
	}
	if !acquired {
		s.logf("situationsignalsworker: skipped OREF poll because another instance owns the lease")
		return
	}
	if pollErr != nil {
		s.logf("situationsignalsworker: OREF poll failed: %v", pollErr)
	}
}

// Run subscribes to the cross-instance Telegram clear broadcast and the poll
// handover channel (B2) and blocks until ctx is cancelled. The clear broadcast is
// required because the Go worker holds process-local Telegram state: another
// instance (or the settings HTTP route) deleting the shared state must also drop
// this process's connection and scratch state. The handover channel is the one
// way another instance can ask the lease owner to run a Telegram cycle.
//
// OREF alert rule maintenance is not a separate loop: like the NestJS service,
// it runs from the poll cycle (triggerOrefAlertChecks), behind its own tick
// gate and process-local throttles.
func (s *Service) Run(ctx context.Context) error {
	if s.redis == nil {
		return fmt.Errorf("situationsignalsworker: redis client is required to subscribe to the Telegram clear broadcast")
	}
	subscriber := s.redis.Subscribe(ctx, clearBroadcastChannel, telegramPollChannel)
	s.pubsubMu.Lock()
	s.pubsub = subscriber
	s.pubsubMu.Unlock()
	defer func() {
		s.pubsubMu.Lock()
		if s.pubsub == subscriber {
			s.pubsub = nil
		}
		s.pubsubMu.Unlock()
		_ = subscriber.Close()
	}()

	if _, err := subscriber.Receive(ctx); err != nil {
		return fmt.Errorf("situationsignalsworker: subscribe to Telegram clear broadcast: %w", err)
	}
	s.logf("situationsignalsworker: subscribed to %s and %s", clearBroadcastChannel, telegramPollChannel)

	messages := subscriber.Channel()
	for {
		select {
		case <-ctx.Done():
			return nil
		case message, ok := <-messages:
			if !ok {
				return nil
			}
			switch message.Channel {
			case clearBroadcastChannel:
				s.handleClearBroadcast(ctx, message.Payload)
			case telegramPollChannel:
				s.handleTelegramPollRequest(ctx, message.Payload)
			}
		}
	}
}

// clearBroadcastMessage is the clear broadcast wire format.
type clearBroadcastMessage struct {
	Version    int   `json:"version"`
	ClearItems *bool `json:"clearItems"`
}

// handleClearBroadcast parses and applies one clear message. Malformed or
// version-mismatched messages are ignored exactly like the NestJS subscriber.
func (s *Service) handleClearBroadcast(ctx context.Context, payload string) {
	var message clearBroadcastMessage
	if err := json.Unmarshal([]byte(payload), &message); err != nil {
		return
	}
	if message.Version != clearBroadcastVersion || message.ClearItems == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logf("situationsignalsworker: received Telegram clear broadcast clearItems=%t", *message.ClearItems)
	s.clearTelegramState(ctx, *message.ClearItems)
}

// Close releases the clear subscription and the MTProto connection. It is
// idempotent and is the process-shutdown hook.
func (s *Service) Close() {
	if !s.closing.CompareAndSwap(false, true) {
		return
	}
	s.pubsubMu.Lock()
	subscriber := s.pubsub
	s.pubsub = nil
	s.pubsubMu.Unlock()
	if subscriber != nil {
		_ = subscriber.Close()
	}
	if s.telegram != nil {
		s.telegram.Close()
	}
}

// publishEvent marshals and publishes one realtime event. A publish failure is
// logged and never fails the poll (Redis PUBLISH is best effort towards the
// subscribers, like the NestJS dispatcher's listener loop).
func (s *Service) publishEvent(ctx context.Context, eventType RealtimeEventType, payload any) {
	if s.eventBus == nil {
		return
	}
	event, err := newRealtimeEvent(eventType, payload)
	if err != nil {
		s.logf("situationsignalsworker: encode realtime event failed: %v", err)
		return
	}
	if err := s.eventBus.Publish(ctx, event); err != nil {
		s.logf("situationsignalsworker: publish realtime event failed: %v", err)
	}
}

// now reads the service clock.
func (s *Service) now() time.Time {
	if s.clock == nil {
		return time.Now()
	}
	return s.clock()
}

// logf writes one log line through the configured logger.
func (s *Service) logf(format string, args ...any) {
	logger := s.logger
	if logger == nil {
		logger = log.Printf
	}
	logger(format, args...)
}
