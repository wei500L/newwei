package newssourcescheduler

import (
	"context"
	"time"
)

// This file ports the RSS adaptive scheduling rules: the cached state, the four
// tiers, the priority adjustment, the interval multiplier and the discovery TTL
// cap. The tier thresholds and clamps come from the persisted runtime settings,
// so a settings update changes both implementations at once.

// readRSSAdaptiveState is readRssAdaptiveState + normalizeRssAdaptiveState.
func (s *Service) readRSSAdaptiveState(ctx context.Context, sourceID string) (rssAdaptiveState, error) {
	var stored rssAdaptiveStateRecord
	ok, err := s.cacheGetJSON(ctx, rssAdaptiveStateKey(sourceID), &stored)
	if err != nil {
		return normalizeRSSAdaptiveState(rssAdaptiveState{}), err
	}
	if !ok {
		return normalizeRSSAdaptiveState(rssAdaptiveState{}), nil
	}
	state := rssAdaptiveState{
		Outcomes:         stored.Outcomes,
		ConsecutiveNoHit: stored.ConsecutiveNoHit,
		UpdatedAt:        stored.UpdatedAt,
	}
	return normalizeRSSAdaptiveState(state), nil
}

// rssAdaptiveStateRecord is the cached RssAdaptiveState JSON.
type rssAdaptiveStateRecord struct {
	Outcomes         []bool `json:"outcomes"`
	ConsecutiveNoHit int    `json:"consecutiveNoHit"`
	UpdatedAt        string `json:"updatedAt"`
}

// writeRSSAdaptiveState is writeRssAdaptiveState: the legacy key and the runtime
// snapshot are both written.
func (s *Service) writeRSSAdaptiveState(ctx context.Context, sourceID string, state rssAdaptiveState) error {
	record := rssAdaptiveStateRecord{
		Outcomes:         state.Outcomes,
		ConsecutiveNoHit: state.ConsecutiveNoHit,
		UpdatedAt:        state.UpdatedAt,
	}
	if err := s.cacheSetJSON(ctx, rssAdaptiveStateKey(sourceID), record, time.Duration(rssAdaptiveStateTTLSeconds)*time.Second); err != nil {
		return err
	}
	snapshotState := state
	return s.SetRSSAdaptiveState(ctx, sourceID, &snapshotState)
}

// shouldUseRSSAdaptive is shouldUseRssAdaptive: only an RSS seed with the
// adaptive flag on and no cron schedule participates.
func (s *Service) shouldUseRSSAdaptive(source *source, seed *seedConfig) bool {
	if seed == nil || seed.Mode != seedModeRSS || !seed.RSSAdaptiveEnabled {
		return false
	}
	return normalizeCronSchedule(source) == nil
}

// resolveRSSAdaptiveTier is resolveRssAdaptiveTier.
func (s *Service) resolveRSSAdaptiveTier(state rssAdaptiveState, sourcePriority int, runtime seedRuntimeSettings) rssAdaptiveTier {
	normalized := normalizeRSSAdaptiveState(state)
	if normalized.ConsecutiveNoHit >= runtime.RSSAdaptiveColdConsecutiveNoHitRuns {
		return rssAdaptiveTierCold
	}
	total := len(normalized.Outcomes)
	if total < 3 {
		return s.resolveRSSAdaptiveTierWithPriority(rssAdaptiveTierNormal, sourcePriority)
	}
	hits := 0
	for _, outcome := range normalized.Outcomes {
		if outcome {
			hits++
		}
	}
	hitRate := float64(hits) / float64(total)
	tier := rssAdaptiveTierNormal
	if hitRate >= float64(runtime.RSSAdaptiveHotHitRatePercent)/100 {
		tier = rssAdaptiveTierHot
	} else if hitRate >= float64(runtime.RSSAdaptiveWarmHitRatePercent)/100 {
		tier = rssAdaptiveTierWarm
	}
	return s.resolveRSSAdaptiveTierWithPriority(tier, sourcePriority)
}

// resolveRSSAdaptiveTierWithPriority is resolveRssAdaptiveTierWithPriority.
func (s *Service) resolveRSSAdaptiveTierWithPriority(tier rssAdaptiveTier, sourcePriority int) rssAdaptiveTier {
	normalizedPriority := normalizeSourcePriority(sourcePriority)
	if normalizedPriority >= crawlHotPriorityThreshold {
		switch tier {
		case rssAdaptiveTierNormal:
			return rssAdaptiveTierWarm
		case rssAdaptiveTierWarm:
			return rssAdaptiveTierHot
		}
		return tier
	}
	if normalizedPriority <= -crawlHotPriorityThreshold {
		switch tier {
		case rssAdaptiveTierHot:
			return rssAdaptiveTierWarm
		case rssAdaptiveTierWarm:
			return rssAdaptiveTierNormal
		case rssAdaptiveTierNormal:
			return rssAdaptiveTierCold
		}
	}
	return tier
}

// resolveRSSAdaptiveIntervalSeconds is resolveRssAdaptiveIntervalSeconds.
func resolveRSSAdaptiveIntervalSeconds(frequencySeconds int, tier rssAdaptiveTier, runtime seedRuntimeSettings) int {
	base := frequencySeconds
	if base < 1 {
		base = 1
	}
	switch tier {
	case rssAdaptiveTierHot:
		return runtime.RSSAdaptiveHotIntervalSeconds
	case rssAdaptiveTierWarm:
		warm := base / runtime.RSSAdaptiveWarmIntervalDivisor
		if warm < runtime.RSSAdaptiveWarmMinIntervalSeconds {
			return runtime.RSSAdaptiveWarmMinIntervalSeconds
		}
		return warm
	case rssAdaptiveTierCold:
		multiplied := base * runtime.RSSAdaptiveColdIntervalMultiplier
		ceiling := runtime.RSSAdaptiveColdMaxIntervalSeconds
		if base > ceiling {
			ceiling = base
		}
		if multiplied > ceiling {
			return ceiling
		}
		return multiplied
	default:
		return base
	}
}

// resolveRSSAdaptiveCacheTTLSeconds is resolveRssAdaptiveCacheTtlSeconds.
func resolveRSSAdaptiveCacheTTLSeconds(cacheTTLSeconds int, tier rssAdaptiveTier, runtime seedRuntimeSettings) int {
	base := cacheTTLSeconds
	if base < 10 {
		base = 10
	}
	if base > 3_600 {
		base = 3_600
	}
	switch tier {
	case rssAdaptiveTierHot:
		capped := base
		if runtime.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds < capped {
			capped = runtime.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds
		}
		if capped < 10 {
			return 10
		}
		return capped
	case rssAdaptiveTierWarm:
		capped := base
		if runtime.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds < capped {
			capped = runtime.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds
		}
		if capped < 10 {
			return 10
		}
		return capped
	default:
		return base
	}
}

// buildNextRSSAdaptiveState is buildNextRssAdaptiveState.
func (s *Service) buildNextRSSAdaptiveState(previous rssAdaptiveState, hasScheduledURLs bool) rssAdaptiveState {
	normalized := normalizeRSSAdaptiveState(previous)
	outcomes := append(append([]bool{}, normalized.Outcomes...), hasScheduledURLs)
	if len(outcomes) > rssAdaptiveHistorySize {
		outcomes = outcomes[len(outcomes)-rssAdaptiveHistorySize:]
	}
	consecutive := normalized.ConsecutiveNoHit + 1
	if hasScheduledURLs {
		consecutive = 0
	}
	return rssAdaptiveState{
		Outcomes:         outcomes,
		ConsecutiveNoHit: consecutive,
		UpdatedAt:        isoMillis(s.now()),
	}
}

// normalizeSourcePriority is normalizeSourcePriority.
func normalizeSourcePriority(priority int) int {
	normalized := priority
	if normalized < sourcePriorityMin {
		normalized = sourcePriorityMin
	}
	if normalized > sourcePriorityMax {
		normalized = sourcePriorityMax
	}
	return normalized
}

// toBullmqPriority is toBullmqPriority: the priority is inverted into BullMQ's
// 1..201 range.
func (s *Service) toBullmqPriority(priority int) int {
	return sourcePriorityMax + 1 - normalizeSourcePriority(priority)
}

// toCrawlPriorityClass is toCrawlPriorityClass.
func toCrawlPriorityClass(priority int) string {
	if normalizeSourcePriority(priority) >= crawlHotPriorityThreshold {
		return "hot"
	}
	return "normal"
}
