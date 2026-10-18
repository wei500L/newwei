package searchreindex

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// finalizeTimeout bounds the best-effort status write, lock release and prune
// that run after a rebuild finishes or the service is shutting down.
const finalizeTimeout = 10 * time.Second

// MachineAuthenticator resolves an mtk_ machine token, mirroring the
// MachineTokenService lookup the global NestJS JwtAuthGuard performs for every
// guarded REST route.
type MachineAuthenticator interface {
	AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error)
}

// Service owns the reindex lifecycle: the Redis job store, the Mongo read
// source, the Elasticsearch writer and the service-lifetime background context.
//
// The background run is deliberately detached from the HTTP request context so a
// client that stops polling cannot cancel a rebuild that already returned 201;
// it is cancelled only by Close.
type Service struct {
	jobs     *jobStore
	source   *mongoSource
	indexer  *Elasticsearch
	machines MachineAuthenticator
	baseCtx  context.Context
	cancel   context.CancelFunc
	wait     sync.WaitGroup
}

// NewService assembles the Redis job store, the Mongo read source, the
// Elasticsearch writer from the ELASTICSEARCH_* environment and the optional
// machine-token resolver.
//
// database must be a usable connection (the go mode requires MONGO_URI). A
// disabled or unconfigured Elasticsearch leaves the writer nil, which keeps the
// legacy disabled branch: the job completes with indexed=0 and Mongo is never
// read.
func NewService(redisClient *redis.Client, database *mongo.Database, machines MachineAuthenticator) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		jobs:     newJobStore(redisClient),
		source:   newMongoSource(database),
		indexer:  newElasticsearchFromEnv(),
		machines: machines,
		baseCtx:  ctx,
		cancel:   cancel,
	}
}

// Close cancels the service-lifetime context and waits for the running rebuild to
// stop. Job state stays in Redis; nothing is re-scheduled on restart.
func (s *Service) Close() {
	if s == nil {
		return
	}
	s.cancel()
	s.wait.Wait()
}

// startReindex acquires the organization lock, persists the queued job and
// starts the background rebuild. It returns errReindexInProgress when another run
// already holds the lock.
func (s *Service) startReindex(ctx context.Context, orgID string) (Job, error) {
	lock, acquired, err := acquireReindexLock(ctx, s.jobs.redis, orgID)
	if err != nil {
		return Job{}, err
	}
	if !acquired {
		return Job{}, errReindexInProgress
	}
	job, err := s.jobs.create(ctx, orgID, time.Now())
	if err != nil {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), finalizeTimeout)
		_ = lock.release(releaseCtx)
		releaseCancel()
		return Job{}, err
	}
	s.wait.Add(1)
	go func() {
		defer s.wait.Done()
		s.runReindex(job.ID, orgID, lock)
	}()
	return job, nil
}

// getJob returns the job only when it belongs to orgID; a missing or expired job
// and a foreign organization all return nil so the handler serializes null.
func (s *Service) getJob(ctx context.Context, orgID, jobID string) (*Job, error) {
	return s.jobs.getForOrg(ctx, orgID, jobID)
}

// runReindex is the background transition sequence: running, the actual rebuild
// with per-batch progress, then completed or failed, and finally stop renewing,
// release the organization lock and prune the current organization's history.
func (s *Service) runReindex(jobID, orgID string, lock *reindexLock) {
	ctx := s.baseCtx
	finishCtx := context.WithoutCancel(ctx)
	stopRenew := lock.startAutoRenew(ctx)
	defer func() {
		stopRenew()
		releaseCtx, releaseCancel := context.WithTimeout(finishCtx, finalizeTimeout)
		defer releaseCancel()
		_ = lock.release(releaseCtx)
		_ = s.jobs.prune(releaseCtx, orgID, time.Now())
	}()

	_, _ = s.jobs.markRunning(ctx, jobID, time.Now())

	written, err := s.reindexOrg(ctx, orgID, func(progressCtx context.Context, indexed int) error {
		_, progressErr := s.jobs.markProgress(progressCtx, jobID, indexed, time.Now())
		return progressErr
	})
	if err != nil {
		finalizeCtx, finalizeCancel := context.WithTimeout(finishCtx, finalizeTimeout)
		_ = s.jobs.markFailed(finalizeCtx, jobID, written, err.Error(), time.Now())
		finalizeCancel()
		return
	}
	finalizeCtx, finalizeCancel := context.WithTimeout(finishCtx, finalizeTimeout)
	_ = s.jobs.markCompleted(finalizeCtx, jobID, written, time.Now())
	finalizeCancel()
}

// reindexOrg rewrites the organization's existing read model documents. It pages
// with an ascending itemMetaId cursor, bulk writes each page with refresh=false
// and refreshes explicitly before the caller may mark the job completed. The
// returned count is the number of documents Elasticsearch actually accepted; on
// failure it keeps every successful document of the earlier batches and of the
// batch that failed.
func (s *Service) reindexOrg(ctx context.Context, orgID string, onProgress func(context.Context, int) error) (int, error) {
	if s.indexer == nil {
		// Disabled branch, matching ItemsElasticsearchService.reindexOrg: no
		// Mongo read and indexed=0.
		return 0, nil
	}
	if s.source == nil {
		return 0, fmt.Errorf("%w: item read model is not configured", errMongo)
	}
	if err := s.indexer.ensureIndex(ctx); err != nil {
		return 0, err
	}
	indexed := 0
	cursor := ""
	for {
		documents, err := s.source.nextBatch(ctx, orgID, cursor)
		if err != nil {
			return indexed, err
		}
		if len(documents) == 0 {
			break
		}
		written, failures, err := s.indexer.bulkIndex(ctx, documents)
		if err != nil {
			return indexed, err
		}
		indexed += written
		if err := onProgress(ctx, indexed); err != nil {
			return indexed, err
		}
		if len(failures) > 0 {
			// Persist the successful count of this batch, then fail without
			// treating the following batches as successful.
			return indexed, bulkFailureError(failures)
		}
		last := documents[len(documents)-1].ItemMetaID
		if last == "" {
			break
		}
		cursor = last
	}
	if err := s.indexer.refresh(ctx); err != nil {
		return indexed, err
	}
	return indexed, nil
}

// bulkFailureError builds the job error text: the itemMetaId, the Elasticsearch
// error type and a short reason. Credentials and document bodies are never
// included.
func bulkFailureError(failures []bulkFailure) error {
	first := failures[0]
	return fmt.Errorf(
		"elasticsearch bulk index failed for %d item(s): itemMetaId=%s type=%s reason=%s",
		len(failures), first.itemMetaID, first.errorType, first.reason,
	)
}
