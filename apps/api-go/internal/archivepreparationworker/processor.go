package archivepreparationworker

import (
	"context"
	"database/sql"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/archivepreparation"
	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
)

// SettingsProvider is the effective archive-preparation settings surface.
type SettingsProvider interface {
	EffectiveArchivePreparationSettings(ctx context.Context) (dataruntimesettings.ArchivePreparationEffectiveSettings, error)
}

// StatusWriter is the derived preparation status port.
type StatusWriter interface {
	MarkProcessing(ctx context.Context, payload archivepreparation.Payload) error
	MarkPartial(ctx context.Context, payload archivepreparation.Payload) error
	MarkReady(ctx context.Context, payload archivepreparation.Payload) error
	MarkFailed(ctx context.Context, payload archivepreparation.Payload, errorMessage string) error
}

// ProcessorDeps wires the worker on the shared connections.
type ProcessorDeps struct {
	DB       *sql.DB
	Redis    *redis.Client
	Mongo    *mongo.Database
	Models   ModelClient
	Settings SettingsProvider
	Now      func() time.Time
	Warn     func(format string, args ...any)
}

// Processor owns one archive preparation job's classification and backfill.
type Processor struct {
	db       *sql.DB
	store    *archivereading.PreparationStore
	mongo    *mongo.Database
	models   ModelClient
	settings SettingsProvider
	news     *newsclassifier.SettingsStore
	policies *newsclassifier.SourcePolicyStore
	now      func() time.Time
	warn     func(format string, args ...any)
}

// NewProcessor builds the processor. It starts no goroutine.
func NewProcessor(deps ProcessorDeps) *Processor {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	warn := deps.Warn
	if warn == nil {
		warn = func(format string, args ...any) { log.Printf(format, args...) }
	}
	return &Processor{
		db:       deps.DB,
		store:    archivereading.NewPreparationStore(deps.DB, deps.Mongo),
		mongo:    deps.Mongo,
		models:   deps.Models,
		settings: deps.Settings,
		news:     newsclassifier.NewSettingsStore(deps.DB, deps.Redis),
		policies: newsclassifier.NewSourcePolicyStore(deps.DB, deps.Redis),
		now:      now,
		warn:     warn,
	}
}

// Consumer is the BullMQ Processor implementation: markProcessing, the job
// loop, markReady; failures are marked by the worker's per-attempt hook.
type Consumer struct {
	processor *Processor
	status    StatusWriter
}

// NewConsumer builds the job handler.
func NewConsumer(processor *Processor, status StatusWriter) *Consumer {
	return &Consumer{processor: processor, status: status}
}

// Handle runs one BullMQ attempt.
func (c *Consumer) Handle(ctx context.Context, job Job) error {
	payload := job.Payload
	traceID := httpx.EnsureTraceID(payload.TraceID)
	log.Printf("archive-preparation: processing job=%s scope=%s org=%s trace=%s", job.ID, payload.Scope, payload.OrgID, traceID)
	if err := c.status.MarkProcessing(ctx, payload); err != nil {
		return err
	}
	if err := c.processor.ProcessJob(ctx, payload, c.status); err != nil {
		return err
	}
	return c.status.MarkReady(ctx, payload)
}

// OnFailure mirrors the Nest 'failed' event: every failed attempt writes the
// FAILED status with the raw error message.
func (c *Consumer) OnFailure(ctx context.Context, job Job, cause error) {
	if c == nil || c.status == nil {
		return
	}
	message := "archive preparation failed"
	if cause != nil {
		message = cause.Error()
	}
	if err := c.status.MarkFailed(ctx, job.Payload, message); err != nil {
		log.Printf("archive-preparation: mark failed job=%s: %v", job.ID, err)
	}
}

// ProcessJob is ArchivePreparationProcessor.processJob with the B1 cursor
// continuation and the digest scan budget accumulated over the whole task.
func (p *Processor) ProcessJob(ctx context.Context, payload archivepreparation.Payload, status StatusWriter) error {
	settings, err := p.settings.EffectiveArchivePreparationSettings(ctx)
	if err != nil {
		return err
	}
	anchor := time.Time{}
	if payload.Scope == archivepreparation.ScopeDigest {
		anchor, err = resolveDigestAnchor(payload.AnchorDate, p.now())
		if err != nil {
			return err
		}
	}
	selection := &selectionState{
		store:   p.store,
		models:  p.models,
		orgID:   payload.OrgID,
		scope:   string(payload.Scope),
		anchor:  anchor,
		month:   payload.Month,
		display: newTaskDisplay(p.mongo),
	}
	session := newsclassifier.NewSession(newsclassifier.Deps{
		Client: p.models, Settings: p.news, SourcePolicies: p.policies, Now: p.now, Warn: p.warn,
	})
	for {
		rows, hasMore, err := selection.Next(ctx, settings.JobBatchSize)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		if err := p.classifyRowsBatch(ctx, payload.OrgID, rows, session, selection.display, settings); err != nil {
			return err
		}
		selection.forgetBackfilled(payload.OrgID, rows)
		if err := status.MarkPartial(ctx, payload); err != nil {
			return err
		}
		if !hasMore {
			return nil
		}
	}
}

// forgetBackfilled drops the task-local display signals the backfill just wrote
// so a later round reads the new values, matching the NestJS cache delete.
func (s *selectionState) forgetBackfilled(orgID string, rows []*archivereading.ArchiveRow) {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if id := trimmed(row.CleanedMarkdownRef); id != "" {
			ids = append(ids, id)
		}
	}
	s.display.forget(orgID, ids)
}

// resolveDigestAnchor reproduces `${anchorDate ?? today}T23:59:59.999Z`.
func resolveDigestAnchor(anchorDate string, now time.Time) (time.Time, error) {
	value := trimmed(anchorDate)
	if value == "" {
		value = now.UTC().Format("2006-01-02")
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, err
	}
	return time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 23, 59, 59, 999*time.Millisecond, time.UTC), nil
}
