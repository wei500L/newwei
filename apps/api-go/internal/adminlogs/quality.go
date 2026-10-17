package adminlogs

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// 本文件是管理端质量面板（internal/qualityoverview）复用任务日志聚合与
// 脱敏的最小导出面：只把既有实现包成可跨包调用的形状，不新增查询语义，
// 避免质量面板再维护一套不一致的脱敏正则与聚合。

// TaskLogListFilters 是质量面板任务日志列表/汇总的过滤条件（都已 trim；
// 空串表示不过滤）。字段语义与控制器一致。
type TaskLogListFilters struct {
	Queue  string
	JobID  string
	Stage  string
	Status string
	Start  *time.Time
}

// TaskLogItemJSON / TaskLogSummaryJSON 是 adminlogs 内部 items / summary
// 形状的导出别名，供 qualityoverview 直接嵌入响应（键序与 undefined
// 省略语义仍由 adminlogs 的 jsonObject / 结构体保证）。
type TaskLogItemJSON = jsonObject

// TaskLogSummaryJSON 是任务日志汇总的导出别名。
type TaskLogSummaryJSON = taskLogSummary

// QualityTaskLogOverview 对齐 QualityTaskLogOverview（admin-logs.service.ts）：
// { sinceMinutes, items, summary }。
type QualityTaskLogOverview struct {
	SinceMinutes int                `json:"sinceMinutes"`
	Items        []TaskLogItemJSON  `json:"items"`
	Summary      TaskLogSummaryJSON `json:"summary"`
}

// RedactSensitiveFields 导出与 Nest 共享的敏感信息脱敏（唯一实现）。
func RedactSensitiveFields(value string) string {
	return redactSensitiveFields(value)
}

// HTTPStatus 把 adminlogs 的服务端错误映射成 Nest 对齐的 HTTP 状态码与
// 文案（当前只有机器令牌 401 "Invalid machine token"）。ok=false 表示不是
// adminlogs 的定型错误，由调用方按通用错误处理。
func HTTPStatus(err error) (int, string, bool) {
	var status *statusError
	if errors.As(err, &status) {
		return status.status, status.message, true
	}
	return 0, "", false
}

// ListTaskLogItems 对齐 quality 任务日志列表：与 listTaskLogs 同一聚合与
// 过滤，只返回 items（不返回 page/pageSize/total/summary）。limit 已在
// 调用方收口到 1..200。
func (s *Service) ListTaskLogItems(ctx context.Context, orgID string, filters TaskLogListFilters, limit int) ([]TaskLogItemJSON, error) {
	result, err := s.runTaskLogAggregate(ctx, taskLogAggregateInput{
		where: buildTaskLogWhere(orgID, taskLogFilters{
			queue:  filters.Queue,
			jobId:  filters.JobID,
			stage:  filters.Stage,
			status: filters.Status,
			start:  filters.Start,
		}),
		page:             1,
		pageSize:         limit,
		includeItems:     true,
		includeTotal:     false,
		includeTopErrors: false,
	})
	if err != nil {
		return nil, err
	}
	items := make([]TaskLogItemJSON, 0, len(result.Items))
	for _, document := range result.Items {
		items = append(items, taskLogJSON(document))
	}
	return items, nil
}

// SummarizeTaskLogsForQuality 对齐 quality 任务日志汇总：与
// summarizeTaskLogs 同一聚合（topErrors 只在没有 status 或 status=failed
// 时聚合）与脱敏。
func (s *Service) SummarizeTaskLogsForQuality(ctx context.Context, orgID string, filters TaskLogListFilters) (TaskLogSummaryJSON, error) {
	result, err := s.runTaskLogAggregate(ctx, taskLogAggregateInput{
		where: buildTaskLogWhere(orgID, taskLogFilters{
			queue:  filters.Queue,
			jobId:  filters.JobID,
			stage:  filters.Stage,
			status: filters.Status,
			start:  filters.Start,
		}),
		includeItems:     false,
		includeTotal:     false,
		includeTopErrors: includeTopErrors(filters.Status),
	})
	if err != nil {
		return taskLogSummary{}, err
	}
	_, summary := summarizeTaskLogAggregate(result, false)
	return summary, nil
}

// QualityTaskLogOverview 是 getQualityTaskLogsOverview 的无缓存查询体：
// 该窗口内全部状态参与 summary/topErrors，items 只取 status=failed 的前
// limit 条，按 createdAt 降序。Redis 缓存与锁在 qualityoverview 侧完成
// （键与 Nest 一致）。
func (s *Service) QualityTaskLogOverview(ctx context.Context, orgID string, sinceMinutes, limit int) (QualityTaskLogOverview, error) {
	since := time.Now().Add(-time.Duration(sinceMinutes) * time.Minute)
	result, err := s.runTaskLogAggregate(ctx, taskLogAggregateInput{
		where: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}},
		},
		itemsMatch:       bson.D{{Key: "status", Value: "failed"}},
		itemLimit:        limit,
		includeItems:     true,
		includeTotal:     false,
		includeTopErrors: true,
	})
	if err != nil {
		return QualityTaskLogOverview{}, err
	}
	items := make([]TaskLogItemJSON, 0, len(result.Items))
	for _, document := range result.Items {
		items = append(items, taskLogJSON(document))
	}
	_, summary := summarizeTaskLogAggregate(result, false)
	return QualityTaskLogOverview{
		SinceMinutes: sinceMinutes,
		Items:        items,
		Summary:      summary,
	}, nil
}
