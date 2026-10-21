package itempipeline

// TaskLog writes. writeTaskLogBestEffort in the NestJS code persists a TaskLog
// document and never fails the caller, so every write here is logged and
// swallowed.

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
	Data    json.RawMessage
	Error   json.RawMessage
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

// writeTaskLog is writeTaskLogBestEffort. A missing Mongo connection (unit
// wiring) is a warning, never an error.
func (p *Processor) writeTaskLog(ctx context.Context, entry taskLogEntry) {
	if p == nil || p.mongo == nil {
		return
	}
	now := msTime(p.now())
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
	if len(entry.Data) > 0 {
		var data any
		if err := json.Unmarshal(entry.Data, &data); err != nil {
			data = string(entry.Data)
		}
		document.Data = data
	}
	if len(entry.Error) > 0 {
		var errorValue any
		if err := json.Unmarshal(entry.Error, &errorValue); err != nil {
			errorValue = string(entry.Error)
		}
		document.Error = errorValue
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := p.mongo.Collection(taskLogsCollection).InsertOne(writeCtx, document); err != nil {
		log.Printf("itempipeline: failed to persist task log queue=%s jobId=%s stage=%s: %v",
			entry.Queue, entry.JobID, entry.Stage, err)
	}
}
