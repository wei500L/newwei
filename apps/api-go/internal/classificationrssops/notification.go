package classificationrssops

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"
)

// notificationTypeSystem is the Prisma NotificationType value used by the
// classification threshold alert.
const notificationTypeSystem = "system"

// presentationKindClassificationQualityThreshold mirrors
// NotificationPresentationKind.ClassificationQualityThresholdExceeded.
const presentationKindClassificationQualityThreshold = "classification_quality_threshold_exceeded"

// classificationAlertTitle mirrors the notification title.
const classificationAlertTitle = "Classification quality threshold exceeded"

// notificationPresentationParams mirrors the params object of the
// classification quality presentation payload. The summary fields are omitted
// when empty, exactly like the conditional spread in the NestJS service.
type notificationPresentationParams struct {
	Window            QualityWindow `json:"window"`
	LatencyAlertCount int           `json:"latencyAlertCount"`
	GateAlertCount    int           `json:"gateAlertCount"`
	LatencySummary    string        `json:"latencySummary,omitempty"`
	GateSummary       string        `json:"gateSummary,omitempty"`
	LatencyStages     []string      `json:"latencyStages"`
	GateMetrics       []string      `json:"gateMetrics"`
}

// notificationPresentation mirrors the presentation object.
type notificationPresentation struct {
	Kind            string                         `json:"kind"`
	Params          notificationPresentationParams `json:"params"`
	TechnicalDetail string                         `json:"technicalDetail"`
}

// classificationAlertNotificationData is the typed Notification.data payload for
// the classification quality threshold alert.
type classificationAlertNotificationData struct {
	Domain        string                   `json:"domain"`
	Window        QualityWindow            `json:"window"`
	LatencyAlerts []latencyAlert           `json:"latencyAlerts"`
	GateAlerts    []gateAlert              `json:"gateAlerts"`
	Presentation  notificationPresentation `json:"presentation"`
}

// classificationAlertInsertRow writes one Notification row. It is a package
// variable so the alert-relay tests can exercise the success and failure paths
// without MySQL; production always uses the INSERT statement below, which is the
// exact row NestJS NotificationsService.notify commits.
var classificationAlertInsertRow = func(
	ctx context.Context,
	db *sql.DB,
	id, orgID string,
	userID *string,
	body string,
	payload []byte,
	now time.Time,
) error {
	_, err := db.ExecContext(ctx, `
INSERT INTO Notification (id, orgId, userId, type, title, body, data, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, orgID, userID, notificationTypeSystem, classificationAlertTitle, body, payload, now, now)
	return err
}

// writeClassificationAlertNotification inserts one Notification row and, when the
// optional relay hook is installed, publishes its identifiers after the commit.
// The row is the source of truth: a failed publish is only logged, because the
// inbox can still re-read it and a realtime event must never turn a summary
// evaluation into a failure.
func (s *Service) writeClassificationAlertNotification(
	ctx context.Context,
	orgID string,
	userID *string,
	body string,
	data classificationAlertNotificationData,
) error {
	if s.db == nil {
		return errNoDatabase
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	id, err := newRowID()
	if err != nil {
		return err
	}
	if err := classificationAlertInsertRow(ctx, s.db, id, orgID, userID, body, payload, nowMillis()); err != nil {
		return err
	}
	s.publishClassificationAlertRelay(ctx, id, orgID, userID)
	return nil
}

// publishClassificationAlertRelay mirrors the NotificationsService.notify branch
// that calls NotificationRealtimeRelay.publish after Prisma commits the row. The
// hook is nil unless cmd/api installed it for
// API_GO_NOTIFICATIONS_SOCKET_MODE=go, so legacy notifications mode keeps the
// in-process NestJS dispatcher as the only realtime path.
func (s *Service) publishClassificationAlertRelay(ctx context.Context, notificationID, orgID string, userID *string) {
	s.notificationRelayMu.RLock()
	publisher := s.notificationRelayPublisher
	s.notificationRelayMu.RUnlock()
	if publisher == nil {
		return
	}
	userIDValue := ""
	if userID != nil {
		userIDValue = *userID
	}
	if err := publisher(ctx, notificationID, orgID, userIDValue); err != nil {
		log.Printf("classification rss ops: failed to publish notification relay notificationId=%s orgId=%s: %v",
			notificationID, orgID, err)
	}
}
