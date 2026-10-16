package llmlogs

import (
	"math"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// normalizeOrgID 对齐 service 的 normalizeOrgId：trim 后为空 → _unknown_。
func normalizeOrgID(orgID string) string {
	trimmed := strings.TrimSpace(orgID)
	if trimmed == "" {
		return unknownOrgID
	}
	return trimmed
}

// normalizeFeatureTokenValue 对齐 normalizeFeatureToken：非法（空、超过
// 64、字符集不符）返回空串（TS 侧是 undefined）。
func normalizeFeatureTokenValue(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	if jsLength(normalized) > 64 || !featureTokenPattern.MatchString(normalized) {
		return ""
	}
	return normalized
}

// normalizeProfileIDValue 对齐 normalizeProfileId：空、超过 128 → nil。
func normalizeProfileIDValue(value string) *string {
	normalized := strings.TrimSpace(value)
	if normalized == "" || jsLength(normalized) > 128 {
		return nil
	}
	return &normalized
}

// toLogFilter 把 summary 的参数集映射成同一套过滤结构（summary 不接收
// model/requestType/status）。
func (filter summaryFilter) toLogFilter() logFilter {
	return logFilter{
		OrgID:     filter.OrgID,
		Feature:   filter.Feature,
		ProfileID: filter.ProfileID,
		RunID:     filter.RunID,
		NodeID:    filter.NodeID,
		Start:     filter.Start,
		End:       filter.End,
	}
}

// normalizeFilterForExport 对齐修好缺陷后的 normalizeFilterForExport：
// 除 orgId/model/feature/profileId/requestType/status/start/end 外，
// runId 与 nodeId 也保留（否则导出会丢掉这两个条件）。
func normalizeFilterForExport(filter logFilter) logFilter {
	out := logFilter{
		OrgID:       normalizeOrgID(filter.OrgID),
		Model:       strings.TrimSpace(filter.Model),
		Feature:     normalizeFeatureTokenValue(filter.Feature),
		RequestType: filter.RequestType,
		Status:      filter.Status,
		Start:       filter.Start,
		End:         filter.End,
	}
	if profileID := normalizeProfileIDValue(filter.ProfileID); profileID != nil {
		out.ProfileID = *profileID
	}
	if runID := normalizeProfileIDValue(filter.RunID); runID != nil {
		out.RunID = *runID
	}
	if nodeID := normalizeProfileIDValue(filter.NodeID); nodeID != nil {
		out.NodeID = *nodeID
	}
	return out
}

// buildWhere 与 service 的 buildWhere 逐条一致：
//
//	orgId 必填（trim 后为空落 _unknown_）；
//	model trim 后精确匹配；requestType、status 精确匹配；
//	feature  → $or: [{feature}, {"metadata.feature"}]
//	profileId→ $or: [{gatewayProfileId}, {"metadata.profileid"}, {"metadata.crawlsiteprofileid"}]
//	runId    → $or: [{"metadata.runid"}, {"metadata.frontierrunid"}]
//	nodeId   → $or: [{"metadata.nodeid"}, {"metadata.frontiernodeid"}]
//	start/end→ createdAt 的 $gte/$lte
//
// 所有 $or 条件收进 $and，彼此是 AND 关系。
func buildWhere(filter logFilter) bson.D {
	where := bson.D{{Key: "orgId", Value: normalizeOrgID(filter.OrgID)}}

	if model := strings.TrimSpace(filter.Model); model != "" {
		where = append(where, bson.E{Key: "model", Value: model})
	}
	if filter.RequestType != "" {
		where = append(where, bson.E{Key: "requestType", Value: filter.RequestType})
	}
	if filter.Status != "" {
		where = append(where, bson.E{Key: "status", Value: filter.Status})
	}

	and := bson.A{}
	if feature := normalizeFeatureTokenValue(filter.Feature); feature != "" {
		and = append(and, orClause(
			bson.E{Key: "feature", Value: feature},
			bson.E{Key: "metadata.feature", Value: feature},
		))
	}
	if profileID := normalizeProfileIDValue(filter.ProfileID); profileID != nil {
		and = append(and, orClause(
			bson.E{Key: "gatewayProfileId", Value: *profileID},
			bson.E{Key: "metadata.profileid", Value: *profileID},
			bson.E{Key: "metadata.crawlsiteprofileid", Value: *profileID},
		))
	}
	if runID := normalizeProfileIDValue(filter.RunID); runID != nil {
		and = append(and, orClause(
			bson.E{Key: "metadata.runid", Value: *runID},
			bson.E{Key: "metadata.frontierrunid", Value: *runID},
		))
	}
	if nodeID := normalizeProfileIDValue(filter.NodeID); nodeID != nil {
		and = append(and, orClause(
			bson.E{Key: "metadata.nodeid", Value: *nodeID},
			bson.E{Key: "metadata.frontiernodeid", Value: *nodeID},
		))
	}

	dateRange := bson.D{}
	if filter.Start != nil {
		dateRange = append(dateRange, bson.E{Key: "$gte", Value: *filter.Start})
	}
	if filter.End != nil {
		dateRange = append(dateRange, bson.E{Key: "$lte", Value: *filter.End})
	}
	if len(dateRange) > 0 {
		where = append(where, bson.E{Key: "createdAt", Value: dateRange})
	}

	if len(and) > 0 {
		where = append(where, bson.E{Key: "$and", Value: and})
	}
	return where
}

func orClause(entries ...bson.E) bson.D {
	or := bson.A{}
	for _, entry := range entries {
		or = append(or, bson.D{entry})
	}
	return bson.D{{Key: "$or", Value: or}}
}

// withTopErrorFilter 对齐 getUsageSummary 的 topErrorWhere：在同一个
// usageWhere 上追加 status: "error" 与 error 为非空字符串。
func withTopErrorFilter(where bson.D) bson.D {
	out := make(bson.D, 0, len(where)+2)
	out = append(out, where...)
	out = append(out,
		bson.E{Key: "status", Value: "error"},
		bson.E{Key: "error", Value: bson.D{
			{Key: "$type", Value: "string"},
			{Key: "$ne", Value: ""},
		}},
	)
	return out
}

// withLatencyNumberFilter 对齐 resolveP95Latency 的 latencyWhere。
func withLatencyNumberFilter(where bson.D) bson.D {
	out := make(bson.D, 0, len(where)+1)
	out = append(out, where...)
	out = append(out, bson.E{Key: "latencyMs", Value: bson.D{{Key: "$type", Value: "number"}}})
	return out
}

// safeNumber 对齐 JS Number(value) + Number.isFinite 的组合语义：
// null → 0（Number(null) === 0）、空串 → 0、不可转换 → 不成立。
func safeNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		return safeNumber(float64(typed))
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int:
		return float64(typed), true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, true
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// toSafeNumber 对齐 service 的 toSafeNumber。
func toSafeNumber(value any) float64 {
	numeric, ok := safeNumber(value)
	if !ok {
		return 0
	}
	return numeric
}

// toSafeInteger 对齐 service 的 toSafeInteger（Math.trunc）。
func toSafeInteger(value any) int64 {
	numeric, ok := safeNumber(value)
	if !ok {
		return 0
	}
	return int64(math.Trunc(numeric))
}

// stringOr 对齐 `typeof value === "string" ? value : fallback`。
func stringOr(value any, fallback string) string {
	if text, ok := value.(string); ok {
		return text
	}
	return fallback
}

// mapUsageValues 对齐 mapUsageAggRow。
func mapUsageValues(requestCount, promptTokens, completionTokens, totalTokens, costUSD, totalLatencyMs any) usageTotals {
	count := toSafeInteger(requestCount)
	totalLatency := toSafeNumber(totalLatencyMs)
	return usageTotals{
		RequestCount:     count,
		PromptTokens:     toSafeInteger(promptTokens),
		CompletionTokens: toSafeInteger(completionTokens),
		TotalTokens:      toSafeInteger(totalTokens),
		CostUSD:          toSafeNumber(costUSD),
		AvgLatencyMs:     averageLatency(totalLatency, count),
	}
}

func averageLatency(totalLatencyMs float64, requestCount int64) float64 {
	if requestCount > 0 {
		return totalLatencyMs / float64(requestCount)
	}
	return 0
}
