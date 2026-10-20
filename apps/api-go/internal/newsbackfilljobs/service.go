// Package newsbackfilljobs wires the news-event clustering failure LLM
// backfill chain and the six-hourly news-indicator association refresh.
//
// It owns the infrastructure adapters (BullMQ producer/worker, vector-service
// client, model gateway observer, scheduling loops and the manual HTTP entry)
// while the domain state machine lives in internal/newsnowclusteringops and
// internal/newsindicator. Every component is constructed only when its switch
// is go; the legacy default constructs nothing.
package newsbackfilljobs

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/clusteringrecoveryqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// Options are the dependencies of the news backfill service.
type Options struct {
	Clustering *newsnowclusteringops.Service
	Queue      *clusteringrecoveryqueue.Producer
	Completer  publicportal.ClusteringDecisionCompleter
	Vectors    *VectorSearcher
	Logs       *llmlogs.CompletionWriter
	Logger     func(format string, args ...any)
	Now        func() time.Time
}

// Service bundles the domain service with the queue, model and vector ports.
type Service struct {
	clustering *newsnowclusteringops.Service
	queue      *clusteringrecoveryqueue.Producer
	completer  publicportal.ClusteringDecisionCompleter
	vectors    *VectorSearcher
	logs       *llmlogs.CompletionWriter
	logger     func(format string, args ...any)
	now        func() time.Time
}

// NewService builds the service. Clustering and Queue are required for every
// switch; the model completer and the vector searcher are required only when
// the worker switch constructs a consumer.
func NewService(opts Options) (*Service, error) {
	if opts.Clustering == nil {
		return nil, errors.New("newsbackfilljobs: clustering service is required")
	}
	if opts.Queue == nil {
		return nil, errors.New("newsbackfilljobs: queue producer is required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Printf
	}
	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		clustering: opts.Clustering,
		queue:      opts.Queue,
		completer:  opts.Completer,
		vectors:    opts.Vectors,
		logs:       opts.Logs,
		logger:     logger,
		now:        now,
	}, nil
}

// Enqueue performs the manual enqueue used by the HTTP entry.
func (s *Service) Enqueue(ctx context.Context, orgID, actorID, groupID string) (newsnowclusteringops.LlmBackfillAccepted, error) {
	if s == nil || s.clustering == nil || s.queue == nil {
		return newsnowclusteringops.LlmBackfillAccepted{}, errors.New("newsbackfilljobs: service is not configured")
	}
	return s.clustering.EnqueueLlmBackfill(ctx, orgID, actorID, groupID, producerAdapter{queue: s.queue})
}

// Scan runs one five-minute tick body (R1 followed by the pending scan).
func (s *Service) Scan(ctx context.Context) (newsnowclusteringops.LlmBackfillScanResult, error) {
	if s == nil || s.clustering == nil {
		return newsnowclusteringops.LlmBackfillScanResult{}, errors.New("newsbackfilljobs: service is not configured")
	}
	return s.clustering.ScanPendingLlmBackfills(ctx, s.scanDeps())
}

// Process runs one BullMQ job.
func (s *Service) Process(ctx context.Context, job clusteringrecoveryqueue.Job) error {
	if s == nil || s.clustering == nil {
		return errors.New("newsbackfilljobs: service is not configured")
	}
	payload := jobFromQueuePayload(job.Payload)
	if payload.JobType != newsnowclusteringops.LlmBackfillJobType {
		// NestJS acknowledges an unknown job type without side effects.
		return nil
	}
	s.logger("newsbackfilljobs: llm backfill job start jobId=%s orgId=%s groupId=%s traceId=%s trigger=%s",
		job.ID, payload.OrgID, payload.GroupID, payload.TraceID, payload.Trigger)
	err := s.clustering.ProcessLlmBackfillJob(ctx, payload, s.processDeps())
	if err != nil {
		s.logger("newsbackfilljobs: llm backfill job failed jobId=%s orgId=%s groupId=%s: %v",
			job.ID, payload.OrgID, payload.GroupID, err)
	}
	return err
}

// NewWorker builds the BullMQ consumer over the shared command client and a
// dedicated blocking client. The concurrency is max(1, min(2, configured)),
// exactly like the NestJS processor.
func (s *Service) NewWorker(command, blocking *redis.Client, configuredConcurrency int) (*clusteringrecoveryqueue.Worker, error) {
	if s == nil {
		return nil, errors.New("newsbackfilljobs: service is not configured")
	}
	if s.completer == nil {
		return nil, errors.New("newsbackfilljobs: LLM completer is required to consume the queue")
	}
	concurrency := configuredConcurrency
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 2 {
		concurrency = 2
	}
	return clusteringrecoveryqueue.NewWorker(command, blocking, clusteringrecoveryqueue.WorkerOptions{
		Concurrency: concurrency,
		Processor:   s.Process,
		Logger:      s.logger,
	})
}

func (s *Service) scanDeps() newsnowclusteringops.LlmBackfillDeps {
	return newsnowclusteringops.LlmBackfillDeps{
		Producer: producerAdapter{queue: s.queue},
		Liveness: livenessAdapter{queue: s.queue},
		Logger:   s.logger,
		Now:      s.now,
	}
}

func (s *Service) processDeps() newsnowclusteringops.LlmBackfillDeps {
	return newsnowclusteringops.LlmBackfillDeps{
		Producer:  producerAdapter{queue: s.queue},
		Liveness:  livenessAdapter{queue: s.queue},
		Completer: completerAdapter{completer: s.completer, observer: newDecisionObserver(s.logs)},
		Vectors:   s.vectors,
		Logger:    s.logger,
		Now:       s.now,
	}
}

// producerAdapter maps the domain payload onto the queue wire payload.
type producerAdapter struct {
	queue *clusteringrecoveryqueue.Producer
}

func (a producerAdapter) AddLlmBackfill(ctx context.Context, jobID string, job newsnowclusteringops.LlmBackfillJob) error {
	return a.queue.Add(ctx, jobID, queuePayloadFromJob(job))
}

// livenessAdapter exposes the queue state probe to the recovery rule.
type livenessAdapter struct {
	queue *clusteringrecoveryqueue.Producer
}

func (a livenessAdapter) LlmBackfillJobActive(ctx context.Context, jobID string) (bool, error) {
	return a.queue.JobIsActive(ctx, jobID)
}

// completerAdapter maps the domain model request onto the publicportal
// completion surface.
type completerAdapter struct {
	completer publicportal.ClusteringDecisionCompleter
	observer  publicportal.ClusteringDecisionObserver
}

func (a completerAdapter) CompleteLlmBackfillDecision(ctx context.Context, req newsnowclusteringops.LlmBackfillModelRequest) (newsnowclusteringops.LlmBackfillModelResponse, error) {
	if a.completer == nil {
		return newsnowclusteringops.LlmBackfillModelResponse{}, errors.New("newsbackfilljobs: LLM completer is not configured")
	}
	result, err := a.completer.CompleteClusteringDecision(ctx, publicportal.ClusteringDecisionRequest{
		OrgID:              req.OrgID,
		Model:              req.Model,
		System:             req.System,
		User:               req.User,
		CandidateCount:     req.CandidateCount,
		ArticleFingerprint: req.ArticleFingerprint,
		Observer:           a.observer,
	})
	if err != nil {
		return newsnowclusteringops.LlmBackfillModelResponse{}, err
	}
	return newsnowclusteringops.LlmBackfillModelResponse{Content: result.Content}, nil
}

// queuePayloadFromJob converts the domain payload to the BullMQ payload. The
// field set is identical; the conversion is centralized so the two contracts
// cannot drift silently.
func queuePayloadFromJob(job newsnowclusteringops.LlmBackfillJob) clusteringrecoveryqueue.Payload {
	return clusteringrecoveryqueue.Payload{
		JobType: job.JobType,
		OrgID:   job.OrgID,
		ActorID: job.ActorID,
		GroupID: job.GroupID,
		TraceID: job.TraceID,
		Trigger: job.Trigger,
	}
}

func jobFromQueuePayload(payload clusteringrecoveryqueue.Payload) newsnowclusteringops.LlmBackfillJob {
	return newsnowclusteringops.LlmBackfillJob{
		JobType: payload.JobType,
		OrgID:   payload.OrgID,
		ActorID: payload.ActorID,
		GroupID: payload.GroupID,
		TraceID: payload.TraceID,
		Trigger: payload.Trigger,
	}
}
