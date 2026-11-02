package exceptioningest

import (
	"encoding/json"
	"time"
)

// ExceptionEventKind is the ExceptionEventKind enum of the Nest exception
// service: "http", "graphql" or "unknown". It stays a string type so the stored
// documents keep the exact values the Nest normalizers write.
type ExceptionEventKind string

// The three kinds the Nest normalizers produce.
const (
	// KindHTTP is the event kind GlobalExceptionFilter records for an HTTP
	// exception. It is exported so the process-wide recorder can build the same
	// event the two migrated POST endpoints accept.
	KindHTTP ExceptionEventKind = "http"
	// KindGraphQL is the event kind GlobalExceptionFilter records for a GraphQL
	// resolver exception.
	KindGraphQL ExceptionEventKind = "graphql"
	// KindUnknown is the fallback kind for an exception raised outside an HTTP or
	// GraphQL host.
	KindUnknown ExceptionEventKind = "unknown"
)

// ExceptionEvent is the normalized, strongly-typed report both endpoints build
// before writing. Empty optional strings are omitted from the stored document,
// which matches Mongoose leaving an undefined field unset. The document id is
// generated when the report is stored.
type ExceptionEvent struct {
	OrgID         string
	UserID        string
	Kind          ExceptionEventKind
	TraceID       string
	Timestamp     time.Time
	StatusCode    *int
	Message       string
	Path          string
	Method        string
	Operation     string
	OperationName string
	ErrorName     string
	Stack         string
}

// eventDocument is the fixed Mongo document shape written into the existing
// "exceptionevents" collection. timestamp/createdAt/updatedAt are BSON Dates
// (not display strings) so the existing admin read endpoints can query them
// unchanged.
type eventDocument struct {
	ID            string             `bson:"id"`
	OrgID         string             `bson:"orgId,omitempty"`
	UserID        string             `bson:"userId,omitempty"`
	Kind          ExceptionEventKind `bson:"kind"`
	TraceID       string             `bson:"traceId"`
	Timestamp     time.Time          `bson:"timestamp"`
	StatusCode    *int               `bson:"statusCode,omitempty"`
	Message       string             `bson:"message"`
	Path          string             `bson:"path,omitempty"`
	Method        string             `bson:"method,omitempty"`
	Operation     string             `bson:"operation,omitempty"`
	OperationName string             `bson:"operationName,omitempty"`
	ErrorName     string             `bson:"errorName,omitempty"`
	Stack         string             `bson:"stack,omitempty"`
	CreatedAt     time.Time          `bson:"createdAt"`
	UpdatedAt     time.Time          `bson:"updatedAt"`
}

// okResponse is the legacy success payload both endpoints return:
// {"ok":true} with HTTP 201.
type okResponse struct {
	OK bool `json:"ok"`
}

// clientBody is the client endpoint's raw protocol leaf: every accepted field
// stays a json.RawMessage so the normalizers can reproduce the Nest
// controller's typeof/Number checks exactly. stack, orgId and userId are
// intentionally not read here (server-side identity wins and client stacks are
// never persisted).
type clientBody struct {
	Kind          json.RawMessage `json:"kind"`
	TraceID       json.RawMessage `json:"traceId"`
	Timestamp     json.RawMessage `json:"timestamp"`
	StatusCode    json.RawMessage `json:"statusCode"`
	Message       json.RawMessage `json:"message"`
	Path          json.RawMessage `json:"path"`
	Method        json.RawMessage `json:"method"`
	Operation     json.RawMessage `json:"operation"`
	OperationName json.RawMessage `json:"operationName"`
	ErrorName     json.RawMessage `json:"errorName"`
}

// internalBody is the internal endpoint's raw protocol leaf. It additionally
// accepts the internal caller's orgId/userId and a stack trace, which the
// client endpoint never accepts.
type internalBody struct {
	Kind          json.RawMessage `json:"kind"`
	TraceID       json.RawMessage `json:"traceId"`
	Timestamp     json.RawMessage `json:"timestamp"`
	StatusCode    json.RawMessage `json:"statusCode"`
	Message       json.RawMessage `json:"message"`
	Path          json.RawMessage `json:"path"`
	Method        json.RawMessage `json:"method"`
	Operation     json.RawMessage `json:"operation"`
	OperationName json.RawMessage `json:"operationName"`
	ErrorName     json.RawMessage `json:"errorName"`
	Stack         json.RawMessage `json:"stack"`
	OrgID         json.RawMessage `json:"orgId"`
	UserID        json.RawMessage `json:"userId"`
}
