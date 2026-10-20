package crawltaskwrite

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingswrite"
)

// This file ports crawl4ai-queue.controller.ts: the queue status projection and
// the pause / resume / concurrency controls. Queue state is global (not
// tenant-scoped), exactly like NestJS.

// adaptiveStateCacheKey is ADAPTIVE_STATE_CACHE_KEY.
const adaptiveStateCacheKey = "crawl:adaptive-concurrency:state"

// QueueMode is CRAWL_QUEUE_MODE.
const QueueMode = "dual"

// queueNames is the queueNames object of the status response.
type queueNames struct {
	Hot    string `json:"hot"`
	Normal string `json:"normal"`
	Legacy string `json:"legacy"`
}

// queueClassStatus is one CrawlQueueClassRuntimeStats object. Field order
// matches getRuntimeStatsByQueue's object literal.
type queueClassStatus struct {
	QueueName            string                 `json:"queueName"`
	Counts               crawlqueue.QueueCounts `json:"counts"`
	Pending              int64                  `json:"pending"`
	Paused               bool                   `json:"paused"`
	EffectiveConcurrency int                    `json:"effectiveConcurrency"`
}

// queuesStatus groups hot, normal and the conditional legacy queue.
type queuesStatus struct {
	Hot    queueClassStatus  `json:"hot"`
	Normal queueClassStatus  `json:"normal"`
	Legacy *queueClassStatus `json:"legacy,omitempty"`
}

// adaptiveThresholds is the thresholds object of the adaptive status.
type adaptiveThresholds struct {
	LatencyRatio   float64 `json:"latencyRatio"`
	ErrorRate      float64 `json:"errorRate"`
	MemoryHeadroom float64 `json:"memoryHeadroom"`
}

// adaptiveMetrics is AdaptiveConcurrencyMetrics.
type adaptiveMetrics struct {
	TaskCount          int      `json:"taskCount"`
	FailedCount        int      `json:"failedCount"`
	ErrorRate          float64  `json:"errorRate"`
	P95LatencyMs       *float64 `json:"p95LatencyMs"`
	MemoryHeadroom     *float64 `json:"memoryHeadroom"`
	MemorySampleCount  int      `json:"memorySampleCount"`
	LatencySampleCount int      `json:"latencySampleCount"`
	SamplingMode       string   `json:"samplingMode"`
}

// adaptiveStatus is CrawlAdaptiveConcurrencyStatus.
type adaptiveStatus struct {
	Enabled               bool               `json:"enabled"`
	LastDecision          string             `json:"lastDecision"`
	LastAdjustedAt        *string            `json:"lastAdjustedAt"`
	Reason                *string            `json:"reason"`
	CurrentMaxConcurrency int                `json:"currentMaxConcurrency"`
	WindowMinutes         int                `json:"windowMinutes"`
	CooldownMinutes       int                `json:"cooldownMinutes"`
	Thresholds            adaptiveThresholds `json:"thresholds"`
	Metrics               adaptiveMetrics    `json:"metrics"`
}

// QueueStatusResponse is the GET /api/admin/crawl4ai/queue payload.
type QueueStatusResponse struct {
	QueueName            string                 `json:"queueName"`
	LegacyQueueName      string                 `json:"legacyQueueName"`
	QueueMode            string                 `json:"queueMode"`
	QueueNames           queueNames             `json:"queueNames"`
	UpdatedAt            string                 `json:"updatedAt"`
	Pending              int64                  `json:"pending"`
	Counts               crawlqueue.QueueCounts `json:"counts"`
	Paused               bool                   `json:"paused"`
	MaxConcurrency       int                    `json:"maxConcurrency"`
	EffectiveConcurrency int                    `json:"effectiveConcurrency"`
	Queues               queuesStatus           `json:"queues"`
	Adaptive             adaptiveStatus         `json:"adaptive"`
}

// QueueStatus is getQueueStats.
func (s *Service) QueueStatus(ctx context.Context) (QueueStatusResponse, error) {
	settings := s.queue.SettingsReader().ReadNormalized(ctx)
	hotCounts, normalCounts, err := s.queue.CountsByQueue(ctx)
	if err != nil {
		return QueueStatusResponse{}, err
	}
	legacyCounts, err := s.queue.LegacyCounts(ctx)
	if err != nil {
		return QueueStatusResponse{}, err
	}
	hotPaused, normalPaused, err := s.queue.PausedByQueue(ctx)
	if err != nil {
		return QueueStatusResponse{}, err
	}
	legacyPaused, err := s.queue.IsPaused(ctx, crawlqueue.QueueLegacy)
	if err != nil {
		return QueueStatusResponse{}, err
	}
	hotGlobal, err := s.queue.GetGlobalConcurrency(ctx, crawlqueue.QueueHot)
	if err != nil {
		return QueueStatusResponse{}, err
	}
	normalGlobal, err := s.queue.GetGlobalConcurrency(ctx, crawlqueue.QueueNormal)
	if err != nil {
		return QueueStatusResponse{}, err
	}

	maxConcurrency := settings.MaxConcurrency
	hot := queueClassStatus{
		QueueName:            crawlqueue.QueueHot,
		Counts:               hotCounts,
		Pending:              hotCounts.Pending(),
		Paused:               hotPaused,
		EffectiveConcurrency: sanitizeConcurrency(hotGlobal, maxConcurrency),
	}
	normal := queueClassStatus{
		QueueName:            crawlqueue.QueueNormal,
		Counts:               normalCounts,
		Pending:              normalCounts.Pending(),
		Paused:               normalPaused,
		EffectiveConcurrency: sanitizeConcurrency(normalGlobal, maxConcurrency),
	}
	legacy := queueClassStatus{
		QueueName:            crawlqueue.QueueLegacy,
		Counts:               legacyCounts,
		Pending:              legacyCounts.Pending(),
		Paused:               legacyPaused,
		EffectiveConcurrency: sanitizeConcurrency(normalGlobal, maxConcurrency),
	}

	counts := hotCounts.Add(normalCounts).Add(legacyCounts)
	adaptive, err := s.adaptiveStatus(ctx, settings)
	if err != nil {
		return QueueStatusResponse{}, err
	}
	return QueueStatusResponse{
		QueueName:       crawlqueue.QueueHot + "," + crawlqueue.QueueNormal,
		LegacyQueueName: crawlqueue.QueueLegacy,
		QueueMode:       QueueMode,
		QueueNames: queueNames{
			Hot:    crawlqueue.QueueHot,
			Normal: crawlqueue.QueueNormal,
			Legacy: crawlqueue.QueueLegacy,
		},
		UpdatedAt:            s.isoNow(),
		Pending:              counts.Waiting + counts.Active + counts.Delayed,
		Counts:               counts,
		Paused:               aggregatePaused(hot, normal, legacy),
		MaxConcurrency:       maxConcurrency,
		EffectiveConcurrency: maxConcurrency,
		Queues:               queuesStatus{Hot: hot, Normal: normal, Legacy: &legacy},
		Adaptive:             adaptive,
	}, nil
}

// aggregatePaused is the controller's paused expression:
//
//	queues.hot.paused && queues.normal.paused && legacyBlocksPause
//
// legacyBlocksPause is true unless the legacy queue has a backlog (pending jobs
// or paused-list entries); in that case the legacy queue's own paused flag
// decides. A legacy queue without backlog never blocks the aggregate.
func aggregatePaused(hot, normal, legacy queueClassStatus) bool {
	if !hot.Paused || !normal.Paused {
		return false
	}
	if legacy.Pending > 0 || legacy.Counts.Paused > 0 {
		return legacy.Paused
	}
	return true
}

// sanitizeConcurrency is sanitizeConcurrency: a positive value wins, otherwise
// the fallback; both are rounded and floored at 1.
func sanitizeConcurrency(value *int, fallback int) int {
	if value != nil && *value > 0 {
		rounded := *value
		if rounded < 1 {
			rounded = 1
		}
		return rounded
	}
	if fallback < 1 {
		return 1
	}
	return fallback
}

// PauseQueue pauses all three queues and returns the refreshed status.
func (s *Service) PauseQueue(ctx context.Context) (QueueStatusResponse, error) {
	if err := s.queue.Pause(ctx); err != nil {
		return QueueStatusResponse{}, err
	}
	return s.QueueStatus(ctx)
}

// ResumeQueue resumes all three queues and returns the refreshed status.
func (s *Service) ResumeQueue(ctx context.Context) (QueueStatusResponse, error) {
	if err := s.queue.Resume(ctx); err != nil {
		return QueueStatusResponse{}, err
	}
	return s.QueueStatus(ctx)
}

// ConcurrencyUpdate is the POST queue/concurrency payload.
type ConcurrencyUpdate struct {
	UpdatedAt      string `json:"updatedAt"`
	MaxConcurrency int    `json:"maxConcurrency"`
}

// UpdateQueueConcurrency is updateQueueConcurrency: persist the setting through
// the shared crawl settings writer, apply the Redis meta to all three queues,
// and broadcast the C2 worker concurrency message.
func (s *Service) UpdateQueueConcurrency(ctx context.Context, identity *authhttp.Identity, maxConcurrency int) (ConcurrencyUpdate, error) {
	updated, err := settingswrite.UpdateCrawlClientMaxConcurrency(ctx, s.db, s.redis,
		identity.OrgID, identity.UserID, maxConcurrency)
	if err != nil {
		return ConcurrencyUpdate{}, err
	}
	if err := s.queue.SetGlobalConcurrency(ctx, updated); err != nil {
		return ConcurrencyUpdate{}, err
	}
	if err := s.queue.PublishWorkerConcurrency(ctx, updated); err != nil {
		// The setting, cache and Redis meta are already written; NestJS
		// reapplies the value on its next start.
		log.Printf("crawltaskwrite: failed to publish worker concurrency broadcast: %v", err)
	}
	return ConcurrencyUpdate{UpdatedAt: s.isoNow(), MaxConcurrency: updated}, nil
}

// adaptiveStatus is getStatus.
func (s *Service) adaptiveStatus(ctx context.Context, settings settingscrawl.CrawlClientNormalized) (adaptiveStatus, error) {
	thresholds := adaptiveThresholds{
		LatencyRatio:   settings.Settings.AdaptiveLatencyThresholdRatio,
		ErrorRate:      settings.Settings.AdaptiveErrorRateThreshold,
		MemoryHeadroom: settings.Settings.AdaptiveMemoryHeadroomThreshold,
	}
	enabled := settings.Settings.AdaptiveConcurrencyEnabled
	status := adaptiveStatus{
		Enabled:               enabled,
		CurrentMaxConcurrency: settings.MaxConcurrency,
		WindowMinutes:         settings.Settings.AdaptiveWindowMinutes,
		CooldownMinutes:       settings.Settings.AdaptiveCooldownMinutes,
		Thresholds:            thresholds,
		Metrics:               emptyAdaptiveMetrics(),
	}
	if !enabled {
		status.LastDecision = "disabled"
		status.Reason = stringPtrValue("adaptive concurrency is disabled")
		return status, nil
	}
	state, err := s.readAdaptiveState(ctx)
	if err != nil {
		return adaptiveStatus{}, err
	}
	status.LastDecision = "idle"
	if state != nil {
		if state.LastDecision != "" {
			status.LastDecision = state.LastDecision
		}
		status.LastAdjustedAt = state.LastAdjustedAt
		status.Reason = state.Reason
		status.Metrics = normalizeAdaptiveMetrics(state.Metrics)
	}
	return status, nil
}

// adaptiveState is the cached AdaptiveConcurrencyState document.
type adaptiveState struct {
	LastDecision   string           `json:"lastDecision"`
	LastAdjustedAt *string          `json:"lastAdjustedAt"`
	Reason         *string          `json:"reason"`
	Metrics        *adaptiveMetrics `json:"metrics"`
}

func (s *Service) readAdaptiveState(ctx context.Context) (*adaptiveState, error) {
	if s.redis == nil {
		return nil, nil
	}
	raw, err := s.redis.Get(ctx, adaptiveStateCacheKey).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, nil
		}
		return nil, err
	}
	var state adaptiveState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, nil
	}
	return &state, nil
}

// normalizeAdaptiveMetrics is normalizeMetrics: the empty document overridden
// by every cached field, with samplingMode forced to recent_sample.
func normalizeAdaptiveMetrics(metrics *adaptiveMetrics) adaptiveMetrics {
	out := emptyAdaptiveMetrics()
	if metrics == nil {
		return out
	}
	out.TaskCount = metrics.TaskCount
	out.FailedCount = metrics.FailedCount
	out.ErrorRate = metrics.ErrorRate
	out.P95LatencyMs = metrics.P95LatencyMs
	out.MemoryHeadroom = metrics.MemoryHeadroom
	out.MemorySampleCount = metrics.MemorySampleCount
	out.LatencySampleCount = metrics.LatencySampleCount
	return out
}

func emptyAdaptiveMetrics() adaptiveMetrics {
	return adaptiveMetrics{SamplingMode: "recent_sample"}
}

func stringPtrValue(value string) *string { return &value }

// isoNow is new Date().toISOString().
func (s *Service) isoNow() string {
	return s.clock().UTC().Format("2006-01-02T15:04:05.000Z")
}

func (s *Service) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

// parseConcurrencyBody validates UpdateCrawlQueueConcurrencyDto.
func parseConcurrencyBody(body []byte) (int, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return 0, newValidationError([]string{"Bad Request"})
	}
	messages := make([]string, 0, 2)
	unknown := make([]string, 0)
	for key := range fields {
		if key != "maxConcurrency" {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	for _, key := range unknown {
		messages = append(messages, "property "+key+" should not exist")
	}
	raw, present := fields["maxConcurrency"]
	value, ok := numberFromJSON(raw)
	if !present || !ok || !isIntegerNumber(value) {
		messages = append(messages, "maxConcurrency must be an integer number")
	} else if value < 1 {
		messages = append(messages, "maxConcurrency must not be less than 1")
	} else if value > 20 {
		messages = append(messages, "maxConcurrency must not be greater than 20")
	}
	if len(messages) > 0 {
		return 0, newValidationError(messages)
	}
	return int(value), nil
}

// numberFromJSON is @Type(() => Number).
func numberFromJSON(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	trimmed := string(raw)
	switch {
	case trimmed == "null":
		return 0, false
	case len(trimmed) > 0 && trimmed[0] == '"':
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0, false
		}
		return numberFromString(text)
	case trimmed == "true":
		return 1, true
	case trimmed == "false":
		return 0, true
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

func numberFromString(value string) (float64, bool) {
	trimmed := trimSpaces(value)
	if trimmed == "" {
		return 0, true
	}
	var number float64
	if err := json.Unmarshal([]byte(trimmed), &number); err != nil {
		return 0, false
	}
	return number, true
}

func isIntegerNumber(value float64) bool {
	return value == float64(int64(value))
}

func trimSpaces(value string) string {
	start, end := 0, len(value)
	for start < end && (value[start] == ' ' || value[start] == '\t' || value[start] == '\n' || value[start] == '\r') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t' || value[end-1] == '\n' || value[end-1] == '\r') {
		end--
	}
	return value[start:end]
}

// The queue control decorators.
const (
	queueReadPermission   = "crawl.read"
	queueManagePermission = "settings.manage"
)
