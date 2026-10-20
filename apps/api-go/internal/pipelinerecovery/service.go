package pipelinerecovery

import (
	"context"
	"database/sql"
	"errors"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

const (
	processedItemsCollection = "processeditems"
	taskLogsCollection       = "tasklogs"
	// itemPipelineQueueName mirrors ITEM_PIPELINE_QUEUE_NAME in
	// apps/api/src/modules/queue/queue.constants.ts.
	itemPipelineQueueName = "itemPipeline"

	runsLimitDefault = 5
	runsLimitMax     = 20
)

// Service carries the MySQL and Mongo reads behind the runs endpoint.
type Service struct {
	db       *sql.DB
	mongo    *mongo.Database
	logs     *adminlogs.Service
	producer *pipelineenqueue.Producer
}

// NewService assembles the dependencies. The adminlogs service is reused for
// machine-token authentication, exactly like the neighbouring quality handlers.
func NewService(db *sql.DB, database *mongo.Database) *Service {
	return &Service{db: db, mongo: database, logs: adminlogs.NewService(db, database)}
}

// NewServiceWithProducer adds the itemPipeline producer that the replay and
// rollback writes use. The read-only constructor keeps a nil producer so the
// runs endpoint never depends on Redis.
func NewServiceWithProducer(db *sql.DB, database *mongo.Database, producer *pipelineenqueue.Producer) *Service {
	service := NewService(db, database)
	service.producer = producer
	return service
}

// AuthenticateMachine resolves a mtk_ token through the shared adminlogs
// implementation.
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if s == nil || s.db == nil || s.logs == nil {
		return nil, newStatus(401, "Invalid machine token")
	}
	return s.logs.AuthenticateMachine(ctx, token)
}

// GetRuns mirrors PipelineRecoveryService.getRuns. limit is the already parsed
// query value; nil means "not supplied" and selects the default of 5.
func (s *Service) GetRuns(ctx context.Context, orgID, itemMetaID string, limit *float64) (RunsResponse, error) {
	if s == nil || s.db == nil {
		return RunsResponse{}, errors.New("pipelinerecovery: mysql is not configured")
	}
	if s.mongo == nil {
		return RunsResponse{}, errors.New("pipelinerecovery: mongo is not configured")
	}

	normalizedLimit := runsLimitDefault
	if limit != nil {
		normalizedLimit = int(floorValue(*limit))
	}
	if normalizedLimit < 1 {
		normalizedLimit = 1
	}
	if normalizedLimit > runsLimitMax {
		normalizedLimit = runsLimitMax
	}

	var itemMeta itemMetaRow
	err := s.db.QueryRowContext(ctx,
		"SELECT id, status, mongoRef FROM ItemMeta WHERE id = ? AND orgId = ? LIMIT 1",
		itemMetaID, orgID).Scan(&itemMeta.ID, &itemMeta.Status, &itemMeta.MongoRef)
	if errors.Is(err, sql.ErrNoRows) {
		return RunsResponse{}, newStatus(404, "Item not found")
	}
	if err != nil {
		return RunsResponse{}, err
	}

	processed, err := s.findProcessedItems(ctx, orgID, itemMetaID, normalizedLimit)
	if err != nil {
		return RunsResponse{}, err
	}

	runs := make([]RunSummary, 0, len(processed))
	for _, record := range processed {
		rawItemID := rawObjectIDString(record.RawItemID)
		if rawItemID == "" {
			rawItemID = derefString(rawString(record.RawItemID))
		}
		jobID := ""
		if rawItemID != "" {
			jobID = itemMetaID + "-" + rawItemID
		}
		createdAt := nowMillis()
		if value := rawTime(record.CreatedAt); value != nil {
			createdAt = *value
		}
		updatedAt := nowMillis()
		if value := rawTime(record.UpdatedAt); value != nil {
			updatedAt = *value
		}
		runs = append(runs, RunSummary{
			JobID:           jobID,
			RawItemID:       rawItemID,
			ProcessedItemID: rawObjectIDString(record.ID),
			Status:          statusString(record.Status, "unknown"),
			CreatedAt:       formatJSTime(createdAt),
			UpdatedAt:       formatJSTime(updatedAt),
		})
	}

	jobIDs := make([]string, 0, len(runs))
	for _, run := range runs {
		if run.JobID != "" {
			jobIDs = append(jobIDs, run.JobID)
		}
	}
	logsByJob, err := s.findTaskLogs(ctx, orgID, jobIDs)
	if err != nil {
		return RunsResponse{}, err
	}

	for index := range runs {
		runs[index].Stages = buildStages(logsByJob[runs[index].JobID])
	}

	return RunsResponse{
		ItemMetaID: itemMeta.ID,
		ItemStatus: itemMeta.Status,
		MongoRef:   itemMeta.MongoRef,
		Runs:       runs,
	}, nil
}

// findProcessedItems loads the most recent runs of one item.
func (s *Service) findProcessedItems(ctx context.Context, orgID, itemMetaID string, limit int) ([]processedItemRow, error) {
	collection := s.mongo.Collection(processedItemsCollection)
	limitValue := int64(limit)
	cursor, err := collection.Find(ctx,
		bson.D{{Key: "orgId", Value: orgID}, {Key: "itemMetaId", Value: itemMetaID}},
		options.Find().
			SetProjection(bson.D{
				{Key: "rawItemId", Value: 1},
				{Key: "status", Value: 1},
				{Key: "createdAt", Value: 1},
				{Key: "updatedAt", Value: 1},
			}).
			SetSort(bson.D{{Key: "createdAt", Value: -1}}).
			SetLimit(limitValue))
	if err != nil {
		return nil, err
	}
	var rows []processedItemRow
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// findTaskLogs groups the itemPipeline logs of the given job ids by job id, in
// ascending createdAt order (which is what makes "last log per stage" work).
func (s *Service) findTaskLogs(ctx context.Context, orgID string, jobIDs []string) (map[string][]taskLogRow, error) {
	grouped := make(map[string][]taskLogRow, len(jobIDs))
	if len(jobIDs) == 0 {
		return grouped, nil
	}
	collection := s.mongo.Collection(taskLogsCollection)
	cursor, err := collection.Find(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: itemPipelineQueueName},
			{Key: "jobId", Value: bson.D{{Key: "$in", Value: jobIDs}}},
		},
		options.Find().
			SetProjection(bson.D{
				{Key: "jobId", Value: 1},
				{Key: "stage", Value: 1},
				{Key: "status", Value: 1},
				{Key: "error", Value: 1},
				{Key: "createdAt", Value: 1},
			}).
			SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []taskLogRow
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, row := range rows {
		jobID := rawString(row.JobID)
		if jobID == nil || *jobID == "" {
			continue
		}
		grouped[*jobID] = append(grouped[*jobID], row)
	}
	return grouped, nil
}

// buildStages keeps the last log row of every stage (the input is ordered by
// createdAt ascending) and sorts the stages by name.
func buildStages(logs []taskLogRow) []RunStage {
	latestByStage := make(map[string]taskLogRow, len(logs))
	for _, log := range logs {
		stage := "unknown"
		if value := rawString(log.Stage); value != nil {
			stage = *value
		}
		latestByStage[stage] = log
	}
	stages := make([]RunStage, 0, len(latestByStage))
	for stage, log := range latestByStage {
		at := nowMillis()
		if value := rawTime(log.CreatedAt); value != nil {
			at = *value
		}
		stages = append(stages, RunStage{
			Stage:  stage,
			Status: statusString(log.Status, "pending"),
			At:     formatJSTime(at),
			Error:  stageErrorFromRaw(log.Error),
		})
	}
	sort.SliceStable(stages, func(left, right int) bool {
		return stages[left].Stage < stages[right].Stage
	})
	return stages
}

// floorValue truncates toward negative infinity, matching Math.floor.
func floorValue(value float64) float64 {
	truncated := float64(int64(value))
	if value < 0 && truncated != value {
		return truncated - 1
	}
	return truncated
}

// derefString returns the pointed-to string or "" for nil.
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
