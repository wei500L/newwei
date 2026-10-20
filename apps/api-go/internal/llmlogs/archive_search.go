package llmlogs

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ArchiveSearchWriter persists the per-attempt archive search model logs.
//
// It is a dedicated writer rather than the brief CompletionWriter because the
// NestJS log row uses requestType embedding/rerank and apiSurface
// embeddings/rerank. The metadata allowlist/prefix policy, organization and
// model normalization, redaction and document shape are the shared ones.
type ArchiveSearchWriter struct {
	service *Service
}

// NewArchiveSearchWriter reuses the shared MySQL pool and Mongo database.
func NewArchiveSearchWriter(db *sql.DB, mongoDatabase *mongo.Database) *ArchiveSearchWriter {
	return &ArchiveSearchWriter{service: NewService(db, mongoDatabase)}
}

// ArchiveSearchUsage is one attempt's upstream usage snapshot.
type ArchiveSearchUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// ArchiveSearchMetadata is the request metadata the archive search sends:
// {orgId, source}. feature stays null, exactly like the Nest archive path.
type ArchiveSearchMetadata struct {
	OrgID  string `json:"orgId"`
	Source string `json:"source"`
}

// ArchiveSearchEntry is one real logical model attempt.
type ArchiveSearchEntry struct {
	OrgID                     string
	RequestType               string
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     ArchiveSearchUsage
	GatewayProfileID          string
	GovernanceApplied         *bool
	AuthMode                  string
	GovernanceTargetProfileID string
	APISurface                string
	Metadata                  *ArchiveSearchMetadata
	OccurredAt                time.Time
}

// WriteArchiveSearchAttempt inserts one attempt. Callers log the returned error
// and continue: model logging is best effort and never fails a search.
func (w *ArchiveSearchWriter) WriteArchiveSearchAttempt(ctx context.Context, entry ArchiveSearchEntry) error {
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
		RequestType:               archiveRequestType(entry.RequestType),
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
		Metadata:                  w.service.filterArchiveSearchMetadata(ctx, entry.Metadata),
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

func archiveRequestType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "rerank":
		return "rerank"
	default:
		return "embedding"
	}
}

// entries exposes the two metadata leaves in a stable write order.
func (m ArchiveSearchMetadata) entries() []metadataEntry {
	orgID := m.OrgID
	source := m.Source
	return []metadataEntry{
		{Key: "orgId", Text: &orgID},
		{Key: "source", Text: &source},
	}
}

func (s *Service) filterArchiveSearchMetadata(ctx context.Context, metadata *ArchiveSearchMetadata) *bson.D {
	if s == nil || metadata == nil {
		return nil
	}
	return s.filterMetadataEntries(ctx, metadata.entries())
}
