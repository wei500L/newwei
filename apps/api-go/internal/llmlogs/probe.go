package llmlogs

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// This file adds the log writer of the LLM gateway diagnostics: every real model
// attempt of test / test-config / proxy-lb-test persists one llmrequestlogs row.
// The fields and metadata mirror logGatewayProbeRequest in
// apps/api/src/modules/system-settings/llm-gateway-test.service.ts.
//
// The difference from the brief writer (completion.go) is deliberate: that one
// pins requestType=completion and only carries feature/eventTitle/sources, while
// this one accepts exactly completion/embedding/rerank, reports the matching
// apiSurface (chat_completions/responses/embeddings/rerank) and writes
// source/feature/operation/model/profileid/userid/tags. Both share the same
// settings, normalization and Mongo storage instead of duplicating the policy.

// ProbeFeature is the feature tag written by every probe.
const ProbeFeature = "gateway_test"

// ProbeRequestType is the request type of one probe. The values must match the
// NestJS LlmRequestType literals.
type ProbeRequestType string

// The three request types this batch can write.
const (
	// ProbeRequestCompletion is a chat/completions or responses probe.
	ProbeRequestCompletion ProbeRequestType = "completion"
	// ProbeRequestEmbedding is an embeddings probe.
	ProbeRequestEmbedding ProbeRequestType = "embedding"
	// ProbeRequestRerank is a rerank probe.
	ProbeRequestRerank ProbeRequestType = "rerank"
)

// ProbeAPISurface is the upstream surface a probe actually used.
type ProbeAPISurface string

// The four surfaces this batch can write.
const (
	// ProbeSurfaceChatCompletions maps to /v1/chat/completions.
	ProbeSurfaceChatCompletions ProbeAPISurface = "chat_completions"
	// ProbeSurfaceResponses maps to /v1/responses.
	ProbeSurfaceResponses ProbeAPISurface = "responses"
	// ProbeSurfaceEmbeddings maps to /v1/embeddings.
	ProbeSurfaceEmbeddings ProbeAPISurface = "embeddings"
	// ProbeSurfaceRerank maps to /v1/rerank.
	ProbeSurfaceRerank ProbeAPISurface = "rerank"
)

// errUnsupportedProbeType refuses to persist an undefined request type as
// another one.
var errUnsupportedProbeType = errors.New("llmlogs: unsupported probe request type")

// ProbeUsage is the token/cost of one probe. Values the upstream did not report
// stay nil instead of becoming 0.
type ProbeUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// ProbeMetadata is the metadata leaf set of one probe. Field order is the write
// order and matches the buildGatewayProbeMetadata object literal; an empty string
// or slice means the key must be absent from the document.
type ProbeMetadata struct {
	Source    string
	Feature   string
	Operation string
	Model     string
	ProfileID string
	UserID    string
	Tags      []string
}

// ProbeLogEntry is the log input of one real model attempt. The caller builds one
// per logical attempt: a primary-path 404/405 followed by a successful short path
// still writes a single row for the final outcome.
type ProbeLogEntry struct {
	OrgID                     string
	RequestType               ProbeRequestType
	APISurface                ProbeAPISurface
	Model                     string
	Status                    string
	Error                     string
	Latency                   time.Duration
	Usage                     ProbeUsage
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	Metadata                  ProbeMetadata
	OccurredAt                time.Time
}

// ProbeWriter persists probe rows. A write failure is best effort: the caller
// logs a warning and keeps the already computed diagnostic result.
type ProbeWriter struct {
	service *Service
}

// NewProbeWriter reuses the existing *sql.DB and Mongo connection; it opens no
// pool of its own.
func NewProbeWriter(db *sql.DB, mongoDatabase *mongo.Database) *ProbeWriter {
	return &ProbeWriter{service: NewService(db, mongoDatabase)}
}

// probeLogDocument is one llmrequestlogs row. Nullable fields are written as an
// explicit null, matching the Mongoose default.
type probeLogDocument struct {
	ID                        bson.ObjectID `bson:"_id"`
	OrgID                     string        `bson:"orgId"`
	RequestType               string        `bson:"requestType"`
	Model                     string        `bson:"model"`
	Status                    string        `bson:"status"`
	PromptTokens              *float64      `bson:"promptTokens"`
	CompletionTokens          *float64      `bson:"completionTokens"`
	TotalTokens               *float64      `bson:"totalTokens"`
	CostUSD                   *float64      `bson:"costUsd"`
	Feature                   *string       `bson:"feature"`
	GatewayProfileID          *string       `bson:"gatewayProfileId"`
	GovernanceApplied         *bool         `bson:"governanceApplied"`
	AuthMode                  *string       `bson:"authMode"`
	GovernanceTargetProfileID *string       `bson:"governanceTargetProfileId"`
	LatencyMS                 float64       `bson:"latencyMs"`
	Error                     *string       `bson:"error"`
	Metadata                  *bson.D       `bson:"metadata"`
	APISurface                *string       `bson:"apiSurface"`
	CreatedAt                 time.Time     `bson:"createdAt"`
	UpdatedAt                 time.Time     `bson:"updatedAt"`
}

// WriteProbe persists one row. A missing Mongo client or a failed insert returns
// an error so the caller can log the best-effort warning.
func (w *ProbeWriter) WriteProbe(ctx context.Context, entry ProbeLogEntry) error {
	if w == nil || w.service == nil {
		return errMongoUnavailable
	}
	requestType, ok := normalizeProbeRequestType(entry.RequestType)
	if !ok {
		return errUnsupportedProbeType
	}
	collection, err := w.service.collection()
	if err != nil {
		return err
	}
	metadata := w.service.filterMetadataEntries(ctx, entry.Metadata.entries())
	created := entry.OccurredAt.UTC()
	if created.IsZero() {
		created = nowMillis()
	} else {
		created = created.Truncate(time.Millisecond)
	}
	feature := ProbeFeature
	governanceApplied := entry.GovernanceApplied
	document := probeLogDocument{
		ID:                        bson.NewObjectID(),
		OrgID:                     normalizeCompletionOrgID(entry.OrgID),
		RequestType:               string(requestType),
		Model:                     normalizeCompletionModel(entry.Model),
		Status:                    normalizeCompletionStatus(entry.Status),
		PromptTokens:              finiteOrNil(entry.Usage.PromptTokens),
		CompletionTokens:          finiteOrNil(entry.Usage.CompletionTokens),
		TotalTokens:               finiteOrNil(entry.Usage.TotalTokens),
		CostUSD:                   finiteOrNil(entry.Usage.CostUSD),
		Feature:                   &feature,
		GatewayProfileID:          normalizeLogProfileID(entry.GatewayProfileID),
		GovernanceApplied:         &governanceApplied,
		AuthMode:                  normalizeAuthMode(entry.AuthMode),
		GovernanceTargetProfileID: normalizeLogProfileID(entry.GovernanceTargetProfileID),
		LatencyMS:                 normalizeLatencyMS(entry.Latency),
		Error:                     normalizeCompletionError(entry.Status, entry.Error),
		Metadata:                  metadata,
		APISurface:                optionalTrimmed(string(entry.APISurface)),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

// normalizeProbeRequestType accepts only the three request types this batch can
// produce, so an embedding or rerank probe can never be persisted as completion.
func normalizeProbeRequestType(value ProbeRequestType) (ProbeRequestType, bool) {
	switch value {
	case ProbeRequestCompletion:
		return ProbeRequestCompletion, true
	case ProbeRequestEmbedding:
		return ProbeRequestEmbedding, true
	case ProbeRequestRerank:
		return ProbeRequestRerank, true
	default:
		return "", false
	}
}

// entries renders the metadata leaves in the same order as the NestJS object
// literal. source/feature/operation/model are unconditional there, while
// profileid/userid are spread only when truthy: only an EMPTY string is dropped,
// so a whitespace-only value is kept exactly like JS truthiness keeps it.
func (m ProbeMetadata) entries() []metadataEntry {
	entries := make([]metadataEntry, 0, 7)
	appendAlways := func(key, value string) {
		text := value
		entries = append(entries, metadataEntry{Key: key, Text: &text})
	}
	appendWhenPresent := func(key, value string) {
		if value == "" {
			return
		}
		text := value
		entries = append(entries, metadataEntry{Key: key, Text: &text})
	}
	appendAlways("source", m.Source)
	appendAlways("feature", m.Feature)
	appendAlways("operation", m.Operation)
	appendAlways("model", m.Model)
	appendWhenPresent("profileid", m.ProfileID)
	appendWhenPresent("userid", m.UserID)
	if len(m.Tags) > 0 {
		entries = append(entries, metadataEntry{Key: "tags", List: m.Tags})
	}
	return entries
}
