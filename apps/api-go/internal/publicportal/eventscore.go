package publicportal

import (
	"bytes"
	"strings"
	"time"
)

// EventHeat 复用公开故事已经对齐 Nest getEventHeatMap 的公式。
func EventHeat(now, lastAt time.Time, itemsLast1h, itemsLast4h, uniqueSources int) (breaking bool, heatScore float64) {
	profile := heatFrom(now, lastAt, itemsLast1h, itemsLast4h, uniqueSources)
	return profile.Breaking, profile.HeatScore
}

// EventAuthority 复用公开故事已经对齐 Nest getEventAuthorityMap 的打分。
func EventAuthority(unique, authoritativeSources, blogSources, authoritativeItems, totalItems int) (sourceType string, credibility float64, uniqueCount, authoritativeCount, blogCount int, corroborated bool) {
	profile := authorityFromAggregates(unique, authoritativeSources, blogSources, authoritativeItems, 0, totalItems)
	return profile.SourceType, profile.CredibilityScore, profile.UniqueSourceCount, profile.AuthoritativeSourceCount, profile.BlogSourceCount, profile.Corroborated
}

// ClassifyEventSource 用组织来源策略（缺省或无法解析时用默认名单）给出分类和来源键。
// 分类只看四张名单，categoryAuthority 不参与，与 Nest classifySourceByLabelAndUrl 相同。
func ClassifyEventSource(label, rawURL string, policyJSON []byte) (class, key string) {
	policy := defaultMatcher()
	trimmed := bytes.TrimSpace(policyJSON)
	if len(trimmed) > 0 && string(trimmed) != "null" {
		policy = parseSourcePolicy(trimmed)
	}
	return classifySource(label, rawURL, policy), strings.ToLower(resolveSourceKey(label, rawURL))
}
