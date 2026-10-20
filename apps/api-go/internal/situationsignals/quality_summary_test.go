package situationsignals

import "testing"

func TestQualitySummaryFromResponse(t *testing.T) {
	dedupe := 0.5
	average := 1.5
	response := insightsResponse{
		GeneratedAt: "2026-10-20T12:00:00.000Z",
		WindowHours: 72,
		CoverageSummary: &insightsCoverageSummary{
			Mode:                    "internal+external",
			ArticleCount:            10,
			ClusterCount:            4,
			MixedSourceClusterCount: 2,
			DedupeRatio:             &dedupe,
			AvgSourcesPerCluster:    &average,
		},
	}
	summary := qualitySummaryFromResponse(response)
	if summary == nil {
		t.Fatal("summary is nil")
	}
	if summary.GeneratedAt != response.GeneratedAt || summary.WindowHours != 72 ||
		summary.Mode != "internal+external" || summary.ArticleCount != 10 ||
		summary.ClusterCount != 4 || summary.MixedSourceClusterCount != 2 ||
		summary.DedupeRatio == nil || *summary.DedupeRatio != dedupe ||
		summary.AvgSourcesPerCluster == nil || *summary.AvgSourcesPerCluster != average {
		t.Fatalf("summary = %+v", summary)
	}
	if qualitySummaryFromResponse(insightsResponse{}) != nil {
		t.Fatal("a response without coverageSummary must map to nil")
	}
}
