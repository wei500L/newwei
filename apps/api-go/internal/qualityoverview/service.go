package qualityoverview

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// Prisma 枚举 ObservabilitySnapshotScope 的两个取值。
	scopeQualityNewsSources = "quality_news_sources"
	scopeQualityPipeline    = "quality_pipeline"

	// ITEM_PIPELINE_QUEUE_NAME（apps/api/src/modules/queue/queue.constants.ts）。
	itemPipelineQueue = "itemPipeline"

	newsSourceTtlSeconds = 60
	pipelineTtlSeconds   = 60

	outboxStaleLockMs  = 5 * 60_000
	maxLatencySamples  = 5_000
	overviewSinceMins  = 60
	overviewItemLimit  = 10
	overviewCacheTtl   = 15
	overviewCachePref  = "quality:task-logs:overview:"
	newssourceWindow24 = 24

	// Mongoose 8 默认集合名：ProcessedItem → processeditems，
	// TaskLog → tasklogs（后者由 adminlogs 持有）。
	processedItemsCollection = "processeditems"
)

// Service 承载 5 条 GET 的 MySQL / Mongo 查询、快照与缓存。handler 只做
// 路由、鉴权与参数收敛。
type Service struct {
	db    *sql.DB
	mongo *mongo.Database
	store *snapshotStore
	// logs 复用 internal/adminlogs 的任务日志聚合、深层脱敏与机器令牌
	// 鉴权（唯一实现）。
	logs *adminlogs.Service
}

// NewService 组装 5 条 GET 的只读来源。database 为 nil 时 Mongo 查询一律
// 失败（fail-closed）；store 负责 ObservabilitySnapshot 与 Redis。
func NewService(db *sql.DB, database *mongo.Database, redisClient *redis.Client) *Service {
	return &Service{
		db:    db,
		mongo: database,
		store: &snapshotStore{db: db, redis: redisClient},
		logs:  adminlogs.NewService(db, database),
	}
}

// AuthenticateMachine 复用人 adminlogs 的机器令牌鉴权实现。
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	return s.logs.AuthenticateMachine(ctx, token)
}

// ---- 新闻源质量 / 流水线质量：快照包装 ----

// NewsSourceQuality 对齐 NewsSourceQualityService.summary：
// windowHours 缺省 24，收口到 [1, 24*14]；命中未过期的快照直接返回。
func (s *Service) NewsSourceQuality(ctx context.Context, orgID string, windowHours float64, hasWindow bool) (json.RawMessage, error) {
	window := 24.0
	if hasWindow {
		window = windowHours
	}
	normalized := clampWindow(window, 1, 24*14)
	return s.store.getOrCreate(ctx, orgID, scopeQualityNewsSources,
		fmt.Sprintf("windowHours:%d", normalized), newsSourceTtlSeconds,
		func() (any, error) { return s.buildNewsSourceSummary(ctx, orgID, normalized) },
	)
}

// PipelineQuality 对齐 PipelineQualityService.summary：
// windowMinutes 缺省 60，收口到 [5, 60*24*14]。
func (s *Service) PipelineQuality(ctx context.Context, orgID string, windowMinutes float64, hasWindow bool) (json.RawMessage, error) {
	window := 60.0
	if hasWindow {
		window = windowMinutes
	}
	normalized := clampWindow(window, 5, 60*24*14)
	return s.store.getOrCreate(ctx, orgID, scopeQualityPipeline,
		fmt.Sprintf("windowMinutes:%d", normalized), pipelineTtlSeconds,
		func() (any, error) { return s.buildPipelineSummary(ctx, orgID, normalized) },
	)
}

// clampWindow 对齐 Math.max(min, Math.min(max, Math.floor(value)))。value 已
// 是有限数（调用方已过滤 NaN/Infinity）。
func clampWindow(value float64, min, max int) int {
	floored := math.Floor(value)
	if floored < float64(min) {
		return min
	}
	if floored > float64(max) {
		return max
	}
	return int(floored)
}

// ---- 任务日志（复用 internal/adminlogs） ----

// TaskLogItems 对齐 quality task-logs 列表：只返回 items。
func (s *Service) TaskLogItems(ctx context.Context, orgID string, filters adminlogs.TaskLogListFilters, limit int) ([]adminlogs.TaskLogItemJSON, error) {
	return s.logs.ListTaskLogItems(ctx, orgID, filters, limit)
}

// TaskLogSummary 对齐 quality task-logs 汇总。
func (s *Service) TaskLogSummary(ctx context.Context, orgID string, filters adminlogs.TaskLogListFilters) (adminlogs.TaskLogSummaryJSON, error) {
	return s.logs.SummarizeTaskLogsForQuality(ctx, orgID, filters)
}

// TaskLogsOverview 对齐 AdminLogsService.getQualityTaskLogsOverview：
// sinceMinutes 固定 60、limit 固定 10，Redis 键
// quality:task-logs:overview:<orgId>:60:10，TTL 15s，lockTtl 2000ms、
// retryDelay 50ms、maxWait 3000ms。
func (s *Service) TaskLogsOverview(ctx context.Context, orgID string) (json.RawMessage, error) {
	key := fmt.Sprintf("%s%s:%d:%d", overviewCachePref, orgID, overviewSinceMins, overviewItemLimit)
	return s.store.cacheWrapJSON(ctx, key, overviewCacheTtl, cacheOptions{
		lockTtl:    2 * time.Second,
		renewEvery: time.Second,
		retryDelay: 50 * time.Millisecond,
		maxWait:    3 * time.Second,
	}, func() (json.RawMessage, error) {
		overview, err := s.logs.QualityTaskLogOverview(ctx, orgID, overviewSinceMins, overviewItemLimit)
		if err != nil {
			return nil, err
		}
		return json.Marshal(overview)
	})
}

// ---- 质量总览 ----

// qualityOverviewResponse 对齐 QualityOverviewResponse。
type qualityOverviewResponse struct {
	GeneratedAt string          `json:"generatedAt"`
	Pipeline    json.RawMessage `json:"pipeline"`
	NewsSources json.RawMessage `json:"newsSources"`
	TaskLogs    json.RawMessage `json:"taskLogs"`
}

// Overview 对齐 QualityOverviewService.getOverview：pipeline 用请求的
// windowMinutes，newsSources 固定 24 小时，taskLogs 固定 60 分钟 / 10 条。
func (s *Service) Overview(ctx context.Context, orgID string, windowMinutes float64, hasWindow bool) (qualityOverviewResponse, error) {
	pipeline, err := s.PipelineQuality(ctx, orgID, windowMinutes, hasWindow)
	if err != nil {
		return qualityOverviewResponse{}, err
	}
	newsSources, err := s.NewsSourceQuality(ctx, orgID, newssourceWindow24, true)
	if err != nil {
		return qualityOverviewResponse{}, err
	}
	taskLogs, err := s.TaskLogsOverview(ctx, orgID)
	if err != nil {
		return qualityOverviewResponse{}, err
	}
	return qualityOverviewResponse{
		GeneratedAt: formatJSTime(time.Now()),
		Pipeline:    pipeline,
		NewsSources: newsSources,
		TaskLogs:    taskLogs,
	}, nil
}

// ---- 新闻源质量构建 ----

func (s *Service) buildNewsSourceSummary(ctx context.Context, orgID string, windowHours int) (newsSourceQualitySummary, error) {
	if s.db == nil {
		return newsSourceQualitySummary{}, errors.New("mysql is not configured")
	}
	now := time.Now()
	since := now.Add(-time.Duration(windowHours) * time.Hour)

	var total, active, failing, circuitOpen int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM NewsSource WHERE orgId = ?", orgID).Scan(&total); err != nil {
		return newsSourceQualitySummary{}, err
	}
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM NewsSource WHERE orgId = ? AND isActive = 1", orgID).Scan(&active); err != nil {
		return newsSourceQualitySummary{}, err
	}
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM NewsSource WHERE orgId = ? AND consecutiveFailures > 0", orgID).Scan(&failing); err != nil {
		return newsSourceQualitySummary{}, err
	}
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM NewsSource WHERE orgId = ? AND isActive = 1 AND circuitOpenUntil > ?",
		orgID, now).Scan(&circuitOpen); err != nil {
		return newsSourceQualitySummary{}, err
	}

	// 对齐 Prisma pipelineJob.groupBy({ by: ["sourceId"], _count: { id },
	// orderBy: { _count: { id: "desc" } }, take: 10 })，sourceId 非空。
	rows, err := s.db.QueryContext(ctx, `
SELECT sourceId, COUNT(id) AS cnt FROM PipelineJob
WHERE orgId = ? AND status = 'failed' AND sourceId IS NOT NULL AND createdAt >= ?
GROUP BY sourceId
ORDER BY cnt DESC
LIMIT 10`, orgID, since)
	if err != nil {
		return newsSourceQualitySummary{}, err
	}
	type failureRow struct {
		sourceID string
		count    int
	}
	failures := []failureRow{}
	for rows.Next() {
		var sourceID string
		var count int
		if err := rows.Scan(&sourceID, &count); err != nil {
			rows.Close()
			return newsSourceQualitySummary{}, err
		}
		failures = append(failures, failureRow{sourceID: sourceID, count: count})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return newsSourceQualitySummary{}, err
	}
	rows.Close()

	ids := make([]string, 0, len(failures))
	for _, failure := range failures {
		ids = append(ids, failure.sourceID)
	}
	sourceMap, err := s.loadNewsSources(ctx, orgID, ids)
	if err != nil {
		return newsSourceQualitySummary{}, err
	}

	topFailing := make([]topFailingSource, 0, len(failures))
	for _, failure := range failures {
		source, ok := sourceMap[failure.sourceID]
		if !ok {
			continue
		}
		topFailing = append(topFailing, topFailingSource{
			SourceID:            failure.sourceID,
			Name:                source.name,
			URL:                 source.url,
			FailedJobs:          failure.count,
			ConsecutiveFailures: source.consecutiveFailures,
			LastFailureAt:       nullTimeISO(source.lastFailureAt),
			CircuitOpenUntil:    nullTimeISO(source.circuitOpenUntil),
			NextRunAt:           nullTimeISO(source.nextRunAt),
		})
	}

	return newsSourceQualitySummary{
		WindowHours: windowHours,
		Totals: newsSourceTotals{
			Total:       total,
			Active:      active,
			Failing:     failing,
			CircuitOpen: circuitOpen,
		},
		TopFailingSources: topFailing,
	}, nil
}

type newsSourceRow struct {
	name                string
	url                 string
	consecutiveFailures int
	lastFailureAt       sql.NullTime
	circuitOpenUntil    sql.NullTime
	nextRunAt           sql.NullTime
}

// loadNewsSources 对齐 `newsSource.findMany({ where: { orgId, id: { in } } })`，
// 缺 ID 时直接返回空（不查库）。
func (s *Service) loadNewsSources(ctx context.Context, orgID string, ids []string) (map[string]newsSourceRow, error) {
	out := make(map[string]newsSourceRow, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	placeholders := ""
	args := make([]any, 0, len(ids)+1)
	args = append(args, orgID)
	for i, id := range ids {
		if i > 0 {
			placeholders += ", "
		}
		placeholders += "?"
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, name, url, consecutiveFailures, lastFailureAt, circuitOpenUntil, nextRunAt FROM NewsSource WHERE orgId = ? AND id IN ("+placeholders+")",
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var row newsSourceRow
		if err := rows.Scan(&id, &row.name, &row.url, &row.consecutiveFailures,
			&row.lastFailureAt, &row.circuitOpenUntil, &row.nextRunAt); err != nil {
			return nil, err
		}
		out[id] = row
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ---- 流水线质量构建 ----

type pipelineStatusBucket struct {
	ID    any   `bson:"_id"`
	Count int64 `bson:"count"`
}

type pipelineLatencyBucket struct {
	AvgLatencyMs *float64 `bson:"avgLatencyMs"`
}

type pipelineLlmBucket struct {
	ID             any      `bson:"_id"`
	Count          int64    `bson:"count"`
	AvgLatencyMs   *float64 `bson:"avgLatencyMs"`
	AvgCostUsd     *float64 `bson:"avgCostUsd"`
	AvgTotalTokens *float64 `bson:"avgTotalTokens"`
}

type pipelineFacet struct {
	StatusAgg  []pipelineStatusBucket  `bson:"statusAgg"`
	LatencyAgg []pipelineLatencyBucket `bson:"latencyAgg"`
	LlmAgg     []pipelineLlmBucket     `bson:"llmAgg"`
}

type failureBucket struct {
	ID struct {
		Stage     any `bson:"stage"`
		ErrorName any `bson:"errorName"`
	} `bson:"_id"`
	Count int64 `bson:"count"`
}

func (s *Service) buildPipelineSummary(ctx context.Context, orgID string, windowMinutes int) (pipelineQualitySummary, error) {
	if s.db == nil {
		return pipelineQualitySummary{}, errors.New("mysql is not configured")
	}
	if s.mongo == nil {
		return pipelineQualitySummary{}, errors.New("mongo is not configured")
	}
	now := time.Now()
	since := now.Add(-time.Duration(windowMinutes) * time.Minute)

	processedFacet, err := s.aggregateProcessedItems(ctx, orgID, since)
	if err != nil {
		return pipelineQualitySummary{}, err
	}
	failures, err := s.aggregateFailureTypes(ctx, orgID, since)
	if err != nil {
		return pipelineQualitySummary{}, err
	}
	ingestion, err := s.computeIngestionLatency(ctx, orgID, since)
	if err != nil {
		return pipelineQualitySummary{}, err
	}
	outbox, err := s.buildOutbox(ctx, orgID, now)
	if err != nil {
		return pipelineQualitySummary{}, err
	}

	totals := pipelineTotals{}
	for _, bucket := range processedFacet.StatusAgg {
		count := int(bucket.Count)
		totals.Total += count
		switch stringOrDefault(bucket.ID, "") {
		case "completed":
			totals.Completed = count
		case "failed":
			totals.Failed = count
		case "processing":
			totals.Processing = count
		case "pending":
			totals.Pending = count
		}
	}

	var successRate *float64
	if totals.Total > 0 {
		rate := float64(totals.Completed) / float64(totals.Total)
		successRate = &rate
	}

	var averageLatencyMs *float64
	if len(processedFacet.LatencyAgg) > 0 {
		candidate := processedFacet.LatencyAgg[0].AvgLatencyMs
		if candidate != nil && isFinite(*candidate) {
			rounded := math.Round(*candidate)
			averageLatencyMs = &rounded
		}
	}

	llmModels := make([]pipelineLlmModel, 0, len(processedFacet.LlmAgg))
	for _, bucket := range processedFacet.LlmAgg {
		llmModels = append(llmModels, pipelineLlmModel{
			Model:          stringOrDefault(bucket.ID, "unknown"),
			Count:          int(bucket.Count),
			AvgLatencyMs:   roundFinite(bucket.AvgLatencyMs, 0),
			AvgCostUsd:     roundFinite(bucket.AvgCostUsd, 3),
			AvgTotalTokens: roundFinite(bucket.AvgTotalTokens, 0),
		})
	}

	failureTypes := make([]pipelineFailureType, 0, len(failures))
	for _, bucket := range failures {
		failureTypes = append(failureTypes, pipelineFailureType{
			Stage:     stringOrDefault(bucket.ID.Stage, "unknown"),
			ErrorName: adminlogs.RedactSensitiveFields(stringOrDefault(bucket.ID.ErrorName, "unknown")),
			Count:     int(bucket.Count),
		})
	}

	return pipelineQualitySummary{
		WindowMinutes:      windowMinutes,
		Totals:             totals,
		SuccessRate:        successRate,
		AverageLatencyMs:   averageLatencyMs,
		IngestionLatencyMs: ingestion,
		FailureTypes:       failureTypes,
		LlmModels:          llmModels,
		Outbox:             outbox,
	}, nil
}

// aggregateProcessedItems 对齐 ProcessedItemModel.aggregate 的 $facet：
// statusAgg（按 status 计数）、latencyAgg（completed 且 llm.latencyMs 为
// number 的平均值）、llmAgg（completed 按 llm.model 分组，count 降序前 10）。
func (s *Service) aggregateProcessedItems(ctx context.Context, orgID string, since time.Time) (pipelineFacet, error) {
	llmNumberCond := func(field string) bson.D {
		return bson.D{{Key: "$cond", Value: bson.A{
			bson.D{{Key: "$eq", Value: bson.A{
				bson.D{{Key: "$type", Value: field}}, "number",
			}}},
			field,
			nil,
		}}}
	}
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		{{Key: "$facet", Value: bson.D{
			{Key: "statusAgg", Value: mongo.Pipeline{
				{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$status"},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				}}},
			}},
			{Key: "latencyAgg", Value: mongo.Pipeline{
				{{Key: "$match", Value: bson.D{
					{Key: "status", Value: "completed"},
					{Key: "llm.latencyMs", Value: bson.D{{Key: "$type", Value: "number"}}},
				}}},
				{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: nil},
					{Key: "avgLatencyMs", Value: bson.D{{Key: "$avg", Value: "$llm.latencyMs"}}},
				}}},
			}},
			{Key: "llmAgg", Value: mongo.Pipeline{
				{{Key: "$match", Value: bson.D{{Key: "status", Value: "completed"}}}},
				{{Key: "$project", Value: bson.D{
					{Key: "model", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$llm.model", "unknown"}}}},
					{Key: "latencyMs", Value: llmNumberCond("$llm.latencyMs")},
					{Key: "costUsd", Value: llmNumberCond("$llm.costUsd")},
					{Key: "totalTokens", Value: llmNumberCond("$llm.totalTokens")},
				}}},
				{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$model"},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
					{Key: "avgLatencyMs", Value: bson.D{{Key: "$avg", Value: "$latencyMs"}}},
					{Key: "avgCostUsd", Value: bson.D{{Key: "$avg", Value: "$costUsd"}}},
					{Key: "avgTotalTokens", Value: bson.D{{Key: "$avg", Value: "$totalTokens"}}},
				}}},
				{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}},
				{{Key: "$limit", Value: 10}},
			}},
		}}},
	}
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, pipeline)
	if err != nil {
		return pipelineFacet{}, err
	}
	var results []pipelineFacet
	if err := cursor.All(ctx, &results); err != nil {
		return pipelineFacet{}, err
	}
	if len(results) == 0 {
		return pipelineFacet{}, nil
	}
	return results[0], nil
}

// aggregateFailureTypes 对齐 TaskLogModel.aggregate：queue=itemPipeline、
// status=failed、createdAt>=since，按 {stage, errorName} 分组，count 降序
// 前 20（errorName 的脱敏在 buildPipelineSummary 里调用 adminlogs 的
// 同一函数完成）。
func (s *Service) aggregateFailureTypes(ctx context.Context, orgID string, since time.Time) ([]failureBucket, error) {
	cursor, err := s.mongo.Collection("tasklogs").Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: itemPipelineQueue},
			{Key: "status", Value: "failed"},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "stage", Value: 1},
			{Key: "errorName", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$error.name", "unknown"}}}},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "stage", Value: "$stage"},
				{Key: "errorName", Value: "$errorName"},
			}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}},
		{{Key: "$limit", Value: 20}},
	})
	if err != nil {
		return nil, err
	}
	var buckets []failureBucket
	if err := cursor.All(ctx, &buckets); err != nil {
		return nil, err
	}
	return buckets, nil
}

type ingestionLatencyDoc struct {
	CreatedAt  time.Time `bson:"createdAt"`
	IngestedAt time.Time `bson:"ingestedAt"`
}

// computeIngestionLatency 对齐 computeIngestionLatency：最近 5000 条
// status=completed 且 ingestedAt 为日期的文档，createdAt - ingestedAt >= 0，
// 升序后算 sampleSize / averageMs / p50 / p90 / p99 / max。
func (s *Service) computeIngestionLatency(ctx context.Context, orgID string, since time.Time) (ingestionLatency, error) {
	cursor, err := s.mongo.Collection(processedItemsCollection).Find(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
			{Key: "status", Value: "completed"},
			{Key: "ingestedAt", Value: bson.D{{Key: "$type", Value: "date"}}},
		},
		options.Find().
			SetProjection(bson.D{
				{Key: "createdAt", Value: 1},
				{Key: "ingestedAt", Value: 1},
			}).
			SetSort(bson.D{{Key: "createdAt", Value: -1}}).
			SetLimit(maxLatencySamples),
	)
	if err != nil {
		return ingestionLatency{}, err
	}
	var documents []ingestionLatencyDoc
	if err := cursor.All(ctx, &documents); err != nil {
		return ingestionLatency{}, err
	}

	latencies := make([]int64, 0, len(documents))
	for _, document := range documents {
		if document.CreatedAt.IsZero() || document.IngestedAt.IsZero() {
			continue
		}
		latency := document.CreatedAt.UnixMilli() - document.IngestedAt.UnixMilli()
		if latency >= 0 {
			latencies = append(latencies, latency)
		}
	}
	if len(latencies) == 0 {
		return ingestionLatency{SampleSize: 0}, nil
	}

	sortInt64s(latencies)
	var sum int64
	for _, value := range latencies {
		sum += value
	}
	average := math.Round(float64(sum) / float64(len(latencies)))
	maxValue := float64(latencies[len(latencies)-1])
	return ingestionLatency{
		SampleSize: len(latencies),
		AverageMs:  &average,
		P50Ms:      percentile(latencies, 0.5),
		P90Ms:      percentile(latencies, 0.9),
		P99Ms:      percentile(latencies, 0.99),
		MaxMs:      &maxValue,
	}, nil
}

// percentile 对齐 PipelineQualityService.percentile：index =
// floor(pct * (len - 1))。
func percentile(sorted []int64, pct float64) *float64 {
	if len(sorted) == 0 {
		return nil
	}
	clamped := math.Min(1, math.Max(0, pct))
	index := int(math.Floor(clamped * float64(len(sorted)-1)))
	value := float64(sorted[index])
	return &value
}

// ---- outbox ----

func (s *Service) buildOutbox(ctx context.Context, orgID string, now time.Time) (pipelineOutbox, error) {
	staleLockCutoff := now.Add(-time.Duration(outboxStaleLockMs) * time.Millisecond)

	rows, err := s.db.QueryContext(ctx,
		"SELECT status, COUNT(*) FROM MongoOutbox WHERE orgId = ? AND type = 'processed_item' GROUP BY status", orgID)
	if err != nil {
		return pipelineOutbox{}, err
	}
	totals := outboxTotals{}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return pipelineOutbox{}, err
		}
		totals.Total += count
		switch status {
		case "pending":
			totals.Pending = count
		case "processing":
			totals.Processing = count
		case "failed":
			totals.Failed = count
		case "dead":
			totals.Dead = count
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return pipelineOutbox{}, err
	}
	rows.Close()

	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM MongoOutbox WHERE orgId = ? AND type = 'processed_item' AND status = 'processing' AND lockedAt < ?",
		orgID, staleLockCutoff).Scan(&totals.StaleProcessing); err != nil {
		return pipelineOutbox{}, err
	}

	var oldest sql.NullTime
	err = s.db.QueryRowContext(ctx,
		"SELECT createdAt FROM MongoOutbox WHERE orgId = ? AND type = 'processed_item' AND status IN ('pending', 'failed', 'processing') ORDER BY createdAt ASC LIMIT 1",
		orgID).Scan(&oldest)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return pipelineOutbox{}, err
	}

	var oldestCreatedAt *string
	var oldestAgeMinutes *float64
	if oldest.Valid {
		serialized := formatJSTime(oldest.Time)
		oldestCreatedAt = &serialized
		age := float64(int64(math.Round(float64(now.UnixMilli()-oldest.Time.UnixMilli()) / 60000.0)))
		if age < 0 {
			age = 0
		}
		oldestAgeMinutes = &age
	}

	return pipelineOutbox{
		Totals:           totals,
		OldestCreatedAt:  oldestCreatedAt,
		OldestAgeMinutes: oldestAgeMinutes,
	}, nil
}

// ---- 小工具 ----

// formatJSTime 是 new Date().toISOString() 的等价格式（毫秒 UTC）。
func formatJSTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func nullTimeISO(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	serialized := formatJSTime(value.Time)
	return &serialized
}

// stringOrDefault 对齐 JS 的 String(value ?? fallback)。
func stringOrDefault(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// roundFinite 对齐 `typeof v === "number" && Number.isFinite(v) ? Math.round(v
// * 10^scale) / 10^scale : null`。
func roundFinite(value *float64, scale int) *float64 {
	if value == nil || !isFinite(*value) {
		return nil
	}
	factor := math.Pow(10, float64(scale))
	rounded := math.Round(*value*factor) / factor
	return &rounded
}

// sortInt64s 升序排序（对齐 Nest 的 `latencies.sort((a, b) => a - b)`）。
func sortInt64s(values []int64) {
	slices.Sort(values)
}
