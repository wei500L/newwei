package adminlogs

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// taskLogsCollection / exceptionEventsCollection 是 Mongoose 8 默认集合名
// （model 名小写后走 legacy pluralize）：TaskLog → tasklogs，
// ExceptionEvent → exceptionevents。两个 schema 都没有显式 collection。
const (
	taskLogsCollection        = "tasklogs"
	exceptionEventsCollection = "exceptionevents"
)

// taskLogFilters 是 buildTaskLogWhere 的输入（都已 trim；空串表示不过滤）。
type taskLogFilters struct {
	queue  string
	jobId  string
	stage  string
	status string
	start  *time.Time
	end    *time.Time
}

// exceptionFilters 是 buildFilter 的输入。strict 版本用 start/end 指针
// （控制器已解析）；lenient 版本用 startRaw/endRaw（service 再按 parseDate
// 解析，非法日期忽略该条件）。
type exceptionFilters struct {
	kind            string
	operationName   string
	messageContains string
	start           *time.Time
	end             *time.Time
	startRaw        string
	endRaw          string
}

// facetResult 是 $facet 聚合的返回形状。
type facetResult struct {
	Items     []bson.M       `bson:"items"`
	Total     []facetCount   `bson:"total"`
	StatusAgg []statusBucket `bson:"statusAgg"`
	StageAgg  []statusBucket `bson:"stageAgg"`
	ErrorAgg  []errorBucket  `bson:"errorAgg"`
}

type facetCount struct {
	Count int64 `bson:"count"`
}

type statusBucket struct {
	ID    any   `bson:"_id"`
	Count int64 `bson:"count"`
}

type errorBucket struct {
	ID struct {
		Queue     any `bson:"queue"`
		Stage     any `bson:"stage"`
		ErrorName any `bson:"errorName"`
	} `bson:"_id"`
	SampleMessage any   `bson:"sampleMessage"`
	Count         int64 `bson:"count"`
}

// buildTaskLogWhere 对齐 buildTaskLogWhere：orgId 恒在，其余按需精确匹配，
// createdAt 落在 [start, end]。
func buildTaskLogWhere(orgID string, filters taskLogFilters) bson.D {
	where := bson.D{{Key: "orgId", Value: orgID}}
	if filters.queue != "" {
		where = append(where, bson.E{Key: "queue", Value: filters.queue})
	}
	if filters.jobId != "" {
		where = append(where, bson.E{Key: "jobId", Value: filters.jobId})
	}
	if filters.stage != "" {
		where = append(where, bson.E{Key: "stage", Value: filters.stage})
	}
	if filters.status != "" {
		where = append(where, bson.E{Key: "status", Value: filters.status})
	}
	if filters.start != nil || filters.end != nil {
		where = append(where, bson.E{Key: "createdAt", Value: dateRange(filters.start, filters.end)})
	}
	return where
}

func dateRange(start, end *time.Time) bson.D {
	window := bson.D{}
	if start != nil {
		window = append(window, bson.E{Key: "$gte", Value: *start})
	}
	if end != nil {
		window = append(window, bson.E{Key: "$lte", Value: *end})
	}
	return window
}

// buildExceptionFilter 对齐 exception-events.service.ts 的 buildFilter：
// orgId 恒在；kind 精确；operationName trim 后精确；messageContains trim 后
// escapeRegex + 不区分大小写正则；timestamp 落在 [start, end]。
func buildExceptionFilter(orgID, kind, operationName, messageContains string, start, end *time.Time) bson.D {
	filter := bson.D{{Key: "orgId", Value: orgID}}
	if kind != "" {
		filter = append(filter, bson.E{Key: "kind", Value: kind})
	}
	if operationName != "" {
		filter = append(filter, bson.E{Key: "operationName", Value: operationName})
	}
	if messageContains != "" {
		filter = append(filter, bson.E{Key: "message", Value: messageContainsFilter(messageContains)})
	}
	if start != nil || end != nil {
		filter = append(filter, bson.E{Key: "timestamp", Value: dateRange(start, end)})
	}
	return filter
}

// includeTopErrors 对齐 `includeTopErrors: !filters.status || filters.status === "failed"`。
func includeTopErrors(status string) bool {
	return status == "" || status == "failed"
}

// runTaskLogAggregate 对齐 runTaskLogAggregate 的 $facet 管线。
func (s *Service) runTaskLogAggregate(ctx context.Context, input taskLogAggregateInput) (facetResult, error) {
	if s.logs == nil {
		return facetResult{}, errors.New("mongo is not configured")
	}

	facets := bson.D{
		{Key: "statusAgg", Value: mongo.Pipeline{
			bson.D{{Key: "$group", Value: bson.D{
				{Key: "_id", Value: "$status"},
				{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			}}},
		}},
		{Key: "stageAgg", Value: mongo.Pipeline{
			bson.D{{Key: "$group", Value: bson.D{
				{Key: "_id", Value: "$stage"},
				{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			}}},
			// count DESC with stage ASC as the deterministic tiebreaker.
			bson.D{{Key: "$sort", Value: bson.D{
				{Key: "count", Value: -1},
				{Key: "_id", Value: 1},
			}}},
			bson.D{{Key: "$limit", Value: 50}},
		}},
	}

	if input.includeItems {
		items := mongo.Pipeline{}
		// itemsMatch 对齐 getQualityTaskLogsOverview 的 `itemsMatch`：先按
		// 额外条件过滤，再排序、截断（质量面板只取 status=failed 的前 N 条）。
		if len(input.itemsMatch) > 0 {
			items = append(items, bson.D{{Key: "$match", Value: input.itemsMatch}})
		}
		items = append(items, bson.D{{Key: "$sort", Value: bson.D{
			{Key: "createdAt", Value: -1},
			{Key: "_id", Value: -1},
		}}})
		if input.itemLimit > 0 {
			limit := input.itemLimit
			if limit < 1 {
				limit = 1
			}
			items = append(items, bson.D{{Key: "$limit", Value: limit}})
		} else {
			skip := (input.page - 1) * input.pageSize
			if skip < 0 {
				skip = 0
			}
			items = append(items,
				bson.D{{Key: "$skip", Value: skip}},
				bson.D{{Key: "$limit", Value: input.pageSize}},
			)
		}
		facets = append(facets, bson.E{Key: "items", Value: items})
	}

	if input.includeTotal {
		facets = append(facets, bson.E{Key: "total", Value: mongo.Pipeline{
			bson.D{{Key: "$count", Value: "count"}},
		}})
	}

	if input.includeTopErrors {
		facets = append(facets, bson.E{Key: "errorAgg", Value: mongo.Pipeline{
			bson.D{{Key: "$match", Value: bson.D{{Key: "status", Value: "failed"}}}},
			bson.D{{Key: "$project", Value: bson.D{
				{Key: "queue", Value: 1},
				{Key: "stage", Value: 1},
				// createdAt and _id must survive the projection so the ordered
				// $top below can pick the most recent sample.
				{Key: "createdAt", Value: 1},
				{Key: "_id", Value: 1},
				{Key: "errorName", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$error.name", "unknown"}}}},
				{Key: "errorMessage", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$error.message", "$message"}}}},
			}}},
			bson.D{{Key: "$group", Value: bson.D{
				{Key: "_id", Value: bson.D{
					{Key: "queue", Value: "$queue"},
					{Key: "stage", Value: "$stage"},
					{Key: "errorName", Value: "$errorName"},
				}},
				{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				// sampleMessage is the message of the group's most recent
				// failed record (createdAt DESC, _id DESC), not an arbitrary
				// $first in collection order.
				{Key: "sampleMessage", Value: bson.D{{Key: "$top", Value: bson.D{
					{Key: "sortBy", Value: bson.D{
						{Key: "createdAt", Value: -1},
						{Key: "_id", Value: -1},
					}},
					{Key: "output", Value: "$errorMessage"},
				}}}},
			}}},
			// count DESC, then queue / stage / errorName ASC.
			bson.D{{Key: "$sort", Value: bson.D{
				{Key: "count", Value: -1},
				{Key: "_id.queue", Value: 1},
				{Key: "_id.stage", Value: 1},
				{Key: "_id.errorName", Value: 1},
			}}},
			bson.D{{Key: "$limit", Value: 25}},
		}})
	}

	cursor, err := s.logs.Aggregate(ctx, mongo.Pipeline{
		bson.D{{Key: "$match", Value: input.where}},
		bson.D{{Key: "$facet", Value: facets}},
	})
	if err != nil {
		return facetResult{}, err
	}
	var results []facetResult
	if err := cursor.All(ctx, &results); err != nil {
		return facetResult{}, err
	}
	if len(results) == 0 {
		return facetResult{}, nil
	}
	return results[0], nil
}

type taskLogAggregateInput struct {
	where    bson.D
	page     int
	pageSize int
	// itemsMatch 是 items 管线的额外 $match（对齐 getQualityTaskLogsOverview）。
	itemsMatch bson.D
	// itemLimit > 0 时 items 只取前 N 条（对齐 itemsMatch + itemLimit）。
	itemLimit        int
	includeItems     bool
	includeTotal     bool
	includeTopErrors bool
}

// summarizeTaskLogAggregate 把 $facet 结果映射成 TaskLogSummary。
func summarizeTaskLogAggregate(result facetResult, includeTotal bool) (int, taskLogSummary) {
	total := 0
	if includeTotal && len(result.Total) > 0 {
		total = int(result.Total[0].Count)
	}
	totals := taskLogTotals{}
	for _, bucket := range result.StatusAgg {
		count := int(bucket.Count)
		totals.Total += count
		switch stringOrUnknown(bucket.ID) {
		case "total":
			totals.Total = count
		case "pending":
			totals.Pending = count
		case "processing":
			totals.Processing = count
		case "completed":
			totals.Completed = count
		case "failed":
			totals.Failed = count
		}
	}
	byStage := make([]stageCount, 0, len(result.StageAgg))
	for _, bucket := range result.StageAgg {
		byStage = append(byStage, stageCount{
			Stage: stringOrUnknown(bucket.ID),
			Count: int(bucket.Count),
		})
	}
	topErrors := make([]taskTopError, 0, len(result.ErrorAgg))
	for _, bucket := range result.ErrorAgg {
		var sample any
		if jsTruthy(bucket.SampleMessage) {
			sample = redactSensitiveFields(stringOrUnknown(bucket.SampleMessage))
		}
		topErrors = append(topErrors, taskTopError{
			Queue:         stringOrUnknown(bucket.ID.Queue),
			Stage:         stringOrUnknown(bucket.ID.Stage),
			ErrorName:     redactSensitiveFields(stringOrUnknown(bucket.ID.ErrorName)),
			SampleMessage: sample,
			Count:         int(bucket.Count),
		})
	}
	return total, taskLogSummary{Totals: totals, ByStage: byStage, TopErrors: topErrors}
}

// ListTaskLogs 对齐 listTaskLogs：分页 items + total + summary。
func (s *Service) ListTaskLogs(ctx context.Context, orgID string, filters taskLogFilters, page, pageSize int) (paginatedTaskLogs, error) {
	normalizedPage, normalizedPageSize := normalizePagination(page, pageSize)
	result, err := s.runTaskLogAggregate(ctx, taskLogAggregateInput{
		where:            buildTaskLogWhere(orgID, filters),
		page:             normalizedPage,
		pageSize:         normalizedPageSize,
		includeItems:     true,
		includeTotal:     true,
		includeTopErrors: includeTopErrors(filters.status),
	})
	if err != nil {
		return paginatedTaskLogs{}, err
	}
	items := make([]jsonObject, 0, len(result.Items))
	for _, document := range result.Items {
		items = append(items, taskLogJSON(document))
	}
	total, summary := summarizeTaskLogAggregate(result, true)
	return paginatedTaskLogs{
		Page:     normalizedPage,
		PageSize: normalizedPageSize,
		Total:    total,
		Items:    items,
		Summary:  summary,
	}, nil
}

// SummarizeTaskLogs 对齐 summarizeTaskLogs：只有 summary。
func (s *Service) SummarizeTaskLogs(ctx context.Context, orgID string, filters taskLogFilters) (taskLogSummary, error) {
	result, err := s.runTaskLogAggregate(ctx, taskLogAggregateInput{
		where:            buildTaskLogWhere(orgID, filters),
		includeItems:     false,
		includeTotal:     false,
		includeTopErrors: includeTopErrors(filters.status),
	})
	if err != nil {
		return taskLogSummary{}, err
	}
	_, summary := summarizeTaskLogAggregate(result, false)
	return summary, nil
}

// queryExceptionEvents 对齐 ExceptionEventsService.list：timestamp desc，
// skip/limit，items 里的 message / stack 读取时脱敏（缺陷修复）。
func (s *Service) queryExceptionEvents(ctx context.Context, filter bson.D, limit, offset int) (int, []jsonObject, error) {
	if s.events == nil {
		return 0, nil, errors.New("mongo is not configured")
	}
	total, err := s.events.CountDocuments(ctx, filter)
	if err != nil {
		return 0, nil, err
	}
	cursor, err := s.events.Find(ctx, filter, options.Find().
		SetSort(bson.D{
			{Key: "timestamp", Value: -1},
			// _id DESC makes equal timestamps deterministic without changing
			// the page/offset protocol.
			{Key: "_id", Value: -1},
		}).
		SetSkip(int64(offset)).
		SetLimit(int64(limit)))
	if err != nil {
		return 0, nil, err
	}
	var documents []bson.M
	if err := cursor.All(ctx, &documents); err != nil {
		return 0, nil, err
	}
	items := make([]jsonObject, 0, len(documents))
	for _, document := range documents {
		items = append(items, exceptionEventJSON(document))
	}
	return int(total), items, nil
}

// ListExceptionEvents 对齐 logs/errors：{page, pageSize, total, items}。
func (s *Service) ListExceptionEvents(ctx context.Context, orgID string, filters exceptionFilters, page, pageSize int) (paginatedExceptionEvents, error) {
	normalizedPage, normalizedPageSize := normalizePagination(page, pageSize)
	offset := (normalizedPage - 1) * normalizedPageSize
	filter := buildExceptionFilter(orgID, filters.kind,
		filters.operationName, filters.messageContains, filters.start, filters.end)
	total, items, err := s.queryExceptionEvents(ctx, filter, clampLimit(float64(normalizedPageSize)), clampOffset(float64(offset)))
	if err != nil {
		return paginatedExceptionEvents{}, err
	}
	return paginatedExceptionEvents{
		Page:     normalizedPage,
		PageSize: normalizedPageSize,
		Total:    total,
		Items:    items,
	}, nil
}

// ListExceptionEventsLenient 对齐 admin/errors：{total, items}，日期非法即
// 忽略该条件（不报 400），kind 已在控制器层收敛。
func (s *Service) ListExceptionEventsLenient(ctx context.Context, orgID string, filters exceptionFilters, limit, offset int) (exceptionEventList, error) {
	start := parseDateIgnoringError(filters.startRaw)
	end := parseDateIgnoringError(filters.endRaw)
	filter := buildExceptionFilter(orgID, filters.kind,
		filters.operationName, filters.messageContains, start, end)
	total, items, err := s.queryExceptionEvents(ctx, filter, limit, offset)
	if err != nil {
		return exceptionEventList{}, err
	}
	return exceptionEventList{Total: total, Items: items}, nil
}

// ExceptionStats 对齐 stats（logs/errors/summary）。
func (s *Service) ExceptionStats(ctx context.Context, orgID string, filters exceptionFilters) (exceptionStats, error) {
	filter := buildExceptionFilter(orgID, filters.kind,
		filters.operationName, filters.messageContains, filters.start, filters.end)
	return s.exceptionStats(ctx, filter)
}

// ExceptionStatsLenient 对齐 admin/errors/stats 的 stats。
func (s *Service) ExceptionStatsLenient(ctx context.Context, orgID string, filters exceptionFilters) (exceptionStats, error) {
	start := parseDateIgnoringError(filters.startRaw)
	end := parseDateIgnoringError(filters.endRaw)
	filter := buildExceptionFilter(orgID, filters.kind,
		filters.operationName, filters.messageContains, start, end)
	return s.exceptionStats(ctx, filter)
}

// exceptionStatsGroup is the single-aggregate result: one compressed row per
// (UTC day, kind) bucket is folded into total plus two pushed arrays.
type exceptionStatsGroup struct {
	Total  int64                      `bson:"total"`
	ByKind []exceptionStatsKindBucket `bson:"byKind"`
	ByDay  []exceptionStatsDayBucket  `bson:"byDay"`
}

type exceptionStatsKindBucket struct {
	Kind  *string `bson:"kind"`
	Count int64   `bson:"count"`
}

type exceptionStatsDayBucket struct {
	Date  *string `bson:"date"`
	Count int64   `bson:"count"`
}

// exceptionStats aligns ExceptionEventsService.stats with the optimized
// single-aggregate pipeline: one $match, one $group by (UTC day, kind), then a
// second $group that sums total and pushes the compressed buckets. total and
// byKind cover every matching document; only byDay is capped at 30 days after
// the merge, and no "last 30 days" filter is added when start/end are absent.
func (s *Service) exceptionStats(ctx context.Context, filter bson.D) (exceptionStats, error) {
	if s.events == nil {
		return exceptionStats{}, errors.New("mongo is not configured")
	}
	cursor, err := s.events.Aggregate(ctx, mongo.Pipeline{
		bson.D{{Key: "$match", Value: filter}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "day", Value: bson.D{{Key: "$dateToString", Value: bson.D{
					{Key: "date", Value: "$timestamp"},
					{Key: "format", Value: "%Y-%m-%d"},
					{Key: "timezone", Value: "UTC"},
				}}}},
				{Key: "kind", Value: "$kind"},
			}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "total", Value: bson.D{{Key: "$sum", Value: "$count"}}},
			{Key: "byKind", Value: bson.D{{Key: "$push", Value: bson.D{
				{Key: "kind", Value: "$_id.kind"},
				{Key: "count", Value: "$count"},
			}}}},
			{Key: "byDay", Value: bson.D{{Key: "$push", Value: bson.D{
				{Key: "date", Value: "$_id.day"},
				{Key: "count", Value: "$count"},
			}}}},
		}}},
	})
	if err != nil {
		return exceptionStats{}, err
	}
	var groups []exceptionStatsGroup
	if err := cursor.All(ctx, &groups); err != nil {
		return exceptionStats{}, err
	}
	if len(groups) == 0 {
		return exceptionStats{Total: 0, ByKind: []kindCount{}, ByDay: []dayCount{}}, nil
	}
	group := groups[0]

	kindTotals := map[string]int{}
	kindOrder := []string{}
	for _, bucket := range group.ByKind {
		kind := "unknown"
		if bucket.Kind != nil {
			kind = *bucket.Kind
		}
		if _, seen := kindTotals[kind]; !seen {
			kindOrder = append(kindOrder, kind)
		}
		kindTotals[kind] += int(bucket.Count)
	}
	// count DESC, kind ASC.
	sort.SliceStable(kindOrder, func(i, j int) bool {
		left, right := kindOrder[i], kindOrder[j]
		if kindTotals[left] != kindTotals[right] {
			return kindTotals[left] > kindTotals[right]
		}
		return left < right
	})
	byKind := make([]kindCount, 0, len(kindOrder))
	for _, kind := range kindOrder {
		byKind = append(byKind, kindCount{Kind: kind, Count: kindTotals[kind]})
	}

	dayTotals := map[string]int{}
	dayOrder := []*string{}
	for _, bucket := range group.ByDay {
		if bucket.Date == nil {
			continue
		}
		if _, seen := dayTotals[*bucket.Date]; !seen {
			dayOrder = append(dayOrder, bucket.Date)
		}
		dayTotals[*bucket.Date] += int(bucket.Count)
	}
	// date DESC, at most 30 dates that actually have data.
	sort.SliceStable(dayOrder, func(i, j int) bool {
		return *dayOrder[i] > *dayOrder[j]
	})
	limit := len(dayOrder)
	if limit > 30 {
		limit = 30
	}
	byDay := make([]dayCount, 0, limit)
	for _, date := range dayOrder[:limit] {
		byDay = append(byDay, dayCount{Date: *date, Count: dayTotals[*date]})
	}

	return exceptionStats{Total: int(group.Total), ByKind: byKind, ByDay: byDay}, nil
}

// parseDateIgnoringError 对齐 exception-events.service.ts 的 parseDate：
// 非法输入返回 undefined（忽略该条件，不报错）。
func parseDateIgnoringError(raw string) *time.Time {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if parsed, ok := parseLooseTime(trimmed); ok {
		return &parsed
	}
	return nil
}

// ---- items 映射 ----

// taskLogJSON 对齐 mapTaskLog：message / data / error 读取时脱敏，
// createdAt / updatedAt 走 serializeDate。
func taskLogJSON(document bson.M) jsonObject {
	messageField := rawField{name: "message", absent: true}
	if rawMessage, present := document["message"]; present {
		switch typed := rawMessage.(type) {
		case nil:
			messageField = rawField{name: "message", value: nil}
		case string:
			messageField = rawField{name: "message", value: redactSensitiveFields(typed)}
		default:
			messageField = rawField{name: "message", value: typed}
		}
	}
	return jsonObject{
		field("id", taskLogID(document)),
		field("queue", stringOrEmpty(document["queue"])),
		field("jobId", stringOrEmpty(document["jobId"])),
		field("orgId", stringOrEmpty(document["orgId"])),
		field("stage", stringOrEmpty(document["stage"])),
		field("status", stringOrDefault(document["status"], "pending")),
		messageField,
		redactedField(document, "data"),
		redactedField(document, "error"),
		field("createdAt", serializeDate(document["createdAt"])),
		field("updatedAt", serializeDate(document["updatedAt"])),
	}
}

// redactedField 对齐 `data: redactDeep(log.data)`：字段缺失时整键省略，
// null 保留为 null。
func redactedField(document bson.M, key string) rawField {
	value, present := document[key]
	if !present {
		return rawField{name: key, absent: true}
	}
	return rawField{name: key, value: redactDeep(value, 0)}
}

// exceptionEventJSON 对齐 ExceptionEventsService.list 的 items 映射，
// 并且按本批的缺陷修复：message 先过 redactSensitiveFields，stack 非空时
// 也过 redactSensitiveFields（只改读取输出，不动库里已存的文档）。
func exceptionEventJSON(document bson.M) jsonObject {
	// id: item.id ?? item._id?.toString()（两者都缺失时整键省略）。
	idField := rawField{name: "id", absent: true}
	if document["id"] != nil {
		idField = rawField{name: "id", value: stringOrEmpty(document["id"])}
	} else if document["_id"] != nil {
		idField = rawField{name: "id", value: taskLogID(document)}
	}

	timestamp := time.Now().UTC()
	switch typed := document["timestamp"].(type) {
	case nil:
	case time.Time:
		timestamp = typed.UTC()
	case bson.DateTime:
		timestamp = typed.Time().UTC()
	case string:
		if parsed, ok := parseLooseTime(typed); ok {
			timestamp = parsed
		}
	}

	// 缺陷修复：message 先过 redactSensitiveFields（非字符串原样返回）。
	message := any("Unknown error")
	if rawMessage, present := document["message"]; present && rawMessage != nil {
		message = rawMessage
	}
	if text, ok := message.(string); ok {
		message = redactSensitiveFields(text)
	}

	// stack: item.stack ? redactSensitiveFields(item.stack) : undefined
	// ——空串与 null 都整键省略。
	stackField := rawField{name: "stack", absent: true}
	if rawStack, present := document["stack"]; present && jsTruthy(rawStack) {
		stack := any(rawStack)
		if text, ok := rawStack.(string); ok {
			stack = redactSensitiveFields(text)
		}
		stackField = rawField{name: "stack", value: stack}
	}

	statusCodeField := rawField{name: "statusCode", absent: true}
	if rawStatus, present := document["statusCode"]; present && rawStatus != nil {
		statusCodeField = rawField{name: "statusCode", value: rawStatus}
	}

	return jsonObject{
		idField,
		field("kind", stringOrDefault(document["kind"], "unknown")),
		field("traceId", stringOrEmpty(document["traceId"])),
		field("timestamp", formatJSTime(timestamp)),
		statusCodeField,
		field("message", message),
		optionalStringField(document, "path"),
		optionalStringField(document, "method"),
		optionalStringField(document, "operation"),
		optionalStringField(document, "operationName"),
		optionalStringField(document, "errorName"),
		stackField,
	}
}

// optionalStringField 对齐 `item.x ?? undefined`：null / 缺失都整键省略。
func optionalStringField(document bson.M, key string) rawField {
	value, present := document[key]
	if !present || value == nil {
		return rawField{name: key, absent: true}
	}
	return rawField{name: key, value: stringOrEmpty(value)}
}

// jsTruthy 对齐 JS 的真值判断（用于 sampleMessage 是否脱敏）。
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case int:
		return typed != 0
	case int32:
		return typed != 0
	case int64:
		return typed != 0
	case float32:
		return typed != 0 && !math.IsNaN(float64(typed))
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func stringOrUnknown(value any) string {
	if value == nil {
		return "unknown"
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}
