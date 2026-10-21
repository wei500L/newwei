package newspipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// This file ports apps/api/src/modules/observability/task-log.writer.ts for the
// news pipeline: every stage outcome and every stage failure is written as one
// TaskLog document, best effort, so a logging failure never changes the pipeline
// result. The Mongoose TaskLog document shape is queue, jobId (string), orgId,
// stage, status, optional message/data, optional error, timestamps and __v.
//
// data is a typed struct per caller (stage outcome data or the stage-specific
// failure data) and is encoded through JSON first so the stored BSON document
// matches what Mongoose writes for a parsed JavaScript object: member order
// preserved and every number stored as a BSON double (JavaScript has a single
// number type). Open JSON leaves inside a typed struct stay json.RawMessage.

const taskLogsCollection = "tasklogs"

// TaskLog status literals (TaskLogWriteStatus).
const (
	pipelineTaskLogStatusCompleted = "completed"
	pipelineTaskLogStatusFailed    = "failed"
)

// taskLogBSONDocument embeds a BSON document as a value. A bare []byte/bson.Raw
// field would be encoded as a binary blob, so document-valued fields use this
// type and its MarshalBSON.
type taskLogBSONDocument []byte

// MarshalBSON returns the embedded document bytes unchanged.
func (d taskLogBSONDocument) MarshalBSON() ([]byte, error) { return []byte(d), nil }

// taskLogError is the TaskLog error sub-document. JavaScript's Error.stack has
// no Go equivalent in a migrated worker, so the member is deliberately absent
// (documented difference; message/name are preserved).
type taskLogError struct {
	Message string `json:"message" bson:"message"`
	Name    string `json:"name" bson:"name"`
}

// taskLogWritePayload is one writeTaskLogBestEffort call. Data is always one of
// this package's typed data structs or nil.
type taskLogWritePayload struct {
	Queue   string
	JobID   string
	OrgID   string
	Stage   string
	Status  string
	Message *string
	Data    any
	Error   *taskLogError
}

// taskLogDocument is one tasklogs document.
type taskLogDocument struct {
	Queue     string              `bson:"queue"`
	JobID     string              `bson:"jobId"`
	OrgID     string              `bson:"orgId"`
	Stage     string              `bson:"stage"`
	Status    string              `bson:"status"`
	Message   *string             `bson:"message,omitempty"`
	Data      taskLogBSONDocument `bson:"data,omitempty"`
	Error     taskLogBSONDocument `bson:"error,omitempty"`
	CreatedAt time.Time           `bson:"createdAt"`
	UpdatedAt time.Time           `bson:"updatedAt"`
	Version   int                 `bson:"__v"`
}

// writeTaskLog is writeTaskLogBestEffort: it never returns an error.
func (s *Service) writeTaskLog(ctx context.Context, payload taskLogWritePayload) {
	if s.mongo == nil {
		return
	}
	document, err := buildTaskLogDocument(payload, s.now())
	if err != nil {
		s.logf("failed to build task log for stage %s: %v", payload.Stage, err)
		return
	}
	if _, err := s.mongo.Collection(taskLogsCollection).InsertOne(ctx, document); err != nil {
		s.logf("failed to persist task log for stage %s: %v", payload.Stage, err)
	}
}

// buildTaskLogDocument converts one write payload into the stored document.
func buildTaskLogDocument(payload taskLogWritePayload, now time.Time) (taskLogDocument, error) {
	timestamp := now.UTC()
	document := taskLogDocument{
		Queue:     payload.Queue,
		JobID:     payload.JobID,
		OrgID:     payload.OrgID,
		Stage:     payload.Stage,
		Status:    payload.Status,
		Message:   payload.Message,
		CreatedAt: timestamp,
		UpdatedAt: timestamp,
	}
	data, err := taskLogJSONDocument(payload.Data)
	if err != nil {
		return taskLogDocument{}, err
	}
	document.Data = data
	if payload.Error != nil {
		encoded, err := taskLogJSONDocument(payload.Error)
		if err != nil {
			return taskLogDocument{}, err
		}
		document.Error = encoded
	}
	return document, nil
}

// taskLogJSONDocument encodes one typed data payload as the BSON document
// Mongoose writes for a parsed JavaScript object.
func taskLogJSONDocument(payload any) (taskLogBSONDocument, error) {
	if payload == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(encoded)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	if trimmed[0] != '{' {
		return nil, errors.New("task log data must be a JSON object")
	}
	var document bson.Raw
	if err := bson.UnmarshalExtJSON(trimmed, false, &document); err != nil {
		return nil, err
	}
	normalized, err := taskLogNormalizeBSONDocument(document)
	if err != nil {
		return nil, err
	}
	bytesOut, err := bson.Marshal(normalized)
	if err != nil {
		return nil, err
	}
	return taskLogBSONDocument(bytesOut), nil
}

// taskLogNormalizeBSONDocument rewrites one document so every number is a BSON
// double, matching JavaScript's single number type.
func taskLogNormalizeBSONDocument(document bson.Raw) (bson.D, error) {
	elements, err := document.Elements()
	if err != nil {
		return nil, err
	}
	rewritten := make(bson.D, 0, len(elements))
	for _, element := range elements {
		key, err := element.KeyErr()
		if err != nil {
			return nil, err
		}
		value, err := element.ValueErr()
		if err != nil {
			return nil, err
		}
		rewritten = append(rewritten, bson.E{Key: key, Value: taskLogNativeBSONValue(value)})
	}
	return rewritten, nil
}

// taskLogNativeBSONValue converts one raw value to its JavaScript-typed Go value
// so the re-encode stores numbers as doubles. Values this converter does not
// model are returned as the original raw value and written unchanged.
func taskLogNativeBSONValue(value bson.RawValue) any {
	if number, ok := value.DoubleOK(); ok {
		return number
	}
	if number, ok := value.Int32OK(); ok {
		return float64(number)
	}
	if number, ok := value.Int64OK(); ok {
		return float64(number)
	}
	if text, ok := value.StringValueOK(); ok {
		return text
	}
	if boolean, ok := value.BooleanOK(); ok {
		return boolean
	}
	if value.Type == bson.TypeNull || value.Type == bson.TypeUndefined {
		return nil
	}
	if nested, ok := value.DocumentOK(); ok {
		document, err := taskLogNormalizeBSONDocument(nested)
		if err != nil {
			return value
		}
		return document
	}
	if array, ok := value.ArrayOK(); ok {
		values, err := bson.Raw(array).Values()
		if err != nil {
			return value
		}
		rewritten := make(bson.A, 0, len(values))
		for _, entry := range values {
			rewritten = append(rewritten, taskLogNativeBSONValue(entry))
		}
		return rewritten
	}
	return value
}

// pipelineErrorName is the JavaScript error.name equivalent. Go errors expose a
// name only when they implement Name() string (the queue permanent error, the
// zod-shaped parse error); everything else is reported as "Error".
func pipelineErrorName(err error) string {
	if err == nil {
		return "Error"
	}
	var named interface{ Name() string }
	if errors.As(err, &named) {
		if name := named.Name(); name != "" {
			return name
		}
	}
	return "Error"
}

// pipelineErrorDetails builds the TaskLog error sub-document.
func pipelineErrorDetails(err error) *taskLogError {
	if err == nil {
		return nil
	}
	return &taskLogError{Message: err.Error(), Name: pipelineErrorName(err)}
}
