package runtimesettings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// Multi-tenant scheduler concurrency bounds.
const (
	multiTenantConcurrencyMin = 1
	multiTenantConcurrencyMax = 16
)

// multiTenantInvalidCode/Message/Detail are the exact strings the NestJS service
// puts into its ConflictException payload.
const (
	multiTenantInvalidCode   = "MULTI_TENANT_SCHEDULER_SETTINGS_INVALID"
	multiTenantInvalidError  = "Stored multi-tenant scheduler runtime settings are invalid."
	multiTenantInvalidDetail = "Multi-tenant scheduler concurrency settings must be integers between 1 and 16."
)

// multiTenantSchedulerConcurrency is the persisted and audited payload: eleven
// concurrency values in the exact key order NestJS writes. It deliberately has
// no `source` key, matching SystemSetting.value.
type multiTenantSchedulerConcurrency struct {
	RealtimeSignalsOrgConcurrency                 int `json:"realtimeSignalsOrgConcurrency"`
	NewsEventsTimelineOrgConcurrency              int `json:"newsEventsTimelineOrgConcurrency"`
	NewsEventsIngestionOrgConcurrency             int `json:"newsEventsIngestionOrgConcurrency"`
	KnowledgeGraphIngestionOrgConcurrency         int `json:"knowledgeGraphIngestionOrgConcurrency"`
	SentimentSnapshotOrgConcurrency               int `json:"sentimentSnapshotOrgConcurrency"`
	NewsnowHottestAnalysisOrgConcurrency          int `json:"newsnowHottestAnalysisOrgConcurrency"`
	ClassificationQualityAlertOrgConcurrency      int `json:"classificationQualityAlertOrgConcurrency"`
	NewsIndicatorAssociationOrgConcurrency        int `json:"newsIndicatorAssociationOrgConcurrency"`
	CrawlQualityTaskSnapshotOrgConcurrency        int `json:"crawlQualityTaskSnapshotOrgConcurrency"`
	SituationMonitorOrefDefaultRuleOrgConcurrency int `json:"situationMonitorOrefDefaultRuleOrgConcurrency"`
	UserDigestDeliveryOrgConcurrency              int `json:"userDigestDeliveryOrgConcurrency"`
}

// multiTenantSchedulerSettings is the public GET/PUT response. source comes
// first, then the eleven values are inlined from the embedded struct.
type multiTenantSchedulerSettings struct {
	Source SettingSource `json:"source"`
	multiTenantSchedulerConcurrency
}

// multiTenantSchedulerRequest mirrors UpdateMultiTenantSchedulerSettingsDto.
type multiTenantSchedulerRequest struct {
	RealtimeSignalsOrgConcurrency                 json.RawMessage `json:"realtimeSignalsOrgConcurrency"`
	NewsEventsTimelineOrgConcurrency              json.RawMessage `json:"newsEventsTimelineOrgConcurrency"`
	NewsEventsIngestionOrgConcurrency             json.RawMessage `json:"newsEventsIngestionOrgConcurrency"`
	KnowledgeGraphIngestionOrgConcurrency         json.RawMessage `json:"knowledgeGraphIngestionOrgConcurrency"`
	SentimentSnapshotOrgConcurrency               json.RawMessage `json:"sentimentSnapshotOrgConcurrency"`
	NewsnowHottestAnalysisOrgConcurrency          json.RawMessage `json:"newsnowHottestAnalysisOrgConcurrency"`
	ClassificationQualityAlertOrgConcurrency      json.RawMessage `json:"classificationQualityAlertOrgConcurrency"`
	NewsIndicatorAssociationOrgConcurrency        json.RawMessage `json:"newsIndicatorAssociationOrgConcurrency"`
	CrawlQualityTaskSnapshotOrgConcurrency        json.RawMessage `json:"crawlQualityTaskSnapshotOrgConcurrency"`
	SituationMonitorOrefDefaultRuleOrgConcurrency json.RawMessage `json:"situationMonitorOrefDefaultRuleOrgConcurrency"`
	UserDigestDeliveryOrgConcurrency              json.RawMessage `json:"userDigestDeliveryOrgConcurrency"`
}

// multiTenantSchedulerStoredValue is the typed view of the stored JSON object.
type multiTenantSchedulerStoredValue struct {
	RealtimeSignalsOrgConcurrency                 json.RawMessage `json:"realtimeSignalsOrgConcurrency"`
	NewsEventsTimelineOrgConcurrency              json.RawMessage `json:"newsEventsTimelineOrgConcurrency"`
	NewsEventsIngestionOrgConcurrency             json.RawMessage `json:"newsEventsIngestionOrgConcurrency"`
	KnowledgeGraphIngestionOrgConcurrency         json.RawMessage `json:"knowledgeGraphIngestionOrgConcurrency"`
	SentimentSnapshotOrgConcurrency               json.RawMessage `json:"sentimentSnapshotOrgConcurrency"`
	NewsnowHottestAnalysisOrgConcurrency          json.RawMessage `json:"newsnowHottestAnalysisOrgConcurrency"`
	ClassificationQualityAlertOrgConcurrency      json.RawMessage `json:"classificationQualityAlertOrgConcurrency"`
	NewsIndicatorAssociationOrgConcurrency        json.RawMessage `json:"newsIndicatorAssociationOrgConcurrency"`
	CrawlQualityTaskSnapshotOrgConcurrency        json.RawMessage `json:"crawlQualityTaskSnapshotOrgConcurrency"`
	SituationMonitorOrefDefaultRuleOrgConcurrency json.RawMessage `json:"situationMonitorOrefDefaultRuleOrgConcurrency"`
	UserDigestDeliveryOrgConcurrency              json.RawMessage `json:"userDigestDeliveryOrgConcurrency"`
}

// concurrencySpec describes one concurrency field so the request and stored
// value walkers stay in one place. The accessor functions are plain typed
// closures, so no schema-less container is involved.
type concurrencySpec struct {
	name         string
	required     bool
	defaultValue int
	requestRaw   func(*multiTenantSchedulerRequest) json.RawMessage
	storedRaw    func(*multiTenantSchedulerStoredValue) json.RawMessage
	assign       func(*multiTenantSchedulerConcurrency, int)
}

// multiTenantConcurrencySpecs lists the eleven fields in declaration order,
// which is also the JSON key order and the order the first invalid field is
// reported in.
var multiTenantConcurrencySpecs = []concurrencySpec{
	{"realtimeSignalsOrgConcurrency", false, 4,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.RealtimeSignalsOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage { return s.RealtimeSignalsOrgConcurrency },
		func(c *multiTenantSchedulerConcurrency, v int) { c.RealtimeSignalsOrgConcurrency = v }},
	{"newsEventsTimelineOrgConcurrency", false, 2,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.NewsEventsTimelineOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage { return s.NewsEventsTimelineOrgConcurrency },
		func(c *multiTenantSchedulerConcurrency, v int) { c.NewsEventsTimelineOrgConcurrency = v }},
	{"newsEventsIngestionOrgConcurrency", true, 4,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.NewsEventsIngestionOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage { return s.NewsEventsIngestionOrgConcurrency },
		func(c *multiTenantSchedulerConcurrency, v int) { c.NewsEventsIngestionOrgConcurrency = v }},
	{"knowledgeGraphIngestionOrgConcurrency", true, 4,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.KnowledgeGraphIngestionOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage {
			return s.KnowledgeGraphIngestionOrgConcurrency
		},
		func(c *multiTenantSchedulerConcurrency, v int) { c.KnowledgeGraphIngestionOrgConcurrency = v }},
	{"sentimentSnapshotOrgConcurrency", true, 2,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.SentimentSnapshotOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage { return s.SentimentSnapshotOrgConcurrency },
		func(c *multiTenantSchedulerConcurrency, v int) { c.SentimentSnapshotOrgConcurrency = v }},
	{"newsnowHottestAnalysisOrgConcurrency", true, 6,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.NewsnowHottestAnalysisOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage {
			return s.NewsnowHottestAnalysisOrgConcurrency
		},
		func(c *multiTenantSchedulerConcurrency, v int) { c.NewsnowHottestAnalysisOrgConcurrency = v }},
	{"classificationQualityAlertOrgConcurrency", false, 4,
		func(d *multiTenantSchedulerRequest) json.RawMessage {
			return d.ClassificationQualityAlertOrgConcurrency
		},
		func(s *multiTenantSchedulerStoredValue) json.RawMessage {
			return s.ClassificationQualityAlertOrgConcurrency
		},
		func(c *multiTenantSchedulerConcurrency, v int) { c.ClassificationQualityAlertOrgConcurrency = v }},
	{"newsIndicatorAssociationOrgConcurrency", false, 2,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.NewsIndicatorAssociationOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage {
			return s.NewsIndicatorAssociationOrgConcurrency
		},
		func(c *multiTenantSchedulerConcurrency, v int) { c.NewsIndicatorAssociationOrgConcurrency = v }},
	{"crawlQualityTaskSnapshotOrgConcurrency", false, 2,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.CrawlQualityTaskSnapshotOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage {
			return s.CrawlQualityTaskSnapshotOrgConcurrency
		},
		func(c *multiTenantSchedulerConcurrency, v int) { c.CrawlQualityTaskSnapshotOrgConcurrency = v }},
	{"situationMonitorOrefDefaultRuleOrgConcurrency", false, 16,
		func(d *multiTenantSchedulerRequest) json.RawMessage {
			return d.SituationMonitorOrefDefaultRuleOrgConcurrency
		},
		func(s *multiTenantSchedulerStoredValue) json.RawMessage {
			return s.SituationMonitorOrefDefaultRuleOrgConcurrency
		},
		func(c *multiTenantSchedulerConcurrency, v int) {
			c.SituationMonitorOrefDefaultRuleOrgConcurrency = v
		}},
	{"userDigestDeliveryOrgConcurrency", true, 4,
		func(d *multiTenantSchedulerRequest) json.RawMessage { return d.UserDigestDeliveryOrgConcurrency },
		func(s *multiTenantSchedulerStoredValue) json.RawMessage { return s.UserDigestDeliveryOrgConcurrency },
		func(c *multiTenantSchedulerConcurrency, v int) { c.UserDigestDeliveryOrgConcurrency = v }},
}

// defaultMultiTenantSchedulerConcurrency mirrors DEFAULT_SETTINGS.
func defaultMultiTenantSchedulerConcurrency() multiTenantSchedulerConcurrency {
	result := multiTenantSchedulerConcurrency{}
	for _, spec := range multiTenantConcurrencySpecs {
		spec.assign(&result, spec.defaultValue)
	}
	return result
}

// strictOptionalInt mirrors toStrictOptionalInt. The second return value is the
// third state NestJS distinguishes: absent means "use the default", whereas a
// present but invalid value invalidates the whole record.
func strictOptionalInt(raw json.RawMessage) (int, bool) {
	if !present(raw) {
		return 0, false
	}
	value, _ := jsNumberFromJSON(raw)
	if !jsIsInteger(value) || value < multiTenantConcurrencyMin || value > multiTenantConcurrencyMax {
		return 0, false
	}
	return int(value), true
}

// parseMultiTenantSchedulerRequest validates the PUT body and returns the full
// replacement payload. Omitted optional fields are overwritten with their
// defaults: this endpoint is a full replace, not a patch.
func parseMultiTenantSchedulerRequest(body []byte) (multiTenantSchedulerConcurrency, error) {
	var dto multiTenantSchedulerRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return multiTenantSchedulerConcurrency{}, err
	}
	problems := validationErrors{}
	for _, spec := range multiTenantConcurrencySpecs {
		numberField(&problems, spec.requestRaw(&dto), spec.name, spec.required,
			multiTenantConcurrencyMin, multiTenantConcurrencyMax)
	}
	if err := problems.err(); err != nil {
		return multiTenantSchedulerConcurrency{}, err
	}

	normalized := multiTenantSchedulerConcurrency{}
	for _, spec := range multiTenantConcurrencySpecs {
		raw := spec.requestRaw(&dto)
		if !present(raw) {
			spec.assign(&normalized, spec.defaultValue)
			continue
		}
		// Layer B: a present value that is null or non-numeric reaches here only
		// for optional fields (@IsOptional skipped it), and NestJS raises a flat
		// BadRequestException instead of the joined class-validator messages.
		value, ok := strictOptionalInt(raw)
		if !ok {
			return multiTenantSchedulerConcurrency{}, &httpError{
				status: http.StatusBadRequest,
				message: fmt.Sprintf("%s must be an integer between %d and %d",
					spec.name, multiTenantConcurrencyMin, multiTenantConcurrencyMax),
			}
		}
		spec.assign(&normalized, value)
	}
	return normalized, nil
}

// invalidMultiTenantSettings builds the 409 for an unusable stored row.
func invalidMultiTenantSettings() error {
	return &httpError{
		status:  http.StatusConflict,
		message: multiTenantInvalidError,
		code:    multiTenantInvalidCode,
		detail:  multiTenantInvalidDetail,
	}
}

// readMultiTenantSchedulerSettings mirrors getSettings: no row returns the
// defaults with source "default"; a row is validated field by field and any
// present but invalid concurrency fails the whole read with 409 (fail-closed,
// no self-heal).
func (s *Service) readMultiTenantSchedulerSettings(ctx context.Context) (multiTenantSchedulerSettings, error) {
	defaults := defaultMultiTenantSchedulerConcurrency()
	raw, found, err := s.loadSetting(ctx, settingKeyMultiTenantScheduler)
	if err != nil {
		return multiTenantSchedulerSettings{}, err
	}
	if !found {
		return multiTenantSchedulerSettings{Source: SourceDefault, multiTenantSchedulerConcurrency: defaults}, nil
	}
	var stored multiTenantSchedulerStoredValue
	if err := json.Unmarshal(raw, &stored); err != nil {
		return multiTenantSchedulerSettings{}, invalidMultiTenantSettings()
	}
	normalized := multiTenantSchedulerConcurrency{}
	for _, spec := range multiTenantConcurrencySpecs {
		value, ok := strictOptionalInt(spec.storedRaw(&stored))
		if !ok {
			// Absent keys fall back to the default; present but invalid keys make
			// the whole record invalid.
			if present(spec.storedRaw(&stored)) {
				return multiTenantSchedulerSettings{}, invalidMultiTenantSettings()
			}
			value = spec.defaultValue
		}
		spec.assign(&normalized, value)
	}
	return multiTenantSchedulerSettings{Source: SourceDB, multiTenantSchedulerConcurrency: normalized}, nil
}

// updateMultiTenantSchedulerSettings mirrors updateSettings: full replacement
// upsert, best-effort audit row and a source:"db" response.
func (s *Service) updateMultiTenantSchedulerSettings(ctx context.Context, orgID, actorID string, normalized multiTenantSchedulerConcurrency) (multiTenantSchedulerSettings, error) {
	if s == nil || s.db == nil {
		return multiTenantSchedulerSettings{}, errNoDatabase
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return multiTenantSchedulerSettings{}, err
	}
	if err := s.upsertSettingForceDescription(ctx, settingKeyMultiTenantScheduler, encoded,
		descriptionMultiTenantScheduler, nullableActorID(actorID)); err != nil {
		return multiTenantSchedulerSettings{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "multi_tenant_scheduler_settings_update", encoded)
	return multiTenantSchedulerSettings{Source: SourceDB, multiTenantSchedulerConcurrency: normalized}, nil
}
