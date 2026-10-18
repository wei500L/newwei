package situationsignals

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// emptyRefreshCrawl is the placeholder written into the response (and used by
// the terminal state machine) when the cached record has no usable `crawl`
// object. It is deliberately narrower than the full crawl summary: the two
// fields an old writer may not have persisted stay absent rather than being
// fabricated.
const emptyRefreshCrawl = `{"activeSourceCount":0,"permitted":false,"attempted":false,"schedulerTriggered":false,"crawlTaskCount":0,"analysisTaskCount":0}`

// refreshRunCacheRecord is the loose projection of the cached refresh-run
// record. S2: it is read through a defensive decoder, because the Redis entry
// (900 second TTL) can outlive the deployment that wrote it and a partial record
// used to make every read fail.
type refreshRunCacheRecord struct {
	// refreshId, requestedAt and taskWindowStart are echoed verbatim, so they
	// stay rawJSON: a null stays null and an absent key stays absent, exactly
	// like the NestJS response spreads the cached object.
	RefreshID       rawJSON       `json:"refreshId"`
	OrgID           trimmedString `json:"orgId"`
	RequestedAt     rawJSON       `json:"requestedAt"`
	TaskWindowStart rawJSON       `json:"taskWindowStart"`
	ActiveSourceIDs jsStringList  `json:"activeSourceIds"`
	Crawl           rawJSON       `json:"crawl"`
	Signals         rawJSON       `json:"signals"`
	Cache           rawJSON       `json:"cache"`
	Warnings        jsRawList     `json:"warnings"`
	Terminal        rawJSON       `json:"terminal"`

	// raw keeps the exact bytes of the cached JSON so the terminal write-back
	// can patch one field without rewriting the record.
	raw json.RawMessage
}

// UnmarshalJSON keeps the raw bytes alongside the decoded projection.
func (r *refreshRunCacheRecord) UnmarshalJSON(data []byte) error {
	type plain refreshRunCacheRecord
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*r = refreshRunCacheRecord(decoded)
	r.raw = append(r.raw[:0], data...)
	return nil
}

// refreshCrawlSummary is the loose projection of the cached `crawl` object. The
// three booleans stay rawJSON because the state machine applies JavaScript
// truthiness to them, not a strict boolean test.
type refreshCrawlSummary struct {
	ActiveSourceCount  jsNumberish `json:"activeSourceCount"`
	Permitted          rawJSON     `json:"permitted"`
	Attempted          rawJSON     `json:"attempted"`
	SchedulerTriggered rawJSON     `json:"schedulerTriggered"`
	CrawlTaskCount     jsNumberish `json:"crawlTaskCount"`
	AnalysisTaskCount  jsNumberish `json:"analysisTaskCount"`
}

// crawlTaskCounts is the crawlTasks progress block.
type crawlTaskCounts struct {
	Pending   int `json:"pending"`
	Queued    int `json:"queued"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Paused    int `json:"paused"`
}

// analysisTaskCounts is the analysisTasks progress block.
type analysisTaskCounts struct {
	Pending   int `json:"pending"`
	Queued    int `json:"queued"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Delayed   int `json:"delayed"`
}

// refreshRunProgress is the progress block.
type refreshRunProgress struct {
	CrawlTasks    crawlTaskCounts    `json:"crawlTasks"`
	AnalysisTasks analysisTaskCounts `json:"analysisTasks"`
}

// refreshRunResponse is the GET /refresh-runs/:refreshId body.
type refreshRunResponse struct {
	RefreshID       *rawJSON               `json:"refreshId,omitempty"`
	RequestedAt     *rawJSON               `json:"requestedAt,omitempty"`
	TaskWindowStart *rawJSON               `json:"taskWindowStart,omitempty"`
	Status          refreshLifecycleStatus `json:"status"`
	Crawl           rawJSON                `json:"crawl"`
	Progress        refreshRunProgress     `json:"progress"`
	// signals and cache are passed through verbatim; the keys are omitted when
	// the cached record did not carry them.
	Signals  *rawJSON  `json:"signals,omitempty"`
	Cache    *rawJSON  `json:"cache,omitempty"`
	Warnings []rawJSON `json:"warnings"`
	Terminal bool      `json:"terminal"`
}

// getRefreshRun mirrors SituationMonitorRefreshService.getRefreshRun.
//
// A record that is missing, owned by another organization or whose
// taskWindowStart does not parse all return the same 404, so cross-tenant
// probing cannot distinguish the three.
func (s *Service) getRefreshRun(ctx context.Context, orgID, refreshID string) (refreshRunResponse, error) {
	if s.cache.get == nil {
		return refreshRunResponse{}, errNoDatabase
	}
	raw, err := s.cache.get(ctx, refreshRunPrefix+refreshID)
	if errors.Is(err, redis.Nil) {
		return refreshRunResponse{}, errRefreshRunMissing
	}
	if err != nil {
		return refreshRunResponse{}, err
	}
	if strings.TrimSpace(raw) == "" {
		return refreshRunResponse{}, errRefreshRunMissing
	}

	var record refreshRunCacheRecord
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		// NestJS JSON.parse throws here and the global filter answers 500.
		return refreshRunResponse{}, newStatus(500, "Internal server error")
	}
	recordedOrgID, _ := record.OrgID.Value()
	if recordedOrgID != orgID {
		return refreshRunResponse{}, errRefreshRunMissing
	}

	windowStart, ok := parseJSTime(record.TaskWindowStart)
	if !ok {
		return refreshRunResponse{}, errRefreshRunMissing
	}

	sourceIDs := record.ActiveSourceIDs.Values()
	crawlRaw := record.Crawl
	crawl := refreshCrawlSummary{}
	crawlPresent := false
	if encoded, ok := record.Crawl.asObject(); ok {
		crawlPresent = true
		payload, err := json.Marshal(encoded)
		if err == nil {
			if err := json.Unmarshal(payload, &crawl); err != nil {
				crawlPresent = false
			}
		}
	}
	if !crawlPresent {
		// Zero-value semantics, not "undefined field" semantics: a record
		// without a crawl object makes activeSourceCount === 0 true.
		crawlRaw = rawJSON{raw: json.RawMessage(emptyRefreshCrawl)}
	}
	warnings := record.Warnings.Values()

	counts, err := s.countRefreshProgress(ctx, orgID, windowStart, sourceIDs)
	if err != nil {
		return refreshRunResponse{}, err
	}

	crawlTaskTotal := numberOrZero(crawl.CrawlTaskCount)
	analysisTaskTotal := numberOrZero(crawl.AnalysisTaskCount)

	activeTaskCount := counts.crawlPending + counts.crawlQueued + counts.crawlRunning +
		counts.analysisPending + counts.analysisQueued + counts.analysisRunning + counts.analysisDelayed

	hasErrors := warningsContainError(warnings) || counts.crawlFailed > 0 || counts.analysisFailed > 0
	hasWarnings := len(warnings) > 0
	hasAnyTasks := crawlTaskTotal > 0 || analysisTaskTotal > 0 ||
		counts.crawlCompleted > 0 || counts.crawlFailed > 0 || counts.crawlPaused > 0 ||
		counts.analysisCompleted > 0 || counts.analysisFailed > 0 || counts.analysisDelayed > 0

	activeSourceCountIsZero := true
	if crawlPresent {
		activeSourceCountIsZero = crawl.ActiveSourceCount.isJSONNumberZero()
	}
	permitted := crawl.Permitted.isTruthy()
	attempted := crawl.Attempted.isTruthy()
	schedulerTriggered := crawl.SchedulerTriggered.isTruthy()

	terminal := activeTaskCount == 0 &&
		(activeSourceCountIsZero || !permitted || !attempted || hasAnyTasks || !schedulerTriggered)

	var status refreshLifecycleStatus
	switch {
	case activeTaskCount > 0 && hasAnyTasks:
		status = refreshStatusRunning
	case activeTaskCount > 0:
		status = refreshStatusQueued
	case hasErrors:
		status = refreshStatusFailed
	case hasWarnings:
		status = refreshStatusPartial
	default:
		status = refreshStatusCompleted
	}

	if terminalNeedsWriteBack(record.Terminal, terminal) {
		if err := s.persistRefreshRunTerminal(ctx, refreshID, record.raw, terminal); err != nil {
			return refreshRunResponse{}, err
		}
	}

	response := refreshRunResponse{
		RefreshID:       passThroughField(record.RefreshID),
		RequestedAt:     passThroughField(record.RequestedAt),
		TaskWindowStart: passThroughField(record.TaskWindowStart),
		Status:          status,
		Crawl:           crawlRaw,
		Progress: refreshRunProgress{
			CrawlTasks: crawlTaskCounts{
				Pending:   counts.crawlPending,
				Queued:    counts.crawlQueued,
				Running:   counts.crawlRunning,
				Completed: counts.crawlCompleted,
				Failed:    counts.crawlFailed,
				Paused:    counts.crawlPaused,
			},
			AnalysisTasks: analysisTaskCounts{
				Pending:   counts.analysisPending,
				Queued:    counts.analysisQueued,
				Running:   counts.analysisRunning,
				Completed: counts.analysisCompleted,
				Failed:    counts.analysisFailed,
				Delayed:   counts.analysisDelayed,
			},
		},
		Warnings: warnings,
		Terminal: terminal,
	}
	if record.Signals.IsObject() {
		value := record.Signals
		response.Signals = &value
	}
	if record.Cache.IsObject() {
		value := record.Cache
		response.Cache = &value
	}
	if response.Warnings == nil {
		response.Warnings = []rawJSON{}
	}
	return response, nil
}

// passThroughField returns a pointer to a cached value, or nil when the key was
// absent (JavaScript undefined). The response therefore omits an absent field
// and echoes a null verbatim, which is what spreading the cached object does.
func passThroughField(value rawJSON) *rawJSON {
	if len(value.raw) == 0 {
		return nil
	}
	copied := value
	return &copied
}

// persistRefreshRunTerminal patches only the `terminal` field of the cached JSON
// and rewrites the key with the same 900 second TTL, so a record written by an
// older revision keeps every other byte it had.
func (s *Service) persistRefreshRunTerminal(ctx context.Context, refreshID string, raw json.RawMessage, terminal bool) error {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	fields["terminal"] = json.RawMessage(strconv.FormatBool(terminal))
	payload, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	return s.cache.set(ctx, refreshRunPrefix+refreshID, payload, refreshRunTTL)
}

// refreshProgressCounts holds the twelve counters.
type refreshProgressCounts struct {
	crawlPending   int
	crawlQueued    int
	crawlRunning   int
	crawlCompleted int
	crawlFailed    int
	crawlPaused    int

	analysisPending   int
	analysisQueued    int
	analysisRunning   int
	analysisCompleted int
	analysisFailed    int
	analysisDelayed   int
}

// countRefreshProgress runs the twelve counts.
//
// Every count filters by orgId, applies the task window and restricts the source
// column to activeSourceIds. When activeSourceIds is empty the count is 0
// without touching MySQL: it is not an unfiltered count.
//
// NestJS issues twelve `... IN (activeSourceIds)` counts. This implementation
// issues one grouped count per table and sums the rows whose source id is in the
// active set, because database/sql only exposes a variadic argument list and
// this package avoids untyped slices. The summed result is identical: rows with a
// NULL or foreign source id are excluded exactly like `IN` excludes them.
func (s *Service) countRefreshProgress(ctx context.Context, orgID string, windowStart time.Time, sourceIDs []string) (refreshProgressCounts, error) {
	var counts refreshProgressCounts
	if len(sourceIDs) == 0 {
		return counts, nil
	}
	if s.db == nil {
		return counts, errNoDatabase
	}
	active := make(map[string]bool, len(sourceIDs))
	for _, sourceID := range sourceIDs {
		active[sourceID] = true
	}

	crawlCounts, err := s.countCrawlTasksByStatus(ctx, orgID, windowStart, active)
	if err != nil {
		return counts, err
	}
	counts.crawlPending = crawlCounts[crawlTaskPending]
	counts.crawlQueued = crawlCounts[crawlTaskQueued]
	counts.crawlRunning = crawlCounts[crawlTaskRunning]
	counts.crawlCompleted = crawlCounts[crawlTaskCompleted]
	counts.crawlFailed = crawlCounts[crawlTaskFailed]
	counts.crawlPaused = crawlCounts[crawlTaskPaused]

	analysisCounts, err := s.countPipelineJobsByStatus(ctx, orgID, windowStart, active)
	if err != nil {
		return counts, err
	}
	counts.analysisPending = analysisCounts[pipelineJobPending]
	counts.analysisQueued = analysisCounts[pipelineJobQueued]
	counts.analysisRunning = analysisCounts[pipelineJobRunning]
	counts.analysisCompleted = analysisCounts[pipelineJobCompleted]
	counts.analysisFailed = analysisCounts[pipelineJobFailed]
	counts.analysisDelayed = analysisCounts[pipelineJobDelayed]

	return counts, nil
}

// countCrawlTasksByStatus counts CrawlTask rows per (newsSourceId, status)
// inside the task window and keeps the active sources.
func (s *Service) countCrawlTasksByStatus(ctx context.Context, orgID string, windowStart time.Time, active map[string]bool) (map[crawlTaskStatus]int, error) {
	out := map[crawlTaskStatus]int{}
	rows, err := s.db.QueryContext(ctx, `
SELECT newsSourceId, status, COUNT(*)
FROM CrawlTask
WHERE orgId = ? AND createdAt >= ?
GROUP BY newsSourceId, status`, orgID, windowStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID sql.NullString
		var status string
		var count int
		if err := rows.Scan(&sourceID, &status, &count); err != nil {
			return nil, err
		}
		if !sourceID.Valid || !active[sourceID.String] {
			continue
		}
		out[crawlTaskStatus(status)] += count
	}
	return out, rows.Err()
}

// countPipelineJobsByStatus counts PipelineJob rows per (sourceId, status)
// inside the task window and keeps the active sources.
func (s *Service) countPipelineJobsByStatus(ctx context.Context, orgID string, windowStart time.Time, active map[string]bool) (map[pipelineJobStatus]int, error) {
	out := map[pipelineJobStatus]int{}
	rows, err := s.db.QueryContext(ctx, `
SELECT sourceId, status, COUNT(*)
FROM PipelineJob
WHERE orgId = ? AND createdAt >= ?
GROUP BY sourceId, status`, orgID, windowStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID sql.NullString
		var status string
		var count int
		if err := rows.Scan(&sourceID, &status, &count); err != nil {
			return nil, err
		}
		if !sourceID.Valid || !active[sourceID.String] {
			continue
		}
		out[pipelineJobStatus(status)] += count
	}
	return out, rows.Err()
}

// parseJSTime parses the taskWindowStart value with the subset of Date parsing
// this endpoint can receive: an ISO 8601 string or a millisecond epoch number.
// Anything else is an invalid date and makes the record unusable.
func parseJSTime(raw rawJSON) (time.Time, bool) {
	if text, ok := raw.asString(); ok {
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return time.Time{}, false
		}
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				return parsed, true
			}
		}
		return time.Time{}, false
	}
	value, ok := jsNumber(raw.raw, len(raw.raw) > 0)
	if !ok {
		return time.Time{}, false
	}
	return time.UnixMilli(int64(value)).UTC(), true
}

// terminalNeedsWriteBack reproduces the strict comparison
// `terminal !== record.terminal` from getRefreshRun. Only a stored JSON boolean
// can compare equal: a missing key, null, 0 or the string "false" all differ
// from the computed boolean and force the write-back.
func terminalNeedsWriteBack(raw rawJSON, terminal bool) bool {
	switch strings.TrimSpace(string(raw.raw)) {
	case "true":
		return !terminal
	case "false":
		return terminal
	default:
		return true
	}
}

// isJSONNumberZero reports whether the raw value is the JSON number 0 (a strict
// `value === 0`, which the string "0" does not satisfy).
func (r rawJSON) isJSONNumberZero() bool {
	trimmed := strings.TrimSpace(string(r.raw))
	if len(trimmed) == 0 {
		return false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return false
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	return err == nil && value == 0
}

// numberOrZero resolves a loose numeric field to a number, treating an absent or
// non-numeric value as 0 for the > 0 comparisons only.
func numberOrZero(value jsNumberish) float64 {
	number, ok := value.Number()
	if !ok {
		return 0
	}
	return number
}

// warningsContainError reports whether any warning element is an object whose
// `severity` is the string "error". A malformed element is ignored instead of
// crashing the request.
func warningsContainError(warnings []rawJSON) bool {
	for _, warning := range warnings {
		record, ok := warning.asObject()
		if !ok {
			continue
		}
		severity, ok := rawJSON{raw: record["severity"]}.asString()
		if ok && severity == "error" {
			return true
		}
	}
	return false
}
