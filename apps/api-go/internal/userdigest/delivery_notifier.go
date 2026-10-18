package userdigest

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"
)

const (
	// notificationTypeSystem is the Prisma NotificationType value.
	notificationTypeSystem = "system"

	// notificationLinkToday is the link the three digest presentations carry.
	notificationLinkToday = "/today"

	// presentationKindUserDigestReady mirrors
	// NotificationPresentationKind.UserDigestReady.
	presentationKindUserDigestReady = "user_digest_ready"
	// presentationKindUserDigestEmpty mirrors
	// NotificationPresentationKind.UserDigestEmpty.
	presentationKindUserDigestEmpty = "user_digest_empty"
	// presentationKindUserDigestDeliveryFailed mirrors
	// NotificationPresentationKind.UserDigestDeliveryFailed.
	presentationKindUserDigestDeliveryFailed = "user_digest_delivery_failed"

	notificationTitleReady   = "每日摘要已送达"
	notificationTitleEmpty   = "今日摘要暂无新内容"
	notificationTitleFailure = "每日摘要投递失败"

	notificationBodyEmpty = "当前窗口内没有新的摘要事件，系统将在下一个日程点继续检查。"
)

// digestReadyPresentationParams is the params object of the ready
// presentation.
type digestReadyPresentationParams struct {
	Link        string `json:"link"`
	EventCount  int    `json:"eventCount"`
	GeneratedAt string `json:"generatedAt"`
	NextRunAt   string `json:"nextRunAt"`
}

// digestReadyPresentation is the typed ready presentation.
type digestReadyPresentation struct {
	Kind   string                        `json:"kind"`
	Params digestReadyPresentationParams `json:"params"`
}

// digestReadyNotificationData is the typed Notification.data payload for the
// ready notification.
type digestReadyNotificationData struct {
	Link         string                  `json:"link"`
	Presentation digestReadyPresentation `json:"presentation"`
}

// digestEmptyPresentationParams is the params object of the empty
// presentation.
type digestEmptyPresentationParams struct {
	Link      string `json:"link"`
	NextRunAt string `json:"nextRunAt"`
}

// digestEmptyPresentation is the typed empty presentation.
type digestEmptyPresentation struct {
	Kind   string                        `json:"kind"`
	Params digestEmptyPresentationParams `json:"params"`
}

// digestEmptyNotificationData is the typed Notification.data payload for the
// empty notification.
type digestEmptyNotificationData struct {
	Link         string                  `json:"link"`
	Presentation digestEmptyPresentation `json:"presentation"`
}

// digestFailurePresentationParams is the params object of the failure
// presentation.
type digestFailurePresentationParams struct {
	Link        string `json:"link"`
	TargetEmail string `json:"targetEmail"`
	Message     string `json:"message"`
}

// digestFailurePresentation is the typed failure presentation. technicalDetail
// repeats the message, matching the NestJS payload.
type digestFailurePresentation struct {
	Kind            string                          `json:"kind"`
	Params          digestFailurePresentationParams `json:"params"`
	TechnicalDetail string                          `json:"technicalDetail"`
}

// digestFailureNotificationData is the typed Notification.data payload for the
// failure notification.
type digestFailureNotificationData struct {
	Link         string                    `json:"link"`
	Presentation digestFailurePresentation `json:"presentation"`
}

// digestNotificationRelayMessage is the digest-only Redis pub/sub envelope. It
// carries identifiers only; the notification body stays in MySQL.
type digestNotificationRelayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
	UserID         string `json:"userId"`
}

// mysqlDeliveryNotifier persists the notification row first and only then
// publishes the relay message. A publish failure is logged and never turns a
// successfully delivered email into a delivery failure.
type mysqlDeliveryNotifier struct {
	db    *sql.DB
	store DeliveryStore
	now   func() time.Time
}

// NewDeliveryNotifier builds the notifier from the shared pool and delivery
// store.
func NewDeliveryNotifier(db *sql.DB, store DeliveryStore) DeliveryNotifier {
	return &mysqlDeliveryNotifier{db: db, store: store}
}

// NotifyReady writes the user_digest_ready notification.
func (n *mysqlDeliveryNotifier) NotifyReady(ctx context.Context, orgID, userID string, params DigestReadyParams) error {
	body := fmt.Sprintf("本次已发送 %d 条摘要事件。", params.EventCount)
	data := digestReadyNotificationData{
		Link: notificationLinkToday,
		Presentation: digestReadyPresentation{
			Kind: presentationKindUserDigestReady,
			Params: digestReadyPresentationParams{
				Link:        params.Link,
				EventCount:  params.EventCount,
				GeneratedAt: params.GeneratedAt,
				NextRunAt:   params.NextRunAt,
			},
		},
	}
	payload, err := marshalJSON(data)
	if err != nil {
		return fmt.Errorf("%w: encode digest notification: %v", errMySQL, err)
	}
	return n.write(ctx, orgID, userID, notificationTitleReady, body, payload)
}

// NotifyEmpty writes the user_digest_empty notification.
func (n *mysqlDeliveryNotifier) NotifyEmpty(ctx context.Context, orgID, userID string, params DigestEmptyParams) error {
	data := digestEmptyNotificationData{
		Link: notificationLinkToday,
		Presentation: digestEmptyPresentation{
			Kind: presentationKindUserDigestEmpty,
			Params: digestEmptyPresentationParams{
				Link:      params.Link,
				NextRunAt: params.NextRunAt,
			},
		},
	}
	payload, err := marshalJSON(data)
	if err != nil {
		return fmt.Errorf("%w: encode digest notification: %v", errMySQL, err)
	}
	return n.write(ctx, orgID, userID, notificationTitleEmpty, notificationBodyEmpty, payload)
}

// NotifyFailure writes the user_digest_delivery_failed notification.
func (n *mysqlDeliveryNotifier) NotifyFailure(ctx context.Context, orgID, userID string, params DigestFailureParams) error {
	data := digestFailureNotificationData{
		Link: notificationLinkToday,
		Presentation: digestFailurePresentation{
			Kind: presentationKindUserDigestDeliveryFailed,
			Params: digestFailurePresentationParams{
				Link:        params.Link,
				TargetEmail: params.TargetEmail,
				Message:     params.Message,
			},
			TechnicalDetail: params.Message,
		},
	}
	payload, err := marshalJSON(data)
	if err != nil {
		return fmt.Errorf("%w: encode digest notification: %v", errMySQL, err)
	}
	return n.write(ctx, orgID, userID, notificationTitleFailure, params.Message, payload)
}

// write inserts one Notification row and then publishes the relay envelope. The
// handler returns an error only when the row itself could not be written; the
// publish step is best effort, like the NestJS NotificationDispatcher fan-out.
func (n *mysqlDeliveryNotifier) write(ctx context.Context, orgID, userID, title, body string, payload []byte) error {
	if n == nil || n.db == nil {
		return fmt.Errorf("%w: mysql is not configured", errMySQL)
	}
	id, err := newRowID()
	if err != nil {
		return fmt.Errorf("%w: digest notification id: %v", errMySQL, err)
	}
	now := n.clock().UTC().Truncate(time.Millisecond)
	if _, err := n.db.ExecContext(ctx,
		"INSERT INTO Notification (id, orgId, userId, type, title, body, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, orgID, userID, notificationTypeSystem, title, body, []byte(payload), now, now,
	); err != nil {
		return fmt.Errorf("%w: insert digest notification: %v", errMySQL, err)
	}
	n.publish(ctx, id, orgID, userID)
	return nil
}

// publish sends the digest-only relay envelope. It is fire-and-forget: a Redis
// outage does not fail the notification row or the delivered email.
func (n *mysqlDeliveryNotifier) publish(ctx context.Context, notificationID, orgID, userID string) {
	if n == nil || n.store == nil {
		return
	}
	message, err := marshalJSON(digestNotificationRelayMessage{
		Version:        1,
		NotificationID: notificationID,
		OrgID:          orgID,
		UserID:         userID,
	})
	if err != nil {
		log.Printf("userdigest: encode digest notification relay message: %v", err)
		return
	}
	if err := n.store.Publish(ctx, deliveryNotificationChannel, string(message)); err != nil {
		log.Printf("userdigest: publish digest notification relay failed: %v", err)
	}
}

func (n *mysqlDeliveryNotifier) clock() time.Time {
	if n != nil && n.now != nil {
		return n.now()
	}
	return time.Now()
}
