package newssourcescheduler

// This file exposes the existing org-wide system notification writer, the
// generic relay variant and the ops-snapshot refresh to the migrated workers.
// NotifySystem keeps its behaviour (MySQL Notification row + the
// news-source:notifications:v1 identifier relay) for the itemPipeline worker;
// NotifySystemGeneric writes the same row but publishes the generic
// notification:events:v1 relay instead, so a Go-owned crawl notification is
// never delivered twice through the legacy socket adapter.

import (
	"context"
	"encoding/json"
)

// systemNotificationType is Prisma NotificationType.system.
const systemNotificationType = "system"

// NotificationRelayFunc publishes one identifiers-only notification relay
// message after the row is committed. An empty userID means an org-wide row
// (userId NULL) and the publisher then omits the member.
type NotificationRelayFunc func(ctx context.Context, notificationID, orgID, userID string) error

// NotifySystem writes one org-wide (userId NULL, type system) notification and
// publishes the identifier-only relay. Failures are logged and swallowed,
// exactly like the memory alert path.
func (s *Service) NotifySystem(ctx context.Context, orgID, title, body string, data json.RawMessage) {
	if s == nil {
		return
	}
	s.notifySystem(ctx, orgID, title, body, data)
}

// NotifySystemGeneric writes one org-wide (userId NULL, type system)
// notification and hands its id to the caller-provided relay publisher. It is
// the B3 variant: the row is written exactly like notifySystem, but the relay
// goes to notification:events:v1 instead of news-source:notifications:v1, so
// the generic subscriber (and the Go notifications transport) owns delivery and
// the legacy socket subscriber never sees the same row. A nil relay writes the
// row and publishes nothing. Failures are logged and swallowed.
func (s *Service) NotifySystemGeneric(
	ctx context.Context,
	orgID, title, body string,
	data json.RawMessage,
	relay NotificationRelayFunc,
) {
	if s == nil || s.repo == nil {
		return
	}
	notificationID, _, err := s.repo.InsertNotification(ctx, notificationInsert{
		OrgID: orgID,
		Title: title,
		Body:  body,
		Data:  data,
		Type:  systemNotificationType,
	})
	if err != nil {
		s.logWarn("failed to write generic system notification", "orgId", orgID, "error", err)
		return
	}
	if relay == nil {
		return
	}
	if relayErr := relay(ctx, notificationID, orgID, ""); relayErr != nil {
		s.logWarn("failed to publish generic notification relay", "orgId", orgID, "notificationId", notificationID, "error", relayErr)
	}
}

// RefreshSnapshot is the exported snapshot-refresh entry point.
func (s *Service) RefreshSnapshot(ctx context.Context, orgID, sourceID string) error {
	if s == nil {
		return nil
	}
	_, err := s.RefreshSnapshotForSource(ctx, orgID, sourceID)
	return err
}
