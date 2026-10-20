package newssources

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"time"
)

// This file ports the read half of NewsSourceOpsSnapshotService.readRuntimeStates:
// the news-source list attaches the runtime block (queued/running crawl task
// counts, backpressure state and the RSS adaptive state) that the scheduler
// writes into Redis. The Go writer uses the same keys and the same JSON shape,
// so a list request served by Go shows the state the Go scheduler wrote.
//
// The legacy keys (news-source:backpressure:{id}, news-source:rss-adaptive:{id}
// and news-source:backpressure-count:{id}) are still hydrated when the newer
// news-source:list-runtime:{id} key is missing, exactly like NestJS: sources that
// were last touched by an older build keep their state visible.

const (
	newsSourceListRuntimeTTLSeconds = 30 * 24 * 60 * 60
	backpressureLookbackMs          = 24 * 60 * 60 * 1000
	rssAdaptiveMaxHistorySize       = 8
)

func runtimeCacheKey(sourceID string) string {
	return "news-source:list-runtime:" + sourceID
}

func legacyBackpressureKey(sourceID string) string {
	return "news-source:backpressure:" + sourceID
}

func legacyBackpressureCountKey(sourceID string) string {
	return "news-source:backpressure-count:" + sourceID
}

func legacyRSSAdaptiveKey(sourceID string) string {
	return "news-source:rss-adaptive:" + sourceID
}

// runtimeSnapshot is NewsSourceListRuntimeState. Field order is the NestJS
// object literal order; the write path in newssourcescheduler marshals the same
// struct shape.
type runtimeSnapshot struct {
	CrawlTaskQueuedCount    int                       `json:"crawlTaskQueuedCount"`
	CrawlTaskRunningCount   int                       `json:"crawlTaskRunningCount"`
	BackpressureUntil       *string                   `json:"backpressureUntil"`
	BackpressurePendingJobs *int                      `json:"backpressurePendingJobs"`
	BackpressureThreshold   *int                      `json:"backpressureThreshold"`
	BackpressureHitTimes    []string                  `json:"backpressureHitTimestamps"`
	RSSAdaptiveState        *rssAdaptiveRuntimeRecord `json:"rssAdaptiveState"`
}

// rssAdaptiveRuntimeRecord is NewsSourceRssAdaptiveRuntimeState.
type rssAdaptiveRuntimeRecord struct {
	Outcomes         []bool `json:"outcomes"`
	ConsecutiveNoHit int    `json:"consecutiveNoHit"`
	UpdatedAt        string `json:"updatedAt"`
}

func emptyRuntimeSnapshot() runtimeSnapshot {
	return runtimeSnapshot{
		BackpressureHitTimes: []string{},
	}
}

// applyRuntimeStates fills opsSummary.Runtime for every listed source.
func (s *Service) applyRuntimeStates(ctx context.Context, sources []sourceRow, summaries map[string]opsSummary) error {
	if len(sources) == 0 {
		return nil
	}
	states := make(map[string]runtimeSnapshot, len(sources))
	for _, source := range sources {
		states[source.ID] = emptyRuntimeSnapshot()
	}
	if s.redis != nil {
		keys := make([]string, 0, len(sources))
		for _, source := range sources {
			keys = append(keys, runtimeCacheKey(source.ID))
		}
		values, err := s.redis.MGet(ctx, keys...).Result()
		if err != nil {
			return err
		}
		missing := make([]string, 0, len(sources))
		for index, source := range sources {
			if index >= len(values) || values[index] == nil {
				missing = append(missing, source.ID)
				continue
			}
			raw, ok := values[index].(string)
			if !ok {
				missing = append(missing, source.ID)
				continue
			}
			states[source.ID] = normalizeRuntimeSnapshot(raw)
		}
		if len(missing) > 0 {
			hydrated := s.hydrateLegacyRuntimeStates(ctx, missing)
			for sourceID, state := range hydrated {
				states[sourceID] = state
			}
		}
	}

	for sourceID, state := range states {
		summary := summaries[sourceID]
		summary = emptyIfNoSnapshot(summary)
		summary.Runtime = runtimeState{
			CrawlTaskQueuedCount:    state.CrawlTaskQueuedCount,
			CrawlTaskRunningCount:   state.CrawlTaskRunningCount,
			BackpressureUntil:       state.BackpressureUntil,
			BackpressurePendingJobs: state.BackpressurePendingJobs,
			BackpressureThreshold:   state.BackpressureThreshold,
			BackpressureCount24h:    len(state.BackpressureHitTimes),
			RssAdaptiveState:        state.RSSAdaptiveState,
		}
		summaries[sourceID] = summary
	}
	return nil
}

// emptyIfNoSnapshot keeps the snapshot-shaped zero value (null latest rows) so
// the runtime block can be attached to a source without a snapshot row.
func emptyIfNoSnapshot(summary opsSummary) opsSummary {
	if summary.LatestJob == nil {
		empty := emptyOps()
		empty.Runtime = summary.Runtime
		return empty
	}
	return summary
}

// hydrateLegacyRuntimeStates reads the three legacy keys for the sources that
// have no list-runtime key yet, builds the state, persists it under the new key
// and returns it. Every failure is best-effort: the list still renders the
// empty state, exactly like the NestJS hydration path.
func (s *Service) hydrateLegacyRuntimeStates(ctx context.Context, sourceIDs []string) map[string]runtimeSnapshot {
	states := make(map[string]runtimeSnapshot, len(sourceIDs))
	if s.redis == nil || len(sourceIDs) == 0 {
		return states
	}
	backpressureKeys := make([]string, 0, len(sourceIDs))
	rssAdaptiveKeys := make([]string, 0, len(sourceIDs))
	countKeys := make([]string, 0, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		backpressureKeys = append(backpressureKeys, legacyBackpressureKey(sourceID))
		rssAdaptiveKeys = append(rssAdaptiveKeys, legacyRSSAdaptiveKey(sourceID))
		countKeys = append(countKeys, legacyBackpressureCountKey(sourceID))
	}
	backpressureValues, err := s.redis.MGet(ctx, backpressureKeys...).Result()
	if err != nil {
		return states
	}
	rssAdaptiveValues, err := s.redis.MGet(ctx, rssAdaptiveKeys...).Result()
	if err != nil {
		return states
	}
	countValues, err := s.redis.MGet(ctx, countKeys...).Result()
	if err != nil {
		return states
	}

	for index, sourceID := range sourceIDs {
		state := emptyRuntimeSnapshot()
		if index < len(backpressureValues) {
			state.BackpressureUntil, state.BackpressurePendingJobs, state.BackpressureThreshold = parseLegacyBackpressure(backpressureValues[index])
		}
		if index < len(rssAdaptiveValues) {
			state.RSSAdaptiveState = parseLegacyRSSAdaptive(rssAdaptiveValues[index])
		}
		if index < len(countValues) {
			if count, ok := parseIntValue(countValues[index]); ok && count > 0 {
				now := nowMillis().Format("2006-01-02T15:04:05.000Z")
				for i := 0; i < count; i++ {
					state.BackpressureHitTimes = append(state.BackpressureHitTimes, now)
				}
			}
		}
		states[sourceID] = state
		if state.BackpressureUntil != nil || len(state.BackpressureHitTimes) > 0 || state.RSSAdaptiveState != nil {
			encoded, marshalErr := json.Marshal(state)
			if marshalErr == nil {
				_ = s.redis.Set(ctx, runtimeCacheKey(sourceID), string(encoded), time.Duration(newsSourceListRuntimeTTLSeconds)*time.Second).Err()
			}
		}
	}
	return states
}

// parseLegacyBackpressure reads the legacy backpressure value.
func parseLegacyBackpressure(value any) (*string, *int, *int) {
	record, ok := decodeRedisObject(value)
	if !ok {
		return nil, nil, nil
	}
	var until *string
	if raw, present := record["until"]; present {
		if text, isString := raw.(string); isString && text != "" {
			until = &text
		}
	}
	var pendingJobs *int
	if raw, present := record["pendingJobs"]; present {
		if number, isNumber := raw.(float64); isNumber && !math.IsNaN(number) && !math.IsInf(number, 0) {
			normalized := int(number)
			pendingJobs = &normalized
		}
	}
	var threshold *int
	if raw, present := record["threshold"]; present {
		if number, isNumber := raw.(float64); isNumber && !math.IsNaN(number) && !math.IsInf(number, 0) {
			normalized := int(number)
			threshold = &normalized
		}
	}
	return until, pendingJobs, threshold
}

// parseLegacyRSSAdaptive reads the legacy RSS adaptive state.
func parseLegacyRSSAdaptive(value any) *rssAdaptiveRuntimeRecord {
	record, ok := decodeRedisObject(value)
	if !ok {
		return nil
	}
	outcomes := []bool{}
	if raw, present := record["outcomes"]; present {
		if list, isList := raw.([]any); isList {
			for _, entry := range list {
				if flag, isBool := entry.(bool); isBool {
					outcomes = append(outcomes, flag)
				}
			}
		}
	}
	if len(outcomes) > rssAdaptiveMaxHistorySize {
		outcomes = outcomes[len(outcomes)-rssAdaptiveMaxHistorySize:]
	}
	consecutiveNoHit := 0
	if raw, present := record["consecutiveNoHit"]; present {
		if number, isNumber := raw.(float64); isNumber && !math.IsNaN(number) && !math.IsInf(number, 0) && number > 0 {
			consecutiveNoHit = int(number)
		}
	}
	updatedAt := time.Unix(0, 0).UTC().Format("2006-01-02T15:04:05.000Z")
	if raw, present := record["updatedAt"]; present {
		if text, isString := raw.(string); isString && text != "" {
			updatedAt = text
		}
	}
	if len(outcomes) == 0 && consecutiveNoHit <= 0 && updatedAt == time.Unix(0, 0).UTC().Format("2006-01-02T15:04:05.000Z") {
		return nil
	}
	return &rssAdaptiveRuntimeRecord{
		Outcomes:         outcomes,
		ConsecutiveNoHit: consecutiveNoHit,
		UpdatedAt:        updatedAt,
	}
}

// decodeRedisObject decodes one Redis JSON object value.
func decodeRedisObject(value any) (map[string]any, bool) {
	raw, ok := value.(string)
	if !ok || raw == "" {
		return nil, false
	}
	var decoded map[string]any
	if json.Unmarshal([]byte(raw), &decoded) != nil {
		return nil, false
	}
	return decoded, true
}

// parseIntValue reads a legacy INCR counter.
func parseIntValue(value any) (int, bool) {
	raw, ok := value.(string)
	if !ok || raw == "" {
		return 0, false
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// normalizeRuntimeSnapshot is normalizeRuntimeState.
func normalizeRuntimeSnapshot(raw string) runtimeSnapshot {
	state := emptyRuntimeSnapshot()
	var record map[string]any
	if json.Unmarshal([]byte(raw), &record) != nil {
		return state
	}
	if number, ok := numberValue(record["crawlTaskQueuedCount"]); ok {
		state.CrawlTaskQueuedCount = maxInt(0, int(math.Floor(number)))
	}
	if number, ok := numberValue(record["crawlTaskRunningCount"]); ok {
		state.CrawlTaskRunningCount = maxInt(0, int(math.Floor(number)))
	}
	if text, ok := stringValue(record["backpressureUntil"]); ok {
		state.BackpressureUntil = &text
	}
	if number, ok := numberValue(record["backpressurePendingJobs"]); ok {
		value := int(number)
		state.BackpressurePendingJobs = &value
	}
	if number, ok := numberValue(record["backpressureThreshold"]); ok {
		value := int(number)
		state.BackpressureThreshold = &value
	}
	if list, ok := record["backpressureHitTimestamps"].([]any); ok {
		state.BackpressureHitTimes = pruneBackpressureHitTimestamps(list)
	}
	if nested, present := record["rssAdaptiveState"]; present && nested != nil {
		if encoded, err := json.Marshal(nested); err == nil {
			state.RSSAdaptiveState = parseLegacyRSSAdaptive(string(encoded))
		}
	}
	return state
}

func pruneBackpressureHitTimestamps(values []any) []string {
	cutoff := nowMillis().UnixMilli() - backpressureLookbackMs
	out := []string{}
	for _, entry := range values {
		text, ok := entry.(string)
		if !ok {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			continue
		}
		if parsed.UnixMilli() >= cutoff {
			out = append(out, text)
		}
	}
	return out
}

func numberValue(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func stringValue(value any) (string, bool) {
	text, ok := value.(string)
	if !ok || text == "" {
		return "", false
	}
	return text, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
