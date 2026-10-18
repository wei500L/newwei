package dataruntimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
)

// archivePreparationDefaults mirrors DEFAULT_SETTINGS.
const (
	defaultJobBatchSize            = 20
	defaultEmbeddingBatchSize      = 20
	defaultEmbeddingMaxConcurrency = 1
	defaultRerankMaxConcurrency    = 1
)

// storedArchivePreparationSettings is the stored value shape. Members stay raw so
// a wrong stored type degrades to the default instead of failing the read.
type storedArchivePreparationSettings struct {
	JobBatchSize            json.RawMessage `json:"jobBatchSize,omitempty"`
	EmbeddingBatchSize      json.RawMessage `json:"embeddingBatchSize,omitempty"`
	EmbeddingMaxConcurrency json.RawMessage `json:"embeddingMaxConcurrency,omitempty"`
	RerankMaxConcurrency    json.RawMessage `json:"rerankMaxConcurrency,omitempty"`
}

// archivePreparationSettings is the normalized four-field document that is
// written to the `archive_preparation_settings` row.
//
// The json tags are REQUIRED: NestJS reads `raw.jobBatchSize` and friends by
// their camelCase names, so a document written with Go's default PascalCase keys
// would silently normalize back to the defaults on the NestJS side (Go's own
// decoder is case-insensitive, which is why only a real-stack database assertion
// catches this).
type archivePreparationSettings struct {
	JobBatchSize            int `json:"jobBatchSize"`
	EmbeddingBatchSize      int `json:"embeddingBatchSize"`
	EmbeddingMaxConcurrency int `json:"embeddingMaxConcurrency"`
	RerankMaxConcurrency    int `json:"rerankMaxConcurrency"`
}

// archivePreparationPublicSettings is the response body. Member order matches
// `{ source, ...settings }` in NestJS.
type archivePreparationPublicSettings struct {
	Source                  ArchiveSettingsSource `json:"source"`
	JobBatchSize            int                   `json:"jobBatchSize"`
	EmbeddingBatchSize      int                   `json:"embeddingBatchSize"`
	EmbeddingMaxConcurrency int                   `json:"embeddingMaxConcurrency"`
	RerankMaxConcurrency    int                   `json:"rerankMaxConcurrency"`
}

// encodeJSON renders the public archive-preparation settings.
func (s archivePreparationPublicSettings) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// defaultArchivePreparationSettings returns the four defaults.
func defaultArchivePreparationSettings() archivePreparationSettings {
	return archivePreparationSettings{
		JobBatchSize:            defaultJobBatchSize,
		EmbeddingBatchSize:      defaultEmbeddingBatchSize,
		EmbeddingMaxConcurrency: defaultEmbeddingMaxConcurrency,
		RerankMaxConcurrency:    defaultRerankMaxConcurrency,
	}
}

// parseStoredArchivePreparationSettings decodes the stored value. A JSON null or
// a primitive yields nil; an object or an array yields a member view (an array
// simply has no members). The nil result is used by the *normalizer* only: the
// response `source` is decided by JavaScript truthiness of the raw value, which
// is why `{}`, `[]`, `0` and `null` must stay distinguishable.
func parseStoredArchivePreparationSettings(raw json.RawMessage) *storedArchivePreparationSettings {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] != '{' && trimmed[0] != '[' {
		return nil
	}
	settings := storedArchivePreparationSettings{}
	if trimmed[0] == '{' {
		if err := json.Unmarshal(trimmed, &settings); err != nil {
			return &storedArchivePreparationSettings{}
		}
	}
	return &settings
}

// jsTruthy mirrors JavaScript truthiness for a decoded JSON value: only null,
// false, 0, -0, NaN and "" are falsy, so an empty array or object is truthy.
//
// NestJS derives the response `source` with `record ? "db" : "default"` on the
// stored value, NOT with "a database row exists": a stored JSON null, a stored 0
// or a stored empty string all report `default` even though the row exists.
func jsTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	switch trimmed[0] {
	case 'n': // null
		return false
	case 'f': // false
		return false
	case 't': // true
		return true
	case '"':
		text, ok := decodeJSONString(trimmed)
		return ok && text != ""
	case '[', '{':
		return true
	default:
		value, isNumber := jsonNumberValue(trimmed)
		if !isNumber {
			return true
		}
		return value != 0
	}
}

// clampStoredInt mirrors the NestJS clampInt helper:
// `typeof value === "number" ? value : Number(value)`, then a non-finite value
// falls back, otherwise `Math.round` followed by the clamp.
//
// A JSON null member becomes Number(null) === 0 and is clamped to the lower
// bound, which is deliberately different from an absent member (that one uses the
// default).
func clampStoredInt(raw json.RawMessage, min, max, fallback int) int {
	if len(bytes.TrimSpace(raw)) == 0 {
		return fallback
	}
	value, present := jsNumberFromJSON(trimmedRaw(raw))
	if !present {
		return fallback
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	rounded := math.Round(value)
	if rounded < float64(min) {
		return min
	}
	if rounded > float64(max) {
		return max
	}
	return int(rounded)
}

// trimmedRaw returns the raw member unchanged; it exists so clampStoredInt reads
// like the NestJS coercion site.
func trimmedRaw(raw json.RawMessage) json.RawMessage { return raw }

// normalizeArchivePreparation mirrors the NestJS normalize method.
func normalizeArchivePreparation(settings *storedArchivePreparationSettings) archivePreparationSettings {
	if settings == nil {
		settings = &storedArchivePreparationSettings{}
	}
	return archivePreparationSettings{
		JobBatchSize:            clampStoredInt(settings.JobBatchSize, 1, 100, defaultJobBatchSize),
		EmbeddingBatchSize:      clampStoredInt(settings.EmbeddingBatchSize, 1, 100, defaultEmbeddingBatchSize),
		EmbeddingMaxConcurrency: clampStoredInt(settings.EmbeddingMaxConcurrency, 1, 8, defaultEmbeddingMaxConcurrency),
		RerankMaxConcurrency:    clampStoredInt(settings.RerankMaxConcurrency, 1, 8, defaultRerankMaxConcurrency),
	}
}

// loadArchivePreparationStored mirrors CacheService.wrap for
// `archive_preparation:settings`.
//
// The cached payload is the RAW settings value (or the JSON literal null), never
// an {exists,value} envelope, so a cached null means "no row", never "a row with
// a null value". A cache read or write failure is logged and the loader is used,
// matching the NestJS tolerance.
//
// Deliberate difference from NestJS: the wrap lock
// (`lock:archive_preparation:settings`, lockTtlMs/retryDelayMs/maxWaitMs) is a
// single-instance stampede guard around the loader. The loader here is one
// deterministic single-row SELECT, so skipping the Redis lease can only make two
// instances compute the same value concurrently; the cached payload and the HTTP
// response are unaffected.
func (s *Service) loadArchivePreparationStored(ctx context.Context) (json.RawMessage, error) {
	if raw, hit, err := s.cacheGet(ctx, cacheKeyArchivePreparation); err != nil {
		logBackground("archive preparation settings cache read failed", err)
	} else if hit {
		return raw, nil
	}
	raw, found, err := s.loadSettingRaw(ctx, settingKeyArchivePreparation)
	if err != nil {
		return nil, err
	}
	if !found {
		raw = jsonNullValue
	}
	s.writeArchivePreparationCache(ctx, raw)
	return raw, nil
}

// writeArchivePreparationCache stores the raw settings value (or JSON null).
func (s *Service) writeArchivePreparationCache(ctx context.Context, raw json.RawMessage) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = jsonNullValue
	}
	if err := s.cacheSet(ctx, cacheKeyArchivePreparation, raw, archiveSettingsCacheTTL); err != nil {
		logBackground("archive preparation settings cache write failed", err)
	}
}

// getArchivePreparationPublic mirrors getPublicSettings.
func (s *Service) getArchivePreparationPublic(ctx context.Context) (*archivePreparationPublicSettings, error) {
	raw, err := s.loadArchivePreparationStored(ctx)
	if err != nil {
		return nil, err
	}
	source := ArchiveSettingsSourceDefault
	if jsTruthy(raw) {
		source = ArchiveSettingsSourceDB
	}
	settings := normalizeArchivePreparation(parseStoredArchivePreparationSettings(raw))
	return &archivePreparationPublicSettings{
		Source:                  source,
		JobBatchSize:            settings.JobBatchSize,
		EmbeddingBatchSize:      settings.EmbeddingBatchSize,
		EmbeddingMaxConcurrency: settings.EmbeddingMaxConcurrency,
		RerankMaxConcurrency:    settings.RerankMaxConcurrency,
	}, nil
}

// updateArchivePreparationSettings mirrors updateSettings.
//
// The caller has already asserted the platform admin (DS1). This route is a full
// four-field replacement, not a partial merge, so it deliberately stays
// lock-free: there is no read-modify-write window to protect.
func (s *Service) updateArchivePreparationSettings(ctx context.Context, orgID, actorID string, update *archivePreparationUpdate) (*archivePreparationPublicSettings, error) {
	settings := normalizeArchivePreparation(&storedArchivePreparationSettings{
		JobBatchSize:            jsonNumberRaw(update.JobBatchSize),
		EmbeddingBatchSize:      jsonNumberRaw(update.EmbeddingBatchSize),
		EmbeddingMaxConcurrency: jsonNumberRaw(update.EmbeddingMaxConcurrency),
		RerankMaxConcurrency:    jsonNumberRaw(update.RerankMaxConcurrency),
	})
	encoded, err := json.Marshal(settings)
	if err != nil {
		return nil, err
	}
	if err := s.upsertArchivePreparation(ctx, encoded, nullableActorID(actorID)); err != nil {
		return nil, err
	}
	metadata, err := json.Marshal(archivePreparationAuditMetadata{
		JobBatchSize:            settings.JobBatchSize,
		EmbeddingBatchSize:      settings.EmbeddingBatchSize,
		EmbeddingMaxConcurrency: settings.EmbeddingMaxConcurrency,
		RerankMaxConcurrency:    settings.RerankMaxConcurrency,
	})
	if err != nil {
		return nil, err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, "archive_preparation_update", metadata); err != nil {
		return nil, err
	}
	if err := s.cacheDel(ctx, cacheKeyArchivePreparation); err != nil {
		logBackground("failed to invalidate archive preparation settings cache", err)
	}
	return s.getArchivePreparationPublic(ctx)
}

// resetArchivePreparationSettings mirrors resetToDefaults: only the
// archive_preparation_settings row is deleted. The status index, the queued jobs
// and the classification records are never touched.
func (s *Service) resetArchivePreparationSettings(ctx context.Context, orgID, actorID string) (*archivePreparationPublicSettings, error) {
	if err := s.deleteSetting(ctx, settingKeyArchivePreparation); err != nil {
		return nil, err
	}
	metadata, err := json.Marshal(resetAuditMetadata{OK: true})
	if err != nil {
		return nil, err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, "archive_preparation_reset", metadata); err != nil {
		return nil, err
	}
	if err := s.cacheDel(ctx, cacheKeyArchivePreparation); err != nil {
		logBackground("failed to invalidate archive preparation settings cache", err)
	}
	return s.getArchivePreparationPublic(ctx)
}

// jsonNumberRaw renders an integer as a JSON member so the shared normalizer sees
// the same value the NestJS DTO produced.
func jsonNumberRaw(value int) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}
