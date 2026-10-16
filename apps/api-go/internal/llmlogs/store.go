package llmlogs

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// 与 service 的常量一致。
const (
	exportMaxRows           = 50_000
	exportMaxDateWindowDays = 90
	exportMaxDateWindowMs   = int64(exportMaxDateWindowDays) * 24 * 60 * 60 * 1000
	summaryTopErrorsLimit   = 5
)

// Service 承载 Mongo 只读查询、MySQL 审计写入与机器令牌解析。handler 只做
// 路由、鉴权与响应写出。
type Service struct {
	db    *sql.DB
	mongo *mongo.Database
}

func NewService(db *sql.DB, mongoDatabase *mongo.Database) *Service {
	return &Service{db: db, mongo: mongoDatabase}
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID 写入 Prisma cuid 列（MySQL 没有客户端默认值，必须显式插入；
// 形状与既有 Go 批次一致：c + 24 位十六进制）。
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func (s *Service) collection() (*mongo.Collection, error) {
	if s == nil || s.mongo == nil {
		return nil, errMongoUnavailable
	}
	return s.mongo.Collection(llmRequestLogsCollection), nil
}

// ---- 列表 ----

// QueryLogs 对齐 queryLogs：metadataPolicy 来自 MySQL SystemSetting，
// 列表按 createdAt 降序分页，pageSize 收口到 1..100。
func (s *Service) QueryLogs(ctx context.Context, filter logFilter, page, pageSize int) (listResponse, error) {
	collection, err := s.collection()
	if err != nil {
		return listResponse{}, err
	}
	page = maxInt(defaultPage, page)
	pageSize = minInt(maxPageSize, maxInt(1, pageSize))
	skip := (page - 1) * pageSize

	where := buildWhere(filter)
	total, err := collection.CountDocuments(ctx, where)
	if err != nil {
		return listResponse{}, err
	}
	cursor, err := collection.Find(ctx, where, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetSkip(int64(skip)).
		SetLimit(int64(pageSize)))
	if err != nil {
		return listResponse{}, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	items := make([]listItem, 0, pageSize)
	for cursor.Next(ctx) {
		var row logRow
		if err := cursor.Decode(&row); err != nil {
			return listResponse{}, err
		}
		items = append(items, toListItem(row))
	}
	if err := cursor.Err(); err != nil {
		return listResponse{}, err
	}

	return listResponse{
		Page:           page,
		PageSize:       pageSize,
		Total:          total,
		Items:          items,
		MetadataPolicy: s.MetadataPolicy(ctx),
	}, nil
}

// MetadataPolicy 读 MySQL SystemSetting 的 llm_request_log_settings。
// 没有行、读取失败或 value 解析失败时用默认列表且 source 为 default
// （与 resolveMetadataPolicySummary 的 default 分支一致；读取失败不阻断
// 列表，避免元数据策略把只读接口拖成 503）。
func (s *Service) MetadataPolicy(ctx context.Context) metadataPolicy {
	if s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
			llmRequestLogSettingsKey).Scan(&raw)
		if err == nil {
			if policy, ok := parseMetadataPolicy(raw); ok {
				return policy
			}
		}
	}
	return defaultMetadataPolicySummary()
}

// ---- 汇总 ----

// GetUsageSummary 对齐 getUsageSummary 的七个聚合并行查询。p95 用
// resolveP95Latency 的算法（rank = max(0, ceil(count*0.95)-1)，按
// latencyMs 升序 skip(rank) 取一条，没有样本时 p95Ms 为 null）。
func (s *Service) GetUsageSummary(ctx context.Context, filter summaryFilter) (summaryResponse, error) {
	collection, err := s.collection()
	if err != nil {
		return summaryResponse{}, err
	}
	where := buildWhere(filter.toLogFilter())
	topErrorWhere := withTopErrorFilter(where)

	var totalsAgg []usageAggRow
	var byModelAgg []usageModelAggRow
	var byDayAgg []usageDayAggRow
	var statusAgg []usageStatusAggRow
	var governanceAgg []usageGovernanceAggRow
	var topErrorAgg []usageErrorAggRow
	var p95Latency *float64

	queries := []func() error{
		func() error {
			return aggregateAll(ctx, collection, mongo.Pipeline{
				{{Key: "$match", Value: where}},
				usageGroupStage(nil),
			}, &totalsAgg)
		},
		func() error {
			return aggregateAll(ctx, collection, mongo.Pipeline{
				{{Key: "$match", Value: where}},
				usageGroupStage("$model"),
				{{Key: "$sort", Value: bson.D{
					{Key: "requestCount", Value: -1},
					{Key: "_id", Value: 1},
				}}},
			}, &byModelAgg)
		},
		func() error {
			return aggregateAll(ctx, collection, mongo.Pipeline{
				{{Key: "$match", Value: where}},
				usageGroupStage(bson.D{{Key: "$dateToString", Value: bson.D{
					{Key: "format", Value: "%Y-%m-%d"},
					{Key: "date", Value: "$createdAt"},
					{Key: "timezone", Value: "UTC"},
				}}}),
				{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
			}, &byDayAgg)
		},
		func() error {
			return aggregateAll(ctx, collection, mongo.Pipeline{
				{{Key: "$match", Value: where}},
				{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$status"},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				}}},
			}, &statusAgg)
		},
		func() error {
			return aggregateAll(ctx, collection, mongo.Pipeline{
				{{Key: "$match", Value: where}},
				{{Key: "$group", Value: governanceGroupStage()}},
			}, &governanceAgg)
		},
		func() error {
			return aggregateAll(ctx, collection, mongo.Pipeline{
				{{Key: "$match", Value: topErrorWhere}},
				{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$error"},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				}}},
				{{Key: "$sort", Value: bson.D{
					{Key: "count", Value: -1},
					{Key: "_id", Value: 1},
				}}},
				{{Key: "$limit", Value: summaryTopErrorsLimit}},
			}, &topErrorAgg)
		},
		func() error {
			value, err := resolveP95Latency(ctx, collection, where)
			if err != nil {
				return err
			}
			p95Latency = value
			return nil
		},
	}

	if err := runConcurrently(ctx, queries); err != nil {
		return summaryResponse{}, err
	}

	totalsRow := usageAggRow{}
	if len(totalsAgg) > 0 {
		totalsRow = totalsAgg[0]
	}
	totals := mapUsageValues(
		totalsRow.RequestCount,
		totalsRow.PromptTokens,
		totalsRow.CompletionTokens,
		totalsRow.TotalTokens,
		totalsRow.CostUSD,
		totalsRow.TotalLatencyMs,
	)

	var successCount, errorCount int64
	for _, row := range statusAgg {
		switch stringOr(row.ID, "") {
		case "success":
			successCount = toSafeInteger(row.Count)
		case "error":
			errorCount = toSafeInteger(row.Count)
		}
	}
	requestCount := totals.RequestCount
	if requestCount < 0 {
		requestCount = 0
	}
	successRate := 0.0
	errorRate := 0.0
	if requestCount > 0 {
		successRate = float64(successCount) / float64(requestCount)
		errorRate = float64(errorCount) / float64(requestCount)
	}

	governanceRow := usageGovernanceAggRow{}
	if len(governanceAgg) > 0 {
		governanceRow = governanceAgg[0]
	}

	topErrors := make([]usageTopError, 0, len(topErrorAgg))
	for _, row := range topErrorAgg {
		message := ""
		if text, ok := row.ID.(string); ok {
			message = strings.TrimSpace(text)
		}
		count := toSafeInteger(row.Count)
		if message == "" || count <= 0 {
			continue
		}
		topErrors = append(topErrors, usageTopError{Message: message, Count: count})
	}

	byModel := make([]usageModelRow, 0, len(byModelAgg))
	for _, row := range byModelAgg {
		model := "unknown"
		if text, ok := row.ID.(string); ok && strings.TrimSpace(text) != "" {
			model = text
		}
		byModel = append(byModel, usageModelRow{
			Model: model,
			usageTotals: mapUsageValues(
				row.RequestCount, row.PromptTokens, row.CompletionTokens,
				row.TotalTokens, row.CostUSD, row.TotalLatencyMs,
			),
		})
	}

	byDay := make([]usageDayRow, 0, len(byDayAgg))
	for _, row := range byDayAgg {
		byDay = append(byDay, usageDayRow{
			Date: stringOr(row.ID, ""),
			usageTotals: mapUsageValues(
				row.RequestCount, row.PromptTokens, row.CompletionTokens,
				row.TotalTokens, row.CostUSD, row.TotalLatencyMs,
			),
		})
	}

	return summaryResponse{
		Totals: totals,
		StatusBreakdown: usageStatusBreakdown{
			Success:     successCount,
			Error:       errorCount,
			SuccessRate: successRate,
			ErrorRate:   errorRate,
		},
		GovernanceBreakdown: usageGovernanceBreakdown{
			GovernedRequestCount:          toSafeInteger(governanceRow.GovernedRequestCount),
			DirectRequestCount:            toSafeInteger(governanceRow.DirectRequestCount),
			GovernedCostUSD:               toSafeNumber(governanceRow.GovernedCostUSD),
			DirectCostUSD:                 toSafeNumber(governanceRow.DirectCostUSD),
			ManagedRuntimeKeyRequestCount: toSafeInteger(governanceRow.ManagedRuntimeKeyRequestCount),
			ProfileKeyRequestCount:        toSafeInteger(governanceRow.ProfileKeyRequestCount),
		},
		Latency: usageLatency{
			AvgMs: totals.AvgLatencyMs,
			P95Ms: p95Latency,
		},
		TopErrors: topErrors,
		ByModel:   byModel,
		ByDay:     byDay,
	}, nil
}

// usageGroupStage 对齐 getUsageSummary 的 $group（_id 由调用方给出：
// null / "$model" / $dateToString）。
func usageGroupStage(idValue any) bson.D {
	return bson.D{{Key: "$group", Value: bson.D{
		{Key: "_id", Value: idValue},
		{Key: "requestCount", Value: bson.D{{Key: "$sum", Value: 1}}},
		{Key: "promptTokens", Value: sumIfNullStage("$promptTokens")},
		{Key: "completionTokens", Value: sumIfNullStage("$completionTokens")},
		{Key: "totalTokens", Value: sumIfNullStage("$totalTokens")},
		{Key: "costUsd", Value: sumIfNullStage("$costUsd")},
		{Key: "totalLatencyMs", Value: sumIfNullStage("$latencyMs")},
	}}}
}

func sumIfNullStage(field string) bson.D {
	return bson.D{{Key: "$sum", Value: bson.D{{Key: "$ifNull", Value: bson.A{field, 0}}}}}
}

// governanceGroupStage 对齐 getUsageSummary 的 governance 聚合
// （governanceApplied 的 $cond 与 authMode 的计数）。
func governanceGroupStage() bson.D {
	governed := bson.D{{Key: "$eq", Value: bson.A{"$governanceApplied", true}}}
	return bson.D{
		{Key: "_id", Value: nil},
		{Key: "governedRequestCount", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{governed, 1, 0}}}}}},
		{Key: "directRequestCount", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{governed, 0, 1}}}}}},
		{Key: "governedCostUsd", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{
			governed,
			bson.D{{Key: "$ifNull", Value: bson.A{"$costUsd", 0}}},
			0,
		}}}}}},
		{Key: "directCostUsd", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{
			governed,
			0,
			bson.D{{Key: "$ifNull", Value: bson.A{"$costUsd", 0}}},
		}}}}}},
		{Key: "managedRuntimeKeyRequestCount", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{
			bson.D{{Key: "$eq", Value: bson.A{"$authMode", "managed_runtime_key"}}},
			1,
			0,
		}}}}}},
		{Key: "profileKeyRequestCount", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{
			bson.D{{Key: "$eq", Value: bson.A{"$authMode", "profile_key"}}},
			1,
			0,
		}}}}}},
	}
}

// resolveP95Latency 对齐 resolveP95Latency：先用 countDocuments 取样本数，
// 再按 rank 取一条。没有样本（或取不到行）→ nil。
func resolveP95Latency(ctx context.Context, collection *mongo.Collection, where bson.D) (*float64, error) {
	latencyWhere := withLatencyNumberFilter(where)
	count, err := collection.CountDocuments(ctx, latencyWhere)
	if err != nil {
		return nil, err
	}
	if count <= 0 {
		return nil, nil
	}
	rank := int64(math.Ceil(float64(count)*0.95)) - 1
	if rank < 0 {
		rank = 0
	}
	cursor, err := collection.Find(ctx, latencyWhere, options.Find().
		SetSort(bson.D{{Key: "latencyMs", Value: 1}}).
		SetSkip(rank).
		SetLimit(1).
		SetProjection(bson.D{{Key: "latencyMs", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	var rows []latencyAggRow
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	value, ok := safeNumber(rows[0].LatencyMs)
	if !ok {
		return nil, nil
	}
	return &value, nil
}

// ---- 导出 ----

// ValidateExportDateWindow 对齐 validateExportDateWindow：只有同时给了
// start 与 end 时才检查；跨度超过 90 天 → 400。
func ValidateExportDateWindow(filter logFilter) error {
	if filter.Start == nil || filter.End == nil {
		return nil
	}
	startMs := filter.Start.UnixMilli()
	endMs := filter.End.UnixMilli()
	if startMs > endMs {
		return &inputError{Message: "start must be earlier than or equal to end"}
	}
	if endMs-startMs > exportMaxDateWindowMs {
		return &inputError{Message: fmt.Sprintf("export date range cannot exceed %d days", exportMaxDateWindowDays)}
	}
	return nil
}

// ResolveExportRowCount 对齐 resolveExportRowCount：探测最多 50001 条
// _id，超过 50000 条 → 400。
func (s *Service) ResolveExportRowCount(ctx context.Context, where bson.D) (int64, error) {
	collection, err := s.collection()
	if err != nil {
		return 0, err
	}
	cursor, err := collection.Find(ctx, where, options.Find().
		SetProjection(bson.D{{Key: "_id", Value: 1}}).
		SetLimit(int64(exportMaxRows)+1))
	if err != nil {
		return 0, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	var rows []bson.M
	if err := cursor.All(ctx, &rows); err != nil {
		return 0, err
	}
	count := int64(len(rows))
	if count > exportMaxRows {
		return count, &inputError{Message: fmt.Sprintf(
			"export row count exceeds %d; narrow filters or date range", exportMaxRows)}
	}
	return count, nil
}

// OpenExportCursor 打开按 createdAt 降序、只投影 CSV 列的游标。
// NestJS 在返回流之前就建立游标，失败会落进 failure 审计并抛错。
func (s *Service) OpenExportCursor(ctx context.Context, where bson.D) (*mongo.Cursor, error) {
	collection, err := s.collection()
	if err != nil {
		return nil, err
	}
	return collection.Find(ctx, where, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetProjection(bson.D{
			{Key: "createdAt", Value: 1},
			{Key: "model", Value: 1},
			{Key: "requestType", Value: 1},
			{Key: "status", Value: 1},
			{Key: "latencyMs", Value: 1},
			{Key: "promptTokens", Value: 1},
			{Key: "completionTokens", Value: 1},
			{Key: "totalTokens", Value: 1},
			{Key: "error", Value: 1},
		}))
}

// StreamExportCSV 依次写出表头与数据行（每行 createdAt 降序）。
func StreamExportCSV(ctx context.Context, writer io.Writer, cursor *mongo.Cursor) error {
	buffered := bufio.NewWriter(writer)
	if _, err := buffered.WriteString(exportCSVHeaderLine()); err != nil {
		return err
	}
	for cursor.Next(ctx) {
		var doc exportDoc
		if err := cursor.Decode(&doc); err != nil {
			return err
		}
		if _, err := buffered.WriteString(toExportCSVLine(toExportRow(doc)) + "\n"); err != nil {
			return err
		}
	}
	if err := cursor.Err(); err != nil {
		return err
	}
	return buffered.Flush()
}

// exportAuditArgs 是导出审计的输入。
type exportAuditArgs struct {
	OrgID        string
	ActorID      *string
	Outcome      string
	RowCount     int64
	DurationMs   int64
	Filter       logFilter
	ErrorMessage *string
}

// WriteExportAuditLog 写 MySQL AuditLog（resource=llm_request_logs、
// action=export_csv）。审计失败绝不阻断响应。
func (s *Service) WriteExportAuditLog(ctx context.Context, args exportAuditArgs) {
	if s.db == nil {
		return
	}
	metadata := map[string]any{
		"outcome":      args.Outcome,
		"rowCount":     args.RowCount,
		"durationMs":   args.DurationMs,
		"model":        nullableFilterValue(args.Filter.Model),
		"feature":      nullableFilterValue(args.Filter.Feature),
		"requestType":  nullableFilterValue(args.Filter.RequestType),
		"status":       nullableFilterValue(args.Filter.Status),
		"start":        nullableTimeValue(args.Filter.Start),
		"end":          nullableTimeValue(args.Filter.End),
		"errorMessage": nullableString(args.ErrorMessage),
	}
	writeAuditLogBestEffort(ctx, s.db, args.OrgID, args.ActorID, "llm_request_logs", "export_csv", metadata)
}

func nullableFilterValue(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableTimeValue(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(isoLayout)
}

// writeAuditLogBestEffort 对齐 apps/api/src/modules/audit/audit-log.writer.ts
// 的 writeAuditLogBestEffort（与 rbacapi 的实现同形）：先写 AuditLog；失败
// 则把等价 payload 入 AuditLogOutbox 重试。两步都失败只记日志。
func writeAuditLogBestEffort(ctx context.Context, db *sql.DB, orgID string, actorID *string, resource, action string, metadata map[string]any) {
	if db == nil {
		return
	}
	metaRaw, err := json.Marshal(metadata)
	if err != nil {
		metaRaw = []byte("null")
	}
	now := nowMillis()
	if id, idErr := newRowID(); idErr == nil {
		_, err = db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, nullableString(actorID), resource, action, metaRaw, now)
		if err == nil {
			return
		}
	}

	payload := map[string]any{
		"orgId":     orgID,
		"actorId":   nullableString(actorID),
		"resource":  resource,
		"action":    action,
		"metadata":  metadata,
		"ipAddress": nil,
		"createdAt": now.Format("2006-01-02T15:04:05.000Z"),
	}
	payloadRaw, payloadErr := json.Marshal(payload)
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("llm logs audit: failed to write audit log and outbox payload (%s/%s): %v", resource, action, err)
		return
	}
	if _, outboxErr := db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payloadRaw, now, now, now); outboxErr != nil {
		log.Printf("llm logs audit: failed to write audit log and enqueue outbox (%s/%s): %v", resource, action, outboxErr)
	}
}

// ---- 机器令牌 ----

// AuthenticateMachine 与 newssources/crawlprofile/crawltemplate 相同：
// SHA-256 十六进制查 MachineAccessToken.tokenHash，连 Org.isActive；查不到、
// 已撤销、已过期、组织停用 → 401 Invalid machine token；查到更新 lastUsedAt。
// 权限只解析令牌行 permissions JSON 里的字符串数组；orgId 只用令牌行的。
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := s.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(401, "Invalid machine token")
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, newStatus(401, "Invalid machine token")
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowMillis(), id)
	return authhttp.NewIdentity("machine:"+id, orgID, permissionList(permissions)), nil
}

func permissionList(raw []byte) []string {
	var parsed []any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil
	}
	out := make([]string, 0, len(parsed))
	for _, item := range parsed {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// ---- 小工具 ----

func aggregateAll(ctx context.Context, collection *mongo.Collection, pipeline mongo.Pipeline, out any) error {
	cursor, err := collection.Aggregate(ctx, pipeline)
	if err != nil {
		return err
	}
	defer func() { _ = cursor.Close(ctx) }()
	return cursor.All(ctx, out)
}

// runConcurrently 并行执行只读查询（对应 NestJS 的 Promise.all），第一个
// 错误即返回。
func runConcurrently(ctx context.Context, queries []func() error) error {
	if len(queries) == 0 {
		return nil
	}
	results := make(chan error, len(queries))
	for _, query := range queries {
		run := query
		go func() { results <- run() }()
	}
	var firstErr error
	for range queries {
		if err := <-results; err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
