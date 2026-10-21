package newssourcescheduler

// This file exposes the existing org-wide system notification writer and the
// ops-snapshot refresh to the migrated itemPipeline worker. It adds no
// behaviour: NotifySystem calls notifySystem (MySQL Notification row + the
// news-source:notifications:v1 identifier relay), and RefreshSnapshot calls
// RefreshSnapshotForSource unchanged.

import (
	"context"
	"encoding/json"
)

// NotifySystem writes one org-wide (userId NULL, type system) notification and
// publishes the identifier-only relay. Failures are logged and swallowed,
// exactly like the memory alert path.
func (s *Service) NotifySystem(ctx context.Context, orgID, title, body string, data json.RawMessage) {
	if s == nil {
		return
	}
	s.notifySystem(ctx, orgID, title, body, data)
}

// RefreshSnapshot is the exported snapshot-refresh entry point.
func (s *Service) RefreshSnapshot(ctx context.Context, orgID, sourceID string) error {
	if s == nil {
		return nil
	}
	_, err := s.RefreshSnapshotForSource(ctx, orgID, sourceID)
	return err
}
