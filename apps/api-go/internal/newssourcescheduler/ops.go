package newssourcescheduler

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// This file ports the four operations endpoints:
//
//	POST :id/dispatch         (manual dispatch, 409 while another dispatch holds
//	                           the per-source lock)
//	POST :id/cancel-queued    (remove this source's queued crawl jobs)
//	POST :id/clear-inflight   (fail this source's active pipeline jobs)
//	POST :id/retry-latest     (retry the latest crawl task or item pipeline job)
//
// Every entry point enforces the same org isolation as NestJS: a source that
// does not belong to the caller's organization answers 404 "News source not
// found".

// DispatchNow is NewsSourceSchedulerService.dispatchNow. The second return value
// is false when the 60-second per-source lock is already held, which the HTTP
// layer renders as 409 "News source is already being dispatched".
func (s *Service) DispatchNow(ctx context.Context, orgID, sourceID, actorID string) (dispatchOutcome, bool, error) {
	now := s.now()
	outcome := dispatchOutcome{}
	acquired := false
	_, err := s.withLock(ctx, dispatchLockPrefix+sourceID, dispatchLockTTL, func(ctx context.Context) error {
		acquired = true
		source, loadErr := s.repo.LoadSource(ctx, sourceID)
		if loadErr != nil {
			return loadErr
		}
		if source == nil || source.OrgID != orgID {
			return notFoundSource()
		}

		dedupe := computeSharedDispatchDedupeKey(source.ID, now)
		dedupeAcquired, dedupeErr := s.cacheSetIfAbsentJSON(ctx, dedupe.Key, dedupeUntilValue{Until: dedupe.Until},
			s.secondsDuration(dedupe.TTLSeconds))
		if dedupeErr != nil {
			return dedupeErr
		}
		if !dedupeAcquired {
			mode := seedModeName(normalizeSeedConfig(source, defaultSeedRuntimeSettings(), nil))
			nextRunAt := now
			if source.NextRunAt != nil {
				nextRunAt = *source.NextRunAt
			}
			until := dedupe.Until
			outcome = dispatchOutcome{
				SourceID:        source.ID,
				Mode:            mode,
				ScheduledFor:    isoMillis(now),
				NextRunAt:       isoMillis(nextRunAt),
				ScheduledCount:  0,
				SkippedCount:    0,
				EnqueueFailures: 0,
				PipelineJobIDs:  []string{},
				CrawlTaskIDs:    []string{},
				Reason:          pipelineDispatchReasonDeduped,
				DedupeUntil:     &until,
			}
			return nil
		}

		result, dispatchErr := s.dispatchSource(ctx, source, dispatchInput{
			Mode:    dispatchModeManual,
			ActorID: &actorID,
		})
		if dispatchErr != nil {
			// The dedupe window is released so the operator can retry at once.
			if delErr := s.cache.Del(ctx, dedupe.Key); delErr != nil {
				s.logWarn("failed to release news source dispatch window", "sourceId", source.ID, "error", delErr)
			}
			return dispatchErr
		}
		outcome = result
		return nil
	})
	if err != nil {
		return dispatchOutcome{}, acquired, err
	}
	if !acquired {
		return dispatchOutcome{}, false, nil
	}
	return outcome, true, nil
}

// CancelQueued is cancelQueuedCrawls.
func (s *Service) CancelQueued(ctx context.Context, orgID, sourceID, triggeredBy string) (cancelQueuedOutcome, error) {
	source, err := s.repo.LoadSource(ctx, sourceID)
	if err != nil {
		return cancelQueuedOutcome{}, err
	}
	if source == nil || source.OrgID != orgID {
		return cancelQueuedOutcome{}, notFoundSource()
	}

	outcome := cancelQueuedOutcome{
		SourceID:        source.ID,
		RemovedJobs:     0,
		ScannedJobs:     0,
		CanceledTaskIDs: []string{},
	}
	queuedTaskIDs, err := s.queue.ListQueuedTaskIDs(ctx)
	if err != nil {
		return cancelQueuedOutcome{}, err
	}
	if len(queuedTaskIDs) == 0 {
		return outcome, nil
	}
	ids := make([]string, 0, len(queuedTaskIDs))
	for taskID := range queuedTaskIDs {
		ids = append(ids, taskID)
	}
	matching, err := s.repo.FindCrawlTaskIDs(ctx, orgID, source.ID, ids)
	if err != nil {
		return cancelQueuedOutcome{}, err
	}
	taskIDsToCancel := make(map[string]struct{}, len(matching))
	for _, taskID := range matching {
		taskIDsToCancel[taskID] = struct{}{}
	}
	// NestJS sets `canceledTaskIds` to the ids whose jobs were actually removed,
	// not to every matching task.
	removed, err := s.queue.RemoveQueuedJobsForTasks(ctx, taskIDsToCancel)
	if err != nil {
		return cancelQueuedOutcome{}, err
	}
	outcome.RemovedJobs = removed.Removed
	outcome.ScannedJobs = removed.Scanned
	outcome.CanceledTaskIDs = removed.RemovedTaskIDs
	if len(removed.RemovedTaskIDs) > 0 {
		message := "Canceled by " + triggeredBy
		if err := s.repo.PauseCrawlTasks(ctx, orgID, removed.RemovedTaskIDs, message, s.now()); err != nil {
			return cancelQueuedOutcome{}, err
		}
		if err := s.SyncQueueCounts(ctx, orgID, source.ID); err != nil {
			s.logWarn("failed to sync queue counts after cancel", "sourceId", source.ID, "error", err)
		}
		if _, err := s.RefreshSnapshotForSource(ctx, orgID, source.ID); err != nil {
			s.logWarn("failed to refresh snapshot after cancel", "sourceId", source.ID, "error", err)
		}
	}
	return outcome, nil
}

// ClearInFlight is clearInFlight.
func (s *Service) ClearInFlight(ctx context.Context, orgID, sourceID string) (clearInFlightOutcome, error) {
	source, err := s.repo.LoadSource(ctx, sourceID)
	if err != nil {
		return clearInFlightOutcome{}, err
	}
	if source == nil || source.OrgID != orgID {
		return clearInFlightOutcome{}, notFoundSource()
	}
	cutoff := s.now().Add(-s.settings.InFlightLookback)
	cleared, err := s.repo.ClearInFlightJobs(ctx, orgID, source.ID, cutoff)
	if err != nil {
		return clearInFlightOutcome{}, err
	}
	if _, err := s.RefreshSnapshotForSource(ctx, orgID, source.ID); err != nil {
		s.logWarn("failed to refresh snapshot after clearing in-flight jobs", "sourceId", source.ID, "error", err)
	}
	return clearInFlightOutcome{
		SourceID:    source.ID,
		Cutoff:      isoMillis(cutoff),
		ClearedJobs: cleared,
	}, nil
}

// RetryLatest is retryLatestFailedTask. identity supplies the organization, the
// actor and the permission set the reused crawl-task retry needs (the crawl
// branch enforces the rate limit and items.write exactly like the NestJS call).
func (s *Service) RetryLatest(ctx context.Context, identity *authhttp.Identity, sourceID string, ip *string) (retryLatestOutcome, error) {
	if identity == nil {
		return retryLatestOutcome{}, notFoundSource()
	}
	orgID := identity.OrgID
	source, err := s.repo.LoadSource(ctx, sourceID)
	if err != nil {
		return retryLatestOutcome{}, err
	}
	if source == nil || source.OrgID != orgID {
		return retryLatestOutcome{}, notFoundSource()
	}

	latest, err := s.repo.LoadLatestPipelineJob(ctx, orgID, source.ID)
	if err != nil {
		return retryLatestOutcome{}, err
	}
	if latest == nil {
		return retryLatestOutcome{}, newStatus(http.StatusNotFound, "No pipeline job found for source")
	}
	metadata, _ := decodeObject(latest.Metadata)
	crawlTaskID, _ := metadata.stringField("crawlTaskId")

	if crawlTaskID != "" {
		status, err := s.repo.LoadCrawlTaskStatus(ctx, orgID, crawlTaskID)
		if err != nil {
			return retryLatestOutcome{}, err
		}
		if status == nil {
			return retryLatestOutcome{}, newStatus(http.StatusNotFound, "crawl task not found")
		}
		if *status != "failed" {
			return retryLatestOutcome{
				SourceID:    source.ID,
				RetryType:   "crawl",
				CrawlTaskID: &crawlTaskID,
				Status:      *status,
				Retried:     false,
			}, nil
		}
		if s.crawlTasks == nil {
			return retryLatestOutcome{}, newStatus(http.StatusInternalServerError, "Internal server error")
		}
		view, retryErr := s.crawlTasks.RetryTask(ctx, identity, crawlTaskID, ip)
		if retryErr != nil {
			return retryLatestOutcome{}, retryErr
		}
		if err := s.SyncQueueCounts(ctx, orgID, source.ID); err != nil {
			s.logWarn("failed to sync queue counts after crawl retry", "sourceId", source.ID, "error", err)
		}
		if _, err := s.RefreshSnapshotForSource(ctx, orgID, source.ID); err != nil {
			s.logWarn("failed to refresh snapshot after crawl retry", "sourceId", source.ID, "error", err)
		}
		return retryLatestOutcome{
			SourceID:    source.ID,
			RetryType:   "crawl",
			CrawlTaskID: &crawlTaskID,
			Status:      string(view.Status),
			Retried:     true,
		}, nil
	}

	itemMetaID, _ := metadata.stringField("itemMetaId")
	rawItemID, _ := metadata.stringField("rawItemId")
	if itemMetaID == "" || rawItemID == "" {
		return retryLatestOutcome{}, newStatus(http.StatusNotFound, "No retryable task found for latest job")
	}
	if latest.Status != "failed" {
		status := latest.Status
		return retryLatestOutcome{
			SourceID:      source.ID,
			RetryType:     "pipeline",
			PipelineJobID: &latest.ID,
			Status:        status,
			Retried:       false,
		}, nil
	}

	now := s.now().UTC().Truncate(time.Millisecond)
	if err := s.repo.SetPipelineJobQueued(ctx, latest.ID, now); err != nil {
		return retryLatestOutcome{}, err
	}
	if err := s.enqueueRetriedPipelineJob(ctx, orgID, itemMetaID, rawItemID, latest.ID, source.ID); err != nil {
		if markErr := s.repo.SetPipelineJobFailedAfterRetry(ctx, latest.ID, err.Error(), now); markErr != nil {
			s.logWarn("failed to restore pipeline job failure", "pipelineJobId", latest.ID, "error", markErr)
		}
		return retryLatestOutcome{}, err
	}
	s.recordPipelineRetryMetric(ctx, orgID, source.ID, sourceNameOrNil(source), latest.ID)
	if _, err := s.RefreshSnapshotForSource(ctx, orgID, source.ID); err != nil {
		s.logWarn("failed to refresh snapshot after pipeline retry", "sourceId", source.ID, "error", err)
	}
	status := "queued"
	return retryLatestOutcome{
		SourceID:      source.ID,
		RetryType:     "pipeline",
		PipelineJobID: &latest.ID,
		Status:        status,
		Retried:       true,
	}, nil
}

// enqueueRetriedPipelineJob is the retryIfFailed branch of
// QueueService.enqueueItem: a retained failed job with the deterministic id is
// removed so the same id can be added again; an existing live job is left alone.
func (s *Service) enqueueRetriedPipelineJob(ctx context.Context, orgID, itemMetaID, rawItemID, pipelineJobID, sourceID string) error {
	if s.pipeline == nil {
		return newStatus(http.StatusInternalServerError, "Internal server error")
	}
	jobID := itemMetaID + "-" + rawItemID
	failed, err := s.pipeline.FailedJobExists(ctx, jobID)
	if err != nil {
		return err
	}
	if failed {
		if _, err := s.pipeline.RemoveFailedJob(ctx, jobID); err != nil {
			return err
		}
	} else {
		exists, err := s.pipeline.JobExists(ctx, jobID)
		if err != nil {
			return err
		}
		if exists {
			return nil
		}
	}
	pipelineJob := pipelineJobID
	source := sourceID
	_, err = s.pipeline.EnqueueItem(ctx, orgID, itemMetaID, rawItemID, pipelineenqueue.EnqueueOptions{
		PipelineJobID: &pipelineJob,
		SourceID:      &source,
	})
	if err != nil && isDuplicateJobError(err) {
		return nil
	}
	return err
}

// isDuplicateJobError reports BullMQ's "already exists" add failure.
func isDuplicateJobError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "already exists")
}

// writeStatusError maps any service error to the HTTP contract. The reused
// crawl-task retry keeps its own status codes (404/409/403/429/500), so they are
// read through crawltaskwrite.HTTPStatus first.
func writeStatusError(w http.ResponseWriter, r *http.Request, err error) {
	if typed := asStatus(err); typed != nil {
		authhttp.WriteHTTPException(w, r, typed.status, typed.message)
		return
	}
	if status, message, ok := crawltaskwrite.HTTPStatus(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	log.Printf("newssourcescheduler: news source operations failed: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
