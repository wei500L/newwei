package newspipeline

import (
	"context"
	"log"
	"math/rand"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
)

// This file is the package entry point: New wires the units of the migration
// (settings reader, cleaner, extractor, deduper, classifier, outbox dispatcher,
// snapshot refresher) and Process ports NewsPipelineStagesService.process.
//
// Process:
//
//	normalize -> crawl -> settings -> legacy | staged
//
// and every stage failure is logged to TaskLog best effort and rethrown, so the
// itemPipeline consumer keeps owning the permanent-vs-transient decision. Only
// individual enrichment stage failures are contained (stages.go).

// pipelineCleaner is the news-content cleaner surface the pipeline calls.
type pipelineCleaner interface {
	FetchArticle(ctx context.Context, job Job, payload NormalizedPayload) (ArticleWithCache, error)
	CleanArticle(ctx context.Context, payload NormalizedPayload, article CrawledArticle, job Job, provider string) (CleanResult, error)
}

// pipelineExtractor is the news-content extraction-stage surface.
type pipelineExtractor interface {
	ExtractEntities(ctx context.Context, stage StageContext, prompt PromptConfig, provider string, input EnrichmentInput) ([]Entity, *LLMMetadata, error)
	AnalyzeSentiment(ctx context.Context, stage StageContext, prompt PromptConfig, provider string, input EnrichmentInput) (string, *LLMMetadata, error)
	ExtractKGRelations(ctx context.Context, stage StageContext, prompt PromptConfig, provider string, input EnrichmentInput) ([]KGRelation, *LLMMetadata, error)
}

// pipelineDeduper is the news-dedupe surface.
type pipelineDeduper interface {
	EvaluateSummaryDedupe(ctx context.Context, input DedupeInput) (DedupeResult, error)
	RevertDuplicateMarkOnPersistFailure(ctx context.Context, job Job, duplicateOf *string) error
}

// Service is the itemPipeline news pipeline worker.
type Service struct {
	settings   SettingsProvider
	cleaner    pipelineCleaner
	extractor  pipelineExtractor
	deduper    pipelineDeduper
	classifier Classifier
	store      pipelineStore
	outbox     OutboxDispatcher
	snapshots  SnapshotRefresher
	config     RuntimeConfig
	now        func() time.Time
	logf       func(format string, args ...any)

	mongo        *mongo.Database
	metadataExec pipelineMetadataExec

	deliverySlots chan struct{}
	asyncWG       sync.WaitGroup
}

// New builds the pipeline service. The Options contract marks DB/Mongo as
// required and Crawl/Models/Vector/Outbox as required for the branches that use
// them; New is total and only panics on programming errors (it never does).
func New(opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	random := opts.Random
	if random == nil {
		random = rand.Float64
	}
	logf := opts.Logger
	if logf == nil {
		logf = log.Printf
	}
	settings := NewSettingsReader(opts.DB, opts.Redis, opts.Config)
	builder := NewPromptBuilder()

	service := &Service{
		settings: settings,
		cleaner: NewCleaner(CleanerDeps{
			DB:       opts.DB,
			Mongo:    opts.Mongo,
			Config:   opts.Config,
			Models:   opts.Models,
			Crawl:    opts.Crawl,
			Settings: settings,
			Now:      now,
		}),
		extractor: NewExtractor(opts.Models, builder),
		deduper: NewDeduper(DeduperDeps{
			DB:       opts.DB,
			Mongo:    opts.Mongo,
			Models:   opts.Models,
			Vector:   opts.Vector,
			Settings: settings,
			Runtime:  opts.Config.Pipeline,
			Now:      now,
			Random:   random,
		}),
		classifier: opts.Classifier,
		store:      &pipelineMySQLStore{db: opts.DB, now: now},
		outbox:     opts.Outbox,
		snapshots:  opts.Snapshots,
		config:     opts.Config.Pipeline,
		now:        now,
		logf:       logf,
		mongo:      opts.Mongo,
	}
	if opts.DB != nil {
		database := opts.DB
		service.metadataExec = func(ctx context.Context, query string, args ...any) error {
			_, err := database.ExecContext(ctx, query, args...)
			return err
		}
	}
	concurrency := opts.Config.Pipeline.OutboxDeliveryConcurrency
	if concurrency <= 0 {
		concurrency = 10
	}
	service.deliverySlots = make(chan struct{}, concurrency)
	return service
}

// Process is NewsPipelineStagesService.process.
func (s *Service) Process(ctx context.Context, job Job, raw RawItem) (ProcessResult, error) {
	payload, err := pipelineRunStage(s, ctx, job, "normalize", func() (NormalizedPayload, error) {
		return NormalizePayload(raw.Payload)
	}, func() any {
		return pipelineStageFailureRawItem{RawItemID: raw.ID}
	})
	if err != nil {
		return ProcessResult{}, err
	}

	article, err := pipelineRunStage(s, ctx, job, "crawl", func() (ArticleWithCache, error) {
		return s.cleaner.FetchArticle(ctx, job, payload)
	}, func() any {
		return pipelineStageFailureURL{URL: payload.URL}
	})
	if err != nil {
		return ProcessResult{}, err
	}

	extractionSettings := s.settings.Extraction(ctx, job.OrgID)
	if extractionSettings.PipelineMode != PipelineModeStaged {
		return s.processLegacyPipeline(ctx, job, raw, payload, article)
	}
	return s.processStagedPipeline(ctx, job, raw, payload, article, extractionSettings)
}

// pipelineRunStage is runStage: log the failure best effort, then rethrow.
func pipelineRunStage[T any](s *Service, ctx context.Context, job Job, stage string, action func() (T, error), onError func() any) (T, error) {
	value, err := action()
	if err != nil {
		var data any
		if onError != nil {
			data = onError()
		}
		s.logStageFailure(ctx, job, stage, data, err)
		var zero T
		return zero, err
	}
	return value, nil
}

// logStageFailure is logStageFailure.
func (s *Service) logStageFailure(ctx context.Context, job Job, stage string, data any, err error) {
	s.writeTaskLog(ctx, taskLogWritePayload{
		Queue:  job.Queue,
		JobID:  job.JobID,
		OrgID:  job.OrgID,
		Stage:  stage,
		Status: pipelineTaskLogStatusFailed,
		Data:   data,
		Error:  pipelineErrorDetails(err),
	})
}
