package classificationrssops

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/redis/go-redis/v9"
)

// Notification realtime relay contract, copied from
// apps/api/src/modules/notifications/notification-realtime.relay.ts.
//
// Classification quality threshold alerts are written by this package (both the
// HTTP summary route and the five-minute scheduler). In
// API_GO_NOTIFICATIONS_SOCKET_MODE=go the NestJS NotificationsService is not the
// writer for those rows, so it never publishes their relay message: without this
// hook the rows would be persisted but never reach the Go /notifications
// transport. The relay is identifiers-only because the Go subscriber re-reads
// the committed row from MySQL before emitting.
const (
	// notificationRelayChannel is NOTIFICATION_REALTIME_CHANNEL.
	notificationRelayChannel = "notification:events:v1"
	// notificationRelayVersion is RELAY_VERSION.
	notificationRelayVersion = 1
)

// NotificationRelayPublisher publishes the identifiers-only relay envelope after
// a Notification row is committed. An empty userID means an organization-wide
// row (userId NULL), so the message omits the key.
type NotificationRelayPublisher func(ctx context.Context, notificationID, orgID, userID string) error

// notificationRelayMessage is the wire envelope NotificationRelay.publish writes:
// key order version, notificationId, orgId, userId; userId is omitted for an
// organization-wide notification.
type notificationRelayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
	UserID         string `json:"userId,omitempty"`
}

// errNoRedisClient fails closed when the relay publisher was built without the
// shared Redis client.
var errNoRedisClient = errors.New("classificationrssops: redis is not configured")

// SetNotificationRelayPublisher installs the optional notification:events:v1
// publisher. cmd/api calls it only when the Go notifications transport owns the
// socket, which reproduces the NotificationsService.notify go-mode branch; a nil
// publisher (the legacy default) keeps publishing disabled. The setter must be
// called before the service starts handling requests or evaluating summaries.
func (s *Service) SetNotificationRelayPublisher(publisher NotificationRelayPublisher) {
	s.notificationRelayMu.Lock()
	s.notificationRelayPublisher = publisher
	s.notificationRelayMu.Unlock()
}

// NewRedisNotificationRelayPublisher builds the production publisher on the
// shared Redis client. Every publish is one PUBLISH on notification:events:v1
// with the identifiers-only JSON payload.
func NewRedisNotificationRelayPublisher(client *redis.Client) NotificationRelayPublisher {
	return func(ctx context.Context, notificationID, orgID, userID string) error {
		if client == nil {
			return errNoRedisClient
		}
		payload, err := notificationRelayPayload(notificationID, orgID, userID)
		if err != nil {
			return err
		}
		return client.Publish(ctx, notificationRelayChannel, payload).Err()
	}
}

// notificationRelayPayload serializes the identifiers-only envelope. It is a pure
// function so the wire contract is tested without Redis.
func notificationRelayPayload(notificationID, orgID, userID string) ([]byte, error) {
	return json.Marshal(notificationRelayMessage{
		Version:        notificationRelayVersion,
		NotificationID: notificationID,
		OrgID:          orgID,
		UserID:         userID,
	})
}
