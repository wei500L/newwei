package crawlmetadata

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file ports the read side of apps/api/src/modules/crawl/deep-discovery-failure.ts
// and NewsSourceService.readDeepDiscoveryFailureStats
// (apps/api/src/modules/crawl/news-source.service.ts:968-1100).
//
// The state and 24h stats values are written by the NestJS news-source
// scheduler, never by this package: the preview is read-only. The Redis values
// are JSON documents under the same two keys the scheduler uses
// (`news-source:deep-failure:state:<id>` and `...:stats24h:<id>`), so a write in
// either runtime is visible to the other without a second cache.
//
// parseDeepDiscoveryError is not ported: the Go discovery chain raises
// *DiscoveryError directly, so the preview maps the code/message/detail without
// re-parsing a formatted exception string.

const (
	deepDiscoveryUnknownErrorCode = "SEED_DEEP_UNKNOWN"
	// DeepDiscoveryFailureStateTTLSeconds and DeepDiscoveryFailureStatsTTLSeconds
	// document the writer TTL; the reader only needs the keys.
	DeepDiscoveryFailureStateTTLSeconds = 7 * 24 * 60 * 60
	DeepDiscoveryFailureStatsTTLSeconds = 24 * 60 * 60
)

// DeepDiscoveryFailureState is DeepDiscoveryFailureState.
type DeepDiscoveryFailureState struct {
	Streak           int
	LastFailureAt    string
	LastCode         string
	LastMessage      string
	LastDetail       *string
	RetryAt          string
	NextRunAt        string
	CircuitOpenUntil *string
}

// DeepDiscoveryFailureStats24h is DeepDiscoveryFailureStats24h.
type DeepDiscoveryFailureStats24h struct {
	Total     int
	ByCode    map[string]int
	UpdatedAt string
}

// DeepFailureCodeCount is one byCode entry, ordered by count descending in the
// preview response.
type DeepFailureCodeCount struct {
	Code  string
	Count int
}

// DeepFailureStats is NewsSourcePreviewDeepFailureStats.
type DeepFailureStats struct {
	Total24h         int
	Streak           int
	ByCode           []DeepFailureCodeCount
	LastFailureAt    *string
	LastCode         *string
	LastMessage      *string
	LastDetail       *string
	NextRetryAt      *string
	CircuitOpenUntil *string
}

// DeepDiscoveryFailureStateCacheKey is deepDiscoveryFailureStateCacheKey.
func DeepDiscoveryFailureStateCacheKey(sourceID string) string {
	return "news-source:deep-failure:state:" + sourceID
}

// DeepDiscoveryFailureStatsCacheKey is deepDiscoveryFailureStatsCacheKey.
func DeepDiscoveryFailureStatsCacheKey(sourceID string) string {
	return "news-source:deep-failure:stats24h:" + sourceID
}

// ReadDeepDiscoveryFailureStats implements readDeepDiscoveryFailureStats. A
// missing state and a missing stats document both yield nil, which the preview
// renders as "absent".
func (s *Service) ReadDeepDiscoveryFailureStats(ctx context.Context, sourceID string) *DeepFailureStats {
	if s.redis == nil {
		return nil
	}
	stateRaw, statsRaw := readRedisJSON(ctx, s.redis, DeepDiscoveryFailureStateCacheKey(sourceID)),
		readRedisJSON(ctx, s.redis, DeepDiscoveryFailureStatsCacheKey(sourceID))
	state := normalizeDeepDiscoveryFailureState(stateRaw)
	stats := normalizeDeepDiscoveryFailureStats24h(statsRaw)

	hasState := state != nil && (state.Streak > 0 || state.LastCode != "" || state.LastFailureAt != "")
	hasStats := stats.Total > 0 || len(stats.ByCode) > 0
	if !hasState && !hasStats {
		return nil
	}

	out := &DeepFailureStats{Total24h: stats.Total}
	if state != nil {
		out.Streak = state.Streak
		out.LastFailureAt = stringOrNil(state.LastFailureAt)
		out.LastCode = stringOrNil(state.LastCode)
		out.LastMessage = stringOrNil(state.LastMessage)
		out.LastDetail = state.LastDetail
		out.NextRetryAt = stringOrNil(state.RetryAt)
		out.CircuitOpenUntil = state.CircuitOpenUntil
	}
	codes := make([]DeepFailureCodeCount, 0, len(stats.ByCode))
	for code, count := range stats.ByCode {
		codes = append(codes, DeepFailureCodeCount{Code: code, Count: count})
	}
	// Count descending; equal counts keep the map iteration out of the response
	// by falling back to the code so the order is stable.
	sortCodeCounts(codes)
	out.ByCode = codes
	return out
}

// sortCodeCounts orders by count descending, then by code so equal counts stay
// deterministic (the source keeps Object.entries insertion order).
func sortCodeCounts(codes []DeepFailureCodeCount) {
	sort.SliceStable(codes, func(i, j int) bool {
		if codes[i].Count != codes[j].Count {
			return codes[i].Count > codes[j].Count
		}
		return codes[i].Code < codes[j].Code
	})
}

func stringOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// readRedisJSON returns the decoded JSON document, or nil when the key is
// absent or the value is not JSON.
func readRedisJSON(ctx context.Context, client *redis.Client, key string) any {
	raw, err := client.Get(ctx, key).Result()
	if err != nil || raw == "" {
		return nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil
	}
	return decoded
}

// normalizeDeepDiscoveryFailureState implements
// normalizeDeepDiscoveryFailureState. A record without a streak, code and
// timestamp is "absent".
func normalizeDeepDiscoveryFailureState(value any) *DeepDiscoveryFailureState {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	state := &DeepDiscoveryFailureState{}
	if streak, ok := numericValue(record["streak"]); ok && streak >= 0 {
		state.Streak = int(streak)
	}
	if text, ok := record["lastFailureAt"].(string); ok {
		state.LastFailureAt = text
	}
	if text, ok := record["lastCode"].(string); ok {
		state.LastCode = text
	}
	if text, ok := record["lastMessage"].(string); ok {
		state.LastMessage = text
	}
	retryAt := ""
	if text, ok := record["retryAt"].(string); ok {
		retryAt = text
	}
	nextRunAt := ""
	if text, ok := record["nextRunAt"].(string); ok {
		nextRunAt = text
	}
	if nextRunAt == "" {
		nextRunAt = retryAt
	}
	if circuitOpenUntil, ok := record["circuitOpenUntil"].(string); ok && circuitOpenUntil != "" {
		state.CircuitOpenUntil = &circuitOpenUntil
	}
	if detail, ok := record["lastDetail"].(string); ok && detail != "" {
		state.LastDetail = &detail
	}

	if state.Streak <= 0 && state.LastCode == "" && state.LastFailureAt == "" {
		return nil
	}
	zero := time.UnixMilli(0).UTC().Format("2006-01-02T15:04:05.000Z")
	if state.LastFailureAt == "" {
		state.LastFailureAt = zero
	}
	if state.LastCode == "" {
		state.LastCode = deepDiscoveryUnknownErrorCode
	}
	if state.LastMessage == "" {
		state.LastMessage = "Deep discovery failed"
	}
	if retryAt == "" && nextRunAt == "" {
		retryAt = zero
		nextRunAt = zero
	}
	if retryAt == "" {
		retryAt = nextRunAt
	}
	if nextRunAt == "" {
		nextRunAt = retryAt
	}
	state.RetryAt = retryAt
	state.NextRunAt = nextRunAt
	return state
}

// normalizeDeepDiscoveryFailureStats24h implements
// normalizeDeepDiscoveryFailureStats24h: only SEED_DEEP_* codes with a positive
// count survive.
func normalizeDeepDiscoveryFailureStats24h(value any) DeepDiscoveryFailureStats24h {
	empty := DeepDiscoveryFailureStats24h{
		ByCode:    map[string]int{},
		UpdatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	record, ok := value.(map[string]any)
	if !ok {
		return empty
	}
	byCode := map[string]int{}
	if rawByCode, ok := record["byCode"].(map[string]any); ok {
		for code, countRaw := range rawByCode {
			if !strings.HasPrefix(code, "SEED_DEEP_") {
				continue
			}
			count, ok := numericValue(countRaw)
			if !ok || count <= 0 {
				continue
			}
			byCode[code] = int(count)
		}
	}
	total := 0
	if value, ok := numericValue(record["total"]); ok && value >= 0 {
		total = int(value)
	} else {
		for _, count := range byCode {
			total += count
		}
	}
	updatedAt := empty.UpdatedAt
	if text, ok := record["updatedAt"].(string); ok && text != "" {
		updatedAt = text
	}
	return DeepDiscoveryFailureStats24h{Total: total, ByCode: byCode, UpdatedAt: updatedAt}
}

// numericValue mirrors `typeof value === "number" && Number.isFinite(value)`.
func numericValue(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok {
		return 0, false
	}
	if number != number {
		return 0, false
	}
	return number, true
}
