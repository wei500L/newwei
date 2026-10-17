package platformgovernance

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// QuotaUsage is the nested usage object of the assistant quota response.
type QuotaUsage struct {
	MonthStart  nestTime `json:"monthStart"`
	TotalTokens int64    `json:"totalTokens"`
	InFlight    int64    `json:"inFlight"`
}

// AssistantQuotaSettingsResponse is the GET /api/system-settings/assistant-quota
// body.
type AssistantQuotaSettingsResponse struct {
	Source             SettingsSource `json:"source"`
	Enabled            bool           `json:"enabled"`
	SubmitLimitPerHour int64          `json:"submitLimitPerHour"`
	MaxInFlightPerOrg  int64          `json:"maxInFlightPerOrg"`
	MonthlyTokenBudget int64          `json:"monthlyTokenBudget"`
	Usage              QuotaUsage     `json:"usage"`
}

// quotaStoredSettings is the SystemSetting.value shape for key
// "assistant_quota". The three limits are read through Number(), so a numeric
// string or boolean is coerced exactly like NestJS coerceLimit.
type quotaStoredSettings struct {
	Enabled            optionalBool `json:"enabled"`
	SubmitLimitPerHour jsNumberish  `json:"submitLimitPerHour"`
	MaxInFlightPerOrg  jsNumberish  `json:"maxInFlightPerOrg"`
	MonthlyTokenBudget jsNumberish  `json:"monthlyTokenBudget"`
}

// quotaStoredValue is the value written to SystemSetting.value; the field order
// matches the NestJS object literal.
type quotaStoredValue struct {
	Enabled            bool  `json:"enabled"`
	SubmitLimitPerHour int64 `json:"submitLimitPerHour"`
	MaxInFlightPerOrg  int64 `json:"maxInFlightPerOrg"`
	MonthlyTokenBudget int64 `json:"monthlyTokenBudget"`
}

// quotaEffectiveValues are the four resolved limits.
type quotaEffectiveValues struct {
	Enabled            bool
	SubmitLimitPerHour int64
	MaxInFlightPerOrg  int64
	MonthlyTokenBudget int64
}

// quotaUpdateMetadata is the AuditLog metadata document for
// "assistant_quota_update".
type quotaUpdateMetadata struct {
	Enabled            bool  `json:"enabled"`
	SubmitLimitPerHour int64 `json:"submitLimitPerHour"`
	MaxInFlightPerOrg  int64 `json:"maxInFlightPerOrg"`
	MonthlyTokenBudget int64 `json:"monthlyTokenBudget"`
}

// quotaResetMetadata is the AuditLog metadata document for
// "assistant_quota_reset".
type quotaResetMetadata struct {
	OK bool `json:"ok"`
}

// quotaTokenUsageRow is the single-document $group result of the assistant
// token usage aggregation.
type quotaTokenUsageRow struct {
	TotalTokens float64 `bson:"totalTokens"`
}

// assistantQuotaSettings computes the GET /assistant-quota response.
func (s *Service) assistantQuotaSettings(ctx context.Context, orgID string) (AssistantQuotaSettingsResponse, error) {
	stored, present, err := s.loadStoredQuota(ctx)
	if err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}
	effective := s.resolveQuotaEffective(stored, present)

	monthStart := startOfUTCMonth(time.Now())
	totalTokens, err := s.assistantTokenUsage(ctx, orgID, monthStart)
	if err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}
	inFlight, err := s.assistantInFlight(ctx, orgID)
	if err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}

	source := SettingsSourceEnv
	if present {
		source = SettingsSourceDB
	}
	return AssistantQuotaSettingsResponse{
		Source:             source,
		Enabled:            effective.Enabled,
		SubmitLimitPerHour: effective.SubmitLimitPerHour,
		MaxInFlightPerOrg:  effective.MaxInFlightPerOrg,
		MonthlyTokenBudget: effective.MonthlyTokenBudget,
		Usage: QuotaUsage{
			MonthStart:  nestTime(monthStart),
			TotalTokens: totalTokens,
			InFlight:    inFlight,
		},
	}, nil
}

// updateAssistantQuotaSettings performs the PUT flow.
func (s *Service) updateAssistantQuotaSettings(ctx context.Context, orgID, actorID string, input quotaUpdateInput) (AssistantQuotaSettingsResponse, error) {
	nextStored := quotaStoredValue{
		Enabled:            input.Enabled,
		SubmitLimitPerHour: input.SubmitLimitPerHour,
		MaxInFlightPerOrg:  input.MaxInFlightPerOrg,
		MonthlyTokenBudget: input.MonthlyTokenBudget,
	}
	effective := s.resolveQuotaEffectiveFromValues(nextStored, true)

	value, err := json.Marshal(nextStored)
	if err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}
	if err := s.upsertSetting(ctx, settingKeyAssistantQuota, value, 0, descriptionAssistantQuota, nullableActorID(actorID)); err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}

	metadata, err := json.Marshal(quotaUpdateMetadata{
		Enabled:            effective.Enabled,
		SubmitLimitPerHour: effective.SubmitLimitPerHour,
		MaxInFlightPerOrg:  effective.MaxInFlightPerOrg,
		MonthlyTokenBudget: effective.MonthlyTokenBudget,
	})
	if err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "assistant_quota_update", metadata)

	s.invalidateStoredCache(ctx, cacheKeyAssistantQuota)
	return s.assistantQuotaSettings(ctx, orgID)
}

// resetAssistantQuotaSettings performs the DELETE flow.
func (s *Service) resetAssistantQuotaSettings(ctx context.Context, orgID, actorID string) (AssistantQuotaSettingsResponse, error) {
	if err := s.deleteSetting(ctx, settingKeyAssistantQuota); err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}
	metadata, err := json.Marshal(quotaResetMetadata{OK: true})
	if err != nil {
		return AssistantQuotaSettingsResponse{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "assistant_quota_reset", metadata)
	s.invalidateStoredCache(ctx, cacheKeyAssistantQuota)
	return s.assistantQuotaSettings(ctx, orgID)
}

// loadStoredQuota reads the assistant_quota row through the Redis cache.
func (s *Service) loadStoredQuota(ctx context.Context) (quotaStoredSettings, bool, error) {
	raw, present, err := s.loadStoredWithCache(ctx, settingKeyAssistantQuota, cacheKeyAssistantQuota, cacheTTLSecondsAssistant)
	if err != nil || !present {
		return quotaStoredSettings{}, present, err
	}
	var stored quotaStoredSettings
	// A stored array is object-like to NestJS but has no named fields.
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &stored); err != nil {
			return quotaStoredSettings{}, false, err
		}
	}
	return stored, true, nil
}

// resolveQuotaEffective applies the stored row (when present) over the
// environment defaults.
func (s *Service) resolveQuotaEffective(stored quotaStoredSettings, present bool) quotaEffectiveValues {
	effective := quotaEffectiveValues{
		Enabled:            true,
		SubmitLimitPerHour: int64(s.env.AssistantOrgSubmitLimitPerHour),
		MaxInFlightPerOrg:  int64(s.env.AssistantOrgMaxInFlight),
		MonthlyTokenBudget: s.env.AssistantOrgMonthlyTokenBudget,
	}
	if !present {
		return effective
	}
	if stored.Enabled.present {
		effective.Enabled = stored.Enabled.value
	}
	effective.SubmitLimitPerHour = coerceLimit(stored.SubmitLimitPerHour.Number(), effective.SubmitLimitPerHour, 10_000)
	effective.MaxInFlightPerOrg = coerceLimit(stored.MaxInFlightPerOrg.Number(), effective.MaxInFlightPerOrg, 100)
	effective.MonthlyTokenBudget = coerceLimit(stored.MonthlyTokenBudget.Number(), effective.MonthlyTokenBudget, 1_000_000_000_000)
	return effective
}

// resolveQuotaEffectiveFromValues applies the same coercion to a freshly written
// value, exactly like the NestJS update path (which resolves the effective
// config from the object it is about to persist).
func (s *Service) resolveQuotaEffectiveFromValues(value quotaStoredValue, present bool) quotaEffectiveValues {
	effective := quotaEffectiveValues{
		Enabled:            true,
		SubmitLimitPerHour: int64(s.env.AssistantOrgSubmitLimitPerHour),
		MaxInFlightPerOrg:  int64(s.env.AssistantOrgMaxInFlight),
		MonthlyTokenBudget: s.env.AssistantOrgMonthlyTokenBudget,
	}
	if !present {
		return effective
	}
	effective.Enabled = value.Enabled
	effective.SubmitLimitPerHour = coerceLimit(float64(value.SubmitLimitPerHour), effective.SubmitLimitPerHour, 10_000)
	effective.MaxInFlightPerOrg = coerceLimit(float64(value.MaxInFlightPerOrg), effective.MaxInFlightPerOrg, 100)
	effective.MonthlyTokenBudget = coerceLimit(float64(value.MonthlyTokenBudget), effective.MonthlyTokenBudget, 1_000_000_000_000)
	return effective
}

// coerceLimit mirrors AssistantQuotaSettingsService.coerceLimit: the already
// Number()-coerced value falls back to the environment default when it is not
// finite, otherwise it is truncated and clamped into [0, max].
func coerceLimit(value float64, fallback, max int64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	truncated := math.Trunc(value)
	if truncated < 0 {
		return 0
	}
	if truncated > float64(max) {
		return max
	}
	return int64(truncated)
}

// assistantTokenUsage sums llmrequestlogs.totalTokens for the caller's org since
// start, matching LlmRequestLogService.getTokenUsageByFeaturePrefix. The orgId
// filter is mandatory: without it the usage figure would leak across tenants.
func (s *Service) assistantTokenUsage(ctx context.Context, orgID string, start time.Time) (int64, error) {
	collection := s.mongoCollection(collectionLlmRequestLogs)
	if collection == nil {
		return 0, errNoMongo
	}
	normalizedPrefix := strings.ToLower(strings.TrimSpace(assistantFeaturePrefix))
	if normalizedPrefix == "" || !metadataTokenPattern.MatchString(normalizedPrefix) {
		return 0, nil
	}
	// The prefix reaches the query as a regex; escaping it keeps a future
	// non-literal prefix from becoming an injection.
	pattern := "^" + escapeRegex(normalizedPrefix)

	pipeline := bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: normalizeOrgID(orgID)},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: start}}},
			{Key: "$or", Value: bson.A{
				bson.D{{Key: "feature", Value: bson.D{{Key: "$regex", Value: pattern}}}},
				bson.D{{Key: "metadata.feature", Value: bson.D{{Key: "$regex", Value: pattern}}}},
				bson.D{{Key: "metadata.source", Value: bson.D{{Key: "$regex", Value: pattern}}}},
			}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "totalTokens", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$ifNull", Value: bson.A{"$totalTokens", 0}},
			}}}},
		}}},
	}

	cursor, err := collection.Aggregate(ctx, pipeline)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = cursor.Close(ctx)
	}()
	var rows []quotaTokenUsageRow
	if err := cursor.All(ctx, &rows); err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return toSafeInteger(rows[0].TotalTokens), nil
}

// assistantInFlight counts the caller's pending and running assistant runs. The
// orgId filter is mandatory for the same cross-tenant reason as above.
func (s *Service) assistantInFlight(ctx context.Context, orgID string) (int64, error) {
	collection := s.mongoCollection(collectionAssistantRuns)
	if collection == nil {
		return 0, errNoMongo
	}
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{
			string(RunStatusPending), string(RunStatusRunning),
		}}}},
	}
	return collection.CountDocuments(ctx, filter)
}

// toSafeInteger mirrors LlmRequestLogService.toSafeInteger: a non-finite value
// becomes 0, everything else is truncated toward zero.
func toSafeInteger(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	truncated := math.Trunc(value)
	if truncated > math.MaxInt64 {
		return math.MaxInt64
	}
	if truncated < math.MinInt64 {
		return math.MinInt64
	}
	return int64(truncated)
}

// startOfUTCMonth returns the first instant of the month in UTC, matching the
// NestJS startOfUtcMonth helper.
func startOfUTCMonth(now time.Time) time.Time {
	utc := now.UTC()
	return time.Date(utc.Year(), utc.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// escapeRegex escapes the regular-expression metacharacters the NestJS usage
// query escapes before building its prefix pattern.
func escapeRegex(value string) string {
	var builder strings.Builder
	builder.Grow(len(value) * 2)
	for _, r := range value {
		switch r {
		case '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			builder.WriteByte('\\')
		}
		builder.WriteRune(r)
	}
	return builder.String()
}
