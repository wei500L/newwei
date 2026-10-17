// Package newsindicators serves the news-indicator association GraphQL read
// roots. Queries are org-scoped by the server-derived identity.
package newsindicators

import (
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
)

// NewsIndicatorAssociationBacktestRunModel is the GraphQL
// NewsIndicatorAssociationBacktestRunModel object.
type NewsIndicatorAssociationBacktestRunModel struct {
	ID          string    `graphql:"id"`
	Status      string    `graphql:"status"`
	WindowStart time.Time `graphql:"windowStart"`
	WindowEnd   time.Time `graphql:"windowEnd"`
	Config      any       `graphql:"config"`
	Metrics     any       `graphql:"metrics"`
	Error       *string   `graphql:"error"`
	CreatedAt   time.Time `graphql:"createdAt"`
	UpdatedAt   time.Time `graphql:"updatedAt"`
}

// NewsIndicatorAssociationModel is the GraphQL NewsIndicatorAssociationModel
// object. Indicator reuses economic.EconomicDataItemModel (registered by the
// economic package). A nil Backtests slice projects as GraphQL null (list items
// and detail with backtestsLimit=0); a non-nil empty slice projects as [].
type NewsIndicatorAssociationModel struct {
	ID              string                                     `graphql:"id"`
	ScopeType       string                                     `graphql:"scopeType"`
	ScopeKey        string                                     `graphql:"scopeKey"`
	ScopeKeyType    string                                     `graphql:"scopeKeyType"`
	FeatureMetric   string                                     `graphql:"featureMetric"`
	Indicator       economic.EconomicDataItemModel             `graphql:"indicator"`
	WindowDays      int                                        `graphql:"windowDays"`
	LagDays         int                                        `graphql:"lagDays"`
	Correlation     float64                                    `graphql:"correlation"`
	PValue          *float64                                   `graphql:"pValue"`
	SampleSize      int                                        `graphql:"sampleSize"`
	AnalyzedStartAt time.Time                                  `graphql:"analyzedStartAt"`
	AnalyzedEndAt   time.Time                                  `graphql:"analyzedEndAt"`
	LastEvaluatedAt time.Time                                  `graphql:"lastEvaluatedAt"`
	Metadata        any                                        `graphql:"metadata"`
	LatestBacktest  *NewsIndicatorAssociationBacktestRunModel  `graphql:"latestBacktest"`
	Backtests       []NewsIndicatorAssociationBacktestRunModel `graphql:"backtests"`
}
