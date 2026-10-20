package newssourcescheduler

import (
	"context"
	"encoding/json"
	"time"
)

// This file ports the two scheduler metric alerts and the system notification
// writes. Every notification is an org-wide row (userId NULL, type system) whose
// data carries the presentation descriptor the console renders. After the row is
// written Go publishes news-source:notifications:v1 so the NestJS subscriber can
// push it over Socket.IO, mirroring the alert and digest relays.

// notificationPresentation is the presentation descriptor.
type notificationPresentation struct {
	Kind   string          `json:"kind"`
	Params json.RawMessage `json:"params"`
}

// backpressureParams is the backpressure presentation params object.
type backpressureParams struct {
	PendingJobs  int    `json:"pendingJobs"`
	Threshold    int    `json:"threshold"`
	DelayedCount int    `json:"delayedCount"`
	RescheduleAt string `json:"rescheduleAt"`
}

// rssNoBodySkipParams is the RSS body-missing presentation params object.
type rssNoBodySkipParams struct {
	SourceID       string  `json:"sourceId"`
	SourceName     *string `json:"sourceName,omitempty"`
	SkippedCount   int     `json:"skippedCount"`
	SourceCount24h int64   `json:"sourceCount24h"`
	OrgCount24h    int64   `json:"orgCount24h"`
	Context        string  `json:"context"`
	Threshold      int     `json:"threshold"`
}

// pipelineRetryParams is the pipeline-retry presentation params object.
type pipelineRetryParams struct {
	SourceID       string  `json:"sourceId"`
	SourceName     *string `json:"sourceName,omitempty"`
	PipelineJobID  string  `json:"pipelineJobId"`
	RetryType      string  `json:"retryType"`
	SourceCount24h int64   `json:"sourceCount24h"`
	OrgCount24h    int64   `json:"orgCount24h"`
	Threshold      int     `json:"threshold"`
}

// backpressureNotificationData is the Notification.data of the backpressure alert.
type backpressureNotificationData struct {
	PendingJobs  int                      `json:"pendingJobs"`
	Threshold    int                      `json:"threshold"`
	DelayedCount int                      `json:"delayedCount"`
	RescheduleAt string                   `json:"rescheduleAt"`
	Presentation notificationPresentation `json:"presentation"`
}

// rssNoBodySkipNotificationData is the Notification.data of the RSS alert.
type rssNoBodySkipNotificationData struct {
	SourceID       string                   `json:"sourceId"`
	SourceName     *string                  `json:"sourceName,omitempty"`
	SkippedCount   int                      `json:"skippedCount"`
	SourceCount24h int64                    `json:"sourceCount24h"`
	OrgCount24h    int64                    `json:"orgCount24h"`
	Context        string                   `json:"context"`
	Threshold      int                      `json:"threshold"`
	Presentation   notificationPresentation `json:"presentation"`
}

// pipelineRetryNotificationData is the Notification.data of the retry alert.
type pipelineRetryNotificationData struct {
	SourceID       string                   `json:"sourceId"`
	SourceName     *string                  `json:"sourceName,omitempty"`
	PipelineJobID  string                   `json:"pipelineJobId"`
	RetryType      string                   `json:"retryType"`
	SourceCount24h int64                    `json:"sourceCount24h"`
	OrgCount24h    int64                    `json:"orgCount24h"`
	Threshold      int                      `json:"threshold"`
	Presentation   notificationPresentation `json:"presentation"`
}

// metricAlertGate is the per-source alert cooldown value.
type metricAlertGate struct {
	At             string `json:"at"`
	SourceCount24h int64  `json:"sourceCount24h"`
	OrgCount24h    int64  `json:"orgCount24h"`
	Context        string `json:"context,omitempty"`
	PipelineJobID  string `json:"pipelineJobId,omitempty"`
}

// notificationRelayMessage is the identifier-only relay envelope. The
// notification body stays in MySQL; the subscriber re-reads it by id + orgId.
type notificationRelayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
}

// notifySystem writes one system notification and asks NestJS to push it.
func (s *Service) notifySystem(ctx context.Context, orgID, title, body string, data json.RawMessage) {
	if s.repo == nil {
		return
	}
	notificationID, _, err := s.repo.InsertNotification(ctx, notificationInsert{
		OrgID: orgID,
		Title: title,
		Body:  body,
		Data:  data,
		Type:  "system",
	})
	if err != nil {
		s.logWarn("failed to write news source system notification", "orgId", orgID, "error", err)
		return
	}
	if s.cache == nil {
		return
	}
	payload, marshalErr := json.Marshal(notificationRelayMessage{
		Version:        notificationRelayVersion,
		NotificationID: notificationID,
		OrgID:          orgID,
	})
	if marshalErr != nil {
		return
	}
	if publishErr := s.cache.Publish(ctx, notificationRelayChannel, payload); publishErr != nil {
		s.logWarn("failed to publish news source notification relay", "orgId", orgID, "error", publishErr)
	}
}

// recordRSSNoBodySkipMetric is recordRssNoBodySkipMetric.
func (s *Service) recordRSSNoBodySkipMetric(ctx context.Context, orgID, sourceID string, sourceName *string, skippedCount int, metricsContext string) {
	if skippedCount <= 0 {
		return
	}
	sourceKey := "news-source:metric:rss-no-body-skip:source:" + sourceID + ":24h"
	orgKey := "news-source:metric:rss-no-body-skip:org:" + orgID + ":24h"

	sourceCount, err := s.cache.HIncrBy(ctx, sourceKey, "count", int64(skippedCount))
	if err != nil {
		s.logWarn("failed to record RSS no-body skip metric", "orgId", orgID, "sourceId", sourceID, "error", err)
		return
	}
	orgCount, err := s.cache.HIncrBy(ctx, orgKey, "count", int64(skippedCount))
	if err != nil {
		s.logWarn("failed to record RSS no-body skip metric", "orgId", orgID, "sourceId", sourceID, "error", err)
		return
	}
	ttl := time.Duration(sourceMetricWindowTTLSeconds) * time.Second
	if expireErr := s.cache.Expire(ctx, sourceKey, ttl); expireErr != nil {
		s.logWarn("failed to expire RSS no-body skip metric", "key", sourceKey, "error", expireErr)
	}
	if expireErr := s.cache.Expire(ctx, orgKey, ttl); expireErr != nil {
		s.logWarn("failed to expire RSS no-body skip metric", "key", orgKey, "error", expireErr)
	}
	s.logWarn("recorded RSS no-body skip metric",
		"orgId", orgID, "sourceId", sourceID, "skippedCount", skippedCount,
		"sourceCount24h", sourceCount, "orgCount24h", orgCount, "context", metricsContext)
	if sourceCount < rssNoBodySkipAlertThreshold {
		return
	}
	notifyKey := "news-source:metric:rss-no-body-skip:alert:" + sourceID
	acquired, setErr := s.cacheSetIfAbsentJSON(ctx, notifyKey, metricAlertGate{
		At:             isoMillis(s.now()),
		SourceCount24h: sourceCount,
		OrgCount24h:    orgCount,
		Context:        metricsContext,
	}, time.Duration(sourceMetricAlertCooldownSeconds)*time.Second)
	if setErr != nil {
		s.logWarn("failed to gate RSS no-body skip alert", "sourceId", sourceID, "error", setErr)
		return
	}
	if !acquired {
		return
	}
	resolvedName := s.sourceNameForAlert(ctx, sourceID, sourceName)
	params := rssNoBodySkipParams{
		SourceID:       sourceID,
		SourceName:     resolvedName,
		SkippedCount:   skippedCount,
		SourceCount24h: sourceCount,
		OrgCount24h:    orgCount,
		Context:        metricsContext,
		Threshold:      rssNoBodySkipAlertThreshold,
	}
	data := rssNoBodySkipNotificationData{
		SourceID:       sourceID,
		SourceName:     resolvedName,
		SkippedCount:   skippedCount,
		SourceCount24h: sourceCount,
		OrgCount24h:    orgCount,
		Context:        metricsContext,
		Threshold:      rssNoBodySkipAlertThreshold,
		Presentation: notificationPresentation{
			Kind:   presentationKindRSSBodyMissingSpike,
			Params: mustJSON(params),
		},
	}
	label := sourceID
	if resolvedName != nil {
		label = *resolvedName
	}
	s.notifySystem(ctx, orgID, "News source RSS body-missing spike",
		"Source "+label+" skipped "+formatJSNumber(float64(sourceCount))+" RSS item(s) without usable body in the last 24h.",
		mustJSON(data))
}

// recordPipelineRetryMetric is recordPipelineRetryMetric.
func (s *Service) recordPipelineRetryMetric(ctx context.Context, orgID, sourceID string, sourceName *string, pipelineJobID string) {
	sourceKey := "news-source:metric:pipeline-retry:source:" + sourceID + ":24h"
	orgKey := "news-source:metric:pipeline-retry:org:" + orgID + ":24h"

	sourceCount, err := s.cache.HIncrBy(ctx, sourceKey, "count", 1)
	if err != nil {
		s.logWarn("failed to record pipeline retry metric", "orgId", orgID, "sourceId", sourceID, "error", err)
		return
	}
	orgCount, err := s.cache.HIncrBy(ctx, orgKey, "count", 1)
	if err != nil {
		s.logWarn("failed to record pipeline retry metric", "orgId", orgID, "sourceId", sourceID, "error", err)
		return
	}
	ttl := time.Duration(sourceMetricWindowTTLSeconds) * time.Second
	if expireErr := s.cache.Expire(ctx, sourceKey, ttl); expireErr != nil {
		s.logWarn("failed to expire pipeline retry metric", "key", sourceKey, "error", expireErr)
	}
	if expireErr := s.cache.Expire(ctx, orgKey, ttl); expireErr != nil {
		s.logWarn("failed to expire pipeline retry metric", "key", orgKey, "error", expireErr)
	}
	s.logInfo("recorded pipeline retry metric",
		"orgId", orgID, "sourceId", sourceID, "pipelineJobId", pipelineJobID,
		"retryType", "pipeline", "sourceCount24h", sourceCount, "orgCount24h", orgCount)
	if sourceCount < pipelineRetryAlertThreshold {
		return
	}
	notifyKey := "news-source:metric:pipeline-retry:alert:" + sourceID
	acquired, setErr := s.cacheSetIfAbsentJSON(ctx, notifyKey, metricAlertGate{
		At:             isoMillis(s.now()),
		SourceCount24h: sourceCount,
		OrgCount24h:    orgCount,
		PipelineJobID:  pipelineJobID,
	}, time.Duration(sourceMetricAlertCooldownSeconds)*time.Second)
	if setErr != nil {
		s.logWarn("failed to gate pipeline retry alert", "sourceId", sourceID, "error", setErr)
		return
	}
	if !acquired {
		return
	}
	resolvedName := s.sourceNameForAlert(ctx, sourceID, sourceName)
	params := pipelineRetryParams{
		SourceID:       sourceID,
		SourceName:     resolvedName,
		PipelineJobID:  pipelineJobID,
		RetryType:      "pipeline",
		SourceCount24h: sourceCount,
		OrgCount24h:    orgCount,
		Threshold:      pipelineRetryAlertThreshold,
	}
	data := pipelineRetryNotificationData{
		SourceID:       sourceID,
		SourceName:     resolvedName,
		PipelineJobID:  pipelineJobID,
		RetryType:      "pipeline",
		SourceCount24h: sourceCount,
		OrgCount24h:    orgCount,
		Threshold:      pipelineRetryAlertThreshold,
		Presentation: notificationPresentation{
			Kind:   presentationKindPipelineRetrySpike,
			Params: mustJSON(params),
		},
	}
	label := sourceID
	if resolvedName != nil {
		label = *resolvedName
	}
	s.notifySystem(ctx, orgID, "News source pipeline retry spike",
		"Source "+label+" retried "+formatJSNumber(float64(sourceCount))+" pipeline job(s) in the last 24h.",
		mustJSON(data))
}

// sourceNameForAlert is the `options.sourceName?.trim().length ? … : lookup`
// branch.
func (s *Service) sourceNameForAlert(ctx context.Context, sourceID string, provided *string) *string {
	if provided != nil {
		trimmed := trimJS(*provided)
		if trimmed != "" {
			return &trimmed
		}
	}
	if s.repo == nil {
		return nil
	}
	source, err := s.repo.LoadSource(ctx, sourceID)
	if err != nil || source == nil {
		return nil
	}
	name := source.Name
	return &name
}

// notifyBackpressure is the backpressure notification for one organization.
func (s *Service) notifyBackpressure(ctx context.Context, orgID string, pendingJobs int, threshold int, delayedCount int, rescheduleAt string) {
	params := backpressureParams{
		PendingJobs:  pendingJobs,
		Threshold:    threshold,
		DelayedCount: delayedCount,
		RescheduleAt: rescheduleAt,
	}
	data := backpressureNotificationData{
		PendingJobs:  pendingJobs,
		Threshold:    threshold,
		DelayedCount: delayedCount,
		RescheduleAt: rescheduleAt,
		Presentation: notificationPresentation{
			Kind:   presentationKindBackpressure,
			Params: mustJSON(params),
		},
	}
	s.notifySystem(ctx, orgID, "News source scheduler backpressure",
		"Delayed "+formatJSNumber(float64(delayedCount))+" source(s) until "+rescheduleAt+
			" (pending "+formatJSNumber(float64(pendingJobs))+" > threshold "+formatJSNumber(float64(threshold))+").",
		mustJSON(data))
}
