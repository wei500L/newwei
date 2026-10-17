package classificationrssops

import (
	"context"
	"encoding/json"
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

// writeClassificationAlertNotification inserts one Notification row. NestJS also
// publishes the row on its realtime dispatcher; Go only persists the row because
// the dispatcher fan-out lives in the NestJS process, which is still the writer
// for every other notification type.
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
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `
INSERT INTO Notification (id, orgId, userId, type, title, body, data, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, orgID, userID, notificationTypeSystem, classificationAlertTitle, body, []byte(payload), now, now)
	return err
}
