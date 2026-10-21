// Package alertworker is the Go owner of the NestJS alerts queue: the scan, the
// rule evaluation, the in-app notification write, the external delivery
// (SMTP + webhook) and the alertEvents / alert notification bridges.
//
// The queue protocol itself lives in internal/alertworker/queue; this package
// holds the business port of apps/api/src/modules/alerts/alerts.service.ts.
//
// Ownership switch: API_GO_ALERT_WORKER_MODE=go makes this package consume the
// `alerts` queue and schedule the scan. In legacy mode (the default) nothing in
// this package starts and the NestJS AlertsProcessor keeps consuming the same
// queue with the same job formats.
package alertworker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/providers"
	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/queue"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
)

// Mailer sends one alert email. authlogin.MailSender satisfies it, so the alert
// worker reuses the shared SMTP implementation instead of opening its own.
type Mailer interface {
	Send(ctx context.Context, message authlogin.MailMessage) error
}

// Config carries the ALERT_* settings the worker needs. The defaults are the
// same ones EnvService.alertingConfig applies.
type Config struct {
	QueueConcurrency     int
	WebhookTimeoutMs     int
	ScanIntervalMs       int64
	NotifyGlobalPerSec   float64
	NotifyEmailPerSec    float64
	NotifyWebhookPerSec  float64
	NotifyPerChannelPSec float64
	NotifyLimiterTTLMs   int64
	BullMQNamespace      string
	// RuleTaskConcurrency is the number of active-rule schedules the startup
	// reconciliation creates in parallel. It is ALERT_RULE_TASK_CONCURRENCY
	// (apps/api/src/modules/alerts/alerts.service.ts:117), a NestJS constant and
	// not an environment setting, so the default is the same 16.
	RuleTaskConcurrency int
}

func (c Config) normalized() Config {
	if c.QueueConcurrency < 1 {
		c.QueueConcurrency = queue.DefaultConcurrency
	}
	if c.WebhookTimeoutMs <= 0 {
		c.WebhookTimeoutMs = 5_000
	}
	if c.ScanIntervalMs <= 0 {
		c.ScanIntervalMs = 300_000
	}
	if c.NotifyLimiterTTLMs <= 0 {
		c.NotifyLimiterTTLMs = 60_000
	}
	if c.BullMQNamespace == "" {
		c.BullMQNamespace = "modular"
	}
	if c.RuleTaskConcurrency < 1 {
		c.RuleTaskConcurrency = defaultRuleTaskConcurrency
	}
	return c
}

// Options are the shared clients and settings of the alert worker.
type Options struct {
	DB       *sql.DB
	Redis    *redis.Client
	Mongo    *mongo.Database
	Mail     Mailer
	Forecast providers.ForecastClient
	Config   Config
	// WebhookClient is the singleton pinned client; when nil the worker builds
	// one with Config.WebhookTimeoutMs.
	WebhookClient *http.Client
	Now           func() time.Time
	Logger        *log.Logger
}

// Service is the alert worker. It owns the BullMQ consumer of the `alerts`
// queue and the scan schedule.
type Service struct {
	db       *sql.DB
	redis    *redis.Client
	repo     *repository
	producer *queue.Producer
	metrics  *providers.Set
	throttle *Throttle
	mail     Mailer
	webhook  *http.Client
	cfg      Config
	now      func() time.Time
	logger   *log.Logger

	worker   *queue.Worker
	blocking *redis.Client

	// lease is the Redis lease of the startup rule-schedule reconciliation;
	// cronlock.Lock implements ruleScheduleLease.
	lease ruleScheduleLease
}

// Errors returned by the worker surface.
var (
	errInvalidEmailTarget = errors.New("Invalid email target")
	errNoDatabase         = errors.New("alertworker: mysql is not configured")
	errNoRedis            = errors.New("alertworker: redis is not configured")
)

// New builds the worker over the shared clients. It performs no I/O.
func New(opts Options) (*Service, error) {
	if opts.DB == nil {
		return nil, errNoDatabase
	}
	if opts.Redis == nil {
		return nil, errNoRedis
	}
	cfg := opts.Config.normalized()
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	producer, err := queue.NewProducer(opts.Redis, queue.Prefix)
	if err != nil {
		return nil, err
	}
	metrics, err := providers.NewSet(providers.Dependencies{
		DB:       opts.DB,
		Redis:    opts.Redis,
		Mongo:    opts.Mongo,
		Forecast: opts.Forecast,
		Cache:    providers.NewCache(opts.Redis),
		Now:      now,
	})
	if err != nil {
		return nil, err
	}
	webhookClient := opts.WebhookClient
	if webhookClient == nil {
		webhookClient = NewPinnedHTTPClient(time.Duration(cfg.WebhookTimeoutMs) * time.Millisecond)
	}
	return &Service{
		db:       opts.DB,
		redis:    opts.Redis,
		repo:     newRepository(opts.DB),
		producer: producer,
		metrics:  metrics,
		throttle: NewThrottle(opts.Redis, ThrottleConfig{
			GlobalPerSecond:     cfg.NotifyGlobalPerSec,
			EmailPerSecond:      cfg.NotifyEmailPerSec,
			WebhookPerSecond:    cfg.NotifyWebhookPerSec,
			PerChannelPerSecond: cfg.NotifyPerChannelPSec,
			LimiterTTLMs:        cfg.NotifyLimiterTTLMs,
			Namespace:           cfg.BullMQNamespace,
		}),
		mail:    opts.Mail,
		webhook: webhookClient,
		cfg:     cfg,
		now:     now,
		logger:  logger,
		lease:   cronlock.New(opts.Redis),
	}, nil
}

// Start adds (or refreshes) the scan schedule, reconciles every active rule's
// schedule and starts the queue consumer. The blocking Redis connection is a
// dedicated client built from the shared client's options, because a connection
// blocked on BZPOPMIN cannot run commands.
func (s *Service) Start(ctx context.Context) error {
	if err := s.producer.EnsureScanSchedule(ctx, s.cfg.ScanIntervalMs); err != nil {
		return err
	}
	// The rule schedules must be in place before the worker claims jobs.
	// AlertsProcessor.onModuleInit awaits scheduleScanJob() and ensureAllSchedules()
	// in the same order before creating its Worker
	// (apps/api/src/modules/alerts/alerts.processor.ts:26-32), and a rejected
	// onModuleInit aborts the NestJS bootstrap: this port keeps that contract
	// instead of starting a worker whose schedules may be stale.
	if err := s.ReconcileRuleSchedules(ctx); err != nil {
		return err
	}
	blocking := redis.NewClient(s.redis.Options())
	worker, err := queue.NewWorker(s.redis, blocking, queue.WorkerOptions{
		Concurrency: s.cfg.QueueConcurrency,
		Prefix:      queue.Prefix,
		Processor:   s.Process,
		BackoffDelay: func(attempt int, backoffType string) (int64, bool) {
			if backoffType != notificationBackoffType {
				return 0, false
			}
			return notificationBackoffDelay(attempt), true
		},
		Logger: s.logf,
	})
	if err != nil {
		blocking.Close()
		return err
	}
	if err := worker.Start(ctx); err != nil {
		blocking.Close()
		return err
	}
	s.worker = worker
	s.blocking = blocking
	s.logger.Printf("alertworker: consuming the %q queue (concurrency=%d, scan interval=%dms)",
		queue.QueueName, s.cfg.QueueConcurrency, s.cfg.ScanIntervalMs)
	return nil
}

// Close stops claiming jobs and drains the in-flight ones.
func (s *Service) Close(ctx context.Context) error {
	if s.worker == nil {
		return nil
	}
	err := s.worker.Close(ctx)
	s.worker = nil
	return err
}

// notificationBackoffType is the custom backoff strategy name of delivery jobs.
const notificationBackoffType = "alertNotifications"

// notificationBackoffDelay mirrors AlertsService.getNotificationBackoffDelay:
// delays[clamp(attemptsMade - 1, 0, len-1)] where attemptsMade is the 1-based
// attempt that just failed.
func notificationBackoffDelay(attempt int) int64 {
	index := attempt - 1
	if index < 0 {
		index = 0
	}
	if index >= len(notificationBackoffDelaysMs) {
		index = len(notificationBackoffDelaysMs) - 1
	}
	return notificationBackoffDelaysMs[index]
}

// Process dispatches one claimed job exactly like the AlertsProcessor worker
// callback: by name and data.type, with no error for unknown shapes.
func (s *Service) Process(ctx context.Context, job queue.Job, handle queue.JobHandle) error {
	switch {
	case job.Name == queue.JobNameScan:
		return s.ScanActiveRules(ctx)
	case strings.HasPrefix(job.Name, queue.JobNameRulePrefix):
		var payload queue.EvaluateJobData
		if len(job.Data) > 0 {
			if err := json.Unmarshal(job.Data, &payload); err != nil {
				return fmt.Errorf("alertworker: decode evaluate payload: %w", err)
			}
		}
		if payload.Type != queue.JobTypeEvaluate || payload.RuleID == "" {
			return nil
		}
		_, err := s.EvaluateRule(ctx, payload.RuleID, payload.OrgID)
		return err
	case strings.HasPrefix(job.Name, queue.JobNameDeliverPrefix):
		var payload queue.DeliverJobData
		if len(job.Data) > 0 {
			if err := json.Unmarshal(job.Data, &payload); err != nil {
				return fmt.Errorf("alertworker: decode deliver payload: %w", err)
			}
		}
		if payload.Type != queue.JobTypeDeliver || payload.DeliveryID == "" {
			return nil
		}
		return s.HandleDeliveryJob(ctx, job, payload, handle)
	default:
		return nil
	}
}

// EnqueueRuleCheck adds one manual evaluation job, used by the rule mutation
// path when Go owns the queue.
func (s *Service) EnqueueRuleCheck(ctx context.Context, ruleID, orgID string) error {
	return s.producer.AddEvaluateJob(ctx, ruleID, orgID, ensureTraceID(""))
}

// EnsureRuleSchedule replaces one rule's repeat schedule, used by the rule
// mutation path when Go owns the queue.
func (s *Service) EnsureRuleSchedule(ctx context.Context, ruleID, orgID string, checkIntervalSec int) error {
	return s.producer.EnsureRuleSchedule(ctx, ruleID, orgID, checkIntervalSec)
}

// RemoveRuleJobs removes a deleted rule's schedule and pending jobs.
func (s *Service) RemoveRuleJobs(ctx context.Context, ruleID string) error {
	return s.producer.RemoveRuleJobs(ctx, ruleID, true)
}

func (s *Service) logf(format string, args ...any) {
	s.logger.Printf(format, args...)
}
