package llmlogs

import "testing"

func TestClusteringDecisionMetadataEntries(t *testing.T) {
	entries := (ClusteringDecisionMetadata{
		Feature:            "news_event_clustering_llm_backfill",
		CandidateCount:     3,
		ArticleFingerprint: "abc123",
	}).entries()
	if len(entries) != 3 {
		t.Fatalf("entries = %d", len(entries))
	}
	if entries[0].Key != "feature" || entries[0].Text == nil || *entries[0].Text != "news_event_clustering_llm_backfill" {
		t.Fatalf("feature entry = %+v", entries[0])
	}
	if entries[1].Key != "candidateCount" || entries[1].Number == nil || *entries[1].Number != 3 {
		t.Fatalf("candidateCount entry = %+v", entries[1])
	}
	if entries[2].Key != "articleFingerprint" || entries[2].Text == nil || *entries[2].Text != "abc123" {
		t.Fatalf("articleFingerprint entry = %+v", entries[2])
	}
}

func TestClusteringFeatureTokenPrefersExplicitFeature(t *testing.T) {
	metadata := &ClusteringDecisionMetadata{Feature: "from_metadata"}
	if token := clusteringFeatureToken("explicit_feature", metadata); token == nil || *token != "explicit_feature" {
		t.Fatalf("explicit token = %v", token)
	}
	if token := clusteringFeatureToken("", metadata); token == nil || *token != "from_metadata" {
		t.Fatalf("metadata token = %v", token)
	}
	if token := clusteringFeatureToken("", nil); token != nil {
		t.Fatalf("nil metadata token = %v", token)
	}
}

func TestClusteringMetadataEntriesNil(t *testing.T) {
	if entries := clusteringMetadataEntries(nil); len(entries) != 0 {
		t.Fatalf("entries = %d", len(entries))
	}
}
