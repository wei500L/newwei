package classificationrssops

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/qualityqueue"
)

// Classification quality report jobs and the BullMQ jobs that build them.
//
// Queue contract (shared with NestJS):
//   - queue name "classification_quality" (internal/qualityqueue owns the key
//     layout);
//   - job name and job id are both "classification-quality-report:<reportJobId>";
//   - data is {jobType:"report", orgId, reportJobId, traceId};
//   - options are removeOnComplete=true, removeOnFail={age:7d, count:10000},
//     attempts=3 and an exponential backoff of 2000 ms, exactly the queue
//     defaultJobOptions in observability.module.ts.
const (
	reportJobQueueJobPrefix = "classification-quality-report:"

	reportResultRetentionDays = 365

	// failedJobAgeSeconds and failedJobCount mirror BULLMQ_FAILED_JOB_RETENTION.
	failedJobAgeSeconds = 7 * 24 * 60 * 60
	failedJobCount      = 10000
)

// reportJobPayload is the job data NestJS writes for a report task.
type reportJobPayload struct {
	JobType     string `json:"jobType"`
	OrgID       string `json:"orgId"`
	ReportJobID string `json:"reportJobId"`
	TraceID     string `json:"traceId"`
}

// reportJobDocument is one classificationreportjobs row. The explicit _id and
// timestamps make a Go insert indistinguishable from a Mongoose create: every
// schema default that NestJS persists is written, including the nulls.
type reportJobDocument struct {
	ID             bson.ObjectID                 `bson:"_id"`
	OrgID          string                        `bson:"orgId"`
	RequestedByID  string                        `bson:"requestedById"`
	SampleID       *string                       `bson:"sampleId"`
	Status         string                        `bson:"status"`
	Progress       float64                       `bson:"progress"`
	ReportResultID *string                       `bson:"reportResultId"`
	StartedAt      *time.Time                    `bson:"startedAt"`
	CompletedAt    *time.Time                    `bson:"completedAt"`
	ExpiresAt      time.Time                     `bson:"expiresAt"`
	Error          *classificationReportJobError `bson:"error,omitempty"`
	CreatedAt      time.Time                     `bson:"createdAt"`
	UpdatedAt      time.Time                     `bson:"updatedAt"`
	Version        int32                         `bson:"__v"`
}

// createReportJobRequest is the controller input.
type createReportJobRequest struct {
	OrgID    string
	ActorID  string
	SampleID *string
}

// createReportJobResponse is the 201 body.
type createReportJobResponse struct {
	JobID     string  `json:"jobId"`
	Status    string  `json:"status"`
	SampleID  *string `json:"sampleId"`
	CreatedAt string  `json:"createdAt"`
}

// reportEnqueuer is the queue surface CreateReportJob needs. Keeping it an
// interface makes the enqueue-failure branch testable without Redis.
type reportEnqueuer interface {
	Add(ctx context.Context, name string, data json.RawMessage, opts qualityqueue.AddOptions) (string, error)
}

// CreateReportJob mirrors createReportJob: create the pending job document,
// enqueue it, and mark it failed when the enqueue fails.
func (s *Service) CreateReportJob(ctx context.Context, request createReportJobRequest) (createReportJobResponse, error) {
	objectID := bson.NewObjectID()
	jobID := objectID.Hex()
	now := nowMillis()
	document := reportJobDocument{
		ID:            objectID,
		OrgID:         request.OrgID,
		RequestedByID: request.ActorID,
		SampleID:      request.SampleID,
		Status:        "pending",
		Progress:      0,
		ExpiresAt:     expiryDate(reportJobRetentionDays),
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	collection, err := s.collection(reportJobsCollection)
	if err != nil {
		return createReportJobResponse{}, err
	}
	if _, err := collection.InsertOne(ctx, document); err != nil {
		return createReportJobResponse{}, err
	}

	payload, err := json.Marshal(reportJobPayload{
		JobType:     "report",
		OrgID:       request.OrgID,
		ReportJobID: jobID,
		TraceID:     httpx.EnsureTraceID(httpx.TraceIDFromContext(ctx)),
	})
	if err != nil {
		return createReportJobResponse{}, err
	}

	if s.reportQueue == nil {
		s.markReportJobEnqueueFailure(ctx, request.OrgID, objectID, errors.New("redis is not configured"))
		return createReportJobResponse{}, newStatus(500, "Failed to enqueue classification report job")
	}
	_, err = s.reportQueue.Add(ctx, reportJobQueueJobPrefix+jobID, payload, qualityqueue.AddOptions{
		JobID:            reportJobQueueJobPrefix + jobID,
		Attempts:         3,
		Backoff:          qualityqueue.Backoff{Type: "exponential", Delay: 2000},
		RemoveOnComplete: qualityqueue.RemoveImmediately(),
		RemoveOnFail:     qualityqueue.Retention(failedJobAgeSeconds, failedJobCount),
	})
	if err != nil {
		s.markReportJobEnqueueFailure(ctx, request.OrgID, objectID, err)
		return createReportJobResponse{}, newStatus(500, "Failed to enqueue classification report job")
	}

	return createReportJobResponse{
		JobID:     jobID,
		Status:    "pending",
		SampleID:  request.SampleID,
		CreatedAt: formatJSTime(now),
	}, nil
}

// markReportJobEnqueueFailure mirrors the NestJS catch block: the job document
// becomes failed with completedAt and error.message, and the request answers 500.
func (s *Service) markReportJobEnqueueFailure(ctx context.Context, orgID string, objectID bson.ObjectID, cause error) {
	jobID := objectID.Hex()
	log.Printf("classification rss ops: failed to enqueue classification report job %s: %v", jobID, cause)
	collection, err := s.collection(reportJobsCollection)
	if err != nil {
		return
	}
	now := nowMillis()
	_, err = collection.UpdateOne(ctx,
		bson.D{{Key: "_id", Value: objectID}, {Key: "orgId", Value: orgID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: "failed"},
			{Key: "completedAt", Value: now},
			{Key: "updatedAt", Value: now},
			{Key: "error", Value: bson.D{{Key: "message", Value: cause.Error()}}},
		}}})
	if err != nil {
		log.Printf("classification rss ops: failed to mark report job %s failed: %v", jobID, err)
	}
}

// reportJobSampleID reads the sampleId the job was created for. A missing or
// non-string value means "no sample filter", like readString.
func reportJobSampleID(raw bson.RawValue) *string {
	value := rawString(raw)
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
