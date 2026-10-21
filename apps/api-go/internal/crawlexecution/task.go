package crawlexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// NewsSource runtime cache constants (NewsSourceOpsSnapshotService).
const (
	newsSourceRuntimeKeyPrefix  = "news-source:list-runtime:"
	newsSourceRuntimeTTLSeconds = 30 * 24 * 60 * 60
	pipelineJobIDMaxLength      = 128
)

// loadTask is crawlTask.findFirst({where:{id, orgId}}).
func (s *Service) loadTask(ctx context.Context, orgID, taskID string) (*taskRow, error) {
	if s.db == nil {
		return nil, errNotConfigured("crawlexecution: mysql is not configured")
	}
	row := s.db.QueryRowContext(ctx,
		"SELECT `id`, `orgId`, `newsSourceId`, `createdById`, `targetUrl`, `displayName`, `status`, `config`, `keywords`, "+
			"`lastResultAt`, `lastCursor`, `lastServerMemoryMb`, `lastPeakMemoryMb`, `lastMemoryEfficiency` "+
			"FROM `CrawlTask` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
		taskID, orgID)
	var record taskRow
	var newsSourceID, displayName, config, keywords sql.NullString
	var lastResultAt, lastCursor sql.NullString
	var serverMemory, peakMemory, memoryEfficiency sql.NullFloat64
	err := row.Scan(
		&record.ID, &record.OrgID, &newsSourceID, &record.CreatedByID, &record.TargetURL,
		&displayName, &record.Status, &config, &keywords,
		&lastResultAt, &lastCursor, &serverMemory, &peakMemory, &memoryEfficiency,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: load crawl task: %w", err)
	}
	if newsSourceID.Valid {
		value := newsSourceID.String
		record.NewsSourceID = &value
	}
	if displayName.Valid {
		value := displayName.String
		record.DisplayName = &value
	}
	if config.Valid {
		record.Config = json.RawMessage(config.String)
	}
	if keywords.Valid {
		record.Keywords = json.RawMessage(keywords.String)
	}
	if lastResultAt.Valid {
		parsed, parseErr := parseMySQLDateTime(lastResultAt.String)
		if parseErr == nil {
			record.LastResultAt = &parsed
		}
	}
	if lastCursor.Valid {
		value := lastCursor.String
		record.LastCursor = &value
	}
	if serverMemory.Valid {
		value := serverMemory.Float64
		record.LastServerMemoryMB = &value
	}
	if peakMemory.Valid {
		value := peakMemory.Float64
		record.LastPeakMemoryMB = &value
	}
	if memoryEfficiency.Valid {
		value := memoryEfficiency.Float64
		record.LastMemoryEfficiency = &value
	}
	return &record, nil
}

// parseMySQLDateTime accepts the driver's time.Time string form and the raw
// "YYYY-MM-DD HH:MM:SS[.fff]" form.
func parseMySQLDateTime(value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999",
		"2006-01-02 15:04:05",
		time.RFC3339Nano,
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported datetime %q", value)
}

// markTaskRunning is the first CrawlTask update of runTask.
func (s *Service) markTaskRunning(ctx context.Context, taskID string) error {
	now := s.now().UTC().Truncate(time.Millisecond)
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = 'running', `lastRunAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		now, now, taskID); err != nil {
		return fmt.Errorf("crawlexecution: mark crawl task running: %w", err)
	}
	return nil
}

// markTaskCompleted is the terminal success update. Fallbacks mirror the NestJS
// `x ?? task.x` expressions.
func (s *Service) markTaskCompleted(ctx context.Context, task *taskRow, update completedTaskUpdate) error {
	now := s.now().UTC().Truncate(time.Millisecond)
	lastResultAt := update.LastResultAt
	if lastResultAt == nil {
		lastResultAt = task.LastResultAt
	}
	lastCursor := update.LastCursor
	if lastCursor == nil {
		lastCursor = task.LastCursor
	}
	serverMemory := fallbackFloat(update.Memory.ServerMemoryMB, task.LastServerMemoryMB)
	peakMemory := fallbackFloat(update.Memory.PeakMemoryMB, task.LastPeakMemoryMB)
	memoryEfficiency := fallbackFloat(update.Memory.EfficiencyPercent, task.LastMemoryEfficiency)
	if _, err := s.db.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = 'completed', `runCount` = `runCount` + 1, `lastSuccessAt` = ?, "+
			"`lastResultAt` = ?, `lastCursor` = ?, `lastError` = NULL, `lastServerMemoryMb` = ?, "+
			"`lastPeakMemoryMb` = ?, `lastMemoryEfficiency` = ?, `updatedAt` = ? WHERE `id` = ?",
		now, nullableTime(lastResultAt), nullableString(lastCursor), nullableFloat(serverMemory),
		nullableFloat(peakMemory), nullableFloat(memoryEfficiency), now, task.ID); err != nil {
		return fmt.Errorf("crawlexecution: mark crawl task completed: %w", err)
	}
	return nil
}

// markTaskFailed is the catch-block status update. NestJS retries once with the
// message truncated to the 191-character varchar limit when the full text does
// not fit; the first update failure is logged.
func (s *Service) markTaskFailed(ctx context.Context, task *taskRow, status, message string) {
	now := s.now().UTC().Truncate(time.Millisecond)
	_, err := s.db.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = ?, `lastError` = ?, `updatedAt` = ? WHERE `id` = ?",
		status, message, now, task.ID)
	if err == nil {
		return
	}
	log.Printf("crawlexecution: failed to persist crawl task error, retrying truncated taskId=%s: %v", task.ID, err)
	truncated := truncateVarchar191Text(message)
	if _, fallbackErr := s.db.ExecContext(ctx,
		"UPDATE `CrawlTask` SET `status` = ?, `lastError` = ?, `updatedAt` = ? WHERE `id` = ?",
		status, truncated, now, task.ID); fallbackErr != nil {
		log.Printf("crawlexecution: failed to persist crawl task error after truncation taskId=%s: %v", task.ID, fallbackErr)
	}
}

// syncSourceQueueCounts is CrawlExecutionResultsService.syncSourceQueueCounts ->
// NewsSourceOpsSnapshotService.syncQueueCounts, coalesced per source (O2).
//
// Each call used to read the CrawlTask queue counts and rewrite the Redis
// runtime state inline; a crawl task start/success/failure triggers three of
// them and concurrent tasks of one source can trigger dozens. The request is now
// recorded in a per-(org, source) coalescer that refreshes the Redis runtime
// state (crawlTaskQueuedCount/crawlTaskRunningCount) at most once per second and
// always refreshes once more after the last change. The MySQL ops snapshot row is
// not part of this path. Failures are logged and swallowed, like the NestJS
// try/catch.
func (s *Service) syncSourceQueueCounts(ctx context.Context, orgID string, sourceID *string) {
	if sourceID == nil || *sourceID == "" {
		return
	}
	if s.snapshots == nil {
		return
	}
	s.snapshots.request(orgID, *sourceID)
}

func (s *Service) writeSourceQueueCounts(ctx context.Context, orgID, sourceID string) error {
	rows, err := s.db.QueryContext(ctx,
		"SELECT `status`, COUNT(*) FROM `CrawlTask` WHERE `orgId` = ? AND `newsSourceId` = ? AND `status` IN ('queued','running') GROUP BY `status`",
		orgID, sourceID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	queued := 0
	running := 0
	for rows.Next() {
		var status string
		var count int64
		if scanErr := rows.Scan(&status, &count); scanErr != nil {
			return scanErr
		}
		switch status {
		case "queued":
			queued = int(count)
		case "running":
			running = int(count)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	key := newsSourceRuntimeKeyPrefix + sourceID
	state := map[string]any{
		"crawlTaskQueuedCount":      0,
		"crawlTaskRunningCount":     0,
		"backpressureUntil":         nil,
		"backpressurePendingJobs":   nil,
		"backpressureThreshold":     nil,
		"backpressureHitTimestamps": []any{},
		"rssAdaptiveState":          nil,
	}
	if raw, readErr := s.redis.Get(ctx, key).Bytes(); readErr == nil && len(raw) > 0 {
		var existing map[string]any
		if jsonErr := json.Unmarshal(raw, &existing); jsonErr == nil && existing != nil {
			for field, value := range existing {
				state[field] = value
			}
		}
	} else if readErr != nil && !errors.Is(readErr, redis.Nil) {
		return readErr
	}
	state["crawlTaskQueuedCount"] = queued
	state["crawlTaskRunningCount"] = running
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return s.redis.Set(ctx, key, payload, newsSourceRuntimeTTLSeconds*time.Second).Err()
}

// extractPipelineJobID is extractPipelineJobId.
func extractPipelineJobID(config json.RawMessage) *string {
	record := decodeConfigObject(config)
	if record == nil {
		return nil
	}
	value := decodeInto[string](record, "pipelineJobId")
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > pipelineJobIDMaxLength {
		trimmed = trimmed[:pipelineJobIDMaxLength]
	}
	return &trimmed
}

// extractPipelineSourceID is extractPipelineSourceId.
func extractPipelineSourceID(config json.RawMessage) *string {
	record := decodeConfigObject(config)
	if record == nil {
		return nil
	}
	if direct := decodeInto[string](record, "sourceId"); direct != nil {
		trimmed := strings.TrimSpace(*direct)
		if trimmed != "" {
			return &trimmed
		}
	}
	itemPayload, ok := record["itemPayload"]
	if !ok || len(itemPayload) == 0 {
		return nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(itemPayload, &payload); err != nil {
		return nil
	}
	metadataRaw, ok := payload["metadata"]
	if !ok || len(metadataRaw) == 0 {
		return nil
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		return nil
	}
	sourceRaw, ok := metadata["sourceId"]
	if !ok {
		return nil
	}
	var sourceID string
	if err := json.Unmarshal(sourceRaw, &sourceID); err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(sourceID)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// extractURLQueryParamAllowlistFromTaskConfig is
// extractUrlQueryParamAllowlistFromTaskConfig. An explicit empty array means
// "strip every query parameter" and must not fall back to the default list.
func extractURLQueryParamAllowlistFromTaskConfig(config json.RawMessage) []string {
	record := decodeConfigObject(config)
	if record == nil {
		return append([]string(nil), newssources.DefaultURLQueryParamAllowlist...)
	}
	if raw, ok := record["urlQueryParamAllowlist"]; ok {
		if value, explicit := explicitAllowlistValue(raw); explicit {
			return newssources.NormalizeURLQueryParamAllowlist(value, []string{})
		}
	}
	if itemPayload, ok := record["itemPayload"]; ok {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(itemPayload, &payload); err == nil {
			if metadataRaw, ok := payload["metadata"]; ok {
				var metadata map[string]json.RawMessage
				if err := json.Unmarshal(metadataRaw, &metadata); err == nil {
					if raw, ok := metadata["urlQueryParamAllowlist"]; ok {
						if value, explicit := explicitAllowlistValue(raw); explicit {
							return newssources.NormalizeURLQueryParamAllowlist(value, []string{})
						}
					}
				}
			}
		}
	}
	return append([]string(nil), newssources.DefaultURLQueryParamAllowlist...)
}

// explicitAllowlistValue reports whether a stored allowlist value is an array or
// a non-blank string, and returns it in the shape the shared normalizer reads.
func explicitAllowlistValue(raw json.RawMessage) (any, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	var probe any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, false
	}
	switch typed := probe.(type) {
	case []any:
		return typed, true
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil, false
		}
		return typed, true
	default:
		return nil, false
	}
}

// extractOrgContentDedupeWindowHours is
// extractOrgContentDedupeWindowHoursFromTaskConfig.
func extractOrgContentDedupeWindowHours(config json.RawMessage) int {
	const (
		defaultHours = 24
		maxHours     = 24 * 30
	)
	record := decodeConfigObject(config)
	if record == nil {
		return defaultHours
	}
	if direct, ok := record["orgContentDedupeWindowHours"]; ok {
		if value, valid := clampWindowHours(direct); valid {
			return value
		}
	}
	if itemPayload, ok := record["itemPayload"]; ok {
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(itemPayload, &payload); err == nil {
			if metadataRaw, ok := payload["metadata"]; ok {
				var metadata map[string]json.RawMessage
				if err := json.Unmarshal(metadataRaw, &metadata); err == nil {
					if seedRaw, ok := metadata["newsSourceSeed"]; ok {
						var seed map[string]json.RawMessage
						if err := json.Unmarshal(seedRaw, &seed); err == nil {
							if value, ok := seed["dedupeWindowHours"]; ok {
								if hours, valid := clampWindowHours(value); valid {
									return hours
								}
							}
						}
					}
				}
			}
		}
	}
	return defaultHours
}

// clampWindowHours mirrors clampWindowHours: a non-number is invalid, a valid
// number rounds and clamps into [0, MAX_CRAWL_ORG_CONTENT_DEDUPE_WINDOW_HOURS].
func clampWindowHours(raw json.RawMessage) (int, bool) {
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	rounded := int(math.Floor(value + 0.5))
	if rounded < 0 {
		rounded = 0
	}
	if rounded > 24*30 {
		rounded = 24 * 30
	}
	return rounded, true
}

// computeExponentialBackoffDelayMs is computeExponentialBackoffDelayMs with the
// same ±25% jitter window.
func computeExponentialBackoffDelayMs(baseDelayMs, attempt, maxDelayMs int) int {
	normalizedAttempt := attempt
	if normalizedAttempt < 1 {
		normalizedAttempt = 1
	}
	exponential := float64(baseDelayMs) * math.Pow(2, float64(normalizedAttempt-1))
	capped := math.Min(exponential, float64(maxDelayMs))
	jitter := 0.75 + rand.Float64()*0.5
	return int(math.Round(capped * jitter))
}

func fallbackFloat(value, fallback *float64) *float64 {
	if value != nil {
		return value
	}
	return fallback
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
