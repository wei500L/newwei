package classificationrssops

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strings"
)

// Settings normalization bounds translated from
// news-classification-quality-settings.service.ts.
const (
	minQualityRate           = 0
	maxQualityRate           = 1
	minCacheTTLSeconds       = 0
	maxCacheTTLSeconds       = 3600
	minLatencyWarnMs         = 100
	maxLatencyWarnMs         = 120000
	minReportPairCount       = 1
	maxReportPairCount       = 1000
	defaultGateMinConfidence = 0.4
)

// classificationQualitySettingsPayload is the full settings object written to
// the Redis cache, identical to JSON.stringify(settings) in NestJS.
type classificationQualitySettingsPayload struct {
	LowConfidenceThreshold    float64 `json:"lowConfidenceThreshold"`
	LLMP95LatencyWarnMs       int     `json:"llmP95LatencyWarnMs"`
	EmbeddingP95LatencyWarnMs int     `json:"embeddingP95LatencyWarnMs"`
	RerankP95LatencyWarnMs    int     `json:"rerankP95LatencyWarnMs"`
	GateRejectRateWarn        float64 `json:"gateRejectRateWarn"`
	GatePenalizedRateWarn     float64 `json:"gatePenalizedRateWarn"`
	ReportMinPairCount        int     `json:"reportMinPairCount"`
	ReportMinPairErrorRate    float64 `json:"reportMinPairErrorRate"`
	CacheTTLSeconds           int     `json:"cacheTTLSeconds"`
}

// settingsPayloadFrom converts the internal settings into the cached shape.
func settingsPayloadFrom(settings qualitySettings) classificationQualitySettingsPayload {
	return classificationQualitySettingsPayload{
		LowConfidenceThreshold:    settings.LowConfidenceThreshold,
		LLMP95LatencyWarnMs:       settings.LLMP95LatencyWarnMs,
		EmbeddingP95LatencyWarnMs: settings.EmbeddingP95LatencyWarnMs,
		RerankP95LatencyWarnMs:    settings.RerankP95LatencyWarnMs,
		GateRejectRateWarn:        settings.GateRejectRateWarn,
		GatePenalizedRateWarn:     settings.GatePenalizedRateWarn,
		ReportMinPairCount:        settings.ReportMinPairCount,
		ReportMinPairErrorRate:    settings.ReportMinPairErrorRate,
		CacheTTLSeconds:           settings.CacheTTLSeconds,
	}
}

// clampFloat mirrors the private clampFloat helper.
func clampFloat(value *float64, min, max, fallback float64) float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return fallback
	}
	return math.Max(min, math.Min(max, round4(*value)))
}

// clampInt mirrors the private clampInt helper.
func clampInt(value *float64, min, max, fallback int) int {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return fallback
	}
	normalized := int(math.Round(*value))
	if normalized < min {
		return min
	}
	if normalized > max {
		return max
	}
	return normalized
}

// normalizeQualitySettings mirrors the private normalizeSettings helper.
func normalizeQualitySettings(record classificationQualitySettingsRecord, fallback qualitySettings) qualitySettings {
	return qualitySettings{
		LowConfidenceThreshold:    clampFloat(record.LowConfidenceThreshold, minQualityRate, maxQualityRate, fallback.LowConfidenceThreshold),
		LLMP95LatencyWarnMs:       clampInt(record.LLMP95LatencyWarnMs, minLatencyWarnMs, maxLatencyWarnMs, fallback.LLMP95LatencyWarnMs),
		EmbeddingP95LatencyWarnMs: clampInt(record.EmbeddingP95LatencyWarnMs, minLatencyWarnMs, maxLatencyWarnMs, fallback.EmbeddingP95LatencyWarnMs),
		RerankP95LatencyWarnMs:    clampInt(record.RerankP95LatencyWarnMs, minLatencyWarnMs, maxLatencyWarnMs, fallback.RerankP95LatencyWarnMs),
		GateRejectRateWarn:        clampFloat(record.GateRejectRateWarn, minQualityRate, maxQualityRate, fallback.GateRejectRateWarn),
		GatePenalizedRateWarn:     clampFloat(record.GatePenalizedRateWarn, minQualityRate, maxQualityRate, fallback.GatePenalizedRateWarn),
		ReportMinPairCount:        clampInt(record.ReportMinPairCount, minReportPairCount, maxReportPairCount, fallback.ReportMinPairCount),
		ReportMinPairErrorRate:    clampFloat(record.ReportMinPairErrorRate, minQualityRate, maxQualityRate, fallback.ReportMinPairErrorRate),
		CacheTTLSeconds:           clampInt(record.CacheTTLSeconds, minCacheTTLSeconds, maxCacheTTLSeconds, fallback.CacheTTLSeconds),
	}
}

// qualitySettingsFor mirrors NewsClassificationQualitySettingsService.getSettings:
// the Redis cache is consulted first, then MySQL SystemSetting, and every
// failure degrades to the shipped defaults without failing the request.
func (s *Service) qualitySettingsFor(ctx context.Context, orgID string) qualitySettings {
	fallback := defaultQualitySettings()
	cacheKey := settingsCachePrefix + orgID
	if s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil && len(raw) > 0 {
			var record classificationQualitySettingsRecord
			if json.Unmarshal(raw, &record) == nil {
				return normalizeQualitySettings(record, fallback)
			}
		}
	}

	settings := fallback
	if s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT value FROM SystemSetting WHERE `key` = ?", settingsSystemKeyPrefix+orgID).Scan(&raw)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			log.Printf("classification rss ops: failed to load quality settings for org %s: %v", orgID, err)
		default:
			var record classificationQualitySettingsRecord
			if json.Unmarshal(raw, &record) == nil {
				settings = normalizeQualitySettings(record, fallback)
			}
		}
	}

	if s.redis != nil {
		if payload, err := json.Marshal(settingsPayloadFrom(settings)); err == nil {
			s.store.writeCache(ctx, cacheKey, payload, settingsCacheTTLSeconds)
		}
	}
	return settings
}

// sourcePolicyFor mirrors the private getSourcePolicy helper.
func (s *Service) sourcePolicyFor(ctx context.Context, orgID string) newsEventSourcePolicy {
	defaults := getDefaultNewsEventSourcePolicy()
	cacheKey := sourcePolicyKeyPrefix + orgID
	if s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil && len(raw) > 0 {
			return parseSourcePolicyRecord(raw, defaults)
		}
	}

	policy := defaults
	if s.db != nil {
		var raw []byte
		err := s.db.QueryRowContext(ctx,
			"SELECT value FROM SystemSetting WHERE `key` = ?", sourcePolicyKeyPrefix+orgID).Scan(&raw)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			log.Printf("classification rss ops: failed to load source policy for org %s: %v", orgID, err)
		default:
			policy = parseSourcePolicyRecord(raw, defaults)
		}
	}

	if s.redis != nil {
		if payload, err := json.Marshal(newsEventSourcePolicyPayload(policy)); err == nil {
			s.store.writeCache(ctx, cacheKey, payload, sourcePolicyCacheSeconds)
		}
	}
	return policy
}

// newsEventSourcePolicyPayload is the cached policy shape (the four lists).
type newsEventSourcePolicyPayload struct {
	AuthoritativeDomains []string `json:"authoritativeDomains"`
	AuthoritativeLabels  []string `json:"authoritativeLabels"`
	BlogDomains          []string `json:"blogDomains"`
	BlogLabels           []string `json:"blogLabels"`
}

// newsEventSourcePolicyPayload converts the internal policy for caching.
func newsEventSourcePolicyPayload(policy newsEventSourcePolicy) newsEventSourcePolicyPayload {
	return newsEventSourcePolicyPayload{
		AuthoritativeDomains: policy.AuthoritativeDomains,
		AuthoritativeLabels:  policy.AuthoritativeLabels,
		BlogDomains:          policy.BlogDomains,
		BlogLabels:           policy.BlogLabels,
	}
}

// gateMinConfidence mirrors the private getGateMinConfidence helper: the
// news_event_settings SystemSetting row holds minCategoryConfidenceForGate and a
// missing or malformed value falls back to 0.4.
func (s *Service) gateMinConfidence(ctx context.Context, orgID string) float64 {
	if s.db == nil {
		return defaultGateMinConfidence
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ?", gateSettingsKeyPrefix+orgID).Scan(&raw)
	if err != nil || len(raw) == 0 {
		return defaultGateMinConfidence
	}
	var record struct {
		MinCategoryConfidenceForGate *float64 `json:"minCategoryConfidenceForGate"`
	}
	if json.Unmarshal(raw, &record) != nil || record.MinCategoryConfidenceForGate == nil {
		return defaultGateMinConfidence
	}
	return math.Max(0, math.Min(1, *record.MinCategoryConfidenceForGate))
}

// loadSourceMap mirrors the private loadSourceMapByIds helper. The id list is
// passed as a JSON array and matched with JSON_CONTAINS so the statement keeps a
// fixed arity (no dynamic placeholder building, no untyped argument slice).
func (s *Service) loadSourceMap(ctx context.Context, orgID string, sourceIDs []string) (map[string]sourceInfo, error) {
	out := make(map[string]sourceInfo)
	if s.db == nil {
		return out, nil
	}
	normalized := normalizeIDList(sourceIDs, 2000)
	if len(normalized) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return out, err
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT id, name, url FROM NewsSource WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id))",
		orgID, string(payload))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var info sourceInfo
		if err := rows.Scan(&info.ID, &info.Name, &info.URL); err != nil {
			return out, err
		}
		out[info.ID] = info
	}
	return out, rows.Err()
}

// loadArticleContexts mirrors the private loadArticleContextMap helper: the
// ProcessedArticle.cleanedMarkdownRef column holds the Mongo ObjectId of the
// processed item, and the join to Article supplies the URL and sourceId.
func (s *Service) loadArticleContexts(ctx context.Context, orgID string, processedItemIDs []string) (map[string]articleContext, error) {
	out := make(map[string]articleContext)
	if s.db == nil {
		return out, nil
	}
	normalized := normalizeIDList(processedItemIDs, 3000)
	if len(normalized) == 0 {
		return out, nil
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return out, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT pa.cleanedMarkdownRef, a.url, a.sourceId
FROM ProcessedArticle pa
JOIN Article a ON a.id = pa.articleId
WHERE a.orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(pa.cleanedMarkdownRef))`,
		orgID, string(payload))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref sql.NullString
		var articleURL, sourceID sql.NullString
		if err := rows.Scan(&ref, &articleURL, &sourceID); err != nil {
			return out, err
		}
		key := strings.TrimSpace(ref.String)
		if !ref.Valid || key == "" {
			continue
		}
		entry := articleContext{ProcessedItemID: key}
		if articleURL.Valid && strings.TrimSpace(articleURL.String) != "" {
			value := articleURL.String
			entry.ArticleURL = &value
		}
		if sourceID.Valid && strings.TrimSpace(sourceID.String) != "" {
			value := sourceID.String
			entry.SourceID = &value
		}
		out[key] = entry
	}
	return out, rows.Err()
}

// loadSourceInfo mirrors the private loadSourceInfo helper.
func (s *Service) loadSourceInfo(ctx context.Context, orgID, sourceID string) (*sourceInfo, error) {
	if s.db == nil {
		return nil, nil
	}
	var info sourceInfo
	err := s.db.QueryRowContext(ctx,
		"SELECT id, name, url FROM NewsSource WHERE id = ? AND orgId = ?", sourceID, orgID).
		Scan(&info.ID, &info.Name, &info.URL)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &info, nil
}

// normalizeIDList trims, drops empties and deduplicates a bounded id list.
func normalizeIDList(values []string, maxSize int) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
		if len(out) >= maxSize {
			break
		}
	}
	return out
}

// alertRecipientUserIDs mirrors the private getAlertRecipientUserIds helper,
// including the Membership.isActive filter: members deactivated inside the
// organization must not receive threshold notifications.
func (s *Service) alertRecipientUserIDs(ctx context.Context, orgID string) ([]string, error) {
	cacheKey := alertRecipientsCachePrefix + orgID
	if s.redis != nil {
		if raw, err := s.redis.Get(ctx, cacheKey).Bytes(); err == nil && len(raw) > 0 {
			var cached []string
			if json.Unmarshal(raw, &cached) == nil {
				return cached, nil
			}
		}
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT m.userId
FROM Membership m
JOIN User u ON u.id = m.userId
WHERE m.orgId = ? AND m.isActive = 1 AND u.isActive = 1
  AND (
    EXISTS (
      SELECT 1 FROM RolePermission rp
      JOIN Permission p ON p.id = rp.permissionId
      WHERE rp.roleId = m.roleId AND p.name = 'settings.manage'
    )
    OR EXISTS (
      SELECT 1 FROM MembershipRole mr
      JOIN RolePermission rp2 ON rp2.roleId = mr.roleId
      JOIN Permission p2 ON p2.id = rp2.permissionId
      WHERE mr.membershipId = m.id AND p2.name = 'settings.manage'
    )
  )
LIMIT 500`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := make(map[string]bool, 8)
	out := make([]string, 0, 8)
	for rows.Next() {
		var userID sql.NullString
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		if !userID.Valid {
			continue
		}
		value := strings.TrimSpace(userID.String)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if s.redis != nil {
		if payload, err := json.Marshal(out); err == nil {
			s.store.writeCache(ctx, cacheKey, payload, alertRecipientsCacheTTL)
		}
	}
	return out, nil
}
