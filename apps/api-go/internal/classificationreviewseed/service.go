package classificationreviewseed

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/qualityqueue"
)

// JobType is the payload jobType the classification-quality worker dispatches
// on (ClassificationQualityJobPayload.jobType).
const JobType = "review_seed_item"

// reviewSeedRetention is BULLMQ_FAILED_JOB_RETENTION for removeOnFail.
const (
	reviewSeedRetentionAgeSeconds int64 = 7 * 24 * 60 * 60
	reviewSeedRetentionCount      int64 = 10_000
	reviewSeedAttempts            int64 = 3
	reviewSeedBackoffMillis       int64 = 2_000
)

// reviewSeedPayload is the job data literal NestJS writes. Field order matches
// the TypeScript object so the stored JSON is byte-identical.
type reviewSeedPayload struct {
	JobType         string `json:"jobType"`
	OrgID           string `json:"orgId"`
	ProcessedItemID string `json:"processedItemId"`
	TraceID         string `json:"traceId"`
}

// Service enqueues review-seed jobs on the classification_quality queue.
type Service struct {
	queue      *qualityqueue.Queue
	newTraceID func() string
}

// New builds the consumer over the shared classification_quality producer.
func New(queue *qualityqueue.Queue) *Service {
	return &Service{queue: queue, newTraceID: randomTraceID}
}

// HandleCompleted is the PipelineCompleted consumer. It extracts the processed
// item id, enqueues the review-seed job and logs enqueue failures as a warning;
// it never propagates an error into the shared read loop.
func (s *Service) HandleCompleted(ctx context.Context, jobID, orgID string, data json.RawMessage) {
	if s == nil || s.queue == nil {
		return
	}
	if strings.TrimSpace(orgID) == "" {
		return
	}
	processedItemID := ProcessedItemID(data)
	if processedItemID == "" {
		return
	}
	if _, err := s.Enqueue(ctx, orgID, processedItemID); err != nil {
		log.Printf("classificationreviewseed: enqueue orgId=%s processedItemId=%s sourceJobId=%s: %v",
			orgID, processedItemID, jobID, err)
	}
}

// Enqueue mirrors ClassificationQualityService.enqueueReviewSeedItemJob:
//
//   - the processed item id is trimmed and an empty value is a no-op;
//   - the job id and the job name are both
//     "classification-quality-review-seed-item:<orgId>:<processedItemId>";
//   - removeOnComplete is true, removeOnFail keeps 7 days / 10 000 jobs,
//     attempts is 3 with exponential backoff starting at 2s;
//   - traceId is ensureTraceId(null): 32 lowercase hex characters, because a
//     background event has no request trace context.
func (s *Service) Enqueue(ctx context.Context, orgID, processedItemID string) (string, error) {
	if s == nil || s.queue == nil {
		return "", fmt.Errorf("classificationreviewseed: queue is not configured")
	}
	processedItemID = strings.TrimSpace(processedItemID)
	if processedItemID == "" {
		return "", nil
	}
	jobID := ReviewSeedJobID(orgID, processedItemID)
	payload, err := json.Marshal(reviewSeedPayload{
		JobType:         JobType,
		OrgID:           orgID,
		ProcessedItemID: processedItemID,
		TraceID:         s.newTraceID(),
	})
	if err != nil {
		return "", err
	}
	return s.queue.Add(ctx, jobID, payload, qualityqueue.AddOptions{
		JobID:            jobID,
		Attempts:         reviewSeedAttempts,
		Backoff:          qualityqueue.Backoff{Type: "exponential", Delay: reviewSeedBackoffMillis},
		RemoveOnComplete: qualityqueue.RemoveImmediately(),
		RemoveOnFail:     qualityqueue.Retention(reviewSeedRetentionAgeSeconds, reviewSeedRetentionCount),
	})
}

// randomTraceID returns 32 lowercase hex characters, the value
// ensureTraceId(undefined) produces in @modular/utils.
func randomTraceID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}
