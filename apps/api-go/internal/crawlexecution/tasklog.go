package crawlexecution

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// taskLogsCollection is Mongoose's pluralized TaskLog collection name.
const taskLogsCollection = "tasklogs"

// taskLogEntry is one TaskLog document. data/error are open leaves.
type taskLogEntry struct {
	Queue   string
	JobID   string
	OrgID   string
	Stage   string
	Status  string
	Message *string
	Data    any
	Error   any
}

type taskLogDocument struct {
	ID        bson.ObjectID `bson:"_id"`
	Queue     string        `bson:"queue"`
	JobID     string        `bson:"jobId"`
	OrgID     string        `bson:"orgId"`
	Stage     string        `bson:"stage"`
	Status    string        `bson:"status"`
	Message   *string       `bson:"message,omitempty"`
	Data      any           `bson:"data,omitempty"`
	Error     any           `bson:"error,omitempty"`
	CreatedAt time.Time     `bson:"createdAt"`
	UpdatedAt time.Time     `bson:"updatedAt"`
}

// writeTaskLog is writeTaskLogBestEffort: a persistence failure is logged and
// never fails the crawl.
func (s *Service) writeTaskLog(ctx context.Context, entry taskLogEntry) {
	if s == nil || s.mongo == nil {
		return
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	document := taskLogDocument{
		ID:        bson.NewObjectID(),
		Queue:     entry.Queue,
		JobID:     entry.JobID,
		OrgID:     entry.OrgID,
		Stage:     entry.Stage,
		Status:    entry.Status,
		Message:   entry.Message,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if entry.Data != nil {
		document.Data = normalizeTaskLogLeaf(entry.Data)
	}
	if entry.Error != nil {
		document.Error = normalizeTaskLogLeaf(entry.Error)
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := s.mongo.Collection(taskLogsCollection).InsertOne(writeCtx, document); err != nil {
		log.Printf("crawlexecution: failed to persist task log queue=%s jobId=%s stage=%s: %v",
			entry.Queue, entry.JobID, entry.Stage, err)
	}
}

// normalizeTaskLogLeaf converts typed values into the open map/any shape Mongo
// stores. Marshaling first keeps time.Time values in their JSON form, exactly
// like the Mongoose Mixed/Date round trip the NestJS writer performs.
func normalizeTaskLogLeaf(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return string(raw)
	}
	return decoded
}
