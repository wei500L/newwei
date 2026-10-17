package newsindicator

import (
	"math"
	"net/url"
	"strconv"
	"strings"
)

// parseFiniteQuery 复刻 controller 的 `trim ? Number(value) : undefined`，
// 并把非有限数当作缺省（返回 nil）。
func parseFiniteQuery(raw string) *float64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	return &parsed
}

// normalizeEnum 复刻 normalizeEnumValue：trim + 小写后必须在白名单内，
// 否则当作未设置（返回空串）。非法字符串不报 400。
func normalizeEnum(value string, allowed []string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	for _, candidate := range allowed {
		if normalized == candidate {
			return normalized
		}
	}
	return ""
}

var scopeTypes = []string{"entity", "topic"}
var featureMetrics = []string{"volume", "avg_score", "negative_ratio"}

// parseListOptions 解析 GET /associations 的查询参数。
func parseListOptions(query url.Values) listOptions {
	return listOptions{
		limit:         parseFiniteQuery(query.Get("limit")),
		indicatorSlug: query.Get("indicatorSlug"),
		scopeType:     normalizeEnum(query.Get("scopeType"), scopeTypes),
		scopeKey:      query.Get("scopeKey"),
		featureMetric: normalizeEnum(query.Get("featureMetric"), featureMetrics),
	}
}

// parseGetOptions 解析 GET /associations/:id 的查询参数。
func parseGetOptions(query url.Values) getOptions {
	return getOptions{backtestsLimit: parseFiniteQuery(query.Get("backtestsLimit"))}
}
