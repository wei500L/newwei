package newssourcescheduler

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
)

// This file ports the deep-discovery failure bookkeeping: the cached streak, the
// exponential retry delay, the circuit breaker, the 24h per-code statistics and
// the NewsSource write that both share. Only errors whose text starts with a
// `[SEED_DEEP_*]` code participate, exactly like isDeepDiscoveryFailureError.

// deepFailureStateDocument is DeepDiscoveryFailureState.
type deepFailureStateDocument struct {
	Streak           int     `json:"streak"`
	LastFailureAt    string  `json:"lastFailureAt"`
	LastCode         string  `json:"lastCode"`
	LastMessage      string  `json:"lastMessage"`
	LastDetail       *string `json:"lastDetail,omitempty"`
	RetryAt          string  `json:"retryAt"`
	NextRunAt        string  `json:"nextRunAt"`
	CircuitOpenUntil *string `json:"circuitOpenUntil"`
}

// deepFailureStatsDocument is DeepDiscoveryFailureStats24h.
type deepFailureStatsDocument struct {
	Total     int            `json:"total"`
	ByCode    map[string]int `json:"byCode"`
	UpdatedAt string         `json:"updatedAt"`
}

// clearDeepDiscoveryFailureState is clearDeepDiscoveryFailureState.
func (s *Service) clearDeepDiscoveryFailureState(ctx context.Context, sourceID string) {
	if err := s.cache.Del(ctx, crawlmetadata.DeepDiscoveryFailureStateCacheKey(sourceID)); err != nil {
		s.logWarn("failed to clear deep discovery failure state", "sourceId", sourceID, "error", err)
	}
}

// isDeepDiscoveryFailureError is isDeepDiscoveryFailureError.
func isDeepDiscoveryFailureError(err error) bool {
	_, ok := crawlmetadata.ParseDeepDiscoveryError(err)
	return ok
}

// markDeepDiscoveryFailureState is markDeepDiscoveryFailureState.
func (s *Service) markDeepDiscoveryFailureState(ctx context.Context, source *source, dispatchErr error, failureAt time.Time) {
	info := normalizeDeepDiscoveryError(dispatchErr)
	stateKey := crawlmetadata.DeepDiscoveryFailureStateCacheKey(source.ID)
	statsKey := crawlmetadata.DeepDiscoveryFailureStatsCacheKey(source.ID)

	var existing deepFailureStateDocument
	_, _ = s.cacheGetJSON(ctx, stateKey, &existing)
	previousStreak := existing.Streak
	if previousStreak < 0 {
		previousStreak = 0
	}
	streak := previousStreak + 1

	failureRecoveryDelay := s.settings.FailureRecoveryDelay.Milliseconds()
	failureMaxDelay := s.settings.FailureMaxDelay.Milliseconds()
	retryDelayMs := s.computeExponentialBackoffDelay(failureRecoveryDelay, int64(streak), failureMaxDelay)
	retryAt := failureAt.Add(time.Duration(retryDelayMs) * time.Millisecond)

	threshold := s.settings.CircuitBreakerThreshold
	if threshold < 0 {
		threshold = 0
	}
	var circuitOpenUntil *time.Time
	if threshold > 0 && streak >= threshold {
		circuitAttempt := int64(streak - threshold + 1)
		circuitDelayMs := s.computeExponentialBackoffDelay(
			s.settings.CircuitBreakerBaseDelay.Milliseconds(),
			circuitAttempt,
			s.settings.CircuitBreakerMaxDelay.Milliseconds(),
		)
		value := failureAt.Add(time.Duration(circuitDelayMs) * time.Millisecond)
		circuitOpenUntil = &value
	}

	nextRunAt := retryAt
	if circuitOpenUntil != nil && circuitOpenUntil.After(nextRunAt) {
		nextRunAt = *circuitOpenUntil
	}

	if err := s.repo.UpdateSourceDeepFailure(ctx, source.ID, failureAt, nextRunAt, circuitOpenUntil); err != nil {
		s.logWarn("failed to persist deep discovery failure", "sourceId", source.ID, "orgId", source.OrgID, "error", err)
	}

	document := deepFailureStateDocument{
		Streak:        streak,
		LastFailureAt: isoMillis(failureAt),
		LastCode:      info.Code,
		LastMessage:   info.Message,
		RetryAt:       isoMillis(retryAt),
		NextRunAt:     isoMillis(nextRunAt),
	}
	if info.Detail != "" {
		detail := info.Detail
		document.LastDetail = &detail
	}
	if circuitOpenUntil != nil {
		formatted := isoMillis(*circuitOpenUntil)
		document.CircuitOpenUntil = &formatted
	}
	if err := s.cacheSetJSON(ctx, stateKey, document, time.Duration(deepDiscoveryFailureStateTTLSeconds)*time.Second); err != nil {
		s.logWarn("failed to cache deep discovery failure state", "sourceId", source.ID, "error", err)
	}

	var existingStats deepFailureStatsDocument
	_, _ = s.cacheGetJSON(ctx, statsKey, &existingStats)
	nextStats := normalizeDeepFailureStats(existingStats)
	if nextStats.ByCode == nil {
		nextStats.ByCode = map[string]int{}
	}
	nextStats.ByCode[info.Code]++
	nextStats.Total++
	nextStats.UpdatedAt = isoMillis(failureAt)
	if err := s.cacheSetJSON(ctx, statsKey, nextStats, time.Duration(deepDiscoveryFailureStatsTTLSeconds)*time.Second); err != nil {
		s.logWarn("failed to cache deep discovery failure stats", "sourceId", source.ID, "error", err)
	}

	s.logWarn("deep seed discovery failed; applied scheduler backoff",
		"sourceId", source.ID, "orgId", source.OrgID, "code", info.Code, "streak", streak,
		"retryAt", retryAt, "circuitOpenUntil", circuitOpenUntil)
}

// normalizeDeepDiscoveryError is normalizeDeepDiscoveryError.
func normalizeDeepDiscoveryError(err error) crawlmetadata.DeepDiscoveryErrorInfo {
	if parsed, ok := crawlmetadata.ParseDeepDiscoveryError(err); ok {
		return parsed
	}
	message := ""
	if err != nil {
		message = err.Error()
	}
	if message == "" {
		message = "Deep discovery failed with unknown error."
	}
	return crawlmetadata.DeepDiscoveryErrorInfo{
		Code:       deepDiscoveryUnknownErrorCode,
		Message:    message,
		RawMessage: message,
	}
}

// normalizeDeepFailureStats is normalizeDeepFailureStats24h.
func normalizeDeepFailureStats(value deepFailureStatsDocument) deepFailureStatsDocument {
	byCode := map[string]int{}
	for code, count := range value.ByCode {
		if code == "" || !hasDeepErrorPrefix(code) {
			continue
		}
		if count <= 0 {
			continue
		}
		byCode[code] = count
	}
	total := value.Total
	if total < 0 {
		total = 0
	}
	if total == 0 {
		for _, count := range byCode {
			total += count
		}
	}
	updatedAt := value.UpdatedAt
	if updatedAt == "" {
		updatedAt = isoMillis(time.Unix(0, 0))
	}
	return deepFailureStatsDocument{Total: total, ByCode: byCode, UpdatedAt: updatedAt}
}

// hasDeepErrorPrefix reports the SEED_DEEP_ prefix.
func hasDeepErrorPrefix(code string) bool {
	return len(code) >= len(deepDiscoveryErrorCodePrefix) && code[:len(deepDiscoveryErrorCodePrefix)] == deepDiscoveryErrorCodePrefix
}

// marshalDeepFailureState is used by the integration tests.
func marshalDeepFailureState(document deepFailureStateDocument) json.RawMessage {
	return mustJSON(document)
}

// ceilSeconds is Math.ceil(ms / 1000).
func ceilSeconds(milliseconds int64) int64 {
	return int64(math.Ceil(float64(milliseconds) / 1000))
}
