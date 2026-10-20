package newssourcescheduler

import (
	"context"
	"encoding/json"
	"time"
)

// This file ports the write half of NewsSourceOpsSnapshotService:
// setBackpressureState, setRssAdaptiveState, syncQueueCounts,
// refreshSnapshotForSource and refreshSnapshotsForSources. Two targets are
// written:
//
//   - the NewsSourceOpsSnapshot row (latestJob / latestCrawlTask /
//     latestArticle / stats24h JSON), which the Go newssources read model
//     already projects;
//   - the news-source:list-runtime:{sourceId} Redis value (30-day TTL) with the
//     crawl-task counters, the backpressure state and the RSS adaptive state.
//     The legacy keys stay authoritative for writes the NestJS service still
//     owns; Go always writes this one, and the Go list reader hydrates the
//     legacy keys when it is missing.

// rssAdaptiveRuntimeState is NewsSourceRssAdaptiveRuntimeState.
type rssAdaptiveRuntimeState struct {
	Outcomes         []bool `json:"outcomes"`
	ConsecutiveNoHit int    `json:"consecutiveNoHit"`
	UpdatedAt        string `json:"updatedAt"`
}

// listRuntimeState is NewsSourceListRuntimeState. Field order is the NestJS
// object literal order.
type listRuntimeState struct {
	CrawlTaskQueuedCount    int                      `json:"crawlTaskQueuedCount"`
	CrawlTaskRunningCount   int                      `json:"crawlTaskRunningCount"`
	BackpressureUntil       *string                  `json:"backpressureUntil"`
	BackpressurePendingJobs *int                     `json:"backpressurePendingJobs"`
	BackpressureThreshold   *int                     `json:"backpressureThreshold"`
	BackpressureHitTimes    []string                 `json:"backpressureHitTimestamps"`
	RSSAdaptiveState        *rssAdaptiveRuntimeState `json:"rssAdaptiveState"`
}

func emptyListRuntimeState() listRuntimeState {
	return listRuntimeState{BackpressureHitTimes: []string{}}
}

// backpressureState is the setBackpressureState argument.
type backpressureState struct {
	Until       string
	PendingJobs *int
	Threshold   *int
	ObservedAt  time.Time
}

// latestJobDocument is NewsSourceLatestJobSnapshot as stored in the snapshot.
type latestJobDocument struct {
	ID          string          `json:"id"`
	Status      string          `json:"status"`
	URL         string          `json:"url"`
	CreatedAt   string          `json:"createdAt"`
	StartedAt   *string         `json:"startedAt"`
	CompletedAt *string         `json:"completedAt"`
	Error       *string         `json:"error"`
	Metadata    json.RawMessage `json:"metadata"`
}

// latestCrawlTaskDocument is NewsSourceLatestCrawlTaskSnapshot.
type latestCrawlTaskDocument struct {
	ID            string  `json:"id"`
	Status        string  `json:"status"`
	LastError     *string `json:"lastError"`
	LastRunAt     *string `json:"lastRunAt"`
	LastSuccessAt *string `json:"lastSuccessAt"`
	LastResultAt  *string `json:"lastResultAt"`
}

// latestArticleDocument is NewsSourceLatestArticleSnapshot.
type latestArticleDocument struct {
	ID         string  `json:"id"`
	URL        string  `json:"url"`
	CrawlAt    string  `json:"crawlAt"`
	TitleGuess *string `json:"titleGuess"`
}

// stats24hDocument is NewsSourceStats24hSnapshot.
type stats24hDocument struct {
	Completed     int      `json:"completed"`
	Failed        int      `json:"failed"`
	SuccessRate   *float64 `json:"successRate"`
	AvgDurationMs *float64 `json:"avgDurationMs"`
}

// opsSummary is NewsSourceOpsSummary.
type opsSummary struct {
	LatestJob       *latestJobDocument       `json:"latestJob"`
	LatestCrawlTask *latestCrawlTaskDocument `json:"latestCrawlTask"`
	LatestArticle   *latestArticleDocument   `json:"latestArticle"`
	Stats24h        stats24hDocument         `json:"stats24h"`
}

// SetBackpressureState is setBackpressureState. A nil state clears the marker
// and keeps the hit history.
func (s *Service) SetBackpressureState(ctx context.Context, sourceID string, state *backpressureState) error {
	current, err := s.readRuntimeState(ctx, sourceID)
	if err != nil {
		return err
	}
	if state == nil {
		current.BackpressureUntil = nil
		current.BackpressurePendingJobs = nil
		current.BackpressureThreshold = nil
		return s.writeRuntimeState(ctx, sourceID, current)
	}
	until := state.Until
	current.BackpressureUntil = &until
	current.BackpressurePendingJobs = state.PendingJobs
	current.BackpressureThreshold = state.Threshold
	observedAt := state.ObservedAt
	if observedAt.IsZero() {
		observedAt = s.now()
	}
	current.BackpressureHitTimes = pruneHitTimestamps(append(current.BackpressureHitTimes, isoMillis(observedAt)), s.now())
	return s.writeRuntimeState(ctx, sourceID, current)
}

// SetRSSAdaptiveState is setRssAdaptiveState.
func (s *Service) SetRSSAdaptiveState(ctx context.Context, sourceID string, state *rssAdaptiveState) error {
	current, err := s.readRuntimeState(ctx, sourceID)
	if err != nil {
		return err
	}
	if state == nil {
		current.RSSAdaptiveState = nil
	} else {
		normalized := normalizeRSSAdaptiveState(*state)
		current.RSSAdaptiveState = &rssAdaptiveRuntimeState{
			Outcomes:         normalized.Outcomes,
			ConsecutiveNoHit: normalized.ConsecutiveNoHit,
			UpdatedAt:        normalized.UpdatedAt,
		}
	}
	return s.writeRuntimeState(ctx, sourceID, current)
}

// SyncQueueCounts is syncQueueCounts.
func (s *Service) SyncQueueCounts(ctx context.Context, orgID, sourceID string) error {
	queued, running, err := s.repo.SyncQueueCounts(ctx, orgID, sourceID)
	if err != nil {
		return err
	}
	current, err := s.readRuntimeState(ctx, sourceID)
	if err != nil {
		return err
	}
	current.CrawlTaskQueuedCount = queued
	current.CrawlTaskRunningCount = running
	return s.writeRuntimeState(ctx, sourceID, current)
}

// RefreshSnapshotForSource is refreshSnapshotForSource: it rebuilds the
// NewsSourceOpsSnapshot row from the latest job, crawl task, article and the
// 24h job statistics.
func (s *Service) RefreshSnapshotForSource(ctx context.Context, orgID, sourceID string) (opsSummary, error) {
	summary := opsSummary{Stats24h: stats24hDocument{}}

	latestJob, err := s.repo.LatestJobForSnapshot(ctx, orgID, sourceID)
	if err != nil {
		return summary, err
	}
	if latestJob != nil {
		document := latestJobDocument{
			ID:          latestJob.ID,
			Status:      latestJob.Status,
			URL:         latestJob.URL,
			CreatedAt:   isoMillis(latestJob.CreatedAt),
			StartedAt:   isoMillisPtr(latestJob.StartedAt),
			CompletedAt: isoMillisPtr(latestJob.CompletedAt),
			Error:       latestJob.Error,
			Metadata:    normalizePlainRecord(latestJob.Metadata),
		}
		summary.LatestJob = &document
	}

	latestArticle, err := s.repo.LatestArticleForSnapshot(ctx, orgID, sourceID)
	if err != nil {
		return summary, err
	}
	if latestArticle != nil {
		crawlAt := isoMillis(latestArticle.CrawlAt)
		summary.LatestArticle = &latestArticleDocument{
			ID:         latestArticle.ID,
			URL:        latestArticle.URL,
			CrawlAt:    crawlAt,
			TitleGuess: latestArticle.TitleGuess,
		}
	}

	var latestCrawlTask *latestCrawlTaskSnapshot
	if crawlTaskID := extractCrawlTaskID(latestJob); crawlTaskID != "" {
		latestCrawlTask, err = s.repo.LatestCrawlTaskByID(ctx, orgID, crawlTaskID)
	} else {
		latestCrawlTask, err = s.repo.LatestCrawlTaskForSource(ctx, orgID, sourceID)
	}
	if err != nil {
		return summary, err
	}
	if latestCrawlTask != nil {
		summary.LatestCrawlTask = &latestCrawlTaskDocument{
			ID:            latestCrawlTask.ID,
			Status:        latestCrawlTask.Status,
			LastError:     latestCrawlTask.LastError,
			LastRunAt:     isoMillisPtr(latestCrawlTask.LastRunAt),
			LastSuccessAt: isoMillisPtr(latestCrawlTask.LastSuccessAt),
			LastResultAt:  isoMillisPtr(latestCrawlTask.LastResultAt),
		}
	}

	since := s.now().Add(-time.Duration(backpressureLookbackMs) * time.Millisecond)
	recentJobs, err := s.repo.RecentJobStats(ctx, orgID, sourceID, since)
	if err != nil {
		return summary, err
	}
	summary.Stats24h = buildStats24h(recentJobs)

	latestJobJSON := json.RawMessage("null")
	if summary.LatestJob != nil {
		latestJobJSON = mustJSON(summary.LatestJob)
	}
	latestCrawlTaskJSON := json.RawMessage("null")
	if summary.LatestCrawlTask != nil {
		latestCrawlTaskJSON = mustJSON(summary.LatestCrawlTask)
	}
	latestArticleJSON := json.RawMessage("null")
	if summary.LatestArticle != nil {
		latestArticleJSON = mustJSON(summary.LatestArticle)
	}
	statsJSON := mustJSON(summary.Stats24h)
	if err := s.repo.UpsertOpsSnapshot(ctx, orgID, sourceID, latestJobJSON, latestCrawlTaskJSON, latestArticleJSON, statsJSON, s.now().UTC().Truncate(time.Millisecond)); err != nil {
		return summary, err
	}
	return summary, nil
}

// RefreshSnapshotsForSources is refreshSnapshotsForSources: unique non-empty
// ids, refreshed one by one.
func (s *Service) RefreshSnapshotsForSources(ctx context.Context, orgID string, sourceIDs []string) error {
	seen := map[string]bool{}
	for _, sourceID := range sourceIDs {
		trimmed := trimJS(sourceID)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		if _, err := s.RefreshSnapshotForSource(ctx, orgID, trimmed); err != nil {
			return err
		}
	}
	return nil
}

// readRuntimeState is readRuntimeState.
func (s *Service) readRuntimeState(ctx context.Context, sourceID string) (listRuntimeState, error) {
	var raw json.RawMessage
	ok, err := s.cacheGetJSON(ctx, listRuntimeKey(sourceID), &raw)
	if err != nil {
		return emptyListRuntimeState(), err
	}
	if !ok {
		return emptyListRuntimeState(), nil
	}
	return normalizeListRuntimeState(raw, s.now()), nil
}

// writeRuntimeState is writeRuntimeState: the hit history is pruned and the
// whole value is rewritten with the 30-day TTL.
func (s *Service) writeRuntimeState(ctx context.Context, sourceID string, state listRuntimeState) error {
	state.BackpressureHitTimes = pruneHitTimestamps(state.BackpressureHitTimes, s.now())
	return s.cacheSetJSON(ctx, listRuntimeKey(sourceID), state, time.Duration(runtimeStateTTLSeconds)*time.Second)
}

// normalizeListRuntimeState is normalizeRuntimeState.
func normalizeListRuntimeState(raw json.RawMessage, now time.Time) listRuntimeState {
	state := emptyListRuntimeState()
	var record map[string]json.RawMessage
	if err := json.Unmarshal(raw, &record); err != nil {
		return state
	}
	if value, ok := readInt(record["crawlTaskQueuedCount"]); ok {
		state.CrawlTaskQueuedCount = maxIntValue(0, value)
	}
	if value, ok := readInt(record["crawlTaskRunningCount"]); ok {
		state.CrawlTaskRunningCount = maxIntValue(0, value)
	}
	if value, ok := readString(record["backpressureUntil"]); ok {
		state.BackpressureUntil = &value
	}
	if value, ok := readNumber(record["backpressurePendingJobs"]); ok {
		normalized := int(value)
		state.BackpressurePendingJobs = &normalized
	}
	if value, ok := readNumber(record["backpressureThreshold"]); ok {
		normalized := int(value)
		state.BackpressureThreshold = &normalized
	}
	if values, ok := readStringList(record["backpressureHitTimestamps"]); ok {
		state.BackpressureHitTimes = pruneHitTimestamps(values, now)
	}
	if rawState, present := record["rssAdaptiveState"]; present && string(rawState) != "null" {
		var parsed rssAdaptiveRuntimeState
		if err := json.Unmarshal(rawState, &parsed); err == nil {
			state.RSSAdaptiveState = normalizeRSSAdaptiveRuntime(&parsed)
		}
	}
	return state
}

// normalizeRSSAdaptiveRuntime is normalizeRssAdaptiveState.
func normalizeRSSAdaptiveRuntime(value *rssAdaptiveRuntimeState) *rssAdaptiveRuntimeState {
	if value == nil {
		return nil
	}
	outcomes := make([]bool, 0, len(value.Outcomes))
	outcomes = append(outcomes, value.Outcomes...)
	if len(outcomes) > rssAdaptiveHistorySize {
		outcomes = outcomes[len(outcomes)-rssAdaptiveHistorySize:]
	}
	consecutive := value.ConsecutiveNoHit
	if consecutive < 0 {
		consecutive = 0
	}
	updatedAt := value.UpdatedAt
	if updatedAt == "" {
		updatedAt = isoMillis(time.Unix(0, 0))
	}
	if len(outcomes) == 0 && consecutive <= 0 && updatedAt == isoMillis(time.Unix(0, 0)) {
		return nil
	}
	return &rssAdaptiveRuntimeState{
		Outcomes:         outcomes,
		ConsecutiveNoHit: consecutive,
		UpdatedAt:        updatedAt,
	}
}

// normalizeRSSAdaptiveState is normalizeRssAdaptiveState of the scheduler
// state (same shape, without the null collapse).
func normalizeRSSAdaptiveState(value rssAdaptiveState) rssAdaptiveState {
	outcomes := make([]bool, 0, len(value.Outcomes))
	outcomes = append(outcomes, value.Outcomes...)
	if len(outcomes) > rssAdaptiveHistorySize {
		outcomes = outcomes[len(outcomes)-rssAdaptiveHistorySize:]
	}
	consecutive := value.ConsecutiveNoHit
	if consecutive < 0 {
		consecutive = 0
	}
	updatedAt := value.UpdatedAt
	if updatedAt == "" {
		updatedAt = isoMillis(time.Unix(0, 0))
	}
	return rssAdaptiveState{Outcomes: outcomes, ConsecutiveNoHit: consecutive, UpdatedAt: updatedAt}
}

// pruneHitTimestamps keeps the parseable timestamps inside the 24h lookback.
func pruneHitTimestamps(values []string, now time.Time) []string {
	cutoff := now.UnixMilli() - backpressureLookbackMs
	out := make([]string, 0, len(values))
	for _, value := range values {
		parsed, ok := parseISOTime(value)
		if !ok {
			continue
		}
		if parsed.UnixMilli() >= cutoff {
			out = append(out, value)
		}
	}
	return out
}

// buildStats24h is buildStats24h.
func buildStats24h(jobs []recentJobStat) stats24hDocument {
	completed := 0
	failed := 0
	durationSumMs := 0.0
	durationCount := 0
	for _, job := range jobs {
		switch job.Status {
		case "completed":
			completed++
		case "failed":
			failed++
		}
		if job.StartedAt != nil && job.CompletedAt != nil {
			durationSumMs += float64(job.CompletedAt.UnixMilli() - job.StartedAt.UnixMilli())
			durationCount++
		}
	}
	stats := stats24hDocument{Completed: completed, Failed: failed}
	totalFinished := completed + failed
	if totalFinished > 0 {
		rate := float64(completed) / float64(totalFinished)
		stats.SuccessRate = &rate
	}
	if durationCount > 0 {
		average := durationSumMs / float64(durationCount)
		stats.AvgDurationMs = &average
	}
	return stats
}

// extractCrawlTaskID reads metadata.crawlTaskId.
func extractCrawlTaskID(job *latestJobSnapshot) string {
	if job == nil || len(job.Metadata) == 0 {
		return ""
	}
	object, ok := decodeObject(job.Metadata)
	if !ok {
		return ""
	}
	value, ok := object.stringField("crawlTaskId")
	if !ok {
		return ""
	}
	return value
}

// normalizePlainRecord is normalizePlainRecord: an object or JSON null.
func normalizePlainRecord(raw json.RawMessage) json.RawMessage {
	trimmed := trimJS(string(raw))
	if trimmed == "" || trimmed == "null" {
		return json.RawMessage("null")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(trimmed)
}

// readInt reads an integer JSON number.
func readInt(raw json.RawMessage) (int, bool) {
	value, ok := readNumber(raw)
	if !ok {
		return 0, false
	}
	return int(value), true
}

// readNumber reads a finite JSON number.
func readNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// readString reads a non-empty JSON string.
func readString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" {
		return "", false
	}
	return value, true
}

// readStringList reads a JSON array of strings.
func readStringList(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		text, ok := readString(value)
		if !ok {
			continue
		}
		out = append(out, text)
	}
	return out, true
}
