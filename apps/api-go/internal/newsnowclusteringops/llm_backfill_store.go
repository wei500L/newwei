package newsnowclusteringops

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// This file adds the Mongo/MySQL persistence of the news-event clustering LLM
// backfill chain. Every state transition mirrors the NestJS
// NewsEventClusteringFailureService methods; the stale-processing recovery
// (R1) is the only new rule and is documented on its method.

// llmBackfillCandidate is one pending failure group returned by the
// five-minute scan.
type llmBackfillCandidate struct {
	OrgID         string
	GroupID       string
	AttemptCount  int
	ItemCount     int
	LastAttemptAt *time.Time
}

// markLlmBackfillQueued atomically claims a pending group and records the job
// that now owns it. The {status: "pending"} predicate is the lock: two
// concurrent manual requests both pass the status pre-check, but only one wins
// this compare-and-set. A nil result means the caller must classify the
// current state.
func (s *clusteringStore) markLlmBackfillQueued(ctx context.Context, orgID, groupID, jobID string, model *string, startedAt time.Time) (*clusteringFailureDoc, error) {
	var doc clusteringFailureDoc
	err := s.failures().FindOneAndUpdate(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
			{Key: "status", Value: ClusteringFailureStatusPending},
		},
		mongo.Pipeline{
			bson.D{{Key: "$set", Value: bson.D{
				{Key: "status", Value: ClusteringFailureStatusProcessing},
				{Key: "lastAttemptAt", Value: startedAt},
				{Key: "lastError", Value: nil},
				{Key: "activeJobId", Value: jobID},
				{Key: "progressProcessedCount", Value: 0},
				{Key: "progressTotalCount", Value: bson.D{
					{Key: "$size", Value: bson.D{
						{Key: "$ifNull", Value: bson.A{"$items", bson.A{}}},
					}},
				}},
				{Key: "lastRecoveryModel", Value: model},
				{Key: "resolvedAt", Value: nil},
				{Key: "resolvedById", Value: nil},
				{Key: "resolutionMode", Value: nil},
				{Key: "resolvedEventIds", Value: bson.A{}},
				{Key: "attemptCount", Value: bson.D{
					{Key: "$add", Value: bson.A{
						bson.D{{Key: "$ifNull", Value: bson.A{"$attemptCount", 0}}},
						1,
					}},
				}},
			}}},
		},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// updateLlmBackfillProgress records the per-article progress. An empty jobID or
// model leaves the stored value untouched, exactly like the NestJS conditional
// spreads.
func (s *clusteringStore) updateLlmBackfillProgress(ctx context.Context, orgID, groupID string, processedCount, totalCount int, jobID, model *string) error {
	set := bson.D{
		{Key: "status", Value: ClusteringFailureStatusProcessing},
		{Key: "progressProcessedCount", Value: maxInt(processedCount, 0)},
		{Key: "progressTotalCount", Value: maxInt(totalCount, 0)},
	}
	if jobID != nil && *jobID != "" {
		set = append(set, bson.E{Key: "activeJobId", Value: *jobID})
	}
	if model != nil && *model != "" {
		set = append(set, bson.E{Key: "lastRecoveryModel", Value: *model})
	}
	_, err := s.failures().UpdateOne(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
		},
		bson.D{{Key: "$set", Value: set}},
	)
	return err
}

// markLlmBackfillResolved marks the group resolved and returns resolvedAt.
func (s *clusteringStore) markLlmBackfillResolved(ctx context.Context, orgID, groupID, actorID string, processedCount, totalCount int, model *string, resolvedEventIDs []string) (time.Time, error) {
	resolvedAt := time.Now().UTC().Truncate(time.Millisecond)
	sorted := make([]string, len(resolvedEventIDs))
	copy(sorted, resolvedEventIDs)
	sortStrings(sorted)
	_, err := s.failures().UpdateOne(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusResolved},
			{Key: "progressProcessedCount", Value: maxInt(processedCount, 0)},
			{Key: "progressTotalCount", Value: maxInt(totalCount, 0)},
			{Key: "lastError", Value: nil},
			{Key: "activeJobId", Value: nil},
			{Key: "resolvedAt", Value: resolvedAt},
			{Key: "resolvedById", Value: actorID},
			{Key: "resolutionMode", Value: "llm_backfill"},
			{Key: "resolvedEventIds", Value: sorted},
			{Key: "lastRecoveryModel", Value: model},
		}}},
	)
	return resolvedAt, err
}

// markLlmBackfillFailed returns the group to pending with the current progress.
func (s *clusteringStore) markLlmBackfillFailed(ctx context.Context, orgID, groupID string, processedCount, totalCount int, errorMessage string, model *string) error {
	_, err := s.failures().UpdateOne(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusPending},
			{Key: "progressProcessedCount", Value: maxInt(processedCount, 0)},
			{Key: "progressTotalCount", Value: maxInt(totalCount, 0)},
			{Key: "lastError", Value: errorMessage},
			{Key: "activeJobId", Value: nil},
			{Key: "lastRecoveryModel", Value: model},
		}}},
	)
	return err
}

// listPendingAutoRetryCandidates returns the pending BERTopic groups that have
// not been attempted inside the retry window, oldest attempt first. The
// predicate and the sort mirror listPendingAutoRetryCandidates in NestJS.
func (s *clusteringStore) listPendingAutoRetryCandidates(ctx context.Context, limit int, retryAfter time.Duration, now time.Time) ([]llmBackfillCandidate, error) {
	if limit <= 0 {
		limit = LlmBackfillBatchSize
	}
	if limit > 100 {
		limit = 100
	}
	retryBefore := now.Add(-retryAfter)
	cursor, err := s.failures().Find(ctx,
		bson.D{
			{Key: "status", Value: ClusteringFailureStatusPending},
			{Key: "clusteringMode", Value: "bertopic_primary"},
			{Key: "itemCount", Value: bson.D{{Key: "$gt", Value: 0}}},
			{Key: "$or", Value: bson.A{
				bson.D{{Key: "lastAttemptAt", Value: nil}},
				bson.D{{Key: "lastAttemptAt", Value: bson.D{{Key: "$lte", Value: retryBefore}}}},
			}},
		},
		options.Find().
			SetSort(bson.D{
				{Key: "lastAttemptAt", Value: 1},
				{Key: "createdAt", Value: 1},
			}).
			SetLimit(int64(limit)).
			SetProjection(bson.D{
				{Key: "orgId", Value: 1},
				{Key: "groupId", Value: 1},
				{Key: "attemptCount", Value: 1},
				{Key: "itemCount", Value: 1},
				{Key: "lastAttemptAt", Value: 1},
			}),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	candidates := make([]llmBackfillCandidate, 0, limit)
	for cursor.Next(ctx) {
		var row struct {
			OrgID         *string    `bson:"orgId"`
			GroupID       *string    `bson:"groupId"`
			AttemptCount  int        `bson:"attemptCount"`
			ItemCount     int        `bson:"itemCount"`
			LastAttemptAt *time.Time `bson:"lastAttemptAt"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		orgID := trimOptionalString(row.OrgID)
		groupID := trimOptionalString(row.GroupID)
		if orgID == "" || groupID == "" {
			continue
		}
		candidates = append(candidates, llmBackfillCandidate{
			OrgID:         orgID,
			GroupID:       groupID,
			AttemptCount:  maxInt(row.AttemptCount, 0),
			ItemCount:     maxInt(row.ItemCount, 0),
			LastAttemptAt: row.LastAttemptAt,
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

// listStaleProcessingGroups returns processing groups whose last attempt is
// older than the retry window. The liveness probe decides which of them are
// really lost; this query is only the cheap first filter.
func (s *clusteringStore) listStaleProcessingGroups(ctx context.Context, olderThan time.Time, limit int) ([]clusteringFailureDoc, error) {
	if limit <= 0 {
		limit = LlmBackfillStaleBatchSize
	}
	cursor, err := s.failures().Find(ctx,
		bson.D{
			{Key: "status", Value: ClusteringFailureStatusProcessing},
			{Key: "lastAttemptAt", Value: bson.D{{Key: "$lt", Value: olderThan}}},
		},
		options.Find().
			SetSort(bson.D{{Key: "lastAttemptAt", Value: 1}}).
			SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	rows := make([]clusteringFailureDoc, 0, limit)
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// recoverStaleProcessingGroup conditionally returns one stuck group to pending.
// The condition repeats status=processing and the exact activeJobId read by the
// caller, so a group that changed owner between the read and the update is
// never stolen.
func (s *clusteringStore) recoverStaleProcessingGroup(ctx context.Context, orgID, groupID string, activeJobID *string) (bool, error) {
	result, err := s.failures().UpdateOne(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
			{Key: "status", Value: ClusteringFailureStatusProcessing},
			{Key: "activeJobId", Value: activeJobID},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusPending},
			{Key: "lastError", Value: msgLlmBackfillLostJob},
			{Key: "activeJobId", Value: nil},
		}}},
	)
	if err != nil {
		return false, err
	}
	return result.MatchedCount > 0, nil
}

// llmBackfillLogData is the sealed data payload of an LLM backfill task log.
// Each stage has its own named struct; the interface only exists so one
// document type can carry the typed payload.
type llmBackfillLogData interface {
	llmBackfillLogData()
}

// llmBackfillQueueLogData is the data of the pending llm_backfill_queue log.
type llmBackfillQueueLogData struct {
	GroupID   string  `bson:"groupId"`
	Model     *string `bson:"model"`
	ItemCount int     `bson:"itemCount"`
	Trigger   string  `bson:"trigger"`
}

func (llmBackfillQueueLogData) llmBackfillLogData() {}

// llmBackfillStartLogData is the data of the processing llm_backfill log.
type llmBackfillStartLogData struct {
	GroupID   string  `bson:"groupId"`
	ItemCount int     `bson:"itemCount"`
	Model     *string `bson:"model"`
	Trigger   string  `bson:"trigger"`
}

func (llmBackfillStartLogData) llmBackfillLogData() {}

// llmBackfillCompletedLogData is the data of the completed llm_backfill log.
type llmBackfillCompletedLogData struct {
	GroupID          string   `bson:"groupId"`
	AssignedCount    int      `bson:"assignedCount"`
	SkippedCount     int      `bson:"skippedCount"`
	ProcessedCount   int      `bson:"processedCount"`
	TotalCount       int      `bson:"totalCount"`
	Model            *string  `bson:"model"`
	Trigger          string   `bson:"trigger"`
	ResolvedEventIDs []string `bson:"resolvedEventIds"`
	ResolvedAt       string   `bson:"resolvedAt"`
}

func (llmBackfillCompletedLogData) llmBackfillLogData() {}

// llmBackfillFailedLogData is the data of the failed llm_backfill log.
type llmBackfillFailedLogData struct {
	GroupID        string  `bson:"groupId"`
	ProcessedCount int     `bson:"processedCount"`
	TotalCount     int     `bson:"totalCount"`
	Model          *string `bson:"model"`
	Trigger        string  `bson:"trigger"`
}

func (llmBackfillFailedLogData) llmBackfillLogData() {}

// llmBackfillRecoveryLogData is the data of the R1 recovery log.
type llmBackfillRecoveryLogData struct {
	GroupID       string  `bson:"groupId"`
	PreviousJobID *string `bson:"previousJobId"`
}

func (llmBackfillRecoveryLogData) llmBackfillLogData() {}

// llmBackfillTaskLogDocument is one tasklogs document of this chain.
type llmBackfillTaskLogDocument struct {
	Queue     string             `bson:"queue"`
	JobID     string             `bson:"jobId"`
	OrgID     string             `bson:"orgId"`
	Stage     string             `bson:"stage"`
	Status    string             `bson:"status"`
	Message   string             `bson:"message,omitempty"`
	Data      llmBackfillLogData `bson:"data,omitempty"`
	CreatedAt time.Time          `bson:"createdAt"`
	UpdatedAt time.Time          `bson:"updatedAt"`
}

// insertLlmBackfillTaskLog writes one task log best effort, mirroring
// writeTaskLogBestEffort. A nil Mongo handle or a write failure is swallowed.
func (s *clusteringStore) insertLlmBackfillTaskLog(ctx context.Context, jobID, orgID, stage, status, message string, data llmBackfillLogData, now time.Time) {
	if s.mongo == nil {
		return
	}
	document := llmBackfillTaskLogDocument{
		Queue:     LlmBackfillQueueName,
		JobID:     jobID,
		OrgID:     orgID,
		Stage:     stage,
		Status:    status,
		Message:   message,
		Data:      data,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_, _ = s.mongo.Collection(taskLogsCollection).InsertOne(ctx, document)
}

// summaryEmbedding is the summary vector and its embedding-model name loaded
// from one ProcessedItem.
type summaryEmbedding struct {
	Model  string
	Vector []float64
}

// loadSummaryEmbedding reads summaryEmbedding/summaryEmbeddingModel of one
// ProcessedItem. A missing, malformed or non-numeric vector yields nil, exactly
// like tryResolveSummaryEmbedding returning null.
func (s *clusteringStore) loadSummaryEmbedding(ctx context.Context, processedItemID *string) *summaryEmbedding {
	if s.mongo == nil || processedItemID == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*processedItemID)
	if trimmed == "" {
		return nil
	}
	objectID, err := bson.ObjectIDFromHex(trimmed)
	if err != nil {
		return nil
	}
	var doc struct {
		Embedding []float64 `bson:"summaryEmbedding"`
		Model     *string   `bson:"summaryEmbeddingModel"`
	}
	err = s.mongo.Collection(processedItemsCollection).FindOne(ctx,
		bson.D{{Key: "_id", Value: objectID}},
		options.FindOne().SetProjection(bson.D{
			{Key: "summaryEmbedding", Value: 1},
			{Key: "summaryEmbeddingModel", Value: 1},
		}),
	).Decode(&doc)
	if err != nil {
		return nil
	}
	if len(doc.Embedding) == 0 || doc.Model == nil {
		return nil
	}
	model := strings.TrimSpace(*doc.Model)
	if model == "" {
		return nil
	}
	return &summaryEmbedding{Model: model, Vector: doc.Embedding}
}

// listMembershipsByProcessedItemIDs maps processedItemId to its eventId for one
// organization. The caller only uses ids returned by a vector search.
func (s *clusteringStore) listMembershipsByProcessedItemIDs(ctx context.Context, orgID string, processedItemIDs []string) (map[string]string, error) {
	if len(processedItemIDs) == 0 {
		return map[string]string{}, nil
	}
	query := "SELECT eventId, processedItemId FROM NewsEventItem WHERE orgId = ? AND processedItemId IN (" +
		placeholders(len(processedItemIDs)) + ") ORDER BY id ASC"
	args := make([]any, 0, len(processedItemIDs)+1)
	args = append(args, orgID)
	for _, id := range processedItemIDs {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	memberships := make(map[string]string, len(processedItemIDs))
	for rows.Next() {
		var eventID string
		var processedItemID sql.NullString
		if err := rows.Scan(&eventID, &processedItemID); err != nil {
			return nil, err
		}
		if !processedItemID.Valid {
			continue
		}
		key := strings.TrimSpace(processedItemID.String)
		if key == "" {
			continue
		}
		// Map semantics of the NestJS `new Map(entries)`: the last row wins.
		memberships[key] = eventID
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return memberships, nil
}

// newsEventCandidateDetail is one event row considered by the LLM candidate
// listing.
type newsEventCandidateDetail struct {
	ID            string
	Title         *string
	Summary       *string
	Language      *string
	PrimaryTopic  *string
	PrimaryEntity *string
	MetadataJSON  []byte
	StartAt       time.Time
	LastAt        time.Time
	ItemCount     int
}

// listNewsEventCandidateDetails loads the display fields, classification
// metadata and item count of the given active events.
func (s *clusteringStore) listNewsEventCandidateDetails(ctx context.Context, orgID string, eventIDs []string) ([]newsEventCandidateDetail, error) {
	if len(eventIDs) == 0 {
		return nil, nil
	}
	query := "SELECT e.id, e.title, e.summary, e.language, e.primaryTopic, e.primaryEntity, e.metadata, e.startAt, e.lastAt," +
		" (SELECT COUNT(*) FROM NewsEventItem i WHERE i.eventId = e.id) AS itemCount" +
		" FROM NewsEvent e WHERE e.orgId = ? AND e.status = 'active' AND e.id IN (" +
		placeholders(len(eventIDs)) + ")"
	args := make([]any, 0, len(eventIDs)+1)
	args = append(args, orgID)
	for _, id := range eventIDs {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	events := make([]newsEventCandidateDetail, 0, len(eventIDs))
	for rows.Next() {
		var event newsEventCandidateDetail
		var title, summary, language, topic, entity sql.NullString
		var metadata []byte
		if err := rows.Scan(&event.ID, &title, &summary, &language, &topic, &entity, &metadata,
			&event.StartAt, &event.LastAt, &event.ItemCount); err != nil {
			return nil, err
		}
		event.Title = nullStringPointer(title)
		event.Summary = nullStringPointer(summary)
		event.Language = nullStringPointer(language)
		event.PrimaryTopic = nullStringPointer(topic)
		event.PrimaryEntity = nullStringPointer(entity)
		event.MetadataJSON = metadata
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

// placeholders renders "?, ?, ?" for an IN clause.
func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

// trimOptionalString trims a nullable string, mapping nil/blank to "".
func trimOptionalString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
