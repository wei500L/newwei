// Package providers ports the nine alert metric providers of
// apps/api/src/modules/alerts/providers to Go.
//
// Every provider answers the same question as its NestJS counterpart: read the
// metric named by rule.MetricSlug and return latest/previous/changePercent plus
// the provider-specific context object. The SQL, the Mongo pipelines, the
// window arithmetic and the context fields are ported one to one; nothing here
// re-designs a statistic.
//
// Evaluation.Context is the extension-shaped JSON object that ends up in
// AlertEvent.context, so it travels as json.RawMessage rather than as a Go map.
package providers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Metric provider names, matching the Prisma AlertMetricProvider enum.
const (
	TypeEconomicData      = "economic_data"
	TypeSystemEvent       = "system_event"
	TypePipelineJob       = "pipeline_job"
	TypeCrawlTask         = "crawl_task"
	TypeSystemMetric      = "system_metric"
	TypeEconomicAnomaly   = "economic_anomaly"
	TypeEntitySentiment   = "entity_sentiment"
	TypeEntityAssociation = "entity_association"
	TypeRealtimeSignal    = "realtime_signal"
)

// Operators used by the providers to choose a query shape, matching the Prisma
// AlertOperator enum.
const (
	OperatorGt            = "gt"
	OperatorGte           = "gte"
	OperatorLt            = "lt"
	OperatorLte           = "lte"
	OperatorEq            = "eq"
	OperatorOutsideRange  = "outside_range"
	OperatorWithinRange   = "within_range"
	OperatorChangeUpPct   = "change_up_pct"
	OperatorChangeDownPct = "change_down_pct"
)

// Evaluation is one provider fetch result. Nil pointers mean "no value", which
// stops the evaluation before any trigger decision.
type Evaluation struct {
	Latest        *float64
	Previous      *float64
	ChangePercent *float64
	// Context is the JSON object merged into the event context, or nil.
	Context json.RawMessage
}

// Rule is the provider-facing subset of an alert rule.
type Rule struct {
	ID              string
	OrgID           string
	MetricProvider  string
	MetricSlug      string
	Operator        string
	ChangeWindowMin *int
	Metadata        json.RawMessage
}

// Provider is one metric provider.
type Provider interface {
	// Type is the Prisma AlertMetricProvider value this provider serves.
	Type() string
	// Fetch evaluates one rule.
	Fetch(ctx context.Context, rule Rule) (Evaluation, error)
}

// Dependencies are the shared clients every provider may use. Mongo, Redis and
// Forecast may be nil when the corresponding provider is not configured; those
// providers then report an error context like the NestJS ones do when their
// dependency is unavailable.
type Dependencies struct {
	DB       *sql.DB
	Redis    *redis.Client
	Mongo    *mongo.Database
	Forecast ForecastClient
	// Cache wraps an expensive loader behind a Redis value + lock. It mirrors
	// CacheService.wrap and is used by the economic anomaly provider.
	Cache *Cache
	Now   func() time.Time
}

func (d Dependencies) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// Set is the provider registry, in the same order as the NestJS
// ALERT_METRIC_PROVIDERS factory.
type Set struct {
	providers []Provider
	byType    map[string]Provider
}

// ErrNoProvider reports a rule whose metric provider has no implementation.
var ErrNoProvider = errors.New("alertworker/providers: no metric provider for rule")

// NewSet builds every provider over the shared clients.
func NewSet(deps Dependencies) (*Set, error) {
	ordered := []Provider{
		NewEconomicData(deps),
		NewEconomicAnomaly(deps),
		NewPipeline(deps),
		NewCrawl(deps),
		NewSystem(deps),
		NewSystemEvent(deps),
		NewEntitySentiment(deps),
		NewEntityAssociation(deps),
		NewRealtimeSignal(deps),
	}
	registry := &Set{providers: ordered, byType: make(map[string]Provider, len(ordered))}
	for _, provider := range ordered {
		if provider == nil {
			return nil, errors.New("alertworker/providers: nil provider in registry")
		}
		registry.byType[provider.Type()] = provider
	}
	return registry, nil
}

// Find resolves the provider for one rule, mirroring
// AlertsService.resolveMetricProvider (a linear scan over supports()).
func (s *Set) Find(rule Rule) (Provider, bool) {
	if s == nil {
		return nil, false
	}
	provider, ok := s.byType[rule.MetricProvider]
	return provider, ok
}

// Fetch resolves the provider and evaluates the rule. A rule without a
// registered provider returns ErrNoProvider, which the caller logs and skips
// exactly like the NestJS warn.
func (s *Set) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	provider, ok := s.Find(rule)
	if !ok {
		return Evaluation{}, fmt.Errorf("%w: %s", ErrNoProvider, rule.MetricProvider)
	}
	return provider.Fetch(ctx, rule)
}
