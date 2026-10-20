package analysisruns

// This file writes the analysis MySQL notifications and the analysis-only
// realtime relay consumed by the NestJS subscriber.

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const (
	// AnalysisNotificationChannel is the analysis-only realtime seam consumed by
	// the NestJS AnalysisNotificationSubscriber when the Go worker owns the
	// queue. It carries identifiers only; the row stays in MySQL.
	AnalysisNotificationChannel = "analysis:notification:v1"

	notificationTypeAnalysisCompleted = "analysis_completed"
	notificationTypeAnalysisFailed    = "analysis_failed"
	presentationKindAnalysisCompleted = "analysis_completed"
	presentationKindAnalysisFailed    = "analysis_failed"
)

type completedPresentationParams struct {
	AnalysisID   string `json:"analysisId"`
	AnalysisType Type   `json:"analysisType"`
	Summary      string `json:"summary,omitempty"`
}

type completedPresentation struct {
	Kind   string                      `json:"kind"`
	Params completedPresentationParams `json:"params"`
}

type completedNotificationData struct {
	AnalysisID   string                `json:"analysisId"`
	Status       string                `json:"status"`
	Type         Type                  `json:"type"`
	Presentation completedPresentation `json:"presentation"`
}

type failedPresentation struct {
	Kind string `json:"kind"`
}

type failedNotificationData struct {
	AnalysisID   string             `json:"analysisId"`
	Status       string             `json:"status"`
	Type         Type               `json:"type"`
	Presentation failedPresentation `json:"presentation"`
}

type notificationRelayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
	UserID         string `json:"userId"`
}

// notificationData is the closed set of persisted Notification.data payloads.
type notificationData interface {
	notificationPayload()
}

func (completedNotificationData) notificationPayload() {}
func (failedNotificationData) notificationPayload()    {}

// NotificationWriter writes the same MySQL Notification rows the NestJS
// NotificationsService writes, then publishes the analysis-only relay. A row or
// relay failure is returned to the caller as a warning; it never turns a
// completed model run into a failure.
type NotificationWriter struct {
	db    *sql.DB
	redis *redis.Client
}

// NewNotificationWriter reuses the shared MySQL pool and Redis client.
func NewNotificationWriter(db *sql.DB, client *redis.Client) *NotificationWriter {
	return &NotificationWriter{db: db, redis: client}
}

// NotifyCompleted writes analysis_completed and its presentation params.
func (w *NotificationWriter) NotifyCompleted(ctx context.Context, record Record) error {
	if w == nil || w.db == nil {
		return fmt.Errorf("analysisruns: mysql is not configured")
	}
	if record.TriggeredByID == nil || *record.TriggeredByID == "" {
		return nil
	}
	params := completedPresentationParams{
		AnalysisID:   record.ID.Hex(),
		AnalysisType: record.Type,
	}
	if record.Summary != nil && *record.Summary != "" {
		params.Summary = *record.Summary
	}
	data := completedNotificationData{
		AnalysisID: record.ID.Hex(),
		Status:     string(StatusCompleted),
		Type:       record.Type,
		Presentation: completedPresentation{
			Kind:   presentationKindAnalysisCompleted,
			Params: params,
		},
	}
	body := record.Summary
	return w.write(
		ctx,
		record.OrgID,
		*record.TriggeredByID,
		notificationTypeAnalysisCompleted,
		string(record.Type)+" analysis completed",
		body,
		data,
	)
}

// NotifyFinalFailure writes analysis_failed once, only after the last attempt.
// It intentionally keeps the simpler notifyFinalFailure payload (no params and
// no technicalDetail), not the notifyResult failed projection.
func (w *NotificationWriter) NotifyFinalFailure(ctx context.Context, record Record) error {
	if w == nil || w.db == nil {
		return fmt.Errorf("analysisruns: mysql is not configured")
	}
	if record.TriggeredByID == nil || *record.TriggeredByID == "" {
		return nil
	}
	body := "Analysis job failed"
	if record.Error != nil {
		body = *record.Error
	}
	data := failedNotificationData{
		AnalysisID: record.ID.Hex(),
		Status:     string(StatusFailed),
		Type:       record.Type,
		Presentation: failedPresentation{
			Kind: presentationKindAnalysisFailed,
		},
	}
	return w.write(
		ctx,
		record.OrgID,
		*record.TriggeredByID,
		notificationTypeAnalysisFailed,
		string(record.Type)+" analysis failed",
		&body,
		data,
	)
}

func (w *NotificationWriter) write(
	ctx context.Context,
	orgID string,
	userID string,
	notificationType string,
	title string,
	body *string,
	data notificationData,
) error {
	id, err := newNotificationID()
	if err != nil {
		return fmt.Errorf("analysisruns: notification id: %w", err)
	}
	payload, err := marshalNoHTMLEscape(data)
	if err != nil {
		return fmt.Errorf("analysisruns: encode notification data: %w", err)
	}
	now := nowMillis()
	bodyValue := sql.NullString{}
	if body != nil {
		bodyValue = sql.NullString{String: *body, Valid: true}
	}
	if _, err := w.db.ExecContext(ctx,
		"INSERT INTO Notification (id, orgId, userId, type, title, body, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, orgID, userID, notificationType, title, bodyValue, []byte(payload), now, now,
	); err != nil {
		return fmt.Errorf("analysisruns: insert notification: %w", err)
	}
	w.publishRelay(ctx, id, orgID, userID)
	return nil
}

// publishRelay is fire-and-forget: a Redis outage does not remove the durable
// SQL notification. The NestJS subscriber re-reads the row and emits only to
// local matching sockets.
func (w *NotificationWriter) publishRelay(ctx context.Context, notificationID, orgID, userID string) {
	if w == nil || w.redis == nil {
		return
	}
	message, err := marshalNoHTMLEscape(notificationRelayMessage{
		Version:        1,
		NotificationID: notificationID,
		OrgID:          orgID,
		UserID:         userID,
	})
	if err != nil {
		return
	}
	_ = w.redis.Publish(ctx, AnalysisNotificationChannel, message).Err()
}

// newNotificationID writes a Prisma cuid-shaped id (c + 24 hex chars). The
// database column has no default because Prisma fills it client-side.
func newNotificationID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}
