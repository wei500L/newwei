package platformgovernance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// defaultLlmLogMetadataKeys mirrors
// DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS (source order).
var defaultLlmLogMetadataKeys = []string{
	"attempt",
	"batchid",
	"category",
	"channel",
	"correlationid",
	"env",
	"feature",
	"flowid",
	"jobid",
	"language",
	"locale",
	"model",
	"module",
	"nodeid",
	"operation",
	"pipeline",
	"profileid",
	"profile",
	"provider",
	"requestid",
	"retry",
	"frontiernodeid",
	"frontierrunid",
	"crawlsiteprofileid",
	"runid",
	"scenario",
	"sessionid",
	"source",
	"stage",
	"tags",
	"taskid",
	"tenantid",
	"traceid",
	"userid",
	"version",
}

// requiredLlmLogMetadataKeys mirrors
// REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS. Every entry is
// already part of the default list, so merging changes nothing until an operator
// removes one.
var requiredLlmLogMetadataKeys = []string{
	"runid",
	"nodeid",
	"profileid",
	"frontierrunid",
	"frontiernodeid",
	"crawlsiteprofileid",
}

// defaultLlmLogMetadataPrefixes mirrors
// DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES.
var defaultLlmLogMetadataPrefixes = []string{"x_", "meta_", "ctx_"}

// Llm request log retention/metadata limits, copied from the NestJS constants.
const (
	maxLlmLogMetadataKeys         = 100
	maxLlmLogMetadataPrefixes     = 20
	maxLlmLogMetadataKeyLength    = 64
	maxLlmLogMetadataPrefixLength = 24

	defaultLlmLogBriefErrorRateThreshold        = 0.1
	defaultLlmLogBriefInvalidJSONRatioThreshold = 0.3
	defaultLlmLogBriefConsecutiveDaysThreshold  = 3
	minLlmLogBriefConsecutiveDaysThreshold      = 1
	maxLlmLogBriefConsecutiveDaysThreshold      = 30
)

// metadataTokenPattern is METADATA_TOKEN_PATTERN.
var metadataTokenPattern = regexp.MustCompile(`^[a-z0-9_:\-.]+$`)

// LlmRequestLogSettingsResponse is the GET /api/system-settings/llm-request-logs
// body. The field order matches the NestJS object literal.
type LlmRequestLogSettingsResponse struct {
	Source                          SettingsSource `json:"source"`
	RetentionDays                   int            `json:"retentionDays"`
	MetadataAllowedTopLevelKeys     []string       `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes []string       `json:"metadataAllowedTopLevelPrefixes"`
	BriefErrorRateThreshold         float64        `json:"briefErrorRateThreshold"`
	BriefInvalidJsonRatioThreshold  float64        `json:"briefInvalidJsonRatioThreshold"`
	BriefConsecutiveDaysThreshold   int            `json:"briefConsecutiveDaysThreshold"`
}

// llmLogStoredSettings is the SystemSetting.value shape for key
// "llm_request_log_settings". The lenient read path applies Number() to the
// scalar fields and its own list normalizer to the raw list bytes.
type llmLogStoredSettings struct {
	RetentionDays                   jsNumberish     `json:"retentionDays"`
	MetadataAllowedTopLevelKeys     json.RawMessage `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes json.RawMessage `json:"metadataAllowedTopLevelPrefixes"`
	BriefErrorRateThreshold         jsNumberish     `json:"briefErrorRateThreshold"`
	BriefInvalidJsonRatioThreshold  jsNumberish     `json:"briefInvalidJsonRatioThreshold"`
	BriefConsecutiveDaysThreshold   jsNumberish     `json:"briefConsecutiveDaysThreshold"`
}

// llmLogStoredValue is the value written to SystemSetting.value.
type llmLogStoredValue struct {
	RetentionDays                   int      `json:"retentionDays"`
	MetadataAllowedTopLevelKeys     []string `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes []string `json:"metadataAllowedTopLevelPrefixes"`
	BriefErrorRateThreshold         float64  `json:"briefErrorRateThreshold"`
	BriefInvalidJsonRatioThreshold  float64  `json:"briefInvalidJsonRatioThreshold"`
	BriefConsecutiveDaysThreshold   int      `json:"briefConsecutiveDaysThreshold"`
}

// llmLogUpdateMetadata is the AuditLog metadata document for
// "llm_request_log_settings_update".
type llmLogUpdateMetadata struct {
	RetentionDays                   int      `json:"retentionDays"`
	MetadataAllowedTopLevelKeys     []string `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes []string `json:"metadataAllowedTopLevelPrefixes"`
	MetadataTopLevelKeysCount       int      `json:"metadataTopLevelKeysCount"`
	MetadataPrefixCount             int      `json:"metadataPrefixCount"`
	BriefErrorRateThreshold         float64  `json:"briefErrorRateThreshold"`
	BriefInvalidJsonRatioThreshold  float64  `json:"briefInvalidJsonRatioThreshold"`
	BriefConsecutiveDaysThreshold   int      `json:"briefConsecutiveDaysThreshold"`
}

// llmLogResetMetadata is the AuditLog metadata document for
// "llm_request_log_settings_reset" (six fields, no counts).
type llmLogResetMetadata struct {
	RetentionDays                   int      `json:"retentionDays"`
	MetadataAllowedTopLevelKeys     []string `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes []string `json:"metadataAllowedTopLevelPrefixes"`
	BriefErrorRateThreshold         float64  `json:"briefErrorRateThreshold"`
	BriefInvalidJsonRatioThreshold  float64  `json:"briefInvalidJsonRatioThreshold"`
	BriefConsecutiveDaysThreshold   int      `json:"briefConsecutiveDaysThreshold"`
}

// llmLogSettings reads the current llm-request-log settings from MySQL. There is
// no process-local cache: every request re-reads the row.
func (s *Service) llmLogSettings(ctx context.Context) (LlmRequestLogSettingsResponse, error) {
	return s.loadLlmLogSettingsFromDB(ctx)
}

// loadLlmLogSettingsFromDB reproduces
// LlmRequestLogSettingsService.loadSettingsFromDb, including the lenient
// normalization of a stored value that has drifted.
func (s *Service) loadLlmLogSettingsFromDB(ctx context.Context) (LlmRequestLogSettingsResponse, error) {
	raw, found, err := s.loadSetting(ctx, settingKeyLlmRequestLog)
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	if !found {
		return s.llmLogDefaultSettings(), nil
	}

	storedRaw, _ := storedValueForStruct(raw)
	var stored llmLogStoredSettings
	if len(storedRaw) > 0 {
		if err := json.Unmarshal(storedRaw, &stored); err != nil {
			return LlmRequestLogSettingsResponse{}, err
		}
	}

	settings := s.llmLogDefaultSettings()
	if retentionDays, ok := parseLlmLogRetentionDays(raw); ok {
		settings.RetentionDays = retentionDays
	}
	settings.MetadataAllowedTopLevelKeys = mergeRequiredLlmLogMetadataKeys(
		lenientLlmLogMetadataTokens(stored.MetadataAllowedTopLevelKeys, maxLlmLogMetadataKeys, maxLlmLogMetadataKeyLength, defaultLlmLogMetadataKeys))
	settings.MetadataAllowedTopLevelPrefixes = lenientLlmLogMetadataTokens(
		stored.MetadataAllowedTopLevelPrefixes, maxLlmLogMetadataPrefixes, maxLlmLogMetadataPrefixLength, defaultLlmLogMetadataPrefixes)
	settings.BriefErrorRateThreshold = lenientLlmLogThresholdRate(stored.BriefErrorRateThreshold.Number(), defaultLlmLogBriefErrorRateThreshold)
	settings.BriefInvalidJsonRatioThreshold = lenientLlmLogThresholdRate(stored.BriefInvalidJsonRatioThreshold.Number(), defaultLlmLogBriefInvalidJSONRatioThreshold)
	settings.BriefConsecutiveDaysThreshold = lenientLlmLogConsecutiveDays(stored.BriefConsecutiveDaysThreshold.Number())
	settings.Source = SettingsSourceDB
	return settings, nil
}

// llmLogDefaultSettings mirrors buildDefaultSettings, including the required-key
// merge on the keys list.
func (s *Service) llmLogDefaultSettings() LlmRequestLogSettingsResponse {
	return LlmRequestLogSettingsResponse{
		Source:                          SettingsSourceDefault,
		RetentionDays:                   defaultLlmRequestLogRetentionDays,
		MetadataAllowedTopLevelKeys:     mergeRequiredLlmLogMetadataKeys(append([]string{}, defaultLlmLogMetadataKeys...)),
		MetadataAllowedTopLevelPrefixes: append([]string{}, defaultLlmLogMetadataPrefixes...),
		BriefErrorRateThreshold:         defaultLlmLogBriefErrorRateThreshold,
		BriefInvalidJsonRatioThreshold:  defaultLlmLogBriefInvalidJSONRatioThreshold,
		BriefConsecutiveDaysThreshold:   defaultLlmLogBriefConsecutiveDaysThreshold,
	}
}

// updateLlmLogSettings takes the settings lock exactly once and runs the merge
// inside it (CONC-01).
func (s *Service) updateLlmLogSettings(ctx context.Context, orgID, actorID string, input llmLogUpdateInput) (LlmRequestLogSettingsResponse, error) {
	var result LlmRequestLogSettingsResponse
	err := s.withSettingsLock(ctx, llmLogSettingsLockName, func(lockCtx context.Context) error {
		value, innerErr := s.updateLlmLogSettingsUnlocked(lockCtx, orgID, actorID, input)
		if innerErr != nil {
			return innerErr
		}
		result = value
		return nil
	})
	if err != nil {
		if err == errLockNotAcquired {
			return LlmRequestLogSettingsResponse{}, conflict(llmLogSettingsLockConflictMessage)
		}
		return LlmRequestLogSettingsResponse{}, err
	}
	return result, nil
}

// updateLlmLogSettingsUnlocked is the PUT body run while the lock is held: it
// merges the provided fields over a FRESHLY read DB row (never a cached one),
// reconciles the Mongo TTL index only when retentionDays actually changes, then
// upserts and audits.
func (s *Service) updateLlmLogSettingsUnlocked(ctx context.Context, orgID, actorID string, input llmLogUpdateInput) (LlmRequestLogSettingsResponse, error) {
	hasAnyInput := hasValue(input.RetentionDays) ||
		hasValue(input.MetadataAllowedTopLevelKeys) ||
		hasValue(input.MetadataAllowedTopLevelPrefixes) ||
		hasValue(input.BriefErrorRateThreshold) ||
		hasValue(input.BriefInvalidJsonRatioThreshold) ||
		hasValue(input.BriefConsecutiveDaysThreshold)
	if !hasAnyInput {
		return LlmRequestLogSettingsResponse{}, badRequest(
			"At least one of retentionDays, metadataAllowedTopLevelKeys, metadataAllowedTopLevelPrefixes, briefErrorRateThreshold, briefInvalidJsonRatioThreshold, briefConsecutiveDaysThreshold is required")
	}

	current, err := s.loadLlmLogSettingsFromDB(ctx)
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}

	retentionDays := current.RetentionDays
	if hasValue(input.RetentionDays) {
		normalized, ok := normalizeLlmLogRetentionDaysStrict(input.RetentionDays)
		if !ok {
			return LlmRequestLogSettingsResponse{}, badRequest(fmt.Sprintf(
				"retentionDays must be an integer between %d and %d", minLlmRequestLogRetentionDays, maxLlmRequestLogRetentionDays))
		}
		retentionDays = normalized
	}

	metadataAllowedTopLevelKeys := current.MetadataAllowedTopLevelKeys
	if hasValue(input.MetadataAllowedTopLevelKeys) {
		normalized, ok := normalizeLlmLogMetadataTokensStrict(input.MetadataAllowedTopLevelKeys, maxLlmLogMetadataKeys, maxLlmLogMetadataKeyLength)
		if !ok {
			return LlmRequestLogSettingsResponse{}, badRequest(fmt.Sprintf(
				"metadataAllowedTopLevelKeys must be an array of up to %d lowercase tokens ([a-z0-9_:. -], max %d chars each)",
				maxLlmLogMetadataKeys, maxLlmLogMetadataKeyLength))
		}
		metadataAllowedTopLevelKeys = mergeRequiredLlmLogMetadataKeys(normalized)
	}

	metadataAllowedTopLevelPrefixes := current.MetadataAllowedTopLevelPrefixes
	if hasValue(input.MetadataAllowedTopLevelPrefixes) {
		normalized, ok := normalizeLlmLogMetadataTokensStrict(input.MetadataAllowedTopLevelPrefixes, maxLlmLogMetadataPrefixes, maxLlmLogMetadataPrefixLength)
		if !ok {
			return LlmRequestLogSettingsResponse{}, badRequest(fmt.Sprintf(
				"metadataAllowedTopLevelPrefixes must be an array of up to %d lowercase prefixes ([a-z0-9_:. -], max %d chars each)",
				maxLlmLogMetadataPrefixes, maxLlmLogMetadataPrefixLength))
		}
		metadataAllowedTopLevelPrefixes = normalized
	}

	briefErrorRateThreshold := current.BriefErrorRateThreshold
	if hasValue(input.BriefErrorRateThreshold) {
		normalized, ok := normalizeLlmLogThresholdRateStrict(jsNumberFromJSON(input.BriefErrorRateThreshold))
		if !ok {
			return LlmRequestLogSettingsResponse{}, badRequest("briefErrorRateThreshold must be a number between 0 and 1")
		}
		briefErrorRateThreshold = normalized
	}

	briefInvalidJsonRatioThreshold := current.BriefInvalidJsonRatioThreshold
	if hasValue(input.BriefInvalidJsonRatioThreshold) {
		normalized, ok := normalizeLlmLogThresholdRateStrict(jsNumberFromJSON(input.BriefInvalidJsonRatioThreshold))
		if !ok {
			return LlmRequestLogSettingsResponse{}, badRequest("briefInvalidJsonRatioThreshold must be a number between 0 and 1")
		}
		briefInvalidJsonRatioThreshold = normalized
	}

	briefConsecutiveDaysThreshold := current.BriefConsecutiveDaysThreshold
	if hasValue(input.BriefConsecutiveDaysThreshold) {
		normalized, ok := normalizeLlmLogConsecutiveDaysStrict(jsNumberFromJSON(input.BriefConsecutiveDaysThreshold))
		if !ok {
			return LlmRequestLogSettingsResponse{}, badRequest(fmt.Sprintf(
				"briefConsecutiveDaysThreshold must be an integer between %d and %d",
				minLlmLogBriefConsecutiveDaysThreshold, maxLlmLogBriefConsecutiveDaysThreshold))
		}
		briefConsecutiveDaysThreshold = normalized
	}

	// The Mongo TTL index follows retentionDays only, and only when the caller
	// actually supplied a different value.
	if hasValue(input.RetentionDays) && retentionDays != current.RetentionDays {
		if err := s.applyRetentionTTLIndex(ctx, collectionLlmRequestLogs, llmRequestLogTTLIndexProfile(), retentionDays); err != nil {
			return LlmRequestLogSettingsResponse{}, internalError()
		}
	}

	value, err := json.Marshal(llmLogStoredValue{
		RetentionDays:                   retentionDays,
		MetadataAllowedTopLevelKeys:     metadataAllowedTopLevelKeys,
		MetadataAllowedTopLevelPrefixes: metadataAllowedTopLevelPrefixes,
		BriefErrorRateThreshold:         briefErrorRateThreshold,
		BriefInvalidJsonRatioThreshold:  briefInvalidJsonRatioThreshold,
		BriefConsecutiveDaysThreshold:   briefConsecutiveDaysThreshold,
	})
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	if err := s.upsertSetting(ctx, settingKeyLlmRequestLog, value, 0, descriptionLlmRequestLog, nullableActorID(actorID)); err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}

	metadata, err := json.Marshal(llmLogUpdateMetadata{
		RetentionDays:                   retentionDays,
		MetadataAllowedTopLevelKeys:     metadataAllowedTopLevelKeys,
		MetadataAllowedTopLevelPrefixes: metadataAllowedTopLevelPrefixes,
		MetadataTopLevelKeysCount:       len(metadataAllowedTopLevelKeys),
		MetadataPrefixCount:             len(metadataAllowedTopLevelPrefixes),
		BriefErrorRateThreshold:         briefErrorRateThreshold,
		BriefInvalidJsonRatioThreshold:  briefInvalidJsonRatioThreshold,
		BriefConsecutiveDaysThreshold:   briefConsecutiveDaysThreshold,
	})
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "llm_request_log_settings_update", metadata)

	return LlmRequestLogSettingsResponse{
		Source:                          SettingsSourceDB,
		RetentionDays:                   retentionDays,
		MetadataAllowedTopLevelKeys:     metadataAllowedTopLevelKeys,
		MetadataAllowedTopLevelPrefixes: metadataAllowedTopLevelPrefixes,
		BriefErrorRateThreshold:         briefErrorRateThreshold,
		BriefInvalidJsonRatioThreshold:  briefInvalidJsonRatioThreshold,
		BriefConsecutiveDaysThreshold:   briefConsecutiveDaysThreshold,
	}, nil
}

// resetLlmLogSettings takes the settings lock once and drops the row inside it.
func (s *Service) resetLlmLogSettings(ctx context.Context, orgID, actorID string) (LlmRequestLogSettingsResponse, error) {
	var result LlmRequestLogSettingsResponse
	err := s.withSettingsLock(ctx, llmLogSettingsLockName, func(lockCtx context.Context) error {
		value, innerErr := s.resetLlmLogSettingsUnlocked(lockCtx, orgID, actorID)
		if innerErr != nil {
			return innerErr
		}
		result = value
		return nil
	})
	if err != nil {
		if err == errLockNotAcquired {
			return LlmRequestLogSettingsResponse{}, conflict(llmLogSettingsLockConflictMessage)
		}
		return LlmRequestLogSettingsResponse{}, err
	}
	return result, nil
}

// resetLlmLogSettingsUnlocked reconciles the TTL index back to the default,
// deletes the row and audits the defaults.
func (s *Service) resetLlmLogSettingsUnlocked(ctx context.Context, orgID, actorID string) (LlmRequestLogSettingsResponse, error) {
	defaults := s.llmLogDefaultSettings()
	if err := s.applyRetentionTTLIndex(ctx, collectionLlmRequestLogs, llmRequestLogTTLIndexProfile(), defaults.RetentionDays); err != nil {
		return LlmRequestLogSettingsResponse{}, internalError()
	}
	if err := s.deleteSetting(ctx, settingKeyLlmRequestLog); err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	metadata, err := json.Marshal(llmLogResetMetadata{
		RetentionDays:                   defaults.RetentionDays,
		MetadataAllowedTopLevelKeys:     defaults.MetadataAllowedTopLevelKeys,
		MetadataAllowedTopLevelPrefixes: defaults.MetadataAllowedTopLevelPrefixes,
		BriefErrorRateThreshold:         defaults.BriefErrorRateThreshold,
		BriefInvalidJsonRatioThreshold:  defaults.BriefInvalidJsonRatioThreshold,
		BriefConsecutiveDaysThreshold:   defaults.BriefConsecutiveDaysThreshold,
	})
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "llm_request_log_settings_reset", metadata)
	return defaults, nil
}

// resetLlmLogMetadataPolicy takes the settings lock once and applies the default
// metadata whitelist through the UNLOCKED merge, never updateLlmLogSettings: a
// second acquisition would open a second connection and wait on itself until
// GET_LOCK times out.
func (s *Service) resetLlmLogMetadataPolicy(ctx context.Context, orgID, actorID string) (LlmRequestLogSettingsResponse, error) {
	keys, err := json.Marshal(append([]string{}, defaultLlmLogMetadataKeys...))
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	prefixes, err := json.Marshal(append([]string{}, defaultLlmLogMetadataPrefixes...))
	if err != nil {
		return LlmRequestLogSettingsResponse{}, err
	}
	return s.updateLlmLogSettings(ctx, orgID, actorID, llmLogUpdateInput{
		MetadataAllowedTopLevelKeys:     keys,
		MetadataAllowedTopLevelPrefixes: prefixes,
	})
}

// ---- normalization ----

// mergeRequiredLlmLogMetadataKeys mirrors
// mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys: a Set union that keeps
// the first occurrence order, appending a missing required key at the end.
func mergeRequiredLlmLogMetadataKeys(keys []string) []string {
	out := make([]string, 0, len(keys)+len(requiredLlmLogMetadataKeys))
	for _, key := range keys {
		if containsString(out, key) {
			continue
		}
		out = append(out, key)
	}
	for _, key := range requiredLlmLogMetadataKeys {
		if containsString(out, key) {
			continue
		}
		out = append(out, key)
	}
	return out
}

// parseLlmLogRetentionDays mirrors parseRetentionDays: a bare JSON number is
// used directly, an object contributes its retentionDays field (through)
// Number(), so an absent field is NaN) and anything else is unusable.
func parseLlmLogRetentionDays(raw json.RawMessage) (int, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9') {
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			return 0, false
		}
		return strictLlmLogRetentionDays(value)
	}
	if trimmed[0] != '{' {
		return 0, false
	}
	var stored llmLogStoredSettings
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return 0, false
	}
	return strictLlmLogRetentionDays(stored.RetentionDays.Number())
}

// normalizeLlmLogRetentionDaysStrict mirrors normalizeRetentionDaysStrict on a
// request value: Number() coercion, then a finite integer inside 1..3650.
func normalizeLlmLogRetentionDaysStrict(raw json.RawMessage) (int, bool) {
	return strictLlmLogRetentionDays(jsNumberFromJSON(raw))
}

// strictLlmLogRetentionDays is the shared finite-integer range check.
func strictLlmLogRetentionDays(value float64) (int, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	if value < float64(minLlmRequestLogRetentionDays) || value > float64(maxLlmRequestLogRetentionDays) {
		return 0, false
	}
	return int(value), true
}

// normalizeLlmLogThresholdRateStrict mirrors normalizeThresholdRateStrict:
// Number(), finite, inside 0..1, then Number(value.toFixed(4)).
func normalizeLlmLogThresholdRateStrict(value float64) (float64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	if value < 0 || value > 1 {
		return 0, false
	}
	return jsToFixed4(value), true
}

// lenientLlmLogThresholdRate mirrors normalizeThresholdRateLenient.
func lenientLlmLogThresholdRate(value, fallback float64) float64 {
	normalized, ok := normalizeLlmLogThresholdRateStrict(value)
	if !ok {
		return fallback
	}
	return normalized
}

// normalizeLlmLogConsecutiveDaysStrict mirrors
// normalizeBriefConsecutiveDaysThresholdStrict.
func normalizeLlmLogConsecutiveDaysStrict(value float64) (int, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
		return 0, false
	}
	if value < float64(minLlmLogBriefConsecutiveDaysThreshold) || value > float64(maxLlmLogBriefConsecutiveDaysThreshold) {
		return 0, false
	}
	return int(value), true
}

// lenientLlmLogConsecutiveDays mirrors
// normalizeBriefConsecutiveDaysThresholdLenient.
func lenientLlmLogConsecutiveDays(value float64) int {
	normalized, ok := normalizeLlmLogConsecutiveDaysStrict(value)
	if !ok {
		return defaultLlmLogBriefConsecutiveDaysThreshold
	}
	return normalized
}

// normalizeLlmLogMetadataTokensStrict mirrors normalizeMetadataTokenList with
// strict=true: a non-array, an over-long list or a rejected entry makes the
// whole list invalid.
func normalizeLlmLogMetadataTokensStrict(raw json.RawMessage, maxItems, maxTokenLength int) ([]string, bool) {
	items, ok := metadataTokenItems(raw)
	if !ok {
		return nil, false
	}
	if len(items) > maxItems {
		return nil, false
	}
	normalized := make([]string, 0, len(items))
	for _, item := range items {
		token, ok := normalizeLlmLogMetadataToken(item, maxTokenLength)
		if !ok {
			return nil, false
		}
		normalized = append(normalized, token)
	}
	if len(normalized) != len(items) {
		return nil, false
	}
	return dedupeStrings(normalized), true
}

// lenientLlmLogMetadataTokens mirrors the lenient mode of
// normalizeMetadataTokenList plus the two wrappers: an over-long list is
// truncated and filtered WITHOUT deduplication (the NestJS lenient path returns
// before the Set), every other list is deduplicated, and an unusable value falls
// back to the supplied default list.
func lenientLlmLogMetadataTokens(raw json.RawMessage, maxItems, maxTokenLength int, fallback []string) []string {
	items, ok := metadataTokenItems(raw)
	if !ok {
		return append([]string{}, fallback...)
	}
	if len(items) > maxItems {
		truncated := make([]string, 0, maxItems)
		for _, item := range items[:maxItems] {
			if token, ok := normalizeLlmLogMetadataToken(item, maxTokenLength); ok {
				truncated = append(truncated, token)
			}
		}
		return truncated
	}
	normalized := make([]string, 0, len(items))
	for _, item := range items {
		if token, ok := normalizeLlmLogMetadataToken(item, maxTokenLength); ok {
			normalized = append(normalized, token)
		}
	}
	return dedupeStrings(normalized)
}

// metadataTokenItems decodes a raw JSON array without interpreting its entries.
func metadataTokenItems(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, false
	}
	return items, true
}

// normalizeLlmLogMetadataToken mirrors normalizeMetadataToken: trim, lowercase,
// non-empty, at most maxTokenLength characters and matching the token pattern.
func normalizeLlmLogMetadataToken(raw json.RawMessage, maxTokenLength int) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" || len(normalized) > maxTokenLength {
		return "", false
	}
	if !metadataTokenPattern.MatchString(normalized) {
		return "", false
	}
	return normalized, true
}

// dedupeStrings keeps the first occurrence order, matching Array.from(new Set()).
func dedupeStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if containsString(out, value) {
			continue
		}
		out = append(out, value)
	}
	return out
}
