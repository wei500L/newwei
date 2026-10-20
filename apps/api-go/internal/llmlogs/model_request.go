package llmlogs

// This file exposes a typed, metadata-driven LLM request-log writer for the
// migrated archive classification and news classifier model calls. It reuses the
// existing document shape, organization/model/status normalization and the
// llm_request_log_settings metadata allowlist. No existing writer changes.

import (
	"context"
	"database/sql"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ModelRequestMetadataField is one ordered metadata leaf. Exactly one of Text,
// Number or List is set.
type ModelRequestMetadataField struct {
	Key    string
	Text   *string
	Number *float64
	List   []string
}

// ModelRequestEntry is one real model attempt.
type ModelRequestEntry struct {
	OrgID                     string
	RequestType               string
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     CompletionUsage
	Feature                   string
	GatewayProfileID          string
	GovernanceApplied         *bool
	AuthMode                  string
	GovernanceTargetProfileID string
	APISurface                string
	Metadata                  []ModelRequestMetadataField
	OccurredAt                time.Time
}

// ModelRequestWriter persists attempts with the shared request-log document.
type ModelRequestWriter struct {
	service *Service
}

// NewModelRequestWriter reuses the shared MySQL pool and Mongo database.
func NewModelRequestWriter(db *sql.DB, mongoDatabase *mongo.Database) *ModelRequestWriter {
	return &ModelRequestWriter{service: NewService(db, mongoDatabase)}
}

// Write persists one attempt. Logging is best effort at the caller.
func (w *ModelRequestWriter) Write(ctx context.Context, entry ModelRequestEntry) error {
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
		RequestType:               modelRequestType(entry.RequestType),
		Model:                     normalizeCompletionModel(entry.Model),
		Status:                    normalizeCompletionStatus(entry.Status),
		PromptTokens:              finiteOrNil(entry.Usage.PromptTokens),
		CompletionTokens:          finiteOrNil(entry.Usage.CompletionTokens),
		TotalTokens:               finiteOrNil(entry.Usage.TotalTokens),
		CostUSD:                   finiteOrNil(entry.Usage.CostUSD),
		Feature:                   normalizeFeatureToken(entry.Feature),
		GatewayProfileID:          normalizeLogProfileID(entry.GatewayProfileID),
		GovernanceApplied:         entry.GovernanceApplied,
		AuthMode:                  normalizeAuthMode(entry.AuthMode),
		GovernanceTargetProfileID: normalizeLogProfileID(entry.GovernanceTargetProfileID),
		LatencyMS:                 normalizeLatencyMS(entry.Latency),
		Error:                     normalizeCompletionError(entry.Status, entry.Error),
		Metadata:                  w.service.filterModelRequestMetadata(ctx, entry.Metadata),
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

func modelRequestType(value string) string {
	switch value {
	case "completion", "embedding", "rerank", "stream", "responses":
		return value
	default:
		return "completion"
	}
}

func (s *Service) filterModelRequestMetadata(ctx context.Context, fields []ModelRequestMetadataField) *bson.D {
	if s == nil || len(fields) == 0 {
		return nil
	}
	entries := make([]metadataEntry, 0, len(fields))
	for _, field := range fields {
		entries = append(entries, metadataEntry{
			Key:    field.Key,
			Text:   field.Text,
			Number: field.Number,
			List:   field.List,
		})
	}
	return s.filterMetadataEntries(ctx, entries)
}

// Metadata fields written by the migrated calls. Keeping these constructors in
// one place makes the request body and the log row share one field set.

// ArchiveClassificationEmbeddingMetadata is one archive embedding request.
type ArchiveClassificationEmbeddingMetadata struct {
	OrgID               string
	Layer               string
	TaxonomyVersion     string
	ProcessedArticleIDs []string
}

// ArchiveClassificationAnchorMetadata is one archive anchor embedding request.
type ArchiveClassificationAnchorMetadata struct {
	OrgID           string
	Layer           string
	TaxonomyVersion string
}

// ArchiveClassificationRerankMetadata is one archive rerank request.
type ArchiveClassificationRerankMetadata struct {
	OrgID              string
	Layer              string
	TaxonomyVersion    string
	ProcessedArticleID string
	ArticleID          string
}

// NewsClassifierMetadata is one news classifier request.
type NewsClassifierMetadata struct {
	OrgID string
	Layer string
	JobID string
}

func textField(key, value string) ModelRequestMetadataField {
	copy := value
	return ModelRequestMetadataField{Key: key, Text: &copy}
}

// Fields returns the ordered request-log metadata members.
func (m ArchiveClassificationEmbeddingMetadata) Fields() []ModelRequestMetadataField {
	return []ModelRequestMetadataField{
		textField("source", "archive-classification"),
		textField("layer", m.Layer),
		textField("orgId", m.OrgID),
		textField("taxonomyVersion", m.TaxonomyVersion),
		{Key: "processedArticleIds", List: m.ProcessedArticleIDs},
	}
}

// Fields returns the ordered request-log metadata members.
func (m ArchiveClassificationAnchorMetadata) Fields() []ModelRequestMetadataField {
	return []ModelRequestMetadataField{
		textField("source", "archive-classification"),
		textField("layer", m.Layer),
		textField("orgId", m.OrgID),
		textField("taxonomyVersion", m.TaxonomyVersion),
	}
}

// Fields returns the ordered request-log metadata members.
func (m ArchiveClassificationRerankMetadata) Fields() []ModelRequestMetadataField {
	return []ModelRequestMetadataField{
		textField("source", "archive-classification"),
		textField("layer", m.Layer),
		textField("orgId", m.OrgID),
		textField("processedArticleId", m.ProcessedArticleID),
		textField("articleId", m.ArticleID),
		textField("taxonomyVersion", m.TaxonomyVersion),
	}
}

// Fields returns the ordered request-log metadata members.
func (m NewsClassifierMetadata) Fields() []ModelRequestMetadataField {
	fields := []ModelRequestMetadataField{
		textField("source", "news-classifier"),
	}
	if m.Layer != "" {
		fields = append(fields, textField("layer", m.Layer))
	}
	fields = append(fields, textField("orgId", m.OrgID))
	if m.JobID != "" {
		fields = append(fields, textField("jobId", m.JobID))
	}
	return fields
}
