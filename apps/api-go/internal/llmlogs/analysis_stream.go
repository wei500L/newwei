package llmlogs

import (
	"context"
	"database/sql"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// This file is the analysis-stream LLM request log writer. It is deliberately
// separate from CompletionWriter (requestType=completion) and from the RSS and
// gateway-probe writers: each product path keeps its own requestType and its
// own typed entry, while reusing the shared collection, normalization,
// metadata filtering and redaction helpers.
//
// The analysis chain sends no metadata and no explicit guardrails, so metadata
// is always BSON null and feature is always null. A failed log write is best
// effort: the analysis result has already been computed and must not become a
// failure because this row could not be inserted.

const analysisStreamRequestType = "stream"

// AnalysisStreamLogEntry is one real streamed model attempt.
type AnalysisStreamLogEntry struct {
	OrgID                     string
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     CompletionUsage
	GatewayProfileID          string
	GovernanceApplied         *bool
	AuthMode                  string
	GovernanceTargetProfileID string
	APISurface                string
	OccurredAt                time.Time
}

// AnalysisStreamWriter writes llmrequestlogs rows with requestType=stream.
type AnalysisStreamWriter struct {
	service *Service
}

// NewAnalysisStreamWriter reuses the shared MySQL pool (metadata policy) and
// Mongo connection; it opens no new connection.
func NewAnalysisStreamWriter(db *sql.DB, mongoDatabase *mongo.Database) *AnalysisStreamWriter {
	return &AnalysisStreamWriter{service: NewService(db, mongoDatabase)}
}

// WriteAttempt inserts one row. Callers treat every returned error as a
// warning, never as an analysis failure.
func (w *AnalysisStreamWriter) WriteAttempt(ctx context.Context, entry AnalysisStreamLogEntry) error {
	if w == nil || w.service == nil {
		return errMongoUnavailable
	}
	collection, err := w.service.collection()
	if err != nil {
		return err
	}
	created := entry.OccurredAt.UTC()
	if created.IsZero() {
		created = nowMillis()
	} else {
		created = created.Truncate(time.Millisecond)
	}
	document := completionLogDocument{
		ID:                        bson.NewObjectID(),
		OrgID:                     normalizeCompletionOrgID(entry.OrgID),
		RequestType:               analysisStreamRequestType,
		Model:                     normalizeCompletionModel(entry.Model),
		Status:                    normalizeCompletionStatus(entry.Status),
		PromptTokens:              finiteOrNil(entry.Usage.PromptTokens),
		CompletionTokens:          finiteOrNil(entry.Usage.CompletionTokens),
		TotalTokens:               finiteOrNil(entry.Usage.TotalTokens),
		CostUSD:                   finiteOrNil(entry.Usage.CostUSD),
		Feature:                   nil,
		GatewayProfileID:          normalizeLogProfileID(entry.GatewayProfileID),
		GovernanceApplied:         entry.GovernanceApplied,
		AuthMode:                  normalizeAuthMode(entry.AuthMode),
		GovernanceTargetProfileID: normalizeLogProfileID(entry.GovernanceTargetProfileID),
		LatencyMS:                 normalizeLatencyMS(entry.Latency),
		Error:                     normalizeCompletionError(entry.Status, entry.Error),
		Metadata:                  nil,
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}
