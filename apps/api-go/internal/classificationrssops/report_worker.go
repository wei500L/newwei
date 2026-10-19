package classificationrssops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Worker side of the classification quality queue.
//
// The queue is consumed by NestJS (classification-quality.processor.ts) in
// legacy mode and by this package when
// API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go. Ownership is exclusive: the
// NestJS processor stops creating its Worker in the go mode, so a job is never
// processed twice. Job payloads stay compatible in both directions:
//
//	{jobType:"report", orgId, reportJobId, traceId}
//	{jobType:"review_seed_item", orgId, processedItemId, traceId}
//
// The report jobs written before jobType existed carry only orgId + reportJobId
// and must keep working, hence the fallback in parseQualityJob.

// qualityJobKind is the dispatch decision for one queue payload.
type qualityJobKind int

const (
	// qualityJobSkip means the payload has neither a usable review-seed pair
	// nor a usable report pair; the worker logs and completes the job.
	qualityJobSkip qualityJobKind = iota
	// qualityJobReport builds a classification report.
	qualityJobReport
	// qualityJobReviewSeed writes one low-confidence review seed.
	qualityJobReviewSeed
)

// qualityJobDispatch is the typed result of reading a queue payload.
type qualityJobDispatch struct {
	Kind            qualityJobKind
	OrgID           string
	ReportJobID     string
	ProcessedItemID string
	TraceID         string
}

// qualityJobPayload is the raw queue payload. Every field is kept raw so a
// non-string value is treated as absent, exactly like the NestJS readString
// helper, instead of failing the whole decode.
type qualityJobPayload struct {
	JobType         json.RawMessage `json:"jobType"`
	OrgID           json.RawMessage `json:"orgId"`
	ReportJobID     json.RawMessage `json:"reportJobId"`
	ProcessedItemID json.RawMessage `json:"processedItemId"`
	TraceID         json.RawMessage `json:"traceId"`
}

// parseQualityJob mirrors the processor's dispatch. ok is false when the payload
// must be skipped with a warning.
func parseQualityJob(raw json.RawMessage) (qualityJobDispatch, bool) {
	dispatch := qualityJobDispatch{}
	var payload qualityJobPayload
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			return dispatch, false
		}
	}
	jobType := payloadString(payload.JobType)
	orgID := payloadString(payload.OrgID)
	processedItemID := payloadString(payload.ProcessedItemID)
	reportJobID := payloadString(payload.ReportJobID)
	traceID := payloadString(payload.TraceID)

	if jobType == "review_seed_item" && orgID != "" && processedItemID != "" {
		return qualityJobDispatch{
			Kind:            qualityJobReviewSeed,
			OrgID:           orgID,
			ProcessedItemID: processedItemID,
			TraceID:         traceID,
		}, true
	}
	// Backward compatibility: report jobs written before jobType existed carry
	// only orgId and reportJobId.
	if orgID == "" || reportJobID == "" {
		return dispatch, false
	}
	return qualityJobDispatch{
		Kind:        qualityJobReport,
		OrgID:       orgID,
		ReportJobID: reportJobID,
		TraceID:     traceID,
	}, true
}

// payloadString mirrors readString: only a JSON string counts, and it is
// trimmed; everything else (missing, null, number, object) is empty.
func payloadString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// HandleQualityJob is the queue handler wired into the Go worker. A skipped
// payload is a completed job, not a failure, which matches the NestJS processor
// returning without throwing.
func (s *Service) HandleQualityJob(ctx context.Context, raw json.RawMessage) error {
	dispatch, ok := parseQualityJob(raw)
	if !ok {
		log.Printf("classification rss ops: skipping classification quality job with invalid payload")
		return nil
	}
	switch dispatch.Kind {
	case qualityJobReviewSeed:
		return s.ProcessReviewSeedItemJob(ctx, dispatch.OrgID, dispatch.ProcessedItemID)
	case qualityJobReport:
		return s.ProcessReportJob(ctx, dispatch.OrgID, dispatch.ReportJobID)
	default:
		return nil
	}
}

// shouldSeedReview mirrors `confidence === null || confidence >= gate -> return`:
// only a completed item with a numeric confidence strictly below the
// organization gate becomes a review seed.
func shouldSeedReview(confidence *float64, gateThreshold float64) bool {
	if confidence == nil {
		return false
	}
	return *confidence < gateThreshold
}

// reviewSeedProcessedItem is the projection processReviewSeedItemJob reads.
type reviewSeedProcessedItem struct {
	ItemMetaID bson.RawValue `bson:"itemMetaId"`
	SourceID   bson.RawValue `bson:"sourceId"`
	CreatedAt  bson.RawValue `bson:"createdAt"`
	Result     struct {
		Title              bson.RawValue `bson:"title"`
		Summary            bson.RawValue `bson:"summary"`
		Source             bson.RawValue `bson:"source"`
		Category           bson.RawValue `bson:"category"`
		CategoryPath       bson.RawValue `bson:"category_path"`
		CategoryConfidence bson.RawValue `bson:"category_confidence"`
		CategoryMethod     bson.RawValue `bson:"category_method"`
		CategoryCandidates bson.RawValue `bson:"category_candidates"`
	} `bson:"result"`
}

// classificationReviewInsert is the $setOnInsert payload of the review upsert.
// Field names, nulls and defaults match the ClassificationReview schema, and the
// unique {orgId, processedItemId} index is what makes the write idempotent.
type classificationReviewInsert struct {
	OrgID                   string               `bson:"orgId"`
	EvidenceID              string               `bson:"evidenceId"`
	ProcessedItemID         string               `bson:"processedItemId"`
	ItemMetaID              *string              `bson:"itemMetaId"`
	SourceID                *string              `bson:"sourceId"`
	SourceType              ClassifiedSourceType `bson:"sourceType"`
	ArticleURL              *string              `bson:"articleUrl"`
	ArticleTitle            *string              `bson:"articleTitle"`
	ArticleSummary          *string              `bson:"articleSummary"`
	PredictedCategoryPath   *string              `bson:"predictedCategoryPath"`
	PredictedLegacyCategory *string              `bson:"predictedLegacyCategory"`
	PredictedConfidence     float64              `bson:"predictedConfidence"`
	PredictedMethod         string               `bson:"predictedMethod"`
	CandidatePaths          []bson.RawValue      `bson:"candidatePaths"`
	Status                  string               `bson:"status"`
	CreatedAt               time.Time            `bson:"createdAt"`
}

// ProcessReviewSeedItemJob mirrors processReviewSeedItemJob: a completed
// processed item whose category confidence is below the organization gate turns
// into one pending ClassificationReview row.
func (s *Service) ProcessReviewSeedItemJob(ctx context.Context, orgID, processedItemID string) error {
	processedItemID = strings.TrimSpace(processedItemID)
	if processedItemID == "" {
		return nil
	}
	objectID, err := bson.ObjectIDFromHex(processedItemID)
	if err != nil {
		return fmt.Errorf("classification rss ops: invalid processedItemId %q: %w", processedItemID, err)
	}

	gateThreshold := s.gateMinConfidence(ctx, orgID)

	collection, err := s.collection(processedItemsCollection)
	if err != nil {
		return err
	}
	var document reviewSeedProcessedItem
	err = collection.FindOne(ctx,
		bson.D{
			{Key: "_id", Value: objectID},
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
		},
		options.FindOne().SetProjection(bson.D{
			{Key: "_id", Value: 1},
			{Key: "itemMetaId", Value: 1},
			{Key: "sourceId", Value: 1},
			{Key: "result.title", Value: 1},
			{Key: "result.summary", Value: 1},
			{Key: "result.source", Value: 1},
			{Key: "result.category", Value: 1},
			{Key: "result.category_path", Value: 1},
			{Key: "result.category_confidence", Value: 1},
			{Key: "result.category_method", Value: 1},
			{Key: "result.category_candidates", Value: 1},
			{Key: "createdAt", Value: 1},
		})).Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}

	confidence := rawConfidence(document.Result.CategoryConfidence)
	if !shouldSeedReview(confidence, gateThreshold) {
		return nil
	}

	policy := s.sourcePolicyFor(ctx, orgID)
	articleContexts, err := s.loadArticleContexts(ctx, orgID, []string{processedItemID})
	if err != nil {
		return err
	}
	articleContext := articleContexts[processedItemID]
	sourceID := rawString(document.SourceID)
	resolvedSourceID := sourceID
	if resolvedSourceID == nil {
		resolvedSourceID = articleContext.SourceID
	}
	var source *sourceInfo
	if resolvedSourceID != nil {
		source, err = s.loadSourceInfo(ctx, orgID, *resolvedSourceID)
		if err != nil {
			return err
		}
	}

	// The classifier reads the source row first and falls back to the result
	// document; the stored articleUrl always comes from the article context.
	classifierLabel := rawString(document.Result.Source)
	classifierURL := articleContext.ArticleURL
	if source != nil {
		name := source.Name
		classifierLabel = &name
		url := source.URL
		classifierURL = &url
	}
	sourceType := classifySourceByLabelAndURL(classifierLabel, classifierURL, policy)

	candidatePaths := []bson.RawValue{}
	if document.Result.CategoryCandidates.Type == bson.TypeArray {
		if err := document.Result.CategoryCandidates.Unmarshal(&candidatePaths); err != nil {
			return err
		}
		if candidatePaths == nil {
			candidatePaths = []bson.RawValue{}
		}
	}

	now := nowMillis()
	evidenceID := processedItemID + ":" + fmt.Sprint(now.UnixMilli())
	if createdAt := rawTime(document.CreatedAt); createdAt != nil {
		evidenceID = processedItemID + ":" + formatJSTime(*createdAt)
	}
	insert := classificationReviewInsert{
		OrgID:                   orgID,
		EvidenceID:              evidenceID,
		ProcessedItemID:         processedItemID,
		ItemMetaID:              rawString(document.ItemMetaID),
		SourceID:                resolvedSourceID,
		SourceType:              sourceType,
		ArticleURL:              articleContext.ArticleURL,
		ArticleTitle:            rawString(document.Result.Title),
		ArticleSummary:          rawString(document.Result.Summary),
		PredictedCategoryPath:   rawString(document.Result.CategoryPath),
		PredictedLegacyCategory: rawString(document.Result.Category),
		PredictedConfidence:     *confidence,
		PredictedMethod:         normalizeMethod(rawString(document.Result.CategoryMethod)),
		CandidatePaths:          candidatePaths,
		Status:                  "pending",
		CreatedAt:               now,
	}
	reviews, err := s.collection(reviewsCollection)
	if err != nil {
		return err
	}
	_, err = reviews.UpdateOne(ctx,
		bson.D{{Key: "orgId", Value: orgID}, {Key: "processedItemId", Value: processedItemID}},
		bson.D{
			{Key: "$setOnInsert", Value: bson.D{
				{Key: "orgId", Value: insert.OrgID},
				{Key: "evidenceId", Value: insert.EvidenceID},
				{Key: "processedItemId", Value: insert.ProcessedItemID},
				{Key: "itemMetaId", Value: insert.ItemMetaID},
				{Key: "sourceId", Value: insert.SourceID},
				{Key: "sourceType", Value: insert.SourceType},
				{Key: "articleUrl", Value: insert.ArticleURL},
				{Key: "articleTitle", Value: insert.ArticleTitle},
				{Key: "articleSummary", Value: insert.ArticleSummary},
				{Key: "predictedCategoryPath", Value: insert.PredictedCategoryPath},
				{Key: "predictedLegacyCategory", Value: insert.PredictedLegacyCategory},
				{Key: "predictedConfidence", Value: insert.PredictedConfidence},
				{Key: "predictedMethod", Value: insert.PredictedMethod},
				{Key: "candidatePaths", Value: insert.CandidatePaths},
				{Key: "status", Value: insert.Status},
				{Key: "createdAt", Value: insert.CreatedAt},
				{Key: "expiresAt", Value: expiryDate(reviewRetentionDays)},
			}},
			{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}},
		},
		options.UpdateOne().SetUpsert(true))
	if err != nil {
		return err
	}
	return nil
}

// reportResultDocument is one classificationreportresults row.
type reportResultDocument struct {
	ID               bson.ObjectID                `bson:"_id"`
	OrgID            string                       `bson:"orgId"`
	JobID            string                       `bson:"jobId"`
	SampleID         *string                      `bson:"sampleId"`
	Total            int                          `bson:"total"`
	Correct          int                          `bson:"correct"`
	Accuracy         float64                      `bson:"accuracy"`
	ConfusionMatrix  []reportResultConfusionEntry `bson:"confusionMatrix"`
	ProblemPathPairs []reportResultProblemPair    `bson:"problemPathPairs"`
	ExpiresAt        time.Time                    `bson:"expiresAt"`
	CreatedAt        time.Time                    `bson:"createdAt"`
	UpdatedAt        time.Time                    `bson:"updatedAt"`
	Version          int32                        `bson:"__v"`
}

// ProcessReportJob mirrors processReportJob. The failure branch marks the job
// document failed and returns the error so BullMQ applies the attempt/backoff
// policy; NestJS logged the error and swallowed it, which left the BullMQ job
// "completed" while the Mongo document said failed.
func (s *Service) ProcessReportJob(ctx context.Context, orgID, jobID string) error {
	jobObjectID, err := bson.ObjectIDFromHex(jobID)
	if err != nil {
		return fmt.Errorf("classification rss ops: invalid reportJobId %q: %w", jobID, err)
	}
	jobs, err := s.collection(reportJobsCollection)
	if err != nil {
		return err
	}
	filter := bson.D{{Key: "_id", Value: jobObjectID}, {Key: "orgId", Value: orgID}}
	setJob := func(fields bson.D) error {
		fields = append(fields, bson.E{Key: "updatedAt", Value: nowMillis()})
		_, err := jobs.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: fields}})
		return err
	}
	if err := setJob(bson.D{
		{Key: "status", Value: "running"},
		{Key: "progress", Value: 0.1},
		{Key: "startedAt", Value: nowMillis()},
	}); err != nil {
		return err
	}

	fail := func(cause error) error {
		log.Printf("classification rss ops: failed to build classification quality report %s: %v", jobID, cause)
		if updateErr := setJob(bson.D{
			{Key: "status", Value: "failed"},
			{Key: "completedAt", Value: nowMillis()},
			{Key: "error", Value: classificationReportJobError{Message: cause.Error()}},
		}); updateErr != nil {
			log.Printf("classification rss ops: failed to mark report job %s failed: %v", jobID, updateErr)
		}
		return cause
	}

	var job classificationReportJobDocument
	if err := jobs.FindOne(ctx, filter).Decode(&job); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return fail(err)
	}
	sampleID := reportJobSampleID(job.SampleID)

	metrics, err := s.computeSampleMetricsAggregated(ctx, orgID, sampleID)
	if err != nil {
		return fail(err)
	}
	if err := setJob(bson.D{{Key: "progress", Value: 0.75}}); err != nil {
		return fail(err)
	}

	confusionMatrix := make([]reportResultConfusionEntry, 0, len(metrics.ConfusionMatrix))
	for _, entry := range metrics.ConfusionMatrix {
		confusionMatrix = append(confusionMatrix, reportResultConfusionEntry{
			PredictedPath: entry.PredictedPath,
			ActualPath:    entry.ActualPath,
			Count:         entry.Count,
		})
	}
	problemPathPairs := make([]reportResultProblemPair, 0, len(metrics.ProblemPathPairs))
	for _, entry := range metrics.ProblemPathPairs {
		problemPathPairs = append(problemPathPairs, reportResultProblemPair{
			PredictedPath: entry.PredictedPath,
			ActualPath:    entry.ActualPath,
			Count:         entry.Count,
			ErrorRate:     entry.ErrorRate,
		})
	}

	now := nowMillis()
	resultObjectID := bson.NewObjectID()
	results, err := s.collection(reportResultsCollection)
	if err != nil {
		return fail(err)
	}
	if _, err := results.InsertOne(ctx, reportResultDocument{
		ID:               resultObjectID,
		OrgID:            orgID,
		JobID:            jobID,
		SampleID:         sampleID,
		Total:            metrics.Total,
		Correct:          metrics.Correct,
		Accuracy:         metrics.Accuracy,
		ConfusionMatrix:  confusionMatrix,
		ProblemPathPairs: problemPathPairs,
		ExpiresAt:        expiryDate(reportResultRetentionDays),
		CreatedAt:        now,
		UpdatedAt:        now,
	}); err != nil {
		return fail(err)
	}

	if err := setJob(bson.D{
		{Key: "status", Value: "completed"},
		{Key: "progress", Value: 1},
		{Key: "completedAt", Value: nowMillis()},
		{Key: "reportResultId", Value: resultObjectID.Hex()},
		{Key: "error", Value: nil},
	}); err != nil {
		return fail(err)
	}
	return nil
}
