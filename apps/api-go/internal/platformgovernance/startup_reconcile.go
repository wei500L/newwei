package platformgovernance

import "context"

// ReconcileTaskLogRetention is the startup half of TaskLogSettingsService:
// read the current retention setting and apply the managed TTL index to
// tasklogs. It returns the applied number of days.
//
// The update path already performs the same read+apply pair; exposing it lets
// the Go startup reconciliation reuse the existing decision logic and index
// names instead of re-deriving them.
func (s *Service) ReconcileTaskLogRetention(ctx context.Context) (int, error) {
	if s == nil {
		return 0, errNoMongo
	}
	settings, err := s.taskLogSettings(ctx)
	if err != nil {
		return 0, err
	}
	if err := s.applyRetentionTTLIndex(ctx, collectionTaskLogs, taskLogTTLIndexProfile(), settings.RetentionDays); err != nil {
		return settings.RetentionDays, err
	}
	return settings.RetentionDays, nil
}

// ReconcileLLMRequestLogRetention is the startup half of
// LlmRequestLogSettingsService: read the current retention setting and apply the
// managed TTL index to llmrequestlogs.
func (s *Service) ReconcileLLMRequestLogRetention(ctx context.Context) (int, error) {
	if s == nil {
		return 0, errNoMongo
	}
	settings, err := s.llmLogSettings(ctx)
	if err != nil {
		return 0, err
	}
	if err := s.applyRetentionTTLIndex(ctx, collectionLlmRequestLogs, llmRequestLogTTLIndexProfile(), settings.RetentionDays); err != nil {
		return settings.RetentionDays, err
	}
	return settings.RetentionDays, nil
}
