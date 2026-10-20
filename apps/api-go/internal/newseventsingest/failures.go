package newseventsingest

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Clustering failure literals.
const (
	clusteringFailureStatusPending       = "pending"
	clusteringFailureReasonRequestFailed = "bertopic_request_failed"
)

// clusteringFailureEntityDoc is one entity inside a failure group item.
type clusteringFailureEntityDoc struct {
	Name       string   `bson:"name"`
	Type       *string  `bson:"type"`
	Confidence *float64 `bson:"confidence"`
}

// clusteringFailureItemDoc is one failed article of a failure group.
type clusteringFailureItemDoc struct {
	ProcessedArticleID string                       `bson:"processedArticleId"`
	ProcessedItemID    *string                      `bson:"processedItemId"`
	ArticleID          string                       `bson:"articleId"`
	Title              *string                      `bson:"title"`
	Summary            *string                      `bson:"summary"`
	Language           *string                      `bson:"language"`
	Category           *string                      `bson:"category"`
	CategoryPath       *string                      `bson:"categoryPath"`
	CategoryConfidence *float64                     `bson:"categoryConfidence"`
	Topics             []string                     `bson:"topics"`
	Entities           []clusteringFailureEntityDoc `bson:"entities"`
	QualityScore       *float64                     `bson:"qualityScore"`
	PublishedAt        *time.Time                   `bson:"publishedAt"`
	ProcessedAt        *time.Time                   `bson:"processedAt"`
	CrawlAt            *time.Time                   `bson:"crawlAt"`
}

// clusteringFailureMetadata is the `metadata` leaf the ingestion writes.
type clusteringFailureMetadata struct {
	RequestID     string `bson:"requestId"`
	DocumentCount int    `bson:"documentCount"`
}

// clusteringFailureInput is one recordFailure call.
type clusteringFailureInput struct {
	OrgID          string
	ClusteringMode string
	FailureReason  string
	FailureMessage string
	RequestID      *string
	Language       *string
	EmbeddingModel *string
	Items          []batchSignalDocument
	Metadata       clusteringFailureMetadata
	Now            time.Time
}

// recordFailure mirrors NewsEventClusteringFailureService.recordFailure: one
// upsert keyed by (orgId, groupId) that resets the group to pending, then one
// bertopic_failure_queue TaskLog. The returned groupId is also the TaskLog jobId.
func (a *assigner) recordFailure(ctx context.Context, input clusteringFailureInput) string {
	processedArticleIDs := make([]string, 0, len(input.Items))
	for _, item := range input.Items {
		processedArticleIDs = append(processedArticleIDs, item.Signal.ProcessedArticleID)
	}
	groupId := buildGroupId(input.OrgID, input.FailureReason, processedArticleIDs)

	sampleTitles := make([]string, 0, 5)
	for _, item := range input.Items {
		if item.Signal.Title == nil {
			continue
		}
		trimmed := jsTrim(*item.Signal.Title)
		if trimmed == "" {
			continue
		}
		sampleTitles = append(sampleTitles, trimmed)
		if len(sampleTitles) == 5 {
			break
		}
	}
	itemCount := len(input.Items)

	failureMessage := input.FailureMessage
	set := bson.D{
		{Key: "status", Value: clusteringFailureStatusPending},
		{Key: "clusteringMode", Value: input.ClusteringMode},
		{Key: "failureReason", Value: input.FailureReason},
		{Key: "failureMessage", Value: failureMessage},
		{Key: "requestId", Value: input.RequestID},
		{Key: "language", Value: input.Language},
		{Key: "embeddingModel", Value: input.EmbeddingModel},
		{Key: "itemCount", Value: itemCount},
		{Key: "sampleTitles", Value: sampleTitles},
		{Key: "items", Value: clusteringFailureItems(input.Items)},
		{Key: "metadata", Value: input.Metadata},
		{Key: "resolvedAt", Value: nil},
		{Key: "resolvedById", Value: nil},
		{Key: "resolutionMode", Value: nil},
		{Key: "resolvedEventIds", Value: []string{}},
		{Key: "lastError", Value: failureMessage},
		{Key: "activeJobId", Value: nil},
		{Key: "progressProcessedCount", Value: 0},
		{Key: "progressTotalCount", Value: itemCount},
		{Key: "lastRecoveryModel", Value: nil},
		{Key: "updatedAt", Value: input.Now},
	}
	update := bson.D{
		{Key: "$set", Value: set},
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "createdAt", Value: input.Now},
			{Key: "attemptCount", Value: 0},
			{Key: "lastAttemptAt", Value: nil},
			{Key: "__v", Value: 0},
		}},
	}
	filter := bson.D{
		{Key: "orgId", Value: input.OrgID},
		{Key: "groupId", Value: groupId},
	}
	// A failure to record the group must not swallow the caller's own success
	// path; the TaskLog below is written either way, exactly like the NestJS
	// best-effort writer.
	_ = a.store.upsertClusteringFailureFiltered(ctx, filter, update)

	data, err := marshalDocument(bertopicFailureLogData{
		FailureReason:  input.FailureReason,
		ClusteringMode: input.ClusteringMode,
		ItemCount:      itemCount,
		Language:       input.Language,
		EmbeddingModel: input.EmbeddingModel,
	})
	if err == nil {
		message := failureMessage
		_ = a.store.insertTaskLog(ctx, taskLogDocument{
			Queue:     taskLogQueueNewsEvents,
			JobID:     groupId,
			OrgID:     input.OrgID,
			Stage:     bertopicFailureQueueStage,
			Status:    taskLogStatusFailed,
			Message:   &message,
			Data:      data,
			CreatedAt: input.Now,
			UpdatedAt: input.Now,
		})
	}
	return groupId
}

// clusteringFailureItems maps the batch documents onto the stored item array.
// Empty topics and entities stay empty arrays, matching the Mongoose defaults
// the NestJS writer relies on.
func clusteringFailureItems(items []batchSignalDocument) []clusteringFailureItemDoc {
	documents := make([]clusteringFailureItemDoc, 0, len(items))
	for _, item := range items {
		signal := item.Signal
		entities := make([]clusteringFailureEntityDoc, 0, len(signal.Entities))
		for _, entity := range signal.Entities {
			entities = append(entities, clusteringFailureEntityDoc{
				Name:       entity.Name,
				Type:       entity.Type,
				Confidence: entity.Confidence,
			})
		}
		topics := make([]string, 0, len(signal.Topics))
		topics = append(topics, signal.Topics...)

		documents = append(documents, clusteringFailureItemDoc{
			ProcessedArticleID: signal.ProcessedArticleID,
			ProcessedItemID:    signal.ProcessedItemID,
			ArticleID:          signal.ArticleID,
			Title:              signal.Title,
			Summary:            signal.Summary,
			Language:           signal.Language,
			Category:           signal.LegacyCategory,
			CategoryPath:       signal.CategoryPath,
			CategoryConfidence: signal.CategoryConfidence,
			Topics:             topics,
			Entities:           entities,
			QualityScore:       signal.QualityScore,
			PublishedAt:        item.Entry.PublishedAt,
			ProcessedAt:        item.Entry.ProcessedAt,
			CrawlAt:            item.Entry.ArticleCrawlAt,
		})
	}
	return documents
}

// buildGroupId mirrors buildGroupId: sha1 over the organization, the failure
// reason and the sorted processedArticleIds joined with commas, truncated to 24
// hex characters.
func buildGroupId(orgID, failureReason string, processedArticleIDs []string) string {
	sorted := make([]string, len(processedArticleIDs))
	copy(sorted, processedArticleIDs)
	sort.Strings(sorted)

	hash := sha1.New()
	_, _ = hash.Write([]byte(orgID))
	_, _ = hash.Write([]byte("|"))
	_, _ = hash.Write([]byte(failureReason))
	_, _ = hash.Write([]byte("|"))
	for _, id := range sorted {
		_, _ = hash.Write([]byte(id))
		_, _ = hash.Write([]byte(","))
	}
	return hex.EncodeToString(hash.Sum(nil))[:24]
}

// upsertClusteringFailureFiltered applies the recordFailure upsert with an
// explicit findOneAndUpdate, so the stored document keeps the same field set as
// the NestJS original.
func (s *store) upsertClusteringFailureFiltered(ctx context.Context, filter bson.D, update bson.D) error {
	if s.mongo == nil {
		return errNoMongo
	}
	_, err := s.mongo.Collection(clusteringFailuresCollection).UpdateOne(ctx, filter, update,
		options.UpdateOne().SetUpsert(true))
	return err
}
