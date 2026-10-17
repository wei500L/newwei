package platformgovernance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

// TaskLogSettingsResponse is the GET /api/system-settings/task-logs body.
type TaskLogSettingsResponse struct {
	Source        SettingsSource `json:"source"`
	RetentionDays int            `json:"retentionDays"`
}

// taskLogStoredSettings is the SystemSetting.value object shape for key
// "task_log_settings".
type taskLogStoredSettings struct {
	RetentionDays optionalJSONNumber `json:"retentionDays"`
}

// taskLogStoredValue is the value written to SystemSetting.value.
type taskLogStoredValue struct {
	RetentionDays int `json:"retentionDays"`
}

// taskLogUpdateMetadata is the AuditLog metadata document for both
// "task_log_settings_update" and "task_log_settings_reset".
type taskLogUpdateMetadata struct {
	RetentionDays int `json:"retentionDays"`
}

// taskLogSettings reads the current task-log settings from MySQL.
//
// Unlike NestJS there is no process-local cache: the value is read on every
// request, so a write from another process is visible immediately.
func (s *Service) taskLogSettings(ctx context.Context) (TaskLogSettingsResponse, error) {
	defaults := s.taskLogDefaultSettings()
	raw, found, err := s.loadSetting(ctx, settingKeyTaskLog)
	if err != nil {
		return TaskLogSettingsResponse{}, err
	}
	if !found {
		return defaults, nil
	}
	retentionDays, ok := parseTaskLogRetentionDays(raw)
	if !ok {
		// An existing row with an unusable value keeps source="db" but falls
		// back to the default number of days.
		return TaskLogSettingsResponse{Source: SettingsSourceDB, RetentionDays: defaults.RetentionDays}, nil
	}
	return TaskLogSettingsResponse{Source: SettingsSourceDB, RetentionDays: retentionDays}, nil
}

// updateTaskLogSettings performs the PUT flow: strict re-validation, TTL
// reconciliation when the number actually changes, the upsert and the audit row.
func (s *Service) updateTaskLogSettings(ctx context.Context, orgID, actorID string, retentionDaysInput int64) (TaskLogSettingsResponse, error) {
	retentionDays, ok := strictTaskLogRetentionDays(float64(retentionDaysInput))
	if !ok {
		return TaskLogSettingsResponse{}, badRequest(fmt.Sprintf(
			"retentionDays must be an integer between %d and %d", minTaskLogRetentionDays, maxTaskLogRetentionDays))
	}

	current, err := s.taskLogSettings(ctx)
	if err != nil {
		return TaskLogSettingsResponse{}, err
	}
	if retentionDays != current.RetentionDays {
		if err := s.applyRetentionTTLIndex(ctx, collectionTaskLogs, taskLogTTLIndexProfile(), retentionDays); err != nil {
			// The Mongo TTL index must match the stored number, so a failed
			// reconciliation refuses the write with the generic 500 shape.
			return TaskLogSettingsResponse{}, internalError()
		}
	}

	value, err := json.Marshal(taskLogStoredValue{RetentionDays: retentionDays})
	if err != nil {
		return TaskLogSettingsResponse{}, err
	}
	if err := s.upsertSetting(ctx, settingKeyTaskLog, value, 0, descriptionTaskLog, nullableActorID(actorID)); err != nil {
		return TaskLogSettingsResponse{}, err
	}

	metadata, err := json.Marshal(taskLogUpdateMetadata{RetentionDays: retentionDays})
	if err != nil {
		return TaskLogSettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "task_log_settings_update", metadata)

	return TaskLogSettingsResponse{Source: SettingsSourceDB, RetentionDays: retentionDays}, nil
}

// resetTaskLogSettings performs the DELETE flow: reconcile the TTL index to the
// default, drop the row, audit, then serve the default.
func (s *Service) resetTaskLogSettings(ctx context.Context, orgID, actorID string) (TaskLogSettingsResponse, error) {
	defaults := s.taskLogDefaultSettings()
	if err := s.applyRetentionTTLIndex(ctx, collectionTaskLogs, taskLogTTLIndexProfile(), defaults.RetentionDays); err != nil {
		return TaskLogSettingsResponse{}, internalError()
	}
	if err := s.deleteSetting(ctx, settingKeyTaskLog); err != nil {
		return TaskLogSettingsResponse{}, err
	}

	metadata, err := json.Marshal(taskLogUpdateMetadata{RetentionDays: defaults.RetentionDays})
	if err != nil {
		return TaskLogSettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "task_log_settings_reset", metadata)

	return defaults, nil
}

// taskLogDefaultSettings mirrors TaskLogSettingsService.buildDefaultSettings:
// the environment value truncated and clamped into 1..3650.
func (s *Service) taskLogDefaultSettings() TaskLogSettingsResponse {
	days := s.env.TaskLogRetentionDays
	if days < minTaskLogRetentionDays {
		days = minTaskLogRetentionDays
	}
	if days > maxTaskLogRetentionDays {
		days = maxTaskLogRetentionDays
	}
	return TaskLogSettingsResponse{Source: SettingsSourceDefault, RetentionDays: days}
}

// parseTaskLogRetentionDays reproduces TaskLogSettingsService.parseRetentionDays:
// a bare JSON number is used directly, an object contributes its retentionDays
// field, and anything else (including an array) is unusable.
func parseTaskLogRetentionDays(raw json.RawMessage) (int, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9') {
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			return 0, false
		}
		return strictTaskLogRetentionDays(value)
	}
	if trimmed[0] != '{' {
		return 0, false
	}
	var stored taskLogStoredSettings
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return 0, false
	}
	if !stored.RetentionDays.present {
		return 0, false
	}
	return strictTaskLogRetentionDays(stored.RetentionDays.value)
}

// strictTaskLogRetentionDays mirrors normalizeRetentionDaysStrict: the value must
// be a finite number whose truncation lies inside 1..3650. A fractional value
// such as 3650.9 is accepted and truncated, exactly like NestJS.
func strictTaskLogRetentionDays(value float64) (int, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	truncated := math.Trunc(value)
	if truncated < float64(minTaskLogRetentionDays) || truncated > float64(maxTaskLogRetentionDays) {
		return 0, false
	}
	return int(truncated), true
}
