package crawlreadtelemetry

import "context"

// RefreshSnapshotsForTaskIDs is the exported maintenance entry for the
// crawl-quality snapshot cron. It delegates to the same private
// refreshSnapshotsForTaskIDs the five-minute NestJS tick uses, so the batch size
// (200), the blank-id filtering, the first-occurrence de-duplication and the
// upsert shape cannot drift between the read-time refresh and the cron.
func (s *Service) RefreshSnapshotsForTaskIDs(ctx context.Context, orgID string, taskIDs []string) error {
	if s == nil {
		return errDatabase
	}
	return s.refreshSnapshotsForTaskIDs(ctx, orgID, taskIDs)
}
