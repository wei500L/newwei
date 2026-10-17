package crawlreadtelemetry

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Crawl quality snapshot constants mirror CrawlQualityMetricsService and
// CrawlQualityTaskSnapshotService.
const (
	// crawlQualityMetricsScope is ObservabilitySnapshotScope.crawl_quality_metrics.
	crawlQualityMetricsScope = "crawl_quality_metrics"
	// crawlQualitySnapshotTTLSeconds is the 60 second snapshot TTL.
	crawlQualitySnapshotTTLSeconds = 60
	// crawlQualityDefaultLookbackHours is the controller fallback (parseInt "24").
	crawlQualityDefaultLookbackHours = 24
	// crawlQualityMaxLookbackHours is 24 * 14 from the service clamp.
	crawlQualityMaxLookbackHours = 24 * 14
	// crawlQualityRefreshBatchSize is REFRESH_BATCH_SIZE.
	crawlQualityRefreshBatchSize = 200
	// crawlQualitySnapshotUpsertColumnCount is the number of bound columns of
	// one CrawlQualityTaskSnapshot upsert row (identity, 24 counters and two
	// timestamps).
	crawlQualitySnapshotUpsertColumnCount = 32
)

// crawlQualityActiveTaskRefreshMaxAge is ACTIVE_TASK_REFRESH_MAX_AGE_MS: an
// active task whose snapshot is older than five minutes is rolled again.
const crawlQualityActiveTaskRefreshMaxAge = 5 * time.Minute

// Alert rule values used by resolveQualityAlertThresholds: the metric slugs it
// inspects, the operators it prefers per metric and the Prisma enum literals.
const (
	crawlQualityPreflightFailureRateSlug = "crawl_quality.preflight_failure_rate"
	crawlQualityHTTP304HitRateSlug       = "crawl_quality.http_304_hit_rate"
	crawlQualityOrgHashDedupeHitRateSlug = "crawl_quality.org_hash_dedupe_hit_rate"

	crawlQualityAlertOperatorGT  = "gt"
	crawlQualityAlertOperatorGTE = "gte"
	crawlQualityAlertOperatorLT  = "lt"
	crawlQualityAlertOperatorLTE = "lte"

	crawlQualityAlertStatusActive      = "active"
	crawlQualityAlertProviderCrawlTask = "crawl_task"
)

// crawlQualityDefaultAlertThresholds mirrors
// DEFAULT_CRAWL_QUALITY_ALERT_THRESHOLDS.
var crawlQualityDefaultAlertThresholds = CrawlQualityAlertThresholds{
	PreflightFailureRateHigh: 0.15,
	HTTP304HitRateLow:        0.05,
	OrgHashDedupeHitRateHigh: 0.3,
}

// crawlQualityNewsSourcePattern is the /^NewsSource:([^:]+):/ fallback of
// normalizeCrawlQualitySourceId.
var crawlQualityNewsSourcePattern = regexp.MustCompile(`^NewsSource:([^:]+):`)

// crawlQualityWindowTaskRow is one CrawlTask of the lookback window: the
// id/status/updatedAt triple buildSnapshot selects.
type crawlQualityWindowTaskRow struct {
	ID        string
	Status    string
	UpdatedAt time.Time
}

// crawlQualityRefreshTaskRow is one CrawlTask read by refreshSnapshotBatch: the
// identity fields needed to normalize the source id and the two timestamps
// written into the snapshot row.
type crawlQualityRefreshTaskRow struct {
	ID           string
	OrgID        string
	NewsSourceID *string
	DisplayName  *string
	Config       []byte
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// crawlQualityAlertRuleRow is one AlertRule contributing a threshold override.
type crawlQualityAlertRuleRow struct {
	MetricSlug string
	Operator   string
	// Threshold is the parsed Decimal(38,12); a malformed value is NaN so the
	// caller keeps the default, matching Number(decimal).
	Threshold float64
}

// crawlQualityMetricsAggregates mirrors CrawlQualityMetricsAggregates: the
// aggregate block of the snapshot without orgId / from / to / alertThresholds.
type crawlQualityMetricsAggregates struct {
	TaskCount                     int
	SampleCounts                  CrawlQualitySampleCounts
	LowSignalRatio                float64
	EmptyMarkdownRate             float64
	ExpansionTriggerRate          float64
	ExpansionSuccessRate          float64
	AvgMarkdownChars              int
	CandidateRejects              CrawlQualityRejectBreakdown
	PublishConfidenceBuckets      CrawlQualityConfidenceBuckets
	FitMarkdownPreferenceRate     float64
	HeadSignalSuccessRate         float64
	HeadSignalSoftFailureRate     float64
	HeadSignalTruncatedRate       float64
	HeadSignalNoPublishSignalRate float64
	HTTP304HitRate                float64
	OrgHashDedupeHitRate          float64
	PreflightFailureRate          float64
	GroupedBySource               []CrawlQualityMetricsSourceSnapshot
}

// serveQualityOverview serves GET /api/admin/crawl4ai/quality. It enforces
// crawl.read and writes the stored snapshot payload byte for byte.
func (h *Handler) serveQualityOverview(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.qualitySnapshotJSON(r.Context(), identity.OrgID, qualityLookbackHours(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONBody(w, http.StatusOK, payload)
}

// serveQualitySource serves GET /api/admin/crawl4ai/quality/sources/:sourceId.
// It reuses the overview snapshot and mirrors getSourceSnapshot: the aggregate
// fields are replaced by the single matching source entry, or zeroed when the
// source has no row in the window.
func (h *Handler) serveQualitySource(w http.ResponseWriter, r *http.Request, sourceID string) {
	identity := h.authorize(w, r, permissionCrawlRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.qualitySnapshotJSON(r.Context(), identity.OrgID, qualityLookbackHours(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	var snapshot CrawlQualityMetricsSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		writeServiceError(w, r, fmt.Errorf("crawl read telemetry: decoding crawl quality snapshot: %w", err))
		return
	}
	projected, err := json.Marshal(crawlQualitySourceProjection(snapshot, sourceID))
	if err != nil {
		writeServiceError(w, r, fmt.Errorf("crawl read telemetry: encoding crawl quality source snapshot: %w", err))
		return
	}
	writeJSONBody(w, http.StatusOK, projected)
}

// qualityLookbackHours mirrors the controller: Number.parseInt(raw ?? "24", 10)
// and a non-finite result becomes 24. querySingle reports an absent or repeated
// parameter as "not given", which the controller also sees as undefined. The
// service clamp is applied here so both handlers share one entry point.
func qualityLookbackHours(r *http.Request) int {
	raw, ok := querySingle(r, "lookbackHours")
	if !ok || raw == "" {
		return crawlQualityDefaultLookbackHours
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return crawlQualityDefaultLookbackHours
	}
	return clampQualityLookbackHours(int(parsed))
}

// clampQualityLookbackHours mirrors Math.max(1, Math.min(24 * 14, Math.floor(h))).
// The input is already an integer, so Math.floor is the identity.
func clampQualityLookbackHours(hours int) int {
	if hours < 1 {
		return 1
	}
	if hours > crawlQualityMaxLookbackHours {
		return crawlQualityMaxLookbackHours
	}
	return hours
}

// crawlQualitySourceProjection mirrors getSourceSnapshot: the first (and, since
// SQL groups by sourceId, only) entry of the requested source replaces every
// aggregate field, otherwise the base snapshot is zeroed and keeps orgId /
// from / to / alertThresholds. An empty GroupedBySource is non-nil so it
// serializes as [] like Nest.
func crawlQualitySourceProjection(snapshot CrawlQualityMetricsSnapshot, sourceID string) CrawlQualityMetricsSnapshot {
	for _, entry := range snapshot.GroupedBySource {
		if entry.SourceID != sourceID {
			continue
		}
		return CrawlQualityMetricsSnapshot{
			OrgID:                         snapshot.OrgID,
			From:                          snapshot.From,
			To:                            snapshot.To,
			TaskCount:                     entry.TaskCount,
			SampleCounts:                  entry.SampleCounts,
			LowSignalRatio:                entry.LowSignalRatio,
			EmptyMarkdownRate:             entry.EmptyMarkdownRate,
			ExpansionTriggerRate:          entry.ExpansionTriggerRate,
			ExpansionSuccessRate:          entry.ExpansionSuccessRate,
			AvgMarkdownChars:              entry.AvgMarkdownChars,
			CandidateRejects:              entry.CandidateRejects,
			PublishConfidenceBuckets:      entry.PublishConfidenceBuckets,
			FitMarkdownPreferenceRate:     entry.FitMarkdownPreferenceRate,
			HeadSignalSuccessRate:         entry.HeadSignalSuccessRate,
			HeadSignalSoftFailureRate:     entry.HeadSignalSoftFailureRate,
			HeadSignalTruncatedRate:       entry.HeadSignalTruncatedRate,
			HeadSignalNoPublishSignalRate: entry.HeadSignalNoPublishSignalRate,
			HTTP304HitRate:                entry.HTTP304HitRate,
			OrgHashDedupeHitRate:          entry.OrgHashDedupeHitRate,
			PreflightFailureRate:          entry.PreflightFailureRate,
			GroupedBySource:               []CrawlQualityMetricsSourceSnapshot{entry},
			AlertThresholds:               snapshot.AlertThresholds,
		}
	}

	return CrawlQualityMetricsSnapshot{
		OrgID:                         snapshot.OrgID,
		From:                          snapshot.From,
		To:                            snapshot.To,
		TaskCount:                     0,
		SampleCounts:                  emptyCrawlQualitySampleCounts(),
		LowSignalRatio:                0,
		EmptyMarkdownRate:             0,
		ExpansionTriggerRate:          0,
		ExpansionSuccessRate:          0,
		AvgMarkdownChars:              0,
		CandidateRejects:              emptyCrawlQualityRejectBreakdown(),
		PublishConfidenceBuckets:      emptyCrawlQualityConfidenceBuckets(),
		FitMarkdownPreferenceRate:     0,
		HeadSignalSuccessRate:         0,
		HeadSignalSoftFailureRate:     0,
		HeadSignalTruncatedRate:       0,
		HeadSignalNoPublishSignalRate: 0,
		HTTP304HitRate:                0,
		OrgHashDedupeHitRate:          0,
		PreflightFailureRate:          0,
		GroupedBySource:               []CrawlQualityMetricsSourceSnapshot{},
		AlertThresholds:               snapshot.AlertThresholds,
	}
}

// qualitySnapshotJSON mirrors getSnapshot: it clamps the lookback hours and
// returns the raw JSON of the crawl_quality_metrics snapshot, rebuilding it
// through the loader when the 60 second snapshot row is missing or expired.
// The loader returns already-marshaled bytes, so the store never sees an
// untyped container.
func (s *Service) qualitySnapshotJSON(ctx context.Context, orgID string, lookbackHours int) ([]byte, error) {
	safeHours := clampQualityLookbackHours(lookbackHours)
	store := snapshotStore{db: s.db, redis: s.redis}
	return store.getOrCreateJSON(ctx, orgID, crawlQualityMetricsScope,
		"lookbackHours:"+strconv.Itoa(safeHours), crawlQualitySnapshotTTLSeconds,
		func() ([]byte, error) {
			snapshot, err := s.buildQualitySnapshot(ctx, orgID, safeHours)
			if err != nil {
				return nil, err
			}
			return json.Marshal(snapshot)
		},
	)
}

// buildQualitySnapshot mirrors buildSnapshot: the window is [now - hours, now],
// the alert thresholds are resolved first, and a window holding no CrawlTask
// row short-circuits to the empty snapshot.
func (s *Service) buildQualitySnapshot(ctx context.Context, orgID string, safeHours int) (CrawlQualityMetricsSnapshot, error) {
	to := time.Now()
	from := to.Add(-time.Duration(safeHours) * time.Hour)

	alertThresholds, err := s.resolveQualityAlertThresholds(ctx, orgID)
	if err != nil {
		return CrawlQualityMetricsSnapshot{}, err
	}

	tasks, err := s.listQualityWindowTasks(ctx, orgID, from, to)
	if err != nil {
		return CrawlQualityMetricsSnapshot{}, err
	}
	if len(tasks) == 0 {
		return buildEmptyCrawlQualitySnapshot(orgID, from, to, alertThresholds), nil
	}

	if err := s.ensureSnapshotsForWindow(ctx, orgID, from, to, tasks, to); err != nil {
		return CrawlQualityMetricsSnapshot{}, err
	}
	aggregates, err := s.readQualityAggregates(ctx, orgID, from, to)
	if err != nil {
		return CrawlQualityMetricsSnapshot{}, err
	}

	return CrawlQualityMetricsSnapshot{
		OrgID:                         orgID,
		From:                          JSTime{Time: from},
		To:                            JSTime{Time: to},
		TaskCount:                     aggregates.TaskCount,
		SampleCounts:                  aggregates.SampleCounts,
		LowSignalRatio:                aggregates.LowSignalRatio,
		EmptyMarkdownRate:             aggregates.EmptyMarkdownRate,
		ExpansionTriggerRate:          aggregates.ExpansionTriggerRate,
		ExpansionSuccessRate:          aggregates.ExpansionSuccessRate,
		AvgMarkdownChars:              aggregates.AvgMarkdownChars,
		CandidateRejects:              aggregates.CandidateRejects,
		PublishConfidenceBuckets:      aggregates.PublishConfidenceBuckets,
		FitMarkdownPreferenceRate:     aggregates.FitMarkdownPreferenceRate,
		HeadSignalSuccessRate:         aggregates.HeadSignalSuccessRate,
		HeadSignalSoftFailureRate:     aggregates.HeadSignalSoftFailureRate,
		HeadSignalTruncatedRate:       aggregates.HeadSignalTruncatedRate,
		HeadSignalNoPublishSignalRate: aggregates.HeadSignalNoPublishSignalRate,
		HTTP304HitRate:                aggregates.HTTP304HitRate,
		OrgHashDedupeHitRate:          aggregates.OrgHashDedupeHitRate,
		PreflightFailureRate:          aggregates.PreflightFailureRate,
		GroupedBySource:               aggregates.GroupedBySource,
		AlertThresholds:               alertThresholds,
	}, nil
}

// buildEmptyCrawlQualitySnapshot mirrors buildEmptySnapshot: every counter and
// rate is zero, thresholds are still resolved from AlertRule.
func buildEmptyCrawlQualitySnapshot(
	orgID string,
	from, to time.Time,
	alertThresholds CrawlQualityAlertThresholds,
) CrawlQualityMetricsSnapshot {
	return CrawlQualityMetricsSnapshot{
		OrgID:                         orgID,
		From:                          JSTime{Time: from},
		To:                            JSTime{Time: to},
		TaskCount:                     0,
		SampleCounts:                  emptyCrawlQualitySampleCounts(),
		LowSignalRatio:                0,
		EmptyMarkdownRate:             0,
		ExpansionTriggerRate:          0,
		ExpansionSuccessRate:          0,
		AvgMarkdownChars:              0,
		CandidateRejects:              emptyCrawlQualityRejectBreakdown(),
		PublishConfidenceBuckets:      emptyCrawlQualityConfidenceBuckets(),
		FitMarkdownPreferenceRate:     0,
		HeadSignalSuccessRate:         0,
		HeadSignalSoftFailureRate:     0,
		HeadSignalTruncatedRate:       0,
		HeadSignalNoPublishSignalRate: 0,
		HTTP304HitRate:                0,
		OrgHashDedupeHitRate:          0,
		PreflightFailureRate:          0,
		GroupedBySource:               []CrawlQualityMetricsSourceSnapshot{},
		AlertThresholds:               alertThresholds,
	}
}

// resolveQualityAlertThresholds mirrors resolveAlertThresholds: defaults are
// overridden by the newest active crawl_task rule per metric slug, preferring
// the operator that matches the alert direction.
func (s *Service) resolveQualityAlertThresholds(ctx context.Context, orgID string) (CrawlQualityAlertThresholds, error) {
	thresholds := crawlQualityDefaultAlertThresholds
	if s == nil || s.db == nil {
		return thresholds, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}

	rows, err := s.db.QueryContext(ctx,
		"SELECT `metricSlug`, `operator`, `thresholdValue` FROM `AlertRule`"+
			" WHERE `orgId` = ? AND `status` = ? AND `metricProvider` = ?"+
			" AND `metricSlug` IN (?, ?, ?) AND `thresholdValue` IS NOT NULL"+
			" ORDER BY `updatedAt` DESC",
		orgID,
		crawlQualityAlertStatusActive,
		crawlQualityAlertProviderCrawlTask,
		crawlQualityPreflightFailureRateSlug,
		crawlQualityHTTP304HitRateSlug,
		crawlQualityOrgHashDedupeHitRateSlug,
	)
	if err != nil {
		return thresholds, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	rules := make([]crawlQualityAlertRuleRow, 0, 3)
	for rows.Next() {
		var metricSlug, operator string
		var thresholdValue sql.NullString
		if err := rows.Scan(&metricSlug, &operator, &thresholdValue); err != nil {
			return thresholds, fmt.Errorf("%w: %v", errDatabase, err)
		}
		rules = append(rules, crawlQualityAlertRuleRow{
			MetricSlug: metricSlug,
			Operator:   operator,
			Threshold:  parseCrawlQualityThreshold(thresholdValue),
		})
	}
	if err := rows.Err(); err != nil {
		return thresholds, fmt.Errorf("%w: %v", errDatabase, err)
	}

	if value, ok := pickCrawlQualityThreshold(rules, crawlQualityPreflightFailureRateSlug,
		[]string{crawlQualityAlertOperatorGTE, crawlQualityAlertOperatorGT}); ok && isFiniteCrawlQualityValue(value) {
		thresholds.PreflightFailureRateHigh = math.Max(0, value)
	}
	if value, ok := pickCrawlQualityThreshold(rules, crawlQualityHTTP304HitRateSlug,
		[]string{crawlQualityAlertOperatorLTE, crawlQualityAlertOperatorLT}); ok && isFiniteCrawlQualityValue(value) {
		thresholds.HTTP304HitRateLow = math.Max(0, value)
	}
	if value, ok := pickCrawlQualityThreshold(rules, crawlQualityOrgHashDedupeHitRateSlug,
		[]string{crawlQualityAlertOperatorGTE, crawlQualityAlertOperatorGT}); ok && isFiniteCrawlQualityValue(value) {
		thresholds.OrgHashDedupeHitRateHigh = math.Max(0, value)
	}
	return thresholds, nil
}

// parseCrawlQualityThreshold mirrors Number(decimal): a NULL or malformed value
// becomes NaN so the caller keeps the default threshold.
func parseCrawlQualityThreshold(value sql.NullString) float64 {
	if !value.Valid {
		return math.NaN()
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value.String), 64)
	if err != nil {
		return math.NaN()
	}
	return parsed
}

// pickCrawlQualityThreshold mirrors pickThreshold: the newest rule for the slug
// whose operator is allowed wins, otherwise the newest rule for the slug. The
// rules slice is already ordered by updatedAt DESC.
func pickCrawlQualityThreshold(rules []crawlQualityAlertRuleRow, metricSlug string, allowedOperators []string) (float64, bool) {
	for _, rule := range rules {
		if rule.MetricSlug == metricSlug && slices.Contains(allowedOperators, rule.Operator) {
			return rule.Threshold, true
		}
	}
	for _, rule := range rules {
		if rule.MetricSlug == metricSlug {
			return rule.Threshold, true
		}
	}
	return 0, false
}

// isFiniteCrawlQualityValue mirrors Number.isFinite.
func isFiniteCrawlQualityValue(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// listQualityWindowTasks mirrors the buildSnapshot CrawlTask.findMany: only id,
// status and updatedAt are selected for the org and the [from, to] window.
func (s *Service) listQualityWindowTasks(ctx context.Context, orgID string, from, to time.Time) ([]crawlQualityWindowTaskRow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `status`, `updatedAt` FROM `CrawlTask`"+
			" WHERE `orgId` = ? AND `createdAt` >= ? AND `createdAt` <= ?",
		orgID, from, to,
	)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	tasks := make([]crawlQualityWindowTaskRow, 0, 16)
	for rows.Next() {
		var task crawlQualityWindowTaskRow
		if err := rows.Scan(&task.ID, &task.Status, &task.UpdatedAt); err != nil {
			return nil, fmt.Errorf("%w: %v", errDatabase, err)
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return tasks, nil
}

// ensureSnapshotsForWindow mirrors ensureSnapshotsForWindow: a task is stale
// when it has no snapshot row, when its stored taskUpdatedAt is older than the
// live updatedAt, or when it is still pending/queued/running and its snapshot
// was rolled more than five minutes ago.
func (s *Service) ensureSnapshotsForWindow(
	ctx context.Context,
	orgID string,
	from, to time.Time,
	tasks []crawlQualityWindowTaskRow,
	now time.Time,
) error {
	if len(tasks) == 0 {
		return nil
	}
	if s == nil || s.db == nil {
		return fmt.Errorf("%w: mysql is not configured", errDatabase)
	}

	rows, err := s.db.QueryContext(ctx,
		"SELECT `taskId`, `taskUpdatedAt`, `rolledAt` FROM `CrawlQualityTaskSnapshot`"+
			" WHERE `orgId` = ? AND `taskCreatedAt` >= ? AND `taskCreatedAt` <= ?",
		orgID, from, to,
	)
	if err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	snapshots := make(map[string]crawlQualitySnapshotMetadata, len(tasks))
	for rows.Next() {
		var metadata crawlQualitySnapshotMetadata
		var taskUpdatedAt, rolledAt time.Time
		if err := rows.Scan(&metadata.TaskID, &taskUpdatedAt, &rolledAt); err != nil {
			return fmt.Errorf("%w: %v", errDatabase, err)
		}
		metadata.TaskUpdatedAt = JSTime{Time: taskUpdatedAt}
		metadata.RolledAt = JSTime{Time: rolledAt}
		snapshots[metadata.TaskID] = metadata
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}

	activeRefreshCutoff := now.Add(-crawlQualityActiveTaskRefreshMaxAge)
	staleTaskIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		metadata, ok := snapshots[task.ID]
		if !ok {
			staleTaskIDs = append(staleTaskIDs, task.ID)
			continue
		}
		if metadata.TaskUpdatedAt.Time.Before(task.UpdatedAt) {
			staleTaskIDs = append(staleTaskIDs, task.ID)
			continue
		}
		// The rolling-aggregation gate: a task that is still being processed
		// keeps producing task logs, so its snapshot is re-rolled even when the
		// updatedAt comparison says it is fresh.
		if isCrawlQualityActiveTaskStatus(task.Status) && metadata.RolledAt.Time.Before(activeRefreshCutoff) {
			staleTaskIDs = append(staleTaskIDs, task.ID)
		}
	}

	if len(staleTaskIDs) == 0 {
		return nil
	}
	return s.refreshSnapshotsForTaskIDs(ctx, orgID, staleTaskIDs)
}

// isCrawlQualityActiveTaskStatus mirrors ACTIVE_TASK_STATUSES.
func isCrawlQualityActiveTaskStatus(status string) bool {
	switch CrawlTaskStatus(status) {
	case CrawlTaskStatusPending, CrawlTaskStatusQueued, CrawlTaskStatusRunning:
		return true
	default:
		return false
	}
}

// readQualityAggregates mirrors readAggregates: the overall row and the
// per-source rows, with the grouped rows keeping the SQL taskCount DESC order.
func (s *Service) readQualityAggregates(ctx context.Context, orgID string, from, to time.Time) (crawlQualityMetricsAggregates, error) {
	overallRows, err := s.queryOverallAggregate(ctx, orgID, from, to)
	if err != nil {
		return crawlQualityMetricsAggregates{}, err
	}
	groupedRows, err := s.queryGroupedAggregates(ctx, orgID, from, to)
	if err != nil {
		return crawlQualityMetricsAggregates{}, err
	}

	aggregates := s.buildAggregateMetrics(overallRows)
	groupedBySource := make([]CrawlQualityMetricsSourceSnapshot, 0, len(groupedRows))
	for index := range groupedRows {
		groupedBySource = append(groupedBySource, s.buildGroupedMetrics(groupedRows[index]))
	}
	aggregates.GroupedBySource = groupedBySource
	return aggregates, nil
}

// refreshSnapshotsForTaskIDs mirrors refreshSnapshotsForTaskIds: blank ids are
// dropped, duplicates collapse (first occurrence wins) and the remainder is
// rolled in batches of 200.
func (s *Service) refreshSnapshotsForTaskIDs(ctx context.Context, orgID string, taskIDs []string) error {
	seen := make(map[string]bool, len(taskIDs))
	uniqueTaskIDs := make([]string, 0, len(taskIDs))
	for _, taskID := range taskIDs {
		if strings.TrimSpace(taskID) == "" || seen[taskID] {
			continue
		}
		seen[taskID] = true
		uniqueTaskIDs = append(uniqueTaskIDs, taskID)
	}
	if len(uniqueTaskIDs) == 0 {
		return nil
	}

	for index := 0; index < len(uniqueTaskIDs); index += crawlQualityRefreshBatchSize {
		end := index + crawlQualityRefreshBatchSize
		if end > len(uniqueTaskIDs) {
			end = len(uniqueTaskIDs)
		}
		if err := s.refreshQualitySnapshotBatch(ctx, orgID, uniqueTaskIDs[index:end]); err != nil {
			return err
		}
	}
	return nil
}

// refreshQualitySnapshotBatch mirrors refreshSnapshotBatch: the live CrawlTask
// rows of the batch are re-read, the four tasklogs / crawlresultcontents
// aggregations are computed over those exact ids and the resulting rows are
// upserted. Nest runs the four aggregations in parallel; this unit runs them
// sequentially, which only changes latency.
func (s *Service) refreshQualitySnapshotBatch(ctx context.Context, orgID string, taskIDs []string) error {
	tasks, err := s.listQualityRefreshTasks(ctx, orgID, taskIDs)
	if err != nil {
		return err
	}
	if len(tasks) == 0 {
		return nil
	}

	existingTaskIDs := make([]string, 0, len(tasks))
	for _, task := range tasks {
		existingTaskIDs = append(existingTaskIDs, task.ID)
	}

	expansionRows, err := s.aggregateExpansionRows(ctx, orgID, existingTaskIDs)
	if err != nil {
		return err
	}
	preflightRows, err := s.aggregatePreflightRows(ctx, orgID, existingTaskIDs)
	if err != nil {
		return err
	}
	dedupeRows, err := s.aggregateDedupeRows(ctx, orgID, existingTaskIDs)
	if err != nil {
		return err
	}
	markdownRows, err := s.aggregateMarkdownRows(ctx, orgID, existingTaskIDs)
	if err != nil {
		return err
	}

	rows := buildCrawlQualityTaskSnapshotRows(tasks, expansionRows, preflightRows, dedupeRows, markdownRows, time.Now())
	return s.upsertQualitySnapshotRows(ctx, rows)
}

// listQualityRefreshTasks mirrors the refreshSnapshotBatch CrawlTask.findMany
// with id: { in: taskIds }.
func (s *Service) listQualityRefreshTasks(ctx context.Context, orgID string, taskIDs []string) ([]crawlQualityRefreshTaskRow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	if len(taskIDs) == 0 {
		return []crawlQualityRefreshTaskRow{}, nil
	}

	// FIND_IN_SET keeps the whole id list a single bound parameter: the ids are
	// Prisma cuids, so no value can contain a comma, and no identifier is
	// interpolated into the SQL text.
	joinedTaskIDs := strings.Join(taskIDs, ",")
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `orgId`, `newsSourceId`, `displayName`, `config`, `createdAt`, `updatedAt`"+
			" FROM `CrawlTask` WHERE `orgId` = ? AND FIND_IN_SET(`id`, ?)",
		orgID, joinedTaskIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	tasks := make([]crawlQualityRefreshTaskRow, 0, len(taskIDs))
	for rows.Next() {
		var task crawlQualityRefreshTaskRow
		var newsSourceID, displayName sql.NullString
		if err := rows.Scan(&task.ID, &task.OrgID, &newsSourceID, &displayName,
			&task.Config, &task.CreatedAt, &task.UpdatedAt); err != nil {
			return nil, fmt.Errorf("%w: %v", errDatabase, err)
		}
		task.NewsSourceID = crawlQualityNullStringPointer(newsSourceID)
		task.DisplayName = crawlQualityNullStringPointer(displayName)
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return tasks, nil
}

// crawlQualityNullStringPointer converts a nullable SQL string to the pointer
// shape Prisma returns for String? columns.
func crawlQualityNullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copied := value.String
	return &copied
}

// crawlQualityPlaceholders returns n comma separated MySQL placeholders.
func crawlQualityPlaceholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.Repeat("?,", count-1) + "?"
}

// normalizeCrawlQualitySourceID mirrors normalizeCrawlQualitySourceId: the
// trimmed newsSourceId wins, then config.itemPayload.metadata.sourceId, then
// the displayName prefix, then "unknown".
func normalizeCrawlQualitySourceID(task crawlQualityRefreshTaskRow) string {
	if task.NewsSourceID != nil {
		if trimmed := strings.TrimSpace(*task.NewsSourceID); trimmed != "" {
			return trimmed
		}
	}
	if sourceID, ok := crawlQualityConfigSourceID(task.Config); ok {
		return sourceID
	}
	if task.DisplayName != nil {
		if match := crawlQualityNewsSourcePattern.FindStringSubmatch(*task.DisplayName); len(match) > 1 {
			return match[1]
		}
	}
	return "unknown"
}

// crawlQualityConfigSourceID mirrors the itemPayload.metadata.sourceId branch of
// normalizeCrawlQualitySourceId. The config is decoded with
// map[string]json.RawMessage so the nested object lookup stays strongly typed:
// a non-object payload, a missing key or a non-string sourceId all report
// "not usable" and the caller falls through to the displayName pattern.
func crawlQualityConfigSourceID(config []byte) (string, bool) {
	trimmed := bytes.TrimSpace(config)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return "", false
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &record); err != nil {
		return "", false
	}
	itemPayloadRaw, ok := record["itemPayload"]
	if !ok {
		return "", false
	}
	var itemPayload map[string]json.RawMessage
	if err := json.Unmarshal(itemPayloadRaw, &itemPayload); err != nil {
		return "", false
	}
	metadataRaw, ok := itemPayload["metadata"]
	if !ok {
		return "", false
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		return "", false
	}
	sourceIDRaw, ok := metadata["sourceId"]
	if !ok {
		return "", false
	}
	var sourceID string
	if err := json.Unmarshal(sourceIDRaw, &sourceID); err != nil {
		return "", false
	}
	trimmedSourceID := strings.TrimSpace(sourceID)
	if trimmedSourceID == "" {
		return "", false
	}
	return trimmedSourceID, true
}

// buildCrawlQualityTaskSnapshotRows mirrors the Nest helper: every task yields
// one row whose counters start at zero and are overlaid, when present, by the
// expansion, preflight, dedupe and markdown summaries of that task.
func buildCrawlQualityTaskSnapshotRows(
	tasks []crawlQualityRefreshTaskRow,
	expansionRows []crawlQualityTaskExpansionSummary,
	preflightRows []crawlQualityTaskPreflightSummary,
	dedupeRows []crawlQualityTaskDedupeSummary,
	markdownRows []crawlQualityTaskMarkdownSummary,
	rolledAt time.Time,
) []crawlQualityTaskSnapshotRow {
	expansionByTaskID := make(map[string]crawlQualityTaskExpansionSummary, len(expansionRows))
	for _, row := range expansionRows {
		expansionByTaskID[row.TaskID] = row
	}
	preflightByTaskID := make(map[string]crawlQualityTaskPreflightSummary, len(preflightRows))
	for _, row := range preflightRows {
		preflightByTaskID[row.TaskID] = row
	}
	dedupeByTaskID := make(map[string]crawlQualityTaskDedupeSummary, len(dedupeRows))
	for _, row := range dedupeRows {
		dedupeByTaskID[row.TaskID] = row
	}
	markdownByTaskID := make(map[string]crawlQualityTaskMarkdownSummary, len(markdownRows))
	for _, row := range markdownRows {
		markdownByTaskID[row.TaskID] = row
	}

	rows := make([]crawlQualityTaskSnapshotRow, 0, len(tasks))
	for _, task := range tasks {
		row := crawlQualityTaskSnapshotRow{
			TaskID:        task.ID,
			OrgID:         task.OrgID,
			SourceID:      normalizeCrawlQualitySourceID(task),
			TaskCreatedAt: JSTime{Time: task.CreatedAt},
			TaskUpdatedAt: JSTime{Time: task.UpdatedAt},
			RolledAt:      JSTime{Time: rolledAt},
		}
		if expansion, ok := expansionByTaskID[task.ID]; ok {
			row.LowSignalTaskCount = expansion.LowSignalTaskCount
			row.ExpansionTriggeredTaskCount = expansion.ExpansionTriggeredTaskCount
			row.ExpansionImprovedTaskCount = expansion.ExpansionImprovedTaskCount
			row.CandidateRejectIncludePatternCount = expansion.CandidateRejectIncludePatternCount
			row.CandidateRejectExcludePatternCount = expansion.CandidateRejectExcludePatternCount
			row.CandidateRejectPublishConfidenceCount = expansion.CandidateRejectPublishConfidenceCount
			row.PublishConfidenceLt04Count = expansion.PublishConfidenceLt04Count
			row.PublishConfidenceFrom04To06Count = expansion.PublishConfidenceFrom04To06Count
			row.PublishConfidenceFrom06To08Count = expansion.PublishConfidenceFrom06To08Count
			row.PublishConfidenceGte08Count = expansion.PublishConfidenceGte08Count
			row.FitMarkdownPreferenceTaskCount = expansion.FitMarkdownPreferenceTaskCount
			row.HeadSignalAttemptedCount = expansion.HeadSignalAttemptedCount
			row.HeadSignalSucceededCount = expansion.HeadSignalSucceededCount
			row.HeadSignalSoftFailureCount = expansion.HeadSignalSoftFailureCount
			row.HeadSignalTruncatedCount = expansion.HeadSignalTruncatedCount
			row.HeadSignalNoPublishSignalCount = expansion.HeadSignalNoPublishSignalCount
		}
		if preflight, ok := preflightByTaskID[task.ID]; ok {
			row.PreflightRunCount = preflight.PreflightRunCount
			row.PreflightFailureCount = preflight.PreflightFailureCount
			row.Preflight304HitCount = preflight.Preflight304HitCount
		}
		if dedupe, ok := dedupeByTaskID[task.ID]; ok {
			row.DedupeEvaluatedCount = dedupe.DedupeEvaluatedCount
			row.DedupeOrgReuseCount = dedupe.DedupeOrgReuseCount
		}
		if markdown, ok := markdownByTaskID[task.ID]; ok {
			row.MarkdownCount = markdown.MarkdownCount
			row.MarkdownCharsTotal = markdown.MarkdownCharsTotal
			row.EmptyMarkdownCount = markdown.EmptyMarkdownCount
		}
		rows = append(rows, row)
	}
	return rows
}

// requireTaskLogsCollection returns the Mongo tasklogs collection, failing
// closed when Mongo is not configured.
func (s *Service) requireTaskLogsCollection() (*mongo.Collection, error) {
	if s == nil || s.taskLogs == nil {
		return nil, fmt.Errorf("%w: mongo is not configured", errMongo)
	}
	return s.taskLogs, nil
}

// requireCrawlResultContentsCollection returns the Mongo crawlresultcontents
// collection, failing closed when Mongo is not configured.
func (s *Service) requireCrawlResultContentsCollection() (*mongo.Collection, error) {
	if s == nil || s.crawlResultContents == nil {
		return nil, fmt.Errorf("%w: mongo is not configured", errMongo)
	}
	return s.crawlResultContents, nil
}

// aggregateExpansionRows mirrors aggregateExpansionRows: the expansion stage
// logs of the given tasks, reduced to one row per task with the
// explicit-vs-inferred head-signal soft-failure choice.
func (s *Service) aggregateExpansionRows(ctx context.Context, orgID string, taskIDs []string) ([]crawlQualityTaskExpansionSummary, error) {
	collection, err := s.requireTaskLogsCollection()
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: crawlQueueName},
			{Key: "stage", Value: "expansion"},
			{Key: "jobId", Value: bson.D{{Key: "$in", Value: taskIDs}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "taskId", Value: "$jobId"},
			{Key: "improvedSuccesses", Value: toNonNegativeIntPath("$data.improvedSuccesses")},
			{Key: "lowSignalResults", Value: toNonNegativeIntPath("$data.lowSignalResults")},
			{Key: "candidateRejectIncludePatternCount", Value: toNonNegativeIntDocument(bson.D{{Key: "$ifNull", Value: bson.A{
				"$data.candidateRejects.includePatternRejected",
				"$data.candidateRejects.includePattern",
			}}})},
			{Key: "candidateRejectExcludePatternCount", Value: toNonNegativeIntDocument(bson.D{{Key: "$ifNull", Value: bson.A{
				"$data.candidateRejects.excludePatternRejected",
				"$data.candidateRejects.excludePattern",
			}}})},
			{Key: "candidateRejectPublishConfidenceCount", Value: toNonNegativeIntDocument(bson.D{{Key: "$ifNull", Value: bson.A{
				"$data.candidateRejects.publishConfidenceRejected",
				"$data.candidateRejects.publishConfidence",
			}}})},
			{Key: "publishConfidenceLt04Count", Value: toNonNegativeIntPath("$data.publishConfidenceBuckets.lt04")},
			{Key: "publishConfidenceFrom04To06Count", Value: toNonNegativeIntPath("$data.publishConfidenceBuckets.from04To06")},
			{Key: "publishConfidenceFrom06To08Count", Value: toNonNegativeIntPath("$data.publishConfidenceBuckets.from06To08")},
			{Key: "publishConfidenceGte08Count", Value: toNonNegativeIntPath("$data.publishConfidenceBuckets.gte08")},
			{Key: "fitMarkdownPreferenceTaskCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$data.detailExpansion.preferFitMarkdownForQuality", true}}},
				1,
				0,
			}}}},
			{Key: "headSignalAttemptedCount", Value: toNonNegativeIntPath("$data.headSignalEnrichment.attempted")},
			{Key: "headSignalSucceededCount", Value: toNonNegativeIntPath("$data.headSignalEnrichment.succeeded")},
			{Key: "headSignalTruncatedCount", Value: toNonNegativeIntPath("$data.headSignalEnrichment.truncatedResponses")},
			{Key: "headSignalNoPublishSignalCount", Value: toNonNegativeIntPath("$data.headSignalEnrichment.softFailures.noPublishSignal")},
			{Key: "explicitHeadSignalSoftFailureCount", Value: toNonNegativeIntPath("$data.headSignalEnrichment.softFailureCount")},
			{Key: "inferredHeadSignalSoftFailureCount", Value: bson.D{{Key: "$add", Value: bson.A{
				toNonNegativeIntPath("$data.headSignalEnrichment.softFailures.httpStatus"),
				toNonNegativeIntPath("$data.headSignalEnrichment.softFailures.nonHtml"),
				toNonNegativeIntPath("$data.headSignalEnrichment.softFailures.emptyHtml"),
				toNonNegativeIntPath("$data.headSignalEnrichment.softFailures.networkOrTimeout"),
				toNonNegativeIntPath("$data.headSignalEnrichment.softFailures.noPublishSignal"),
			}}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "taskId", Value: 1},
			{Key: "lowSignalTaskCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$gt", Value: bson.A{"$lowSignalResults", 0}}}, 1, 0,
			}}}},
			{Key: "expansionTriggeredTaskCount", Value: bson.D{{Key: "$literal", Value: 1}}},
			{Key: "expansionImprovedTaskCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$gt", Value: bson.A{"$improvedSuccesses", 0}}}, 1, 0,
			}}}},
			{Key: "candidateRejectIncludePatternCount", Value: 1},
			{Key: "candidateRejectExcludePatternCount", Value: 1},
			{Key: "candidateRejectPublishConfidenceCount", Value: 1},
			{Key: "publishConfidenceLt04Count", Value: 1},
			{Key: "publishConfidenceFrom04To06Count", Value: 1},
			{Key: "publishConfidenceFrom06To08Count", Value: 1},
			{Key: "publishConfidenceGte08Count", Value: 1},
			{Key: "fitMarkdownPreferenceTaskCount", Value: 1},
			{Key: "headSignalAttemptedCount", Value: 1},
			{Key: "headSignalSucceededCount", Value: 1},
			{Key: "headSignalSoftFailureCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$gt", Value: bson.A{"$explicitHeadSignalSoftFailureCount", 0}}},
				"$explicitHeadSignalSoftFailureCount",
				"$inferredHeadSignalSoftFailureCount",
			}}}},
			{Key: "headSignalTruncatedCount", Value: 1},
			{Key: "headSignalNoPublishSignalCount", Value: 1},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$taskId"},
			{Key: "lowSignalTaskCount", Value: bson.D{{Key: "$max", Value: "$lowSignalTaskCount"}}},
			{Key: "expansionTriggeredTaskCount", Value: bson.D{{Key: "$max", Value: "$expansionTriggeredTaskCount"}}},
			{Key: "expansionImprovedTaskCount", Value: bson.D{{Key: "$max", Value: "$expansionImprovedTaskCount"}}},
			{Key: "candidateRejectIncludePatternCount", Value: bson.D{{Key: "$max", Value: "$candidateRejectIncludePatternCount"}}},
			{Key: "candidateRejectExcludePatternCount", Value: bson.D{{Key: "$max", Value: "$candidateRejectExcludePatternCount"}}},
			{Key: "candidateRejectPublishConfidenceCount", Value: bson.D{{Key: "$max", Value: "$candidateRejectPublishConfidenceCount"}}},
			{Key: "publishConfidenceLt04Count", Value: bson.D{{Key: "$max", Value: "$publishConfidenceLt04Count"}}},
			{Key: "publishConfidenceFrom04To06Count", Value: bson.D{{Key: "$max", Value: "$publishConfidenceFrom04To06Count"}}},
			{Key: "publishConfidenceFrom06To08Count", Value: bson.D{{Key: "$max", Value: "$publishConfidenceFrom06To08Count"}}},
			{Key: "publishConfidenceGte08Count", Value: bson.D{{Key: "$max", Value: "$publishConfidenceGte08Count"}}},
			{Key: "fitMarkdownPreferenceTaskCount", Value: bson.D{{Key: "$max", Value: "$fitMarkdownPreferenceTaskCount"}}},
			{Key: "headSignalAttemptedCount", Value: bson.D{{Key: "$max", Value: "$headSignalAttemptedCount"}}},
			{Key: "headSignalSucceededCount", Value: bson.D{{Key: "$max", Value: "$headSignalSucceededCount"}}},
			{Key: "headSignalSoftFailureCount", Value: bson.D{{Key: "$max", Value: "$headSignalSoftFailureCount"}}},
			{Key: "headSignalTruncatedCount", Value: bson.D{{Key: "$max", Value: "$headSignalTruncatedCount"}}},
			{Key: "headSignalNoPublishSignalCount", Value: bson.D{{Key: "$max", Value: "$headSignalNoPublishSignalCount"}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "taskId", Value: "$_id"},
			{Key: "lowSignalTaskCount", Value: 1},
			{Key: "expansionTriggeredTaskCount", Value: 1},
			{Key: "expansionImprovedTaskCount", Value: 1},
			{Key: "candidateRejectIncludePatternCount", Value: 1},
			{Key: "candidateRejectExcludePatternCount", Value: 1},
			{Key: "candidateRejectPublishConfidenceCount", Value: 1},
			{Key: "publishConfidenceLt04Count", Value: 1},
			{Key: "publishConfidenceFrom04To06Count", Value: 1},
			{Key: "publishConfidenceFrom06To08Count", Value: 1},
			{Key: "publishConfidenceGte08Count", Value: 1},
			{Key: "fitMarkdownPreferenceTaskCount", Value: 1},
			{Key: "headSignalAttemptedCount", Value: 1},
			{Key: "headSignalSucceededCount", Value: 1},
			{Key: "headSignalSoftFailureCount", Value: 1},
			{Key: "headSignalTruncatedCount", Value: 1},
			{Key: "headSignalNoPublishSignalCount", Value: 1},
		}}},
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	defer cursor.Close(ctx)

	rows := make([]crawlQualityTaskExpansionSummary, 0, len(taskIDs))
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	return rows, nil
}

// aggregatePreflightRows mirrors aggregatePreflightRows: one row per task with
// run, failure and HTTP 304 counts.
func (s *Service) aggregatePreflightRows(ctx context.Context, orgID string, taskIDs []string) ([]crawlQualityTaskPreflightSummary, error) {
	collection, err := s.requireTaskLogsCollection()
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: crawlQueueName},
			{Key: "stage", Value: "preflight"},
			{Key: "jobId", Value: bson.D{{Key: "$in", Value: taskIDs}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "taskId", Value: "$jobId"},
			{Key: "preflightRunCount", Value: bson.D{{Key: "$literal", Value: 1}}},
			{Key: "preflightFailureCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$status", "failed"}}}, 1, 0,
			}}}},
			{Key: "preflight304HitCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{toNonNegativeIntPath("$data.status"), 304}}}, 1, 0,
			}}}},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$taskId"},
			{Key: "preflightRunCount", Value: bson.D{{Key: "$sum", Value: "$preflightRunCount"}}},
			{Key: "preflightFailureCount", Value: bson.D{{Key: "$sum", Value: "$preflightFailureCount"}}},
			{Key: "preflight304HitCount", Value: bson.D{{Key: "$sum", Value: "$preflight304HitCount"}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "taskId", Value: "$_id"},
			{Key: "preflightRunCount", Value: 1},
			{Key: "preflightFailureCount", Value: 1},
			{Key: "preflight304HitCount", Value: 1},
		}}},
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	defer cursor.Close(ctx)

	rows := make([]crawlQualityTaskPreflightSummary, 0, len(taskIDs))
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	return rows, nil
}

// aggregateDedupeRows mirrors aggregateDedupeRows: one row per task with the
// evaluated and org-reuse counts of the dedupe stage.
func (s *Service) aggregateDedupeRows(ctx context.Context, orgID string, taskIDs []string) ([]crawlQualityTaskDedupeSummary, error) {
	collection, err := s.requireTaskLogsCollection()
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "queue", Value: crawlQueueName},
			{Key: "stage", Value: "dedupe"},
			{Key: "jobId", Value: bson.D{{Key: "$in", Value: taskIDs}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "taskId", Value: "$jobId"},
			{Key: "dedupeEvaluatedCount", Value: toNonNegativeIntPath("$data.evaluatedCount")},
			{Key: "dedupeOrgReuseCount", Value: toNonNegativeIntPath("$data.orgReuseCount")},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$taskId"},
			{Key: "dedupeEvaluatedCount", Value: bson.D{{Key: "$sum", Value: "$dedupeEvaluatedCount"}}},
			{Key: "dedupeOrgReuseCount", Value: bson.D{{Key: "$sum", Value: "$dedupeOrgReuseCount"}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "taskId", Value: "$_id"},
			{Key: "dedupeEvaluatedCount", Value: 1},
			{Key: "dedupeOrgReuseCount", Value: 1},
		}}},
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	defer cursor.Close(ctx)

	rows := make([]crawlQualityTaskDedupeSummary, 0, len(taskIDs))
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	return rows, nil
}

// aggregateMarkdownRows mirrors aggregateMarkdownRows with the cross-tenant
// isolation fix: crawlresultcontents rows are matched by taskId AND by either
// the requesting orgId or a missing orgId field, so a task id owned by another
// tenant can never contribute markdown counts. The Nest original matched
// taskId only; the Go takeover closes that hole.
func (s *Service) aggregateMarkdownRows(ctx context.Context, orgID string, taskIDs []string) ([]crawlQualityTaskMarkdownSummary, error) {
	collection, err := s.requireCrawlResultContentsCollection()
	if err != nil {
		return nil, err
	}
	cursor, err := collection.Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "taskId", Value: bson.D{{Key: "$in", Value: taskIDs}}},
			{Key: "$or", Value: bson.A{
				bson.D{{Key: "orgId", Value: orgID}},
				bson.D{{Key: "orgId", Value: bson.D{{Key: "$exists", Value: false}}}},
			}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "taskId", Value: 1},
			{Key: "markdownLength", Value: bson.D{{Key: "$strLenCP", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$markdown", ""}}}}}},
			{Key: "trimmedMarkdownLength", Value: bson.D{{Key: "$strLenCP", Value: bson.D{{Key: "$trim", Value: bson.D{
				{Key: "input", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$markdown", ""}}}},
			}}}}}},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$taskId"},
			{Key: "markdownCount", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "markdownCharsTotal", Value: bson.D{{Key: "$sum", Value: "$markdownLength"}}},
			{Key: "emptyMarkdownCount", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$trimmedMarkdownLength", 0}}}, 1, 0,
			}}}}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "taskId", Value: "$_id"},
			{Key: "markdownCount", Value: 1},
			{Key: "markdownCharsTotal", Value: 1},
			{Key: "emptyMarkdownCount", Value: 1},
		}}},
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	defer cursor.Close(ctx)

	rows := make([]crawlQualityTaskMarkdownSummary, 0, len(taskIDs))
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, fmt.Errorf("%w: %v", errMongo, err)
	}
	return rows, nil
}

// toNonNegativeIntPath mirrors toNonNegativeIntExpr for a field path input:
// {$max: [0, {$convert: {input: path, to: "int", onError: 0, onNull: 0}}]}.
func toNonNegativeIntPath(path string) bson.D {
	return bson.D{{Key: "$max", Value: bson.A{0, bson.D{{Key: "$convert", Value: bson.D{
		{Key: "input", Value: path},
		{Key: "to", Value: "int"},
		{Key: "onError", Value: 0},
		{Key: "onNull", Value: 0},
	}}}}}}
}

// toNonNegativeIntDocument is toNonNegativeIntPath for a computed input
// document, for example the $ifNull default chain of the candidate rejects.
func toNonNegativeIntDocument(input bson.D) bson.D {
	return bson.D{{Key: "$max", Value: bson.A{0, bson.D{{Key: "$convert", Value: bson.D{
		{Key: "input", Value: input},
		{Key: "to", Value: "int"},
		{Key: "onError", Value: 0},
		{Key: "onNull", Value: 0},
	}}}}}}
}

// Column list and upsert of CrawlQualityTaskSnapshot, byte-shaped like the
// Prisma.sql INSERT of upsertSnapshotRows. Every value is bound as a
// placeholder; only the placeholder list is generated.
const crawlQualitySnapshotInsertSQLPrefix = "INSERT INTO `CrawlQualityTaskSnapshot` (" +
	"`taskId`, `orgId`, `sourceId`, `taskCreatedAt`, `taskUpdatedAt`, `rolledAt`, " +
	"`lowSignalTaskCount`, `expansionTriggeredTaskCount`, `expansionImprovedTaskCount`, " +
	"`markdownCount`, `markdownCharsTotal`, `emptyMarkdownCount`, " +
	"`candidateRejectIncludePatternCount`, `candidateRejectExcludePatternCount`, " +
	"`candidateRejectPublishConfidenceCount`, `publishConfidenceLt04Count`, " +
	"`publishConfidenceFrom04To06Count`, `publishConfidenceFrom06To08Count`, " +
	"`publishConfidenceGte08Count`, `fitMarkdownPreferenceTaskCount`, " +
	"`headSignalAttemptedCount`, `headSignalSucceededCount`, `headSignalSoftFailureCount`, " +
	"`headSignalTruncatedCount`, `headSignalNoPublishSignalCount`, `preflightRunCount`, " +
	"`preflightFailureCount`, `preflight304HitCount`, `dedupeEvaluatedCount`, " +
	"`dedupeOrgReuseCount`, `createdAt`, `updatedAt`) VALUES "

// crawlQualitySnapshotUpsertSQLSuffix is the fixed ON DUPLICATE KEY UPDATE
// clause of upsertSnapshotRows: taskId and createdAt are never updated.
const crawlQualitySnapshotUpsertSQLSuffix = " ON DUPLICATE KEY UPDATE " +
	"`orgId` = VALUES(`orgId`), " +
	"`sourceId` = VALUES(`sourceId`), " +
	"`taskCreatedAt` = VALUES(`taskCreatedAt`), " +
	"`taskUpdatedAt` = VALUES(`taskUpdatedAt`), " +
	"`rolledAt` = VALUES(`rolledAt`), " +
	"`lowSignalTaskCount` = VALUES(`lowSignalTaskCount`), " +
	"`expansionTriggeredTaskCount` = VALUES(`expansionTriggeredTaskCount`), " +
	"`expansionImprovedTaskCount` = VALUES(`expansionImprovedTaskCount`), " +
	"`markdownCount` = VALUES(`markdownCount`), " +
	"`markdownCharsTotal` = VALUES(`markdownCharsTotal`), " +
	"`emptyMarkdownCount` = VALUES(`emptyMarkdownCount`), " +
	"`candidateRejectIncludePatternCount` = VALUES(`candidateRejectIncludePatternCount`), " +
	"`candidateRejectExcludePatternCount` = VALUES(`candidateRejectExcludePatternCount`), " +
	"`candidateRejectPublishConfidenceCount` = VALUES(`candidateRejectPublishConfidenceCount`), " +
	"`publishConfidenceLt04Count` = VALUES(`publishConfidenceLt04Count`), " +
	"`publishConfidenceFrom04To06Count` = VALUES(`publishConfidenceFrom04To06Count`), " +
	"`publishConfidenceFrom06To08Count` = VALUES(`publishConfidenceFrom06To08Count`), " +
	"`publishConfidenceGte08Count` = VALUES(`publishConfidenceGte08Count`), " +
	"`fitMarkdownPreferenceTaskCount` = VALUES(`fitMarkdownPreferenceTaskCount`), " +
	"`headSignalAttemptedCount` = VALUES(`headSignalAttemptedCount`), " +
	"`headSignalSucceededCount` = VALUES(`headSignalSucceededCount`), " +
	"`headSignalSoftFailureCount` = VALUES(`headSignalSoftFailureCount`), " +
	"`headSignalTruncatedCount` = VALUES(`headSignalTruncatedCount`), " +
	"`headSignalNoPublishSignalCount` = VALUES(`headSignalNoPublishSignalCount`), " +
	"`preflightRunCount` = VALUES(`preflightRunCount`), " +
	"`preflightFailureCount` = VALUES(`preflightFailureCount`), " +
	"`preflight304HitCount` = VALUES(`preflight304HitCount`), " +
	"`dedupeEvaluatedCount` = VALUES(`dedupeEvaluatedCount`), " +
	"`dedupeOrgReuseCount` = VALUES(`dedupeOrgReuseCount`), " +
	"`updatedAt` = VALUES(`updatedAt`)"

// upsertQualitySnapshotRows mirrors upsertSnapshotRows: one multi-row INSERT
// with a generated placeholder list and the fixed ON DUPLICATE KEY UPDATE.
// createdAt and updatedAt are both rolledAt, exactly like the Prisma template.
func (s *Service) upsertQualitySnapshotRows(ctx context.Context, rows []crawlQualityTaskSnapshotRow) error {
	if len(rows) == 0 {
		return nil
	}
	if s == nil || s.db == nil {
		return fmt.Errorf("%w: mysql is not configured", errDatabase)
	}

	rowPlaceholders := "(" + crawlQualityPlaceholders(crawlQualitySnapshotUpsertColumnCount) + ")"
	query := crawlQualitySnapshotInsertSQLPrefix + rowPlaceholders + crawlQualitySnapshotUpsertSQLSuffix

	// The upsert runs once per row inside a single transaction: a dynamic
	// multi-row VALUES clause would require an untyped variadic argument slice,
	// and the transaction keeps the batch atomic exactly like the Prisma
	// template. Every column stays a bound placeholder.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, row := range rows {
		if _, err := tx.ExecContext(ctx, query,
			row.TaskID,
			row.OrgID,
			row.SourceID,
			row.TaskCreatedAt.Time,
			row.TaskUpdatedAt.Time,
			row.RolledAt.Time,
			row.LowSignalTaskCount,
			row.ExpansionTriggeredTaskCount,
			row.ExpansionImprovedTaskCount,
			row.MarkdownCount,
			row.MarkdownCharsTotal,
			row.EmptyMarkdownCount,
			row.CandidateRejectIncludePatternCount,
			row.CandidateRejectExcludePatternCount,
			row.CandidateRejectPublishConfidenceCount,
			row.PublishConfidenceLt04Count,
			row.PublishConfidenceFrom04To06Count,
			row.PublishConfidenceFrom06To08Count,
			row.PublishConfidenceGte08Count,
			row.FitMarkdownPreferenceTaskCount,
			row.HeadSignalAttemptedCount,
			row.HeadSignalSucceededCount,
			row.HeadSignalSoftFailureCount,
			row.HeadSignalTruncatedCount,
			row.HeadSignalNoPublishSignalCount,
			row.PreflightRunCount,
			row.PreflightFailureCount,
			row.Preflight304HitCount,
			row.DedupeEvaluatedCount,
			row.DedupeOrgReuseCount,
			row.RolledAt.Time,
			row.RolledAt.Time,
		); err != nil {
			return fmt.Errorf("%w: %v", errDatabase, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	return nil
}

// crawlQualityAggregateSelectColumns is the shared COUNT / COALESCE(SUM())
// projection of the overall and grouped aggregate queries, in scan order.
const crawlQualityAggregateSelectColumns = "COUNT(*) AS `taskCount`, " +
	"COALESCE(SUM(`lowSignalTaskCount`), 0) AS `lowSignalTaskCount`, " +
	"COALESCE(SUM(`expansionTriggeredTaskCount`), 0) AS `expansionTriggeredTaskCount`, " +
	"COALESCE(SUM(`expansionImprovedTaskCount`), 0) AS `expansionImprovedTaskCount`, " +
	"COALESCE(SUM(`markdownCount`), 0) AS `markdownCount`, " +
	"COALESCE(SUM(`markdownCharsTotal`), 0) AS `markdownCharsTotal`, " +
	"COALESCE(SUM(`emptyMarkdownCount`), 0) AS `emptyMarkdownCount`, " +
	"COALESCE(SUM(`candidateRejectIncludePatternCount`), 0) AS `candidateRejectIncludePatternCount`, " +
	"COALESCE(SUM(`candidateRejectExcludePatternCount`), 0) AS `candidateRejectExcludePatternCount`, " +
	"COALESCE(SUM(`candidateRejectPublishConfidenceCount`), 0) AS `candidateRejectPublishConfidenceCount`, " +
	"COALESCE(SUM(`publishConfidenceLt04Count`), 0) AS `publishConfidenceLt04Count`, " +
	"COALESCE(SUM(`publishConfidenceFrom04To06Count`), 0) AS `publishConfidenceFrom04To06Count`, " +
	"COALESCE(SUM(`publishConfidenceFrom06To08Count`), 0) AS `publishConfidenceFrom06To08Count`, " +
	"COALESCE(SUM(`publishConfidenceGte08Count`), 0) AS `publishConfidenceGte08Count`, " +
	"COALESCE(SUM(`fitMarkdownPreferenceTaskCount`), 0) AS `fitMarkdownPreferenceTaskCount`, " +
	"COALESCE(SUM(`headSignalAttemptedCount`), 0) AS `headSignalAttemptedCount`, " +
	"COALESCE(SUM(`headSignalSucceededCount`), 0) AS `headSignalSucceededCount`, " +
	"COALESCE(SUM(`headSignalSoftFailureCount`), 0) AS `headSignalSoftFailureCount`, " +
	"COALESCE(SUM(`headSignalTruncatedCount`), 0) AS `headSignalTruncatedCount`, " +
	"COALESCE(SUM(`headSignalNoPublishSignalCount`), 0) AS `headSignalNoPublishSignalCount`, " +
	"COALESCE(SUM(`preflightRunCount`), 0) AS `preflightRunCount`, " +
	"COALESCE(SUM(`preflightFailureCount`), 0) AS `preflightFailureCount`, " +
	"COALESCE(SUM(`preflight304HitCount`), 0) AS `preflight304HitCount`, " +
	"COALESCE(SUM(`dedupeEvaluatedCount`), 0) AS `dedupeEvaluatedCount`, " +
	"COALESCE(SUM(`dedupeOrgReuseCount`), 0) AS `dedupeOrgReuseCount`"

// crawlQualityOverallAggregateSQL is queryOverallAggregate's $queryRaw.
const crawlQualityOverallAggregateSQL = "SELECT " + crawlQualityAggregateSelectColumns +
	" FROM `CrawlQualityTaskSnapshot`" +
	" WHERE `orgId` = ? AND `taskCreatedAt` >= ? AND `taskCreatedAt` <= ?"

// crawlQualityGroupedAggregateSQL is queryGroupedAggregates' $queryRaw; the
// sourceId ordering is already taskCount DESC and is preserved downstream.
const crawlQualityGroupedAggregateSQL = "SELECT `sourceId`, " + crawlQualityAggregateSelectColumns +
	" FROM `CrawlQualityTaskSnapshot`" +
	" WHERE `orgId` = ? AND `taskCreatedAt` >= ? AND `taskCreatedAt` <= ?" +
	" GROUP BY `sourceId` ORDER BY `taskCount` DESC, `sourceId` ASC"

// queryOverallAggregate mirrors queryOverallAggregate: one aggregate row or nil
// when MySQL reports no row (the caller then treats every counter as zero).
func (s *Service) queryOverallAggregate(ctx context.Context, orgID string, from, to time.Time) (*crawlQualityAggregateRow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	row := crawlQualityAggregateRow{}
	err := s.db.QueryRowContext(ctx, crawlQualityOverallAggregateSQL, orgID, from, to).Scan(
		&row.TaskCount,
		&row.LowSignalTaskCount,
		&row.ExpansionTriggeredTaskCount,
		&row.ExpansionImprovedTaskCount,
		&row.MarkdownCount,
		&row.MarkdownCharsTotal,
		&row.EmptyMarkdownCount,
		&row.CandidateRejectIncludePatternCount,
		&row.CandidateRejectExcludePatternCount,
		&row.CandidateRejectPublishConfidenceCount,
		&row.PublishConfidenceLt04Count,
		&row.PublishConfidenceFrom04To06Count,
		&row.PublishConfidenceFrom06To08Count,
		&row.PublishConfidenceGte08Count,
		&row.FitMarkdownPreferenceTaskCount,
		&row.HeadSignalAttemptedCount,
		&row.HeadSignalSucceededCount,
		&row.HeadSignalSoftFailureCount,
		&row.HeadSignalTruncatedCount,
		&row.HeadSignalNoPublishSignalCount,
		&row.PreflightRunCount,
		&row.PreflightFailureCount,
		&row.Preflight304HitCount,
		&row.DedupeEvaluatedCount,
		&row.DedupeOrgReuseCount,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return &row, nil
}

// queryGroupedAggregates mirrors queryGroupedAggregates: the same aggregate
// grouped by the nullable sourceId column, in the SQL ordering.
func (s *Service) queryGroupedAggregates(ctx context.Context, orgID string, from, to time.Time) ([]crawlQualityAggregateRow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	rows, err := s.db.QueryContext(ctx, crawlQualityGroupedAggregateSQL, orgID, from, to)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	aggregates := []crawlQualityAggregateRow{}
	for rows.Next() {
		var row crawlQualityAggregateRow
		var sourceID sql.NullString
		if err := rows.Scan(
			&sourceID,
			&row.TaskCount,
			&row.LowSignalTaskCount,
			&row.ExpansionTriggeredTaskCount,
			&row.ExpansionImprovedTaskCount,
			&row.MarkdownCount,
			&row.MarkdownCharsTotal,
			&row.EmptyMarkdownCount,
			&row.CandidateRejectIncludePatternCount,
			&row.CandidateRejectExcludePatternCount,
			&row.CandidateRejectPublishConfidenceCount,
			&row.PublishConfidenceLt04Count,
			&row.PublishConfidenceFrom04To06Count,
			&row.PublishConfidenceFrom06To08Count,
			&row.PublishConfidenceGte08Count,
			&row.FitMarkdownPreferenceTaskCount,
			&row.HeadSignalAttemptedCount,
			&row.HeadSignalSucceededCount,
			&row.HeadSignalSoftFailureCount,
			&row.HeadSignalTruncatedCount,
			&row.HeadSignalNoPublishSignalCount,
			&row.PreflightRunCount,
			&row.PreflightFailureCount,
			&row.Preflight304HitCount,
			&row.DedupeEvaluatedCount,
			&row.DedupeOrgReuseCount,
		); err != nil {
			return nil, fmt.Errorf("%w: %v", errDatabase, err)
		}
		row.SourceID = crawlQualityNullStringPointer(sourceID)
		aggregates = append(aggregates, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return aggregates, nil
}

// buildAggregateMetrics mirrors buildAggregateMetrics; a missing overall row
// behaves like the Nest `row?.` accesses and yields an all-zero block.
func (s *Service) buildAggregateMetrics(row *crawlQualityAggregateRow) crawlQualityMetricsAggregates {
	if row == nil {
		row = &crawlQualityAggregateRow{}
	}

	taskCount := crawlQualityToSafeNonNegativeInt(row.TaskCount)
	markdownCount := crawlQualityToSafeNonNegativeInt(row.MarkdownCount)
	markdownCharsTotal := crawlQualityToSafeNonNegativeInt(row.MarkdownCharsTotal)
	expansionTriggeredTaskCount := crawlQualityToSafeNonNegativeInt(row.ExpansionTriggeredTaskCount)
	headSignalAttemptedCount := crawlQualityToSafeNonNegativeInt(row.HeadSignalAttemptedCount)
	preflightRunCount := crawlQualityToSafeNonNegativeInt(row.PreflightRunCount)
	dedupeEvaluatedCount := crawlQualityToSafeNonNegativeInt(row.DedupeEvaluatedCount)

	avgMarkdownChars := 0
	if markdownCount > 0 {
		avgMarkdownChars = int(math.Round(float64(markdownCharsTotal) / float64(markdownCount)))
	}

	return crawlQualityMetricsAggregates{
		TaskCount: taskCount,
		SampleCounts: CrawlQualitySampleCounts{
			MarkdownCount:               markdownCount,
			ExpansionTriggeredTaskCount: expansionTriggeredTaskCount,
			HeadSignalAttemptedCount:    headSignalAttemptedCount,
			PreflightRunCount:           preflightRunCount,
			DedupeEvaluatedCount:        dedupeEvaluatedCount,
		},
		LowSignalRatio: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.LowSignalTaskCount),
			taskCount,
		),
		EmptyMarkdownRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.EmptyMarkdownCount),
			markdownCount,
		),
		ExpansionTriggerRate: crawlQualitySafeRatio(expansionTriggeredTaskCount, taskCount),
		ExpansionSuccessRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.ExpansionImprovedTaskCount),
			expansionTriggeredTaskCount,
		),
		AvgMarkdownChars: avgMarkdownChars,
		CandidateRejects: CrawlQualityRejectBreakdown{
			IncludePattern: crawlQualityToSafeNonNegativeInt(row.CandidateRejectIncludePatternCount),
			ExcludePattern: crawlQualityToSafeNonNegativeInt(row.CandidateRejectExcludePatternCount),
			PublishConfidence: crawlQualityToSafeNonNegativeInt(
				row.CandidateRejectPublishConfidenceCount,
			),
		},
		PublishConfidenceBuckets: CrawlQualityConfidenceBuckets{
			Lt04:       crawlQualityToSafeNonNegativeInt(row.PublishConfidenceLt04Count),
			From04To06: crawlQualityToSafeNonNegativeInt(row.PublishConfidenceFrom04To06Count),
			From06To08: crawlQualityToSafeNonNegativeInt(row.PublishConfidenceFrom06To08Count),
			Gte08:      crawlQualityToSafeNonNegativeInt(row.PublishConfidenceGte08Count),
		},
		FitMarkdownPreferenceRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.FitMarkdownPreferenceTaskCount),
			expansionTriggeredTaskCount,
		),
		HeadSignalSuccessRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.HeadSignalSucceededCount),
			headSignalAttemptedCount,
		),
		HeadSignalSoftFailureRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.HeadSignalSoftFailureCount),
			headSignalAttemptedCount,
		),
		HeadSignalTruncatedRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.HeadSignalTruncatedCount),
			headSignalAttemptedCount,
		),
		HeadSignalNoPublishSignalRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.HeadSignalNoPublishSignalCount),
			headSignalAttemptedCount,
		),
		HTTP304HitRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.Preflight304HitCount),
			preflightRunCount,
		),
		OrgHashDedupeHitRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.DedupeOrgReuseCount),
			dedupeEvaluatedCount,
		),
		PreflightFailureRate: crawlQualitySafeRatio(
			crawlQualityToSafeNonNegativeInt(row.PreflightFailureCount),
			preflightRunCount,
		),
	}
}

// buildGroupedMetrics mirrors buildGroupedMetrics: the aggregate block plus the
// sourceId, where an empty or NULL sourceId becomes "unknown".
func (s *Service) buildGroupedMetrics(row crawlQualityAggregateRow) CrawlQualityMetricsSourceSnapshot {
	metrics := s.buildAggregateMetrics(&row)
	sourceID := "unknown"
	if row.SourceID != nil && *row.SourceID != "" {
		sourceID = *row.SourceID
	}
	return CrawlQualityMetricsSourceSnapshot{
		SourceID:                      sourceID,
		TaskCount:                     metrics.TaskCount,
		SampleCounts:                  metrics.SampleCounts,
		LowSignalRatio:                metrics.LowSignalRatio,
		EmptyMarkdownRate:             metrics.EmptyMarkdownRate,
		ExpansionTriggerRate:          metrics.ExpansionTriggerRate,
		ExpansionSuccessRate:          metrics.ExpansionSuccessRate,
		AvgMarkdownChars:              metrics.AvgMarkdownChars,
		CandidateRejects:              metrics.CandidateRejects,
		PublishConfidenceBuckets:      metrics.PublishConfidenceBuckets,
		FitMarkdownPreferenceRate:     metrics.FitMarkdownPreferenceRate,
		HeadSignalSuccessRate:         metrics.HeadSignalSuccessRate,
		HeadSignalSoftFailureRate:     metrics.HeadSignalSoftFailureRate,
		HeadSignalTruncatedRate:       metrics.HeadSignalTruncatedRate,
		HeadSignalNoPublishSignalRate: metrics.HeadSignalNoPublishSignalRate,
		HTTP304HitRate:                metrics.HTTP304HitRate,
		OrgHashDedupeHitRate:          metrics.OrgHashDedupeHitRate,
		PreflightFailureRate:          metrics.PreflightFailureRate,
	}
}

// crawlQualityToSafeNonNegativeInt mirrors toSafeNonNegativeInt for an int64
// column: the driver already decoded a finite number, so only the rounding to
// an integer and the max(0, ·) clamp remain.
func crawlQualityToSafeNonNegativeInt(value int64) int {
	if value < 0 {
		return 0
	}
	return int(value)
}

// crawlQualitySafeRatio mirrors safeRatio: (max(0, numerator) / denominator)
// rounded to four decimals, with a non-positive denominator or a non-finite
// quotient collapsing to 0.
func crawlQualitySafeRatio(numerator, denominator int) float64 {
	if denominator <= 0 {
		return 0
	}
	if numerator < 0 {
		numerator = 0
	}
	ratio := float64(numerator) / float64(denominator)
	if !isFiniteCrawlQualityValue(ratio) {
		return 0
	}
	return math.Round(ratio*10000) / 10000
}
