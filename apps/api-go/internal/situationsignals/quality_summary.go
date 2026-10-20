package situationsignals

import (
	"context"
	"database/sql"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// QualitySummary is SituationMonitorQualitySummary. Field order matches the
// NestJS object literal.
type QualitySummary struct {
	GeneratedAt             string   `json:"generatedAt"`
	WindowHours             int      `json:"windowHours"`
	Mode                    string   `json:"mode"`
	ArticleCount            int      `json:"articleCount"`
	ClusterCount            int      `json:"clusterCount"`
	MixedSourceClusterCount int      `json:"mixedSourceClusterCount"`
	DedupeRatio             *float64 `json:"dedupeRatio"`
	AvgSourcesPerCluster    *float64 `json:"avgSourcesPerCluster"`
}

// QualitySummaryService exposes SituationMonitorService.getQualitySummary to
// other Go domains (the situation settings response) without duplicating the
// insights pipeline or its 45 second core cache.
type QualitySummaryService struct {
	service *insightsService
}

// NewQualitySummaryService wires the same collaborators as NewInsightsService.
func NewQualitySummaryService(db *sql.DB, redisClient *redis.Client, mongoDatabase *mongo.Database, settings *settingsReader) *QualitySummaryService {
	return &QualitySummaryService{service: NewInsightsService(db, redisClient, mongoDatabase, settings)}
}

// GetQualitySummary mirrors getQualitySummary: run the core section with the
// default window (72h) and maxItems (400), scope all, and map coverageSummary.
// It returns nil when the pipeline produced no coverage summary.
func (s *QualitySummaryService) GetQualitySummary(ctx context.Context, orgID string) (*QualitySummary, error) {
	if s == nil || s.service == nil {
		return nil, nil
	}
	response, err := s.service.getInsights(ctx, orgID, insightsOptions{
		Sections: []string{"core"},
		Scope:    "all",
	})
	if err != nil {
		return nil, err
	}
	return qualitySummaryFromResponse(response), nil
}

// qualitySummaryFromResponse maps the insights response exactly like
// getQualitySummary.
func qualitySummaryFromResponse(response insightsResponse) *QualitySummary {
	coverage := response.CoverageSummary
	if coverage == nil {
		return nil
	}
	return &QualitySummary{
		GeneratedAt:             response.GeneratedAt,
		WindowHours:             response.WindowHours,
		Mode:                    coverage.Mode,
		ArticleCount:            coverage.ArticleCount,
		ClusterCount:            coverage.ClusterCount,
		MixedSourceClusterCount: coverage.MixedSourceClusterCount,
		DedupeRatio:             coverage.DedupeRatio,
		AvgSourcesPerCluster:    coverage.AvgSourcesPerCluster,
	}
}
