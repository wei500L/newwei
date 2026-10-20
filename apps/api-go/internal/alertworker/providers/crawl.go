package providers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// CrawlTaskStatus values, matching the Prisma enum.
const (
	crawlStatusPending   = "pending"
	crawlStatusQueued    = "queued"
	crawlStatusRunning   = "running"
	crawlStatusCompleted = "completed"
	crawlStatusFailed    = "failed"
	crawlStatusPaused    = "paused"
)

// crawlQueueName is CRAWL_QUEUE_NAME from crawl.constants.ts.
const crawlQueueName = "crawl4ai"

// The two TaskLog stages the quality-rate aggregations match.
const (
	crawlStagePreflight = "preflight"
	crawlStageDedupe    = "dedupe"
)

// The three quality-rate slugs.
const (
	crawlQualityPreflightFailureRateSlug = "crawl_quality.preflight_failure_rate"
	crawlQualityHTTP304HitRateSlug       = "crawl_quality.http_304_hit_rate"
	crawlQualityOrgHashDedupeHitRateSlug = "crawl_quality.org_hash_dedupe_hit_rate"
	// crawlTaskLogsCollection is the Mongoose 8 default collection name of
	// TaskLog (model name lowercased, legacy pluralize).
	crawlTaskLogsCollection = "tasklogs"
)

// crawlTaskStatuses is Object.values(CrawlTaskStatus).
var crawlTaskStatuses = []string{
	crawlStatusPending,
	crawlStatusQueued,
	crawlStatusRunning,
	crawlStatusCompleted,
	crawlStatusFailed,
	crawlStatusPaused,
}

// crawlSlugMissingContext is {error: "metric_slug_missing"}.
type crawlSlugMissingContext struct {
	Error string `json:"error"`
}

// crawlPreflightCounts is the {runs, failures, http304Hits} object.
type crawlPreflightCounts struct {
	Runs        int `json:"runs"`
	Failures    int `json:"failures"`
	HTTP304Hits int `json:"http304Hits"`
}

// crawlDedupeCounts is the {evaluatedCount, orgReuseCount} object.
type crawlDedupeCounts struct {
	EvaluatedCount int `json:"evaluatedCount"`
	OrgReuseCount  int `json:"orgReuseCount"`
}

// crawlPreflightQualityContext is the context of the preflight and http_304
// rate metrics.
type crawlPreflightQualityContext struct {
	WindowMinutes  int                  `json:"windowMinutes"`
	MetricSlug     string               `json:"metricSlug"`
	LatestCounts   crawlPreflightCounts `json:"latestCounts"`
	PreviousCounts crawlPreflightCounts `json:"previousCounts"`
}

// crawlDedupeQualityContext is the context of the org hash dedupe rate metric.
type crawlDedupeQualityContext struct {
	WindowMinutes  int               `json:"windowMinutes"`
	MetricSlug     string            `json:"metricSlug"`
	LatestCounts   crawlDedupeCounts `json:"latestCounts"`
	PreviousCounts crawlDedupeCounts `json:"previousCounts"`
}

// crawlTaskCountContext is the context of the task-count metric. createdById is
// `undefined` when the metadata filter is absent.
type crawlTaskCountContext struct {
	WindowMinutes int      `json:"windowMinutes"`
	Statuses      []string `json:"statuses"`
	CreatedByID   *string  `json:"createdById,omitempty"`
}

// crawlPreflightRow is the $group output of the preflight pipeline. The values
// stay untyped so the toSafeNonNegativeInt guard can reject non-numbers exactly
// like the NestJS helper does.
type crawlPreflightRow struct {
	Runs        any `bson:"runs"`
	Failures    any `bson:"failures"`
	HTTP304Hits any `bson:"http304Hits"`
}

// crawlDedupeRow is the $group output of the dedupe pipeline.
type crawlDedupeRow struct {
	EvaluatedCount any `bson:"evaluatedCount"`
	OrgReuseCount  any `bson:"orgReuseCount"`
}

// crawlProvider is CrawlMetricProvider.
type crawlProvider struct {
	deps Dependencies
}

// NewCrawl returns the crawl_task metric provider.
func NewCrawl(deps Dependencies) Provider {
	return &crawlProvider{deps: deps}
}

// Type is AlertMetricProvider.crawl_task.
func (p *crawlProvider) Type() string {
	return TypeCrawlTask
}

// Fetch mirrors CrawlMetricProvider.fetch.
func (p *crawlProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	if metricSlug == "" {
		return crawlEvaluation(crawlSlugMissingContext{Error: "metric_slug_missing"})
	}
	if crawlIsQualitySlug(metricSlug) {
		return p.fetchQualityRateMetric(ctx, rule, metricSlug)
	}
	return p.fetchTaskCountMetric(ctx, rule)
}

// crawlEvaluation returns a value-less evaluation that only carries context.
func crawlEvaluation(payload any) (Evaluation, error) {
	raw, err := marshalProviderContext(payload)
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Context: raw}, nil
}

func crawlIsQualitySlug(slug string) bool {
	switch slug {
	case crawlQualityPreflightFailureRateSlug,
		crawlQualityHTTP304HitRateSlug,
		crawlQualityOrgHashDedupeHitRateSlug:
		return true
	default:
		return false
	}
}

// crawlNormalizeWindowMinutes mirrors normalizeWindowMinutes: a non-finite or
// non-positive input falls back to 60, otherwise Math.round then clamp to
// [1, 1440].
func crawlNormalizeWindowMinutes(value float64) int {
	if !isFiniteMetricNumber(value) || value <= 0 {
		return 60
	}
	rounded := math.Round(value)
	if rounded < 1 {
		return 1
	}
	if rounded > 24*60 {
		return 24 * 60
	}
	return int(rounded)
}

// crawlSafeRate mirrors safeRate: null when the denominator is not positive.
func crawlSafeRate(numerator, denominator int) *float64 {
	if denominator <= 0 {
		return nil
	}
	return evaluationNumber(float64(numerator) / float64(denominator))
}

// crawlChangePercent mirrors computeChangePercent: null when either side is
// null or the previous value is zero.
func crawlChangePercent(latest, previous *float64) *float64 {
	if latest == nil || previous == nil || *previous == 0 {
		return nil
	}
	return evaluationNumber((*latest - *previous) / *previous * 100)
}

// crawlSafeNonNegativeInt mirrors toSafeNonNegativeInt: a non-number or
// non-finite value is 0, otherwise Math.max(0, Math.round(value)).
func crawlSafeNonNegativeInt(value any) int {
	number, ok := bsonNumericValue(value)
	if !ok || !isFiniteMetricNumber(number) || number < 0 {
		return 0
	}
	return int(math.Round(number))
}

// resolveCrawlTaskStatuses mirrors the statuses resolution of the task-count
// branch: the requested statuses filtered through Object.values(CrawlTaskStatus),
// or [failed] when the rule requested none.
func resolveCrawlTaskStatuses(metadata ruleMetadataFields) []string {
	requested, hasRequested := requestedRuleStatuses(metadata)
	if !hasRequested {
		return []string{crawlStatusFailed}
	}
	return filterAllowedStatuses(requested, crawlTaskStatuses)
}

// crawlCreatedAtWindow is buildCreatedAtWindow: {$gte: from} or
// {$gte: from, $lt: to}.
func crawlCreatedAtWindow(from time.Time, to *time.Time) bson.D {
	window := bson.D{{Key: "$gte", Value: from}}
	if to != nil {
		window = append(window, bson.E{Key: "$lt", Value: *to})
	}
	return window
}

// buildCrawlPreflightPipeline is collectPreflightCounts' aggregation: one
// $match on the preflight TaskLogs, then a $group that counts runs, failed
// statuses and HTTP 304 responses.
func buildCrawlPreflightPipeline(orgID string, from time.Time, to *time.Time) mongo.Pipeline {
	return mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: crawlQueueName},
			{Key: "stage", Value: crawlStagePreflight},
			{Key: "createdAt", Value: crawlCreatedAtWindow(from, to)},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "runs", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "failures", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$cond", Value: bson.A{
					bson.D{{Key: "$eq", Value: bson.A{"$status", "failed"}}},
					1,
					0,
				}},
			}}}},
			{Key: "http304Hits", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$cond", Value: bson.A{
					bson.D{{Key: "$and", Value: bson.A{
						bson.D{{Key: "$isNumber", Value: "$data.status"}},
						bson.D{{Key: "$eq", Value: bson.A{
							bson.D{{Key: "$round", Value: bson.A{"$data.status", 0}}},
							304,
						}}},
					}}},
					1,
					0,
				}},
			}}}},
		}}},
	}
}

// buildCrawlDedupePipeline is collectDedupeCounts' aggregation: one $match on
// the dedupe TaskLogs, a $project that rounds each counter to a non-negative
// integer (0 when the field is not a number), then a $group that sums them.
func buildCrawlDedupePipeline(orgID string, from time.Time, to *time.Time) mongo.Pipeline {
	return mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: crawlQueueName},
			{Key: "stage", Value: crawlStageDedupe},
			{Key: "createdAt", Value: crawlCreatedAtWindow(from, to)},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "evaluatedCount", Value: crawlRoundedNonNegativeExpr("$data.evaluatedCount")},
			{Key: "orgReuseCount", Value: crawlRoundedNonNegativeExpr("$data.orgReuseCount")},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "evaluatedCount", Value: bson.D{{Key: "$sum", Value: "$evaluatedCount"}}},
			{Key: "orgReuseCount", Value: bson.D{{Key: "$sum", Value: "$orgReuseCount"}}},
		}}},
	}
}

// crawlRoundedNonNegativeExpr is toRoundedNonNegativeNumberExpr:
// $cond: [{$isNumber: path}, {$max: [{$round: [path, 0]}, 0]}, 0].
func crawlRoundedNonNegativeExpr(path string) bson.D {
	return bson.D{{Key: "$cond", Value: bson.A{
		bson.D{{Key: "$isNumber", Value: path}},
		bson.D{{Key: "$max", Value: bson.A{
			bson.D{{Key: "$round", Value: bson.A{path, 0}}},
			0,
		}}},
		0,
	}}}
}

// fetchTaskCountMetric is the created/updated task count branch. Unlike the
// quality metrics it does not normalize the window.
func (p *crawlProvider) fetchTaskCountMetric(ctx context.Context, rule Rule) (Evaluation, error) {
	windowMinutes := 60
	if rule.ChangeWindowMin != nil {
		windowMinutes = *rule.ChangeWindowMin
	}
	window := time.Duration(windowMinutes) * time.Minute
	now := p.deps.now().UTC()
	windowStart := now.Add(-window)
	previousWindowStart := now.Add(-2 * window)

	metadata := readRuleMetadata(rule.Metadata)
	statuses := resolveCrawlTaskStatuses(metadata)
	createdByID, _ := metadata.text("createdById")

	latest, err := p.countCrawlTasks(ctx, rule.OrgID, statuses, createdByID, windowStart, nil)
	if err != nil {
		return Evaluation{}, err
	}
	previous, err := p.countCrawlTasks(ctx, rule.OrgID, statuses, createdByID, previousWindowStart, &windowStart)
	if err != nil {
		return Evaluation{}, err
	}

	raw, err := marshalProviderContext(crawlTaskCountContext{
		WindowMinutes: windowMinutes,
		Statuses:      statuses,
		CreatedByID:   stringPointerWhenSet(createdByID),
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{
		Latest:        evaluationNumber(float64(latest)),
		Previous:      evaluationNumber(float64(previous)),
		ChangePercent: pipelineCountChangePercent(latest, previous),
		Context:       raw,
	}, nil
}

// countCrawlTasks runs prisma.crawlTask.count on the updatedAt window.
func (p *crawlProvider) countCrawlTasks(ctx context.Context, orgID string, statuses []string, createdByID string, from time.Time, before *time.Time) (int64, error) {
	if p.deps.DB == nil {
		return 0, errors.New("alertworker/providers: crawl metric: mysql is not configured")
	}
	if len(statuses) == 0 {
		// Prisma `{ in: [] }` matches no row; MySQL rejects `IN ()`.
		return 0, nil
	}
	query := "SELECT COUNT(*) FROM CrawlTask WHERE orgId = ? AND status IN (" +
		providerSQLPlaceholders(len(statuses)) + ")"
	args := make([]any, 0, len(statuses)+4)
	args = append(args, orgID)
	for _, status := range statuses {
		args = append(args, status)
	}
	if createdByID != "" {
		query += " AND createdById = ?"
		args = append(args, createdByID)
	}
	query += " AND updatedAt >= ?"
	args = append(args, from)
	if before != nil {
		query += " AND updatedAt < ?"
		args = append(args, *before)
	}
	var count int64
	if err := p.deps.DB.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("alertworker/providers: crawl task count: %w", err)
	}
	return count, nil
}

// fetchQualityRateMetric is fetchQualityRateMetric.
func (p *crawlProvider) fetchQualityRateMetric(ctx context.Context, rule Rule, metricSlug string) (Evaluation, error) {
	rawWindow := 60.0
	if rule.ChangeWindowMin != nil {
		rawWindow = float64(*rule.ChangeWindowMin)
	}
	windowMinutes := crawlNormalizeWindowMinutes(rawWindow)
	window := time.Duration(windowMinutes) * time.Minute
	now := p.deps.now().UTC()
	windowStart := now.Add(-window)
	previousWindowStart := now.Add(-2 * window)

	if metricSlug == crawlQualityOrgHashDedupeHitRateSlug {
		latestCounts, err := p.collectDedupeCounts(ctx, rule.OrgID, windowStart, nil)
		if err != nil {
			return Evaluation{}, err
		}
		previousCounts, err := p.collectDedupeCounts(ctx, rule.OrgID, previousWindowStart, &windowStart)
		if err != nil {
			return Evaluation{}, err
		}
		latest := crawlSafeRate(latestCounts.OrgReuseCount, latestCounts.EvaluatedCount)
		previous := crawlSafeRate(previousCounts.OrgReuseCount, previousCounts.EvaluatedCount)
		raw, err := marshalProviderContext(crawlDedupeQualityContext{
			WindowMinutes:  windowMinutes,
			MetricSlug:     metricSlug,
			LatestCounts:   latestCounts,
			PreviousCounts: previousCounts,
		})
		if err != nil {
			return Evaluation{}, err
		}
		return Evaluation{
			Latest:        latest,
			Previous:      previous,
			ChangePercent: crawlChangePercent(latest, previous),
			Context:       raw,
		}, nil
	}

	latestCounts, err := p.collectPreflightCounts(ctx, rule.OrgID, windowStart, nil)
	if err != nil {
		return Evaluation{}, err
	}
	previousCounts, err := p.collectPreflightCounts(ctx, rule.OrgID, previousWindowStart, &windowStart)
	if err != nil {
		return Evaluation{}, err
	}
	var latest, previous *float64
	if metricSlug == crawlQualityPreflightFailureRateSlug {
		latest = crawlSafeRate(latestCounts.Failures, latestCounts.Runs)
		previous = crawlSafeRate(previousCounts.Failures, previousCounts.Runs)
	} else {
		latest = crawlSafeRate(latestCounts.HTTP304Hits, latestCounts.Runs)
		previous = crawlSafeRate(previousCounts.HTTP304Hits, previousCounts.Runs)
	}
	raw, err := marshalProviderContext(crawlPreflightQualityContext{
		WindowMinutes:  windowMinutes,
		MetricSlug:     metricSlug,
		LatestCounts:   latestCounts,
		PreviousCounts: previousCounts,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{
		Latest:        latest,
		Previous:      previous,
		ChangePercent: crawlChangePercent(latest, previous),
		Context:       raw,
	}, nil
}

// collectPreflightCounts runs the preflight aggregation with allowDiskUse.
func (p *crawlProvider) collectPreflightCounts(ctx context.Context, orgID string, from time.Time, to *time.Time) (crawlPreflightCounts, error) {
	if p.deps.Mongo == nil {
		return crawlPreflightCounts{}, errors.New("alertworker/providers: crawl metric: mongo is not configured")
	}
	cursor, err := p.deps.Mongo.Collection(crawlTaskLogsCollection).Aggregate(ctx,
		buildCrawlPreflightPipeline(orgID, from, to),
		options.Aggregate().SetAllowDiskUse(true),
	)
	if err != nil {
		return crawlPreflightCounts{}, fmt.Errorf("alertworker/providers: crawl preflight aggregate: %w", err)
	}
	var rows []crawlPreflightRow
	if err := cursor.All(ctx, &rows); err != nil {
		return crawlPreflightCounts{}, fmt.Errorf("alertworker/providers: crawl preflight decode: %w", err)
	}
	if len(rows) == 0 {
		return crawlPreflightCounts{}, nil
	}
	row := rows[0]
	return crawlPreflightCounts{
		Runs:        crawlSafeNonNegativeInt(row.Runs),
		Failures:    crawlSafeNonNegativeInt(row.Failures),
		HTTP304Hits: crawlSafeNonNegativeInt(row.HTTP304Hits),
	}, nil
}

// collectDedupeCounts runs the dedupe aggregation with allowDiskUse.
func (p *crawlProvider) collectDedupeCounts(ctx context.Context, orgID string, from time.Time, to *time.Time) (crawlDedupeCounts, error) {
	if p.deps.Mongo == nil {
		return crawlDedupeCounts{}, errors.New("alertworker/providers: crawl metric: mongo is not configured")
	}
	cursor, err := p.deps.Mongo.Collection(crawlTaskLogsCollection).Aggregate(ctx,
		buildCrawlDedupePipeline(orgID, from, to),
		options.Aggregate().SetAllowDiskUse(true),
	)
	if err != nil {
		return crawlDedupeCounts{}, fmt.Errorf("alertworker/providers: crawl dedupe aggregate: %w", err)
	}
	var rows []crawlDedupeRow
	if err := cursor.All(ctx, &rows); err != nil {
		return crawlDedupeCounts{}, fmt.Errorf("alertworker/providers: crawl dedupe decode: %w", err)
	}
	if len(rows) == 0 {
		return crawlDedupeCounts{}, nil
	}
	row := rows[0]
	return crawlDedupeCounts{
		EvaluatedCount: crawlSafeNonNegativeInt(row.EvaluatedCount),
		OrgReuseCount:  crawlSafeNonNegativeInt(row.OrgReuseCount),
	}, nil
}
