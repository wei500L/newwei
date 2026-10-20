package gdeltsnapshot

import (
	"context"
	"math"
	"time"
)

// statusMetrics is SituationMonitorExternalSnapshotStatusMetrics: everything
// buildStatusSummary needs that does not come from the current payload.
type statusMetrics struct {
	LastFullSuccessAt                       *string
	LastNonSuccessAt                        *string
	NextScheduledAt                         string
	Rolling24hSuccessRate                   *float64
	Rolling24hRateLimitedCount              int
	Rolling24hAverageAvailableCategoryCount *float64
}

// loadStatusMetrics mirrors loadStatusMetrics with one projected query instead
// of three payload-loading queries. The aggregation is computed in SQL and the
// rounding happens in Go with the same operations the NestJS code uses.
func (s *Service) loadStatusMetrics(ctx context.Context) (statusMetrics, error) {
	now := s.now()
	row, err := s.store.Aggregates(ctx, now)
	if err != nil {
		return statusMetrics{}, err
	}
	return computeStatusMetrics(row, now), nil
}

// computeStatusMetrics derives the metrics from the projected window.
//
// The rounding is intentionally written as the NestJS expressions:
// Math.round((completed / recent) * 1000) / 10 for the success rate and
// Math.round((sum / valid) * 10) / 10 for the average. Both operands are
// non-negative, so Go's half-away-from-zero math.Round matches Math.round,
// including exact ties such as 24/96 * 10 = 2.5.
func computeStatusMetrics(row aggregateRow, now time.Time) statusMetrics {
	scheduled := isoTime(nextScheduledAt(now))
	metrics := statusMetrics{
		LastFullSuccessAt:          isoTimePtr(row.LastFullSuccessAt),
		LastNonSuccessAt:           isoTimePtr(row.LastNonSuccessAt),
		NextScheduledAt:            scheduled,
		Rolling24hRateLimitedCount: row.RateLimitedCount,
	}
	if row.RecentCount > 0 {
		rate := math.Round(float64(row.CompletedCount)/float64(row.RecentCount)*1000) / 10
		metrics.Rolling24hSuccessRate = &rate
	}
	if row.ValidPayloadCount > 0 {
		average := roundOneDecimal(float64(row.AvailableCategorySum) / float64(row.ValidPayloadCount))
		metrics.Rolling24hAverageAvailableCategoryCount = &average
	}
	return metrics
}

// nextScheduledAt mirrors computeNextScheduledAt: the next quarter-hour
// boundary strictly after now, in UTC. A run at exactly :00:00.000 therefore
// reports the following boundary, which is what the cron expression does.
func nextScheduledAt(now time.Time) time.Time {
	truncated := now.UTC().Truncate(time.Minute)
	minute := truncated.Minute()
	nextQuarterMinute := ((minute + 1 + 14) / 15) * 15
	if nextQuarterMinute >= 60 {
		return truncated.Add(time.Hour).Truncate(time.Hour)
	}
	return truncated.Add(time.Duration(nextQuarterMinute-minute) * time.Minute)
}

// buildStatusSummary mirrors buildStatusSummary. The status is disabled when
// GDELT is off, idle when no snapshot exists, and otherwise the stored status.
func (s *Service) buildStatusSummary(ctx context.Context, payload *Payload, stale bool, enabled bool) (Summary, error) {
	metrics, err := s.loadStatusMetrics(ctx)
	if err != nil {
		return Summary{}, err
	}
	summary := Summary{
		Enabled:                                 enabled,
		IntervalMinutes:                         refreshIntervalMinutes,
		HistoryRetentionDays:                    historyRetentionDays,
		Stale:                                   stale,
		LastFullSuccessAt:                       metrics.LastFullSuccessAt,
		LastNonSuccessAt:                        metrics.LastNonSuccessAt,
		Rolling24hSuccessRate:                   metrics.Rolling24hSuccessRate,
		Rolling24hRateLimitedCount:              metrics.Rolling24hRateLimitedCount,
		Rolling24hAverageAvailableCategoryCount: metrics.Rolling24hAverageAvailableCategoryCount,
		Warnings:                                make([]Warning, 0),
	}
	switch {
	case !enabled:
		summary.Status = "disabled"
	case payload != nil:
		summary.Status = string(payload.Status)
	default:
		summary.Status = "idle"
	}
	if enabled {
		next := metrics.NextScheduledAt
		summary.NextScheduledAt = &next
	}
	if payload != nil {
		summary.Partial = payload.Partial
		generatedAt := payload.GeneratedAt
		summary.GeneratedAt = &generatedAt
		expiresAt := payload.ExpiresAt
		summary.ExpiresAt = &expiresAt
		summary.WarningCount = len(payload.Warnings)
		summary.Warnings = payload.Warnings
		available := 0
		for _, category := range Categories {
			if len(payload.HeadlinesByCategory.headlines(category)) > 0 {
				available++
			}
		}
		summary.AvailableCategoryCount = available
	}
	return summary, nil
}
