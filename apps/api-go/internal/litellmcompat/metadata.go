package litellmcompat

import (
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// ArchiveEmbeddingMetadata is the archive classification embedding metadata.
type ArchiveEmbeddingMetadata struct {
	Layer               string
	OrgID               string
	TaxonomyVersion     string
	ProcessedArticleIDs []string
}

type archiveEmbeddingPayload struct {
	Source              string   `json:"source"`
	Layer               string   `json:"layer"`
	OrgID               string   `json:"orgId"`
	TaxonomyVersion     string   `json:"taxonomyVersion"`
	ProcessedArticleIDs []string `json:"processedArticleIds"`
}

// JSONValue returns the ordered request metadata object.
func (m ArchiveEmbeddingMetadata) JSONValue() any {
	return archiveEmbeddingPayload{
		Source:              "archive-classification",
		Layer:               m.Layer,
		OrgID:               m.OrgID,
		TaxonomyVersion:     m.TaxonomyVersion,
		ProcessedArticleIDs: m.ProcessedArticleIDs,
	}
}

// LogFields returns the request-log metadata members.
func (m ArchiveEmbeddingMetadata) LogFields() []llmlogs.ModelRequestMetadataField {
	return llmlogs.ArchiveClassificationEmbeddingMetadata{
		OrgID:               m.OrgID,
		Layer:               m.Layer,
		TaxonomyVersion:     m.TaxonomyVersion,
		ProcessedArticleIDs: m.ProcessedArticleIDs,
	}.Fields()
}

// ArchiveAnchorMetadata is the archive anchor embedding metadata.
type ArchiveAnchorMetadata struct {
	Layer           string
	OrgID           string
	TaxonomyVersion string
}

type archiveAnchorPayload struct {
	Source          string `json:"source"`
	Layer           string `json:"layer"`
	OrgID           string `json:"orgId"`
	TaxonomyVersion string `json:"taxonomyVersion"`
}

// JSONValue returns the ordered request metadata object.
func (m ArchiveAnchorMetadata) JSONValue() any {
	return archiveAnchorPayload{
		Source:          "archive-classification",
		Layer:           m.Layer,
		OrgID:           m.OrgID,
		TaxonomyVersion: m.TaxonomyVersion,
	}
}

// LogFields returns the request-log metadata members.
func (m ArchiveAnchorMetadata) LogFields() []llmlogs.ModelRequestMetadataField {
	return llmlogs.ArchiveClassificationAnchorMetadata{
		OrgID:           m.OrgID,
		Layer:           m.Layer,
		TaxonomyVersion: m.TaxonomyVersion,
	}.Fields()
}

// ArchiveRerankMetadata is the archive classification rerank metadata.
type ArchiveRerankMetadata struct {
	Layer              string
	OrgID              string
	TaxonomyVersion    string
	ProcessedArticleID string
	ArticleID          string
}

type archiveRerankPayload struct {
	Source             string `json:"source"`
	Layer              string `json:"layer"`
	OrgID              string `json:"orgId"`
	ProcessedArticleID string `json:"processedArticleId"`
	ArticleID          string `json:"articleId"`
	TaxonomyVersion    string `json:"taxonomyVersion"`
}

// JSONValue returns the ordered request metadata object.
func (m ArchiveRerankMetadata) JSONValue() any {
	return archiveRerankPayload{
		Source:             "archive-classification",
		Layer:              m.Layer,
		OrgID:              m.OrgID,
		ProcessedArticleID: m.ProcessedArticleID,
		ArticleID:          m.ArticleID,
		TaxonomyVersion:    m.TaxonomyVersion,
	}
}

// LogFields returns the request-log metadata members.
func (m ArchiveRerankMetadata) LogFields() []llmlogs.ModelRequestMetadataField {
	return llmlogs.ArchiveClassificationRerankMetadata{
		OrgID:              m.OrgID,
		Layer:              m.Layer,
		TaxonomyVersion:    m.TaxonomyVersion,
		ProcessedArticleID: m.ProcessedArticleID,
		ArticleID:          m.ArticleID,
	}.Fields()
}

// NewsClassifierMetadata is the news classifier request metadata.
type NewsClassifierMetadata struct {
	Layer string
	OrgID string
	JobID string
}

type newsClassifierPayload struct {
	Source string `json:"source"`
	Layer  string `json:"layer,omitempty"`
	OrgID  string `json:"orgId"`
	JobID  string `json:"jobId,omitempty"`
}

// JSONValue returns the ordered request metadata object.
func (m NewsClassifierMetadata) JSONValue() any {
	return newsClassifierPayload{
		Source: "news-classifier",
		Layer:  m.Layer,
		OrgID:  m.OrgID,
		JobID:  m.JobID,
	}
}

// LogFields returns the request-log metadata members.
func (m NewsClassifierMetadata) LogFields() []llmlogs.ModelRequestMetadataField {
	return llmlogs.NewsClassifierMetadata{
		OrgID: m.OrgID,
		Layer: m.Layer,
		JobID: m.JobID,
	}.Fields()
}

// metadataFeature returns the feature token of the request. It mirrors
// resolveFeatureToken: feature, then source, then module, lowercased and
// restricted to the log token alphabet.
func metadataFeature(metadata Metadata) string {
	tokens := metadataFeatureTokens(metadata)
	if len(tokens) == 0 {
		return ""
	}
	return normalizeFeatureToken(tokens[0])
}

func metadataLogFields(metadata Metadata) []llmlogs.ModelRequestMetadataField {
	if metadata == nil {
		return nil
	}
	return metadata.LogFields()
}

// metadataFeatureTokens exposes the feature/source/module tokens used for the
// untrusted-content guardrail decision. The migrated metadata types only carry
// source.
func metadataFeatureTokens(metadata Metadata) []string {
	switch metadata.(type) {
	case ArchiveEmbeddingMetadata, ArchiveAnchorMetadata, ArchiveRerankMetadata:
		return []string{"archive-classification"}
	case NewsClassifierMetadata:
		return []string{"news-classifier"}
	default:
		return nil
	}
}

func normalizeFeatureToken(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" || len([]rune(trimmed)) > 64 {
		return ""
	}
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == ':' || r == '-' || r == '.' {
			continue
		}
		return ""
	}
	return trimmed
}
