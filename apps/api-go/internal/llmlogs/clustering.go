package llmlogs

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// This file adds the LLM request-log writer of the news-event clustering LLM
// backfill. It writes exactly one llmrequestlogs row per real model attempt,
// including failed attempts, and reuses the row document, normalization and
// metadata allowlist of the brief completion writer. The only new part is the
// typed metadata of this feature: feature, candidateCount and
// articleFingerprint. The default allowlist keeps feature only, so the other
// two fields are dropped unless the operator opts them in.

// ClusteringDecisionMetadata is the model-request metadata of one clustering
// LLM backfill decision.
type ClusteringDecisionMetadata struct {
	Feature            string
	CandidateCount     int
	ArticleFingerprint string
}

// entries returns the metadata fields in a stable write order.
func (m ClusteringDecisionMetadata) entries() []metadataEntry {
	feature := m.Feature
	count := float64(m.CandidateCount)
	fingerprint := m.ArticleFingerprint
	return []metadataEntry{
		{Key: "feature", Text: &feature},
		{Key: "candidateCount", Number: &count},
		{Key: "articleFingerprint", Text: &fingerprint},
	}
}

// ClusteringDecisionLogEntry is one real model attempt of the clustering LLM
// backfill.
type ClusteringDecisionLogEntry struct {
	OrgID                     string
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
	Metadata                  *ClusteringDecisionMetadata
	OccurredAt                time.Time
}

// WriteClusteringDecision writes one clustering decision attempt. The caller
// treats a failure as best effort: the backfill keeps its own error, and the
// missing audit row never changes the group status.
func (w *CompletionWriter) WriteClusteringDecision(ctx context.Context, entry ClusteringDecisionLogEntry) error {
	if w == nil || w.service == nil {
		return errMongoUnavailable
	}
	collection, err := w.service.collection()
	if err != nil {
		return err
	}
	metadata := w.service.filterMetadataEntries(ctx, clusteringMetadataEntries(entry.Metadata))
	created := entry.OccurredAt.UTC()
	if created.IsZero() {
		created = nowMillis()
	} else {
		created = created.Truncate(time.Millisecond)
	}
	document := completionLogDocument{
		ID:                        bson.NewObjectID(),
		OrgID:                     normalizeCompletionOrgID(entry.OrgID),
		RequestType:               completionRequestType,
		Model:                     normalizeCompletionModel(entry.Model),
		Status:                    normalizeCompletionStatus(entry.Status),
		PromptTokens:              finiteOrNil(entry.Usage.PromptTokens),
		CompletionTokens:          finiteOrNil(entry.Usage.CompletionTokens),
		TotalTokens:               finiteOrNil(entry.Usage.TotalTokens),
		CostUSD:                   finiteOrNil(entry.Usage.CostUSD),
		Feature:                   clusteringFeatureToken(entry.Feature, entry.Metadata),
		GatewayProfileID:          normalizeLogProfileID(entry.GatewayProfileID),
		GovernanceApplied:         entry.GovernanceApplied,
		AuthMode:                  normalizeAuthMode(entry.AuthMode),
		GovernanceTargetProfileID: normalizeLogProfileID(entry.GovernanceTargetProfileID),
		LatencyMS:                 normalizeLatencyMS(entry.Latency),
		Error:                     normalizeCompletionError(entry.Status, entry.Error),
		Metadata:                  metadata,
		APISurface:                optionalTrimmed(entry.APISurface),
		CreatedAt:                 created,
		UpdatedAt:                 created,
	}
	_, err = collection.InsertOne(ctx, document)
	return err
}

// clusteringMetadataEntries renders the typed metadata for the policy filter.
func clusteringMetadataEntries(metadata *ClusteringDecisionMetadata) []metadataEntry {
	if metadata == nil {
		return nil
	}
	return metadata.entries()
}

// clusteringFeatureToken mirrors completionFeatureToken for this feature: an
// explicit feature wins, otherwise the typed metadata feature is used.
func clusteringFeatureToken(value string, metadata *ClusteringDecisionMetadata) *string {
	if token := normalizeFeatureToken(value); token != nil {
		return token
	}
	if metadata == nil {
		return nil
	}
	return normalizeFeatureToken(metadata.Feature)
}
