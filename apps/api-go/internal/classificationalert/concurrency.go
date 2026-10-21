package classificationalert

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Multi-tenant scheduler runtime settings contract. The scheduler reads one
// field, but NestJS validates the whole stored record before returning it, so
// the default reader keeps that fail-closed behavior.
const (
	// multiTenantSchedulerSettingKey is the global SystemSetting primary key.
	multiTenantSchedulerSettingKey = "multi_tenant_scheduler_runtime_settings"
	// defaultOrgConcurrency is DEFAULT_SETTINGS.classificationQualityAlertOrgConcurrency.
	defaultOrgConcurrency = 4
	// minOrgConcurrency and maxOrgConcurrency are CONCURRENCY_MIN/MAX.
	minOrgConcurrency = 1
	maxOrgConcurrency = 16
	// runtimeSettingsCacheTTL is RUNTIME_CACHE_TTL_MS: the process-local cache
	// MultiTenantSchedulerSettingsService.getRuntimeSettings serves for 30s. A
	// five-minute tick always reads past it, so the cache only collapses
	// concurrent/duplicate reads.
	runtimeSettingsCacheTTL = 30 * time.Second
)

// errInvalidRuntimeSettings mirrors the ConflictException payload of
// MultiTenantSchedulerSettingsService.getSettings. The scheduler treats it as a
// tick failure, exactly like the @Interval rejection NestJS logs.
var errInvalidRuntimeSettings = errors.New(
	"classificationalert: stored multi-tenant scheduler runtime settings are invalid " +
		"(MULTI_TENANT_SCHEDULER_SETTINGS_INVALID): multi-tenant scheduler concurrency " +
		"settings must be integers between 1 and 16",
)

// storedMultiTenantSchedulerSettings is the typed view of SystemSetting.value.
// The eleven concurrency fields are raw so an absent key and a present-but-null
// key stay distinguishable; NestJS defaults the former and rejects the latter.
type storedMultiTenantSchedulerSettings struct {
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

// concurrencyValues lists every field in the order the NestJS normalizer walks
// them, so the first invalid field decides the whole record.
func (value storedMultiTenantSchedulerSettings) concurrencyValues() []json.RawMessage {
	return []json.RawMessage{
		value.RealtimeSignalsOrgConcurrency,
		value.NewsEventsTimelineOrgConcurrency,
		value.NewsEventsIngestionOrgConcurrency,
		value.KnowledgeGraphIngestionOrgConcurrency,
		value.SentimentSnapshotOrgConcurrency,
		value.NewsnowHottestAnalysisOrgConcurrency,
		value.ClassificationQualityAlertOrgConcurrency,
		value.NewsIndicatorAssociationOrgConcurrency,
		value.CrawlQualityTaskSnapshotOrgConcurrency,
		value.SituationMonitorOrefDefaultRuleOrgConcurrency,
		value.UserDigestDeliveryOrgConcurrency,
	}
}

// systemSettingConcurrencyReader is the default OrgConcurrencyReader: one
// SystemSetting row read, the same whole-record validation NestJS performs, and
// the 30 second process-local runtime cache.
type systemSettingConcurrencyReader struct {
	db  *sql.DB
	now func() time.Time

	mu          sync.Mutex
	cached      bool
	cachedValue int
	cachedAt    time.Time
}

// newSystemSettingConcurrencyReader builds the reader. now defaults to
// time.Now and is injectable so tests do not sleep.
func newSystemSettingConcurrencyReader(db *sql.DB, now func() time.Time) *systemSettingConcurrencyReader {
	if now == nil {
		now = time.Now
	}
	return &systemSettingConcurrencyReader{db: db, now: now}
}

// ReadClassificationQualityAlertOrgConcurrency returns the persisted value,
// defaulting to 4 when the setting row or the field is absent. An invalid stored
// record fails the read instead of silently using the default.
func (r *systemSettingConcurrencyReader) ReadClassificationQualityAlertOrgConcurrency(ctx context.Context) (int, error) {
	if r == nil || r.db == nil {
		return 0, errNoDatabase
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if r.cached && now.Sub(r.cachedAt) <= runtimeSettingsCacheTTL {
		return r.cachedValue, nil
	}
	value, err := r.read(ctx)
	if err != nil {
		return 0, err
	}
	r.cached = true
	r.cachedValue = value
	r.cachedAt = now
	return value, nil
}

// read loads and validates the stored record. getSettings() maps a missing row
// to the defaults and a present-but-invalid record to the ConflictException,
// which the scheduler surfaces as a tick failure.
func (r *systemSettingConcurrencyReader) read(ctx context.Context) (int, error) {
	var raw []byte
	err := r.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
		multiTenantSchedulerSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultOrgConcurrency, nil
	}
	if err != nil {
		return 0, err
	}
	return parseClassificationQualityAlertConcurrency(raw)
}

// parseClassificationQualityAlertConcurrency validates the stored JSON object
// like MultiTenantSchedulerSettingsService.normalizeStoredSettings: a non-object
// value or any present invalid concurrency field invalidates the whole record;
// absent fields fall back to their defaults.
func parseClassificationQualityAlertConcurrency(raw []byte) (int, error) {
	trimmed := bytes.TrimSpace(raw)
	// JSON null is not an object; NestJS rejects it instead of reading defaults.
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0, errInvalidRuntimeSettings
	}
	var stored storedMultiTenantSchedulerSettings
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return 0, errInvalidRuntimeSettings
	}
	for _, field := range stored.concurrencyValues() {
		if _, present, valid := strictOptionalConcurrency(field); present && !valid {
			return 0, errInvalidRuntimeSettings
		}
	}
	value, present, valid := strictOptionalConcurrency(stored.ClassificationQualityAlertOrgConcurrency)
	if !present {
		return defaultOrgConcurrency, nil
	}
	if !valid {
		return 0, errInvalidRuntimeSettings
	}
	return value, nil
}

// strictOptionalConcurrency mirrors toStrictOptionalInt: present=false means the
// key is absent and the caller uses the default, present=true with valid=false
// means the stored value invalidates the whole record.
func strictOptionalConcurrency(raw json.RawMessage) (value int, present bool, valid bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false, true
	}
	number, numeric := jsNumber(trimmed)
	if !numeric || math.IsNaN(number) || math.IsInf(number, 0) ||
		math.Trunc(number) != number ||
		number < minOrgConcurrency || number > maxOrgConcurrency {
		return 0, true, false
	}
	return int(number), true, true
}

// jsNumber mirrors JavaScript's Number(value) for the JSON shapes a stored
// SystemSetting value can contain: numbers, numeric strings, booleans and
// null (0). It is only used to reproduce toStrictOptionalInt's coercion, never
// to change the value a valid record yields.
func jsNumber(raw []byte) (float64, bool) {
	switch raw[0] {
	case '"':
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return math.NaN(), false
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return 0, true
		}
		value, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return math.NaN(), true
		}
		return value, true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return 0, true
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return math.NaN(), true
		}
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			return jsNumber(items[0])
		default:
			return math.NaN(), true
		}
	case '{':
		return math.NaN(), true
	default:
		value, err := strconv.ParseFloat(string(raw), 64)
		if err != nil {
			return math.NaN(), true
		}
		return value, true
	}
}
