package workspace

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	itemPipelineQueue  = "itemPipeline"
	taskLogsCollection = "tasklogs"
)

// queueStatsCountsKey builds the Redis hash key that QueueOrgStatsService
// maintains for one organization.
func queueStatsCountsKey(orgID string) string {
	return "queue:" + itemPipelineQueue + ":org:" + orgID + ":counts"
}

// queueStats implements the queueStats root: MySQL item count, Mongo
// processed-item count, the Redis org counters, and the ten most recent
// itemPipeline task logs with their messages redacted.
func (s *service) queueStats(ctx contract.Context) (*QueueStatsModel, error) {
	callCtx := s.call(ctx)
	itemCount, err := s.countItemMeta(callCtx, ctx.Identity.OrgID)
	if err != nil {
		return nil, err
	}
	processedCount, err := s.countProcessedItems(callCtx, ctx.Identity.OrgID)
	if err != nil {
		return nil, err
	}
	counts, available := s.orgQueueCounts(callCtx, ctx.Identity.OrgID)
	logs, err := s.recentQueueLogs(callCtx, ctx.Identity.OrgID)
	if err != nil {
		return nil, err
	}
	return &QueueStatsModel{
		Counts:          counts,
		CountsAvailable: available,
		ItemCount:       itemCount,
		ProcessedCount:  processedCount,
		RecentLogs:      logs,
	}, nil
}

// countItemMeta counts the organization's MySQL items.
func (s *service) countItemMeta(ctx context.Context, orgID string) (int, error) {
	if s == nil || s.db == nil {
		return 0, errDatabaseUnavailable
	}
	var count int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ItemMeta WHERE orgId = ?", orgID).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// countProcessedItems counts the organization's Mongo processeditems.
func (s *service) countProcessedItems(ctx context.Context, orgID string) (int, error) {
	if s == nil || s.mongo == nil {
		return 0, errMongoUnavailable
	}
	count, err := s.mongo.Collection(processedItemsCollection).CountDocuments(ctx, bson.D{{Key: "orgId", Value: orgID}})
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// orgQueueCounts reads the five org counter fields from the Redis hash. A
// Redis failure is not an error: the counters become zero and countsAvailable
// is false, so consumers never read an all-zero hash as a healthy queue.
func (s *service) orgQueueCounts(ctx context.Context, orgID string) (QueueCountsModel, bool) {
	counts := QueueCountsModel{}
	if s == nil || s.redis == nil {
		return counts, false
	}
	key := queueStatsCountsKey(orgID)
	fields := []struct {
		name  string
		apply func(int)
	}{
		{name: "waiting", apply: func(value int) { counts.Waiting = value }},
		{name: "active", apply: func(value int) { counts.Active = value }},
		{name: "completed", apply: func(value int) { counts.Completed = value }},
		{name: "failed", apply: func(value int) { counts.Failed = value }},
		{name: "delayed", apply: func(value int) { counts.Delayed = value }},
	}
	for _, field := range fields {
		value, err := hashCounter(ctx, s.redis, key, field.name)
		if err != nil {
			return QueueCountsModel{}, false
		}
		field.apply(value)
	}
	return counts, true
}

// hashCounter reads and clamps one Redis hash counter like
// QueueOrgStatsService: a missing field is zero and a negative or unparsable
// value clamps to zero.
func hashCounter(ctx context.Context, client *redis.Client, key, field string) (int, error) {
	raw, err := client.HGet(ctx, key, field).Result()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	number, parseErr := strconv.ParseFloat(raw, 64)
	if parseErr != nil || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return 0, nil
	}
	return int(number), nil
}

// taskLogDoc is the projection of one tasklogs row used by queueStats.
type taskLogDoc struct {
	JobID     bson.RawValue `bson:"jobId"`
	Stage     bson.RawValue `bson:"stage"`
	Status    bson.RawValue `bson:"status"`
	Message   bson.RawValue `bson:"message"`
	CreatedAt bson.RawValue `bson:"createdAt"`
}

// queueLogData is the JSON payload the recentLogs.data string carries. Each
// field is a raw JSON token so a stored null stays null while a missing field
// is omitted, matching JSON.stringify over a JavaScript object.
type queueLogData struct {
	Stage   json.RawMessage `json:"stage,omitempty"`
	Status  json.RawMessage `json:"status,omitempty"`
	Message json.RawMessage `json:"message,omitempty"`
}

// recentQueueLogs loads the ten newest itemPipeline logs for the organization.
func (s *service) recentQueueLogs(ctx context.Context, orgID string) ([]QueueEventModel, error) {
	if s == nil || s.mongo == nil {
		return nil, errMongoUnavailable
	}
	cursor, err := s.mongo.Collection(taskLogsCollection).Find(ctx,
		bson.D{{Key: "orgId", Value: orgID}, {Key: "queue", Value: itemPipelineQueue}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(10))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	docs := make([]taskLogDoc, 0, 10)
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	out := make([]QueueEventModel, 0, len(docs))
	for _, doc := range docs {
		out = append(out, queueEventFromLog(doc, s.clock()))
	}
	return out, nil
}

// queueEventFromLog maps one task log onto the GraphQL queue event. The
// message is redacted before it is embedded in data.
func queueEventFromLog(doc taskLogDoc, now time.Time) QueueEventModel {
	stage, hasStage := rawStringValue(doc.Stage)
	status, hasStatus := rawStringValue(doc.Status)
	stageLabel := "stage"
	if hasStage {
		stageLabel = stage
	}
	statusLabel := "status"
	if hasStatus {
		statusLabel = status
	}
	jobID, hasJobID := rawStringValue(doc.JobID)
	if !hasJobID {
		jobID = "n/a"
	}
	payload := queueLogData{
		Stage:   rawJSONToken(doc.Stage, false),
		Status:  rawJSONToken(doc.Status, false),
		Message: rawJSONToken(doc.Message, true),
	}
	encoded, err := json.Marshal(payload)
	var data *string
	if err == nil {
		text := string(encoded)
		data = &text
	}
	timestamp := now.UTC()
	if stamp, ok := rawTimeValue(doc.CreatedAt); ok {
		timestamp = stamp
	}
	return QueueEventModel{
		Data:      data,
		Event:     strings.ToUpper(stageLabel + ":" + statusLabel),
		JobID:     jobID,
		Timestamp: contract.FormatDateTime(timestamp),
	}
}

// rawJSONToken converts a BSON value into a JSON token. When redact is true a
// string value is passed through RedactSensitiveFields first so a failure
// message cannot leak a bearer token or password.
func rawJSONToken(value bson.RawValue, redact bool) json.RawMessage {
	if value.IsZero() {
		return nil
	}
	switch value.Type {
	case bson.TypeNull, bson.TypeUndefined:
		return json.RawMessage("null")
	case bson.TypeString:
		text, ok := rawStringValue(value)
		if !ok {
			return nil
		}
		if redact {
			text = adminlogs.RedactSensitiveFields(text)
		}
		encoded, err := json.Marshal(text)
		if err != nil {
			return nil
		}
		return json.RawMessage(encoded)
	default:
		return nil
	}
}

// rawStringValue reads a BSON string and reports whether the value was a
// string rather than null, undefined, or another type.
func rawStringValue(value bson.RawValue) (string, bool) {
	if value.Type != bson.TypeString {
		return "", false
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return "", false
	}
	return text, true
}

// rawTimeValue reads a BSON date value.
func rawTimeValue(value bson.RawValue) (time.Time, bool) {
	if value.Type != bson.TypeDateTime {
		return time.Time{}, false
	}
	var stamp time.Time
	if err := value.Unmarshal(&stamp); err != nil {
		return time.Time{}, false
	}
	return stamp.UTC(), true
}
