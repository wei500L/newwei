package providers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// PipelineJobStatus values, matching the Prisma enum. They are the plain
// strings stored in MySQL.
const (
	pipelineStatusPending   = "pending"
	pipelineStatusQueued    = "queued"
	pipelineStatusRunning   = "running"
	pipelineStatusCompleted = "completed"
	pipelineStatusFailed    = "failed"
	pipelineStatusDelayed   = "delayed"
)

// MongoOutboxStatus values, matching the Prisma enum.
const (
	outboxStatusPending    = "pending"
	outboxStatusProcessing = "processing"
	outboxStatusFailed     = "failed"
	outboxStatusDead       = "dead"
)

// MongoOutboxType values, matching the Prisma enum.
const (
	outboxTypeProcessedItem       = "processed_item"
	outboxTypeCleanupCrawlResults = "cleanup_crawl_results"
	outboxTypeRawItem             = "raw_item"
)

const (
	// pipelineLLMRequestLogsCollection is the Mongoose 8 default collection
	// name of LlmRequestLog (model name lowercased, legacy pluralize).
	pipelineLLMRequestLogsCollection = "llmrequestlogs"
	// pipelineLatencySampleLimit is the take/limit(5000) both latency metrics use.
	pipelineLatencySampleLimit = 5000
	// outboxStaleLockWindow is the outboxStaleLockMs = 5 * 60_000 cutoff.
	outboxStaleLockWindow = 5 * time.Minute
)

// pipelineJobStatuses is Object.values(PipelineJobStatus).
var pipelineJobStatuses = []string{
	pipelineStatusPending,
	pipelineStatusQueued,
	pipelineStatusRunning,
	pipelineStatusCompleted,
	pipelineStatusFailed,
	pipelineStatusDelayed,
}

// outboxStatuses is Object.values(MongoOutboxStatus); the enum declaration
// order is pending, processing, failed, dead.
var outboxStatuses = []string{
	outboxStatusPending,
	outboxStatusProcessing,
	outboxStatusFailed,
	outboxStatusDead,
}

// outboxTypes is Object.values(MongoOutboxType).
var outboxTypes = []string{
	outboxTypeProcessedItem,
	outboxTypeCleanupCrawlResults,
	outboxTypeRawItem,
}

// ruleMetadataFields is AlertRule.metadata decoded as an object of raw JSON
// values. Every NestJS provider repeats the same toMetadata() guard and then
// tests each field with typeof, so the Go port keeps the raw values and reads
// them through typed accessors instead of a struct: a wrong field type must not
// invalidate the other fields.
type ruleMetadataFields map[string]json.RawMessage

// readRuleMetadata mirrors toMetadata(): anything that is not a JSON object
// (null, array, string, number) yields nil, i.e. "no metadata".
func readRuleMetadata(raw json.RawMessage) ruleMetadataFields {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var fields ruleMetadataFields
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return nil
	}
	return fields
}

// number reads one metadata field with `typeof value === "number"` semantics.
// A JSON null, string, boolean, object or array is not a number. An
// out-of-range literal (1e400) is a number in JavaScript, Inf after parsing, so
// it is reported as a number here too and the clamp helpers decide what to do
// with a non-finite value.
func (m ruleMetadataFields) number(key string) (float64, bool) {
	raw, ok := m[key]
	if !ok {
		return 0, false
	}
	text := string(bytes.TrimSpace(raw))
	if text == "" || (text[0] != '-' && (text[0] < '0' || text[0] > '9')) {
		return 0, false
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		if errors.Is(err, strconv.ErrRange) {
			return value, true
		}
		return 0, false
	}
	return value, true
}

// text reads one metadata field with `typeof value === "string"` semantics.
// The value is not trimmed; callers trim where the NestJS code trims.
func (m ruleMetadataFields) text(key string) (string, bool) {
	raw, ok := m[key]
	if !ok {
		return "", false
	}
	text := bytes.TrimSpace(raw)
	if len(text) == 0 || text[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(text, &value); err != nil {
		return "", false
	}
	return value, true
}

// textArray reads one metadata field with `Array.isArray(value)` semantics,
// keeping only the string entries (`typeof status === "string"`).
func (m ruleMetadataFields) textArray(key string) ([]string, bool) {
	raw, ok := m[key]
	if !ok {
		return nil, false
	}
	text := bytes.TrimSpace(raw)
	if len(text) == 0 || text[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(text, &items); err != nil {
		return nil, false
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		trimmed := bytes.TrimSpace(item)
		// A JSON null unmarshals into a string without an error, so the
		// `typeof status === "string"` guard has to reject it explicitly.
		if len(trimmed) == 0 || trimmed[0] != '"' {
			continue
		}
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			continue
		}
		values = append(values, value)
	}
	return values, true
}

// numberOr is the `typeof metadata?.key === "number" ? metadata.key : fallback`
// ternary.
func (m ruleMetadataFields) numberOr(key string, fallback float64) float64 {
	if value, ok := m.number(key); ok {
		return value
	}
	return fallback
}

// requestedRuleStatuses mirrors the statuses/status metadata resolution every
// provider repeats. ok reports that the rule supplied a filter at all; the
// caller then filters it through its own allowed enum values.
func requestedRuleStatuses(metadata ruleMetadataFields) ([]string, bool) {
	if values, ok := metadata.textArray("statuses"); ok {
		return values, true
	}
	if value, ok := metadata.text("status"); ok {
		return []string{value}, true
	}
	return nil, false
}

// filterAllowedStatuses mirrors `requested.filter((status) =>
// allowed.includes(status))`. Duplicates are preserved; the result is always a
// non-nil slice so the JSON context renders `[]` rather than `null`.
func filterAllowedStatuses(requested, allowed []string) []string {
	filtered := make([]string, 0, len(requested))
	for _, status := range requested {
		for _, candidate := range allowed {
			if status == candidate {
				filtered = append(filtered, status)
				break
			}
		}
	}
	return filtered
}

// providerSQLPlaceholders renders `?,?,?` for an IN list.
func providerSQLPlaceholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

// jsISOTimestamp renders Date.toISOString(): UTC with exactly three fractional
// digits. The outbox cutoff and the entity timestamps are persisted in the
// event context after JSON serialisation, where a Date becomes this string.
func jsISOTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// isFiniteMetricNumber is Number.isFinite for the numeric paths.
func isFiniteMetricNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// bsonNumericValue converts the numeric BSON types that can appear when an
// aggregation result or a projected number is decoded into any. A Decimal128
// stays an object on purpose: JavaScript Number(decimal128) is not a number
// either, so the `typeof value === "number"` guards reject it in both runtimes.
func bsonNumericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int:
		return float64(typed), true
	case float64:
		return typed, true
	default:
		return 0, false
	}
}

// evaluationNumber boxes a value as Evaluation.Latest/Previous.
func evaluationNumber(value float64) *float64 {
	number := value
	return &number
}

// stringPointerWhenSet is `value ? value : undefined` for the optional context
// fields (an empty metadata filter is falsy in NestJS, so it is omitted).
func stringPointerWhenSet(value string) *string {
	if value == "" {
		return nil
	}
	text := value
	return &text
}

// marshalProviderContext renders the extension-shaped context object. Every
// provider stores it in AlertEvent.context, so it travels as raw JSON.
func marshalProviderContext(payload any) (json.RawMessage, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: marshal context: %w", err)
	}
	return encoded, nil
}

// pipelineQuantile is a 1:1 port of quantile(): keep finite values, sort them
// ascending, take index ceil(percentile/100*len)-1 clamped to [0,len-1] and
// return null for an empty sample. It is deliberately not an interpolating
// quantile.
func pipelineQuantile(values []float64, percentile float64) *float64 {
	finite := make([]float64, 0, len(values))
	for _, value := range values {
		if isFiniteMetricNumber(value) {
			finite = append(finite, value)
		}
	}
	if len(finite) == 0 {
		return nil
	}
	sort.Float64s(finite)
	// Clamp in float space before converting: a NaN percentile indexes an
	// array as undefined in JavaScript (and `?? null` turns that into null),
	// while an infinite percentile clamps to the last element.
	index := math.Ceil((percentile/100)*float64(len(finite))) - 1
	if math.IsNaN(index) {
		return nil
	}
	if index < 0 {
		index = 0
	}
	if last := float64(len(finite) - 1); index > last {
		index = last
	}
	return evaluationNumber(finite[int(index)])
}

// pipelineCountChangePercent mirrors `previous !== null && Number.isFinite(previous)
// && previous !== 0 ? ((latest - previous) / previous) * 100 : null`. Both
// inputs come from COUNT(*), so they are always finite numbers.
func pipelineCountChangePercent(latest, previous int64) *float64 {
	if previous == 0 {
		return nil
	}
	return evaluationNumber((float64(latest) - float64(previous)) / float64(previous) * 100)
}

// outboxStatusesForSlug is defaultStatusesBySlug: an unknown slug falls back to
// the backlog set exactly like the NestJS table lookup does.
func outboxStatusesForSlug(slug string) []string {
	switch slug {
	case "mongo_outbox.backlog":
		return []string{outboxStatusPending, outboxStatusFailed, outboxStatusProcessing}
	case "mongo_outbox.pending":
		return []string{outboxStatusPending}
	case "mongo_outbox.failed":
		return []string{outboxStatusFailed}
	case "mongo_outbox.processing":
		return []string{outboxStatusProcessing}
	case "mongo_outbox.dead":
		return []string{outboxStatusDead}
	default:
		return []string{outboxStatusPending, outboxStatusFailed, outboxStatusProcessing}
	}
}

// resolvePipelineJobStatuses mirrors the statuses resolution of the default
// branch: the requested statuses filtered through Object.values(PipelineJobStatus),
// or [failed] when the rule requested none.
func resolvePipelineJobStatuses(metadata ruleMetadataFields) []string {
	requested, hasRequested := requestedRuleStatuses(metadata)
	if !hasRequested {
		return []string{pipelineStatusFailed}
	}
	return filterAllowedStatuses(requested, pipelineJobStatuses)
}

// resolveOutboxStatuses mirrors the statuses resolution of the mongo_outbox.*
// branches: the requested statuses filtered through Object.values(MongoOutboxStatus),
// or the per-slug default set.
func resolveOutboxStatuses(metadata ruleMetadataFields, slug string) []string {
	if requested, hasRequested := requestedRuleStatuses(metadata); hasRequested {
		return filterAllowedStatuses(requested, outboxStatuses)
	}
	return outboxStatusesForSlug(slug)
}

// outboxTypeFromMetadata resolves `allowedTypes.includes(requestedType) ?
// requestedType : processed_item` after trimming the metadata value.
func outboxTypeFromMetadata(metadata ruleMetadataFields) string {
	requested, ok := metadata.text("type")
	if ok {
		requested = strings.TrimSpace(requested)
	}
	if ok {
		for _, allowed := range outboxTypes {
			if requested == allowed {
				return allowed
			}
		}
	}
	return outboxTypeProcessedItem
}

// pipelineSlugMissingContext is {error: "metric_slug_missing"}.
type pipelineSlugMissingContext struct {
	Error string `json:"error"`
}

// pipelineJobCountContext is the context of the status-count metric. queueName
// and sourceId are `undefined` when the metadata filter is absent, so
// JSON.stringify drops them.
type pipelineJobCountContext struct {
	WindowMinutes int      `json:"windowMinutes"`
	Statuses      []string `json:"statuses"`
	QueueName     *string  `json:"queueName,omitempty"`
	SourceID      *string  `json:"sourceId,omitempty"`
}

// pipelineRateContext is the success_rate/failure_rate context.
type pipelineRateContext struct {
	WindowMinutes int     `json:"windowMinutes"`
	Total         int64   `json:"total"`
	Completed     int64   `json:"completed"`
	Failed        int64   `json:"failed"`
	QueueName     *string `json:"queueName,omitempty"`
	SourceID      *string `json:"sourceId,omitempty"`
}

// pipelineAverageLatencyContext is the average_llm_latency_ms context.
type pipelineAverageLatencyContext struct {
	WindowMinutes int `json:"windowMinutes"`
	SampleSize    int `json:"sampleSize"`
}

// pipelineIngestionLatencyContext is the ingestion_p90/p99 context.
type pipelineIngestionLatencyContext struct {
	WindowMinutes int `json:"windowMinutes"`
	SampleSize    int `json:"sampleSize"`
	Percentile    int `json:"percentile"`
}

// mongoOutboxOldestContext is the oldest_age_minutes context. oldestCreatedAt
// stays present as null when no row matched.
type mongoOutboxOldestContext struct {
	Type            string  `json:"type"`
	OldestCreatedAt *string `json:"oldestCreatedAt"`
}

// mongoOutboxStaleContext is the stale_processing context. The NestJS
// staleLockCutoff is a Date; it reaches AlertEvent.context as an ISO string.
type mongoOutboxStaleContext struct {
	Type            string `json:"type"`
	StaleLockCutoff string `json:"staleLockCutoff"`
}

// mongoOutboxCountContext is the pending/backlog/failed/processing/dead context.
type mongoOutboxCountContext struct {
	Type     string   `json:"type"`
	Statuses []string `json:"statuses"`
}

// pipelineProvider is PipelineMetricProvider.
type pipelineProvider struct {
	deps Dependencies
}

// NewPipeline returns the pipeline_job metric provider.
func NewPipeline(deps Dependencies) Provider {
	return &pipelineProvider{deps: deps}
}

// Type is AlertMetricProvider.pipeline_job.
func (p *pipelineProvider) Type() string {
	return TypePipelineJob
}

// Fetch mirrors PipelineMetricProvider.fetch.
func (p *pipelineProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	if metricSlug == "" {
		return pipelineEvaluation(pipelineSlugMissingContext{Error: "metric_slug_missing"})
	}
	if strings.HasPrefix(metricSlug, "mongo_outbox.") {
		return p.fetchMongoOutboxMetric(ctx, rule, metricSlug)
	}
	switch metricSlug {
	case "pipeline.success_rate", "pipeline.failure_rate":
		return p.fetchPipelineRateMetric(ctx, rule, metricSlug)
	case "pipeline.average_llm_latency_ms",
		"pipeline.ingestion_p90_ms",
		"pipeline.ingestion_p99_ms":
		return p.fetchPipelineLatencyMetric(ctx, rule, metricSlug)
	default:
		return p.fetchPipelineJobCountMetric(ctx, rule)
	}
}

// pipelineEvaluation returns a value-less evaluation that only carries context.
func pipelineEvaluation(payload any) (Evaluation, error) {
	raw, err := marshalProviderContext(payload)
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Context: raw}, nil
}

// pipelineJobFilter is one Prisma.PipelineJobWhereInput reduced to the columns
// the provider filters on.
type pipelineJobFilter struct {
	OrgID string
	// Statuses is the resolved `status: { in: ... }` list.
	Statuses []string
	// FilterStatuses distinguishes "no status condition" (the rate total) from
	// an empty IN list (a rule that requested no allowed status).
	FilterStatuses bool
	QueueName      string
	SourceID       string
	From           time.Time
	// Before encodes `createdAt: { gte: From, lt: Before }` when set.
	Before *time.Time
}

// countPipelineJobs runs the COUNT(*) the NestJS provider would run through
// prisma.pipelineJob.count.
func (p *pipelineProvider) countPipelineJobs(ctx context.Context, filter pipelineJobFilter) (int64, error) {
	if p.deps.DB == nil {
		return 0, errors.New("alertworker/providers: pipeline metric: mysql is not configured")
	}
	if filter.FilterStatuses && len(filter.Statuses) == 0 {
		// Prisma `{ in: [] }` matches no row; MySQL rejects `IN ()`.
		return 0, nil
	}
	query := "SELECT COUNT(*) FROM PipelineJob WHERE orgId = ?"
	args := []any{filter.OrgID}
	if filter.FilterStatuses {
		query += " AND status IN (" + providerSQLPlaceholders(len(filter.Statuses)) + ")"
		for _, status := range filter.Statuses {
			args = append(args, status)
		}
	}
	if filter.QueueName != "" {
		query += " AND queueName = ?"
		args = append(args, filter.QueueName)
	}
	if filter.SourceID != "" {
		query += " AND sourceId = ?"
		args = append(args, filter.SourceID)
	}
	query += " AND createdAt >= ?"
	args = append(args, filter.From)
	if filter.Before != nil {
		query += " AND createdAt < ?"
		args = append(args, *filter.Before)
	}
	var count int64
	if err := p.deps.DB.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("alertworker/providers: pipeline job count: %w", err)
	}
	return count, nil
}

// fetchPipelineJobCountMetric is the default status-count branch.
func (p *pipelineProvider) fetchPipelineJobCountMetric(ctx context.Context, rule Rule) (Evaluation, error) {
	windowMinutes := 60
	if rule.ChangeWindowMin != nil {
		windowMinutes = *rule.ChangeWindowMin
	}
	window := time.Duration(windowMinutes) * time.Minute
	now := p.deps.now().UTC()
	windowStart := now.Add(-window)
	previousWindowStart := now.Add(-2 * window)

	metadata := readRuleMetadata(rule.Metadata)
	statuses := resolvePipelineJobStatuses(metadata)
	queueName, _ := metadata.text("queueName")
	sourceID, _ := metadata.text("sourceId")

	latest, err := p.countPipelineJobs(ctx, pipelineJobFilter{
		OrgID:          rule.OrgID,
		Statuses:       statuses,
		FilterStatuses: true,
		QueueName:      queueName,
		SourceID:       sourceID,
		From:           windowStart,
	})
	if err != nil {
		return Evaluation{}, err
	}
	previous, err := p.countPipelineJobs(ctx, pipelineJobFilter{
		OrgID:          rule.OrgID,
		Statuses:       statuses,
		FilterStatuses: true,
		QueueName:      queueName,
		SourceID:       sourceID,
		From:           previousWindowStart,
		Before:         &windowStart,
	})
	if err != nil {
		return Evaluation{}, err
	}

	raw, err := marshalProviderContext(pipelineJobCountContext{
		WindowMinutes: windowMinutes,
		Statuses:      statuses,
		QueueName:     stringPointerWhenSet(queueName),
		SourceID:      stringPointerWhenSet(sourceID),
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

// fetchPipelineRateMetric is success_rate/failure_rate.
func (p *pipelineProvider) fetchPipelineRateMetric(ctx context.Context, rule Rule, metricSlug string) (Evaluation, error) {
	windowMinutes := 60
	if rule.ChangeWindowMin != nil {
		windowMinutes = *rule.ChangeWindowMin
	}
	windowStart := p.deps.now().UTC().Add(-time.Duration(windowMinutes) * time.Minute)

	metadata := readRuleMetadata(rule.Metadata)
	queueName, _ := metadata.text("queueName")
	sourceID, _ := metadata.text("sourceId")

	total, err := p.countPipelineJobs(ctx, pipelineJobFilter{
		OrgID:     rule.OrgID,
		QueueName: queueName,
		SourceID:  sourceID,
		From:      windowStart,
	})
	if err != nil {
		return Evaluation{}, err
	}
	completed, err := p.countPipelineJobs(ctx, pipelineJobFilter{
		OrgID:          rule.OrgID,
		Statuses:       []string{pipelineStatusCompleted},
		FilterStatuses: true,
		QueueName:      queueName,
		SourceID:       sourceID,
		From:           windowStart,
	})
	if err != nil {
		return Evaluation{}, err
	}
	failed, err := p.countPipelineJobs(ctx, pipelineJobFilter{
		OrgID:          rule.OrgID,
		Statuses:       []string{pipelineStatusFailed},
		FilterStatuses: true,
		QueueName:      queueName,
		SourceID:       sourceID,
		From:           windowStart,
	})
	if err != nil {
		return Evaluation{}, err
	}

	var latest float64
	if total > 0 {
		if metricSlug == "pipeline.success_rate" {
			latest = float64(completed) / float64(total)
		} else {
			latest = float64(failed) / float64(total)
		}
	}
	// The NestJS provider also exports a Prometheus gauge through
	// setPipelineMetric; the Go worker has no Prometheus registry for this
	// queue, so the metric export is not part of the queue contract.
	raw, err := marshalProviderContext(pipelineRateContext{
		WindowMinutes: windowMinutes,
		Total:         total,
		Completed:     completed,
		Failed:        failed,
		QueueName:     stringPointerWhenSet(queueName),
		SourceID:      stringPointerWhenSet(sourceID),
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(latest), Context: raw}, nil
}

// fetchPipelineLatencyMetric dispatches average_llm_latency_ms and the two
// ingestion percentiles.
func (p *pipelineProvider) fetchPipelineLatencyMetric(ctx context.Context, rule Rule, metricSlug string) (Evaluation, error) {
	windowMinutes := 60
	if rule.ChangeWindowMin != nil {
		windowMinutes = *rule.ChangeWindowMin
	}
	if metricSlug == "pipeline.average_llm_latency_ms" {
		return p.fetchAverageLLMLatency(ctx, rule, windowMinutes)
	}
	return p.fetchIngestionLatency(ctx, rule, metricSlug, windowMinutes)
}

// fetchAverageLLMLatency reads the newest 5000 numeric latency samples from
// llmrequestlogs and averages the finite non-negative ones.
func (p *pipelineProvider) fetchAverageLLMLatency(ctx context.Context, rule Rule, windowMinutes int) (Evaluation, error) {
	if p.deps.Mongo == nil {
		return Evaluation{}, errors.New("alertworker/providers: pipeline metric: mongo is not configured")
	}
	windowStart := p.deps.now().UTC().Add(-time.Duration(windowMinutes) * time.Minute)
	cursor, err := p.deps.Mongo.Collection(pipelineLLMRequestLogsCollection).Find(ctx,
		bson.D{
			{Key: "orgId", Value: rule.OrgID},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: windowStart}}},
			// $type: "number" keeps BSON ints and doubles but drops null/missing.
			{Key: "latencyMs", Value: bson.D{{Key: "$type", Value: "number"}}},
		},
		options.Find().
			SetProjection(bson.D{{Key: "latencyMs", Value: 1}}).
			SetSort(bson.D{{Key: "createdAt", Value: -1}}).
			SetLimit(pipelineLatencySampleLimit),
	)
	if err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: llm latency query: %w", err)
	}
	defer cursor.Close(ctx)

	values := make([]float64, 0, pipelineLatencySampleLimit)
	for cursor.Next(ctx) {
		var row struct {
			LatencyMs any `bson:"latencyMs"`
		}
		if err := cursor.Decode(&row); err != nil {
			return Evaluation{}, fmt.Errorf("alertworker/providers: llm latency decode: %w", err)
		}
		value, ok := bsonNumericValue(row.LatencyMs)
		if !ok || !isFiniteMetricNumber(value) || value < 0 {
			continue
		}
		values = append(values, value)
	}
	if err := cursor.Err(); err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: llm latency cursor: %w", err)
	}

	latest := 0.0
	if len(values) > 0 {
		sum := 0.0
		for _, value := range values {
			sum += value
		}
		latest = sum / float64(len(values))
	}
	raw, err := marshalProviderContext(pipelineAverageLatencyContext{
		WindowMinutes: windowMinutes,
		SampleSize:    len(values),
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(latest), Context: raw}, nil
}

// fetchIngestionLatency reads the newest 5000 completed PipelineJob durations
// and returns their p90/p99.
func (p *pipelineProvider) fetchIngestionLatency(ctx context.Context, rule Rule, metricSlug string, windowMinutes int) (Evaluation, error) {
	if p.deps.DB == nil {
		return Evaluation{}, errors.New("alertworker/providers: pipeline metric: mysql is not configured")
	}
	windowStart := p.deps.now().UTC().Add(-time.Duration(windowMinutes) * time.Minute)
	rows, err := p.deps.DB.QueryContext(ctx,
		"SELECT startedAt, completedAt FROM PipelineJob"+
			" WHERE orgId = ? AND status = ? AND createdAt >= ?"+
			" AND startedAt IS NOT NULL AND completedAt IS NOT NULL"+
			" ORDER BY completedAt DESC LIMIT ?",
		rule.OrgID, pipelineStatusCompleted, windowStart, pipelineLatencySampleLimit,
	)
	if err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: pipeline ingestion latency query: %w", err)
	}
	defer rows.Close()

	values := make([]float64, 0, pipelineLatencySampleLimit)
	for rows.Next() {
		var startedAt, completedAt sql.NullTime
		if err := rows.Scan(&startedAt, &completedAt); err != nil {
			return Evaluation{}, fmt.Errorf("alertworker/providers: pipeline ingestion latency scan: %w", err)
		}
		if !startedAt.Valid || !completedAt.Valid {
			continue
		}
		milliseconds := float64(completedAt.Time.Sub(startedAt.Time)) / float64(time.Millisecond)
		if !isFiniteMetricNumber(milliseconds) || milliseconds < 0 {
			continue
		}
		values = append(values, milliseconds)
	}
	if err := rows.Err(); err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: pipeline ingestion latency rows: %w", err)
	}

	percentile := 90
	if metricSlug == "pipeline.ingestion_p99_ms" {
		percentile = 99
	}
	latest := 0.0
	if sampled := pipelineQuantile(values, float64(percentile)); sampled != nil {
		latest = *sampled
	}
	raw, err := marshalProviderContext(pipelineIngestionLatencyContext{
		WindowMinutes: windowMinutes,
		SampleSize:    len(values),
		Percentile:    percentile,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(latest), Context: raw}, nil
}

// fetchMongoOutboxMetric ports every mongo_outbox.* branch.
func (p *pipelineProvider) fetchMongoOutboxMetric(ctx context.Context, rule Rule, metricSlug string) (Evaluation, error) {
	if p.deps.DB == nil {
		return Evaluation{}, errors.New("alertworker/providers: pipeline metric: mysql is not configured")
	}
	now := p.deps.now().UTC()
	staleLockCutoff := now.Add(-outboxStaleLockWindow)
	metadata := readRuleMetadata(rule.Metadata)
	outboxType := outboxTypeFromMetadata(metadata)
	slug := strings.TrimSpace(metricSlug)

	switch slug {
	case "mongo_outbox.oldest_age_minutes":
		return p.fetchOutboxOldest(ctx, rule.OrgID, outboxType, now)
	case "mongo_outbox.stale_processing":
		return p.fetchOutboxStaleProcessing(ctx, rule.OrgID, outboxType, staleLockCutoff)
	}

	statuses := resolveOutboxStatuses(metadata, slug)

	if len(statuses) == 0 {
		// Prisma `{ in: [] }` matches no row; MySQL rejects `IN ()`.
		raw, err := marshalProviderContext(mongoOutboxCountContext{Type: outboxType, Statuses: statuses})
		if err != nil {
			return Evaluation{}, err
		}
		return Evaluation{Latest: evaluationNumber(0), Context: raw}, nil
	}

	query := "SELECT COUNT(*) FROM MongoOutbox WHERE orgId = ? AND type = ?" +
		" AND status IN (" + providerSQLPlaceholders(len(statuses)) + ")"
	args := []any{rule.OrgID, outboxType}
	for _, status := range statuses {
		args = append(args, status)
	}
	if slug == "mongo_outbox.pending" {
		query += " AND availableAt <= ?"
		args = append(args, now)
	}
	var count int64
	if err := p.deps.DB.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: mongo outbox count: %w", err)
	}
	raw, err := marshalProviderContext(mongoOutboxCountContext{Type: outboxType, Statuses: statuses})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(float64(count)), Context: raw}, nil
}

// fetchOutboxOldest is mongo_outbox.oldest_age_minutes.
func (p *pipelineProvider) fetchOutboxOldest(ctx context.Context, orgID, outboxType string, now time.Time) (Evaluation, error) {
	var createdAt sql.NullTime
	err := p.deps.DB.QueryRowContext(ctx,
		"SELECT createdAt FROM MongoOutbox"+
			" WHERE orgId = ? AND type = ? AND status IN (?, ?, ?)"+
			" ORDER BY createdAt ASC LIMIT 1",
		orgID, outboxType, outboxStatusPending, outboxStatusFailed, outboxStatusProcessing,
	).Scan(&createdAt)
	var latest *float64
	var oldestCreatedAt *string
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// No active row: both latest and oldestCreatedAt stay null.
	case err != nil:
		return Evaluation{}, fmt.Errorf("alertworker/providers: mongo outbox oldest query: %w", err)
	case createdAt.Valid:
		minutes := math.Max(0, now.Sub(createdAt.Time).Minutes())
		latest = evaluationNumber(math.Round(minutes))
		timestamp := jsISOTimestamp(createdAt.Time)
		oldestCreatedAt = &timestamp
	}
	raw, err := marshalProviderContext(mongoOutboxOldestContext{
		Type:            outboxType,
		OldestCreatedAt: oldestCreatedAt,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: latest, Context: raw}, nil
}

// fetchOutboxStaleProcessing is mongo_outbox.stale_processing: processing rows
// whose lock is older than the five minute cutoff.
func (p *pipelineProvider) fetchOutboxStaleProcessing(ctx context.Context, orgID, outboxType string, staleLockCutoff time.Time) (Evaluation, error) {
	var count int64
	if err := p.deps.DB.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM MongoOutbox WHERE orgId = ? AND type = ? AND status = ? AND lockedAt < ?",
		orgID, outboxType, outboxStatusProcessing, staleLockCutoff,
	).Scan(&count); err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: mongo outbox stale query: %w", err)
	}
	raw, err := marshalProviderContext(mongoOutboxStaleContext{
		Type:            outboxType,
		StaleLockCutoff: jsISOTimestamp(staleLockCutoff),
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(float64(count)), Context: raw}, nil
}
