package notificationssocket

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Realtime error codes mirror @modular/utils RealtimeSocketErrorCode. The
// browser already renders these codes, so the strings are part of the wire
// contract.
const (
	codeUnauthorized             = "UNAUTHORIZED"
	codeTooManyConnections       = "TOO_MANY_CONNECTIONS"
	codeTooManyConnectionAttempt = "TOO_MANY_CONNECTION_ATTEMPTS"
	codeRateLimitExceeded        = "RATE_LIMIT_EXCEEDED"
	codeTooManyFailedAttempts    = "TOO_MANY_FAILED_ATTEMPTS"
)

// NotificationEvent is the exact payload the NestJS notifications.gateway
// emits on the "notification" event. JSON tags and nullability follow
// NotificationEvent in apps/api/src/modules/notifications/notification.dispatcher.ts.
type NotificationEvent struct {
	ID        string          `json:"id"`
	OrgID     string          `json:"orgId"`
	UserID    *string         `json:"userId"`
	Type      string          `json:"type"`
	Title     string          `json:"title"`
	Body      *string         `json:"body"`
	Data      json.RawMessage `json:"data"`
	ReadAt    *string         `json:"readAt"`
	CreatedAt string          `json:"createdAt"`
}

// socketErrorPayload is the "notification:error" event body.
type socketErrorPayload struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	RetryAfterMS *int64 `json:"retryAfterMs,omitempty"`
}

// relayMessage is the identifiers-only envelope published by api-go workers
// and by the NestJS NotificationsService in go mode. Display data is always
// re-read from MySQL; the relay is not a durable event log.
type relayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
	UserID         string `json:"userId,omitempty"`
}

// relay-channel kinds. Each channel keeps the validation its NestJS
// subscriber performs, so a malformed or cross-domain envelope cannot turn
// into an arbitrary realtime event.
type relayKind int

const (
	relayGeneric relayKind = iota
	relayAlert
	relayAnalysis
	relayDigest
	relayNewsSource
)

const (
	relayVersion = 1

	channelGeneric    = "notification:events:v1"
	channelAlert      = "alert:notifications:v1"
	channelAnalysis   = "analysis:notification:v1"
	channelDigest     = "user-digest:notifications:v1"
	channelNewsSource = "news-source:notifications:v1"
)

var relayChannels = map[string]relayKind{
	channelGeneric:    relayGeneric,
	channelAlert:      relayAlert,
	channelAnalysis:   relayAnalysis,
	channelDigest:     relayDigest,
	channelNewsSource: relayNewsSource,
}

func parseRelayMessage(raw string) (relayMessage, error) {
	var message relayMessage
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		return relayMessage{}, err
	}
	if message.Version != relayVersion {
		return relayMessage{}, fmt.Errorf("unsupported notification relay version %d", message.Version)
	}
	if strings.TrimSpace(message.NotificationID) == "" || strings.TrimSpace(message.OrgID) == "" {
		return relayMessage{}, fmt.Errorf("notification relay is missing id or orgId")
	}
	return message, nil
}

// notificationData is the closed subset of Notification.data used to verify
// that a relayed row still belongs to the domain that published it. Unknown
// leaves stay unparsed; the original raw JSON is what gets emitted.
type notificationData struct {
	AnalysisID   string                    `json:"analysisId"`
	Presentation *notificationPresentation `json:"presentation"`
}

type notificationPresentation struct {
	Kind string `json:"kind"`
}

func validateRelayedRow(kind relayKind, event NotificationEvent) bool {
	switch kind {
	case relayGeneric:
		return true
	case relayAlert:
		if event.Type != "alert_triggered" {
			return false
		}
		data, ok := parseNotificationData(event.Data)
		return ok && data.Presentation != nil && data.Presentation.Kind == "alert_triggered"
	case relayAnalysis:
		if event.Type != "analysis_completed" && event.Type != "analysis_failed" {
			return false
		}
		data, ok := parseNotificationData(event.Data)
		if !ok || strings.TrimSpace(data.AnalysisID) == "" || data.Presentation == nil {
			return false
		}
		return data.Presentation.Kind == "analysis_completed" || data.Presentation.Kind == "analysis_failed"
	case relayDigest:
		if event.Type != "system" {
			return false
		}
		data, ok := parseNotificationData(event.Data)
		if !ok || data.Presentation == nil {
			return false
		}
		switch data.Presentation.Kind {
		case "user_digest_ready", "user_digest_empty", "user_digest_delivery_failed":
			return true
		}
		return false
	case relayNewsSource:
		// News-source alerts are org-wide system rows (userId NULL) written by
		// the Go scheduler/ops takeover, so a user-scoped row must never be
		// fanned out to the whole organization.
		if event.Type != "system" || event.UserID != nil {
			return false
		}
		data, ok := parseNotificationData(event.Data)
		if !ok || data.Presentation == nil {
			return false
		}
		switch data.Presentation.Kind {
		case "news_source_scheduler_backpressure",
			"news_source_rss_body_missing_spike",
			"news_source_pipeline_retry_spike",
			// Item pipeline circuit-open / auto-disable alerts: org-wide system
			// rows written by the Go itempipeline worker after a final failure.
			"news_source_circuit_opened",
			"news_source_auto_disabled":
			return true
		}
		return false
	default:
		return false
	}
}

func parseNotificationData(raw json.RawMessage) (notificationData, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return notificationData{}, true
	}
	var data notificationData
	if err := json.Unmarshal(raw, &data); err != nil {
		return notificationData{}, false
	}
	return data, true
}

func formatISOMillis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}
