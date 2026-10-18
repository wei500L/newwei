package infrastructuresettings

import (
	"bytes"
	"context"
	"encoding/json"
)

// ---- vector service cache ----

// cachedVectorSettings is the `vector_service:settings` envelope: an
// exists/value wrapper so a "no row yet" result is cached too.
type cachedVectorSettings struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// vectorStoredSettings is the stored `vector_service` value. Fields stay raw so
// a wrong stored type degrades to the environment default instead of failing
// the read, exactly like the NestJS unknown-typed union.
type vectorStoredSettings struct {
	Enabled         json.RawMessage `json:"enabled,omitempty"`
	FallbackToMongo json.RawMessage `json:"fallbackToMongo,omitempty"`
	BaseURL         json.RawMessage `json:"baseUrl,omitempty"`
	Token           json.RawMessage `json:"token,omitempty"`
	TimeoutMs       json.RawMessage `json:"timeoutMs,omitempty"`
	MaxRetries      json.RawMessage `json:"maxRetries,omitempty"`
}

// parseVectorStoredSettings mirrors the NestJS `raw && typeof raw === "object"`
// check: JSON null and primitives are "no settings", while objects and arrays
// count as a settings document (arrays simply yield undefined members).
func parseVectorStoredSettings(raw json.RawMessage) *vectorStoredSettings {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] != '{' && trimmed[0] != '[' {
		return nil
	}
	settings := vectorStoredSettings{}
	if trimmed[0] == '{' {
		if err := json.Unmarshal(trimmed, &settings); err != nil {
			return &vectorStoredSettings{}
		}
	}
	return &settings
}

// loadVectorSettingsCache reads the Redis envelope. A cache failure is logged
// and treated as a miss, matching the NestJS try/catch.
func (s *Service) loadVectorSettingsCache(ctx context.Context) (found bool, settings *vectorStoredSettings) {
	raw, hit, err := s.cacheGet(ctx, cacheKeyVectorService)
	if err != nil {
		logBackground("vector service settings cache read failed", err)
		return false, nil
	}
	if !hit {
		return false, nil
	}
	var cached cachedVectorSettings
	if err := json.Unmarshal(raw, &cached); err != nil {
		logBackground("vector service settings cache entry is not valid", err)
		return false, nil
	}
	if !cached.Exists {
		return true, nil
	}
	return true, parseVectorStoredSettings(cached.Value)
}

// loadVectorSettingsFromDB reads the row straight from MySQL.
func (s *Service) loadVectorSettingsFromDB(ctx context.Context) (*vectorStoredSettings, error) {
	raw, found, err := s.loadSetting(ctx, settingKeyVectorService)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return parseVectorStoredSettings(raw), nil
}

// loadVectorSettings reads cache-first (the plain GET path).
func (s *Service) loadVectorSettings(ctx context.Context) (*vectorStoredSettings, error) {
	if found, settings := s.loadVectorSettingsCache(ctx); found {
		return settings, nil
	}
	settings, err := s.loadVectorSettingsFromDB(ctx)
	if err != nil {
		return nil, err
	}
	envelope := cachedVectorSettings{Exists: settings != nil}
	if settings != nil {
		encoded, encodeErr := json.Marshal(settings)
		if encodeErr == nil {
			envelope.Value = encoded
		}
	}
	if payload, encodeErr := json.Marshal(envelope); encodeErr == nil {
		if cacheErr := s.cacheSet(ctx, cacheKeyVectorService, payload, vectorCacheTTLSeconds); cacheErr != nil {
			logBackground("vector service settings cache write failed", cacheErr)
		}
	}
	return settings, nil
}

// ---- storage cache ----

// storageRecordMap holds the nine storage SystemSetting values by their full
// database key. Named fields replace a generic JSON map on purpose: the key set
// is closed and the cache document is a direct object keyed by those names.
type storageRecordMap struct {
	CrawlImageStorage      json.RawMessage
	AccessKeyID            json.RawMessage
	SecretAccessKey        json.RawMessage
	Region                 json.RawMessage
	Bucket                 json.RawMessage
	Endpoint               json.RawMessage
	PublicBaseURL          json.RawMessage
	ForcePathStyle         json.RawMessage
	PresignedURLTTLSeconds json.RawMessage
}

// set stores one value by its database key. Unknown keys are ignored: the
// selection is always one of the nine declared rows.
func (m *storageRecordMap) set(key string, value json.RawMessage) {
	switch key {
	case settingKeyCrawlImageStorage:
		m.CrawlImageStorage = value
	case settingKeyS3AccessKeyID:
		m.AccessKeyID = value
	case settingKeyS3SecretAccessKey:
		m.SecretAccessKey = value
	case settingKeyS3Region:
		m.Region = value
	case settingKeyS3Bucket:
		m.Bucket = value
	case settingKeyS3Endpoint:
		m.Endpoint = value
	case settingKeyS3PublicBaseURL:
		m.PublicBaseURL = value
	case settingKeyS3ForcePathStyle:
		m.ForcePathStyle = value
	case settingKeyS3PresignedURLTTLSecond:
		m.PresignedURLTTLSeconds = value
	}
}

// get returns the raw value for a database key, or nil when absent.
func (m storageRecordMap) get(key string) json.RawMessage {
	switch key {
	case settingKeyCrawlImageStorage:
		return m.CrawlImageStorage
	case settingKeyS3AccessKeyID:
		return m.AccessKeyID
	case settingKeyS3SecretAccessKey:
		return m.SecretAccessKey
	case settingKeyS3Region:
		return m.Region
	case settingKeyS3Bucket:
		return m.Bucket
	case settingKeyS3Endpoint:
		return m.Endpoint
	case settingKeyS3PublicBaseURL:
		return m.PublicBaseURL
	case settingKeyS3ForcePathStyle:
		return m.ForcePathStyle
	case settingKeyS3PresignedURLTTLSecond:
		return m.PresignedURLTTLSeconds
	default:
		return nil
	}
}

// storageCacheDocument is the `storage:settings` Redis payload: a direct object
// keyed by the full SystemSetting key. Absent keys are omitted and JSON null is
// preserved.
type storageCacheDocument struct {
	CrawlImageStorage      json.RawMessage `json:"crawl_image_storage,omitempty"`
	AccessKeyID            json.RawMessage `json:"storage_s3_access_key_id,omitempty"`
	SecretAccessKey        json.RawMessage `json:"storage_s3_secret_access_key,omitempty"`
	Region                 json.RawMessage `json:"storage_s3_region,omitempty"`
	Bucket                 json.RawMessage `json:"storage_s3_bucket,omitempty"`
	Endpoint               json.RawMessage `json:"storage_s3_endpoint,omitempty"`
	PublicBaseURL          json.RawMessage `json:"storage_s3_public_base_url,omitempty"`
	ForcePathStyle         json.RawMessage `json:"storage_s3_force_path_style,omitempty"`
	PresignedURLTTLSeconds json.RawMessage `json:"storage_s3_presigned_url_ttl_seconds,omitempty"`
}

// records converts the document into the typed record map.
func (d storageCacheDocument) records() storageRecordMap {
	return storageRecordMap{
		CrawlImageStorage:      d.CrawlImageStorage,
		AccessKeyID:            d.AccessKeyID,
		SecretAccessKey:        d.SecretAccessKey,
		Region:                 d.Region,
		Bucket:                 d.Bucket,
		Endpoint:               d.Endpoint,
		PublicBaseURL:          d.PublicBaseURL,
		ForcePathStyle:         d.ForcePathStyle,
		PresignedURLTTLSeconds: d.PresignedURLTTLSeconds,
	}
}

// document renders the record map back into the cache document.
func (m storageRecordMap) document() storageCacheDocument {
	return storageCacheDocument{
		CrawlImageStorage:      m.CrawlImageStorage,
		AccessKeyID:            m.AccessKeyID,
		SecretAccessKey:        m.SecretAccessKey,
		Region:                 m.Region,
		Bucket:                 m.Bucket,
		Endpoint:               m.Endpoint,
		PublicBaseURL:          m.PublicBaseURL,
		ForcePathStyle:         m.ForcePathStyle,
		PresignedURLTTLSeconds: m.PresignedURLTTLSeconds,
	}
}

// loadStorageRecords reads cache-first and repopulates the cache on a miss.
func (s *Service) loadStorageRecords(ctx context.Context) (storageRecordMap, error) {
	if raw, hit, err := s.cacheGet(ctx, cacheKeyStorageSettings); err != nil {
		logBackground("storage settings cache read failed; falling back to database", err)
	} else if hit {
		var document storageCacheDocument
		if err := json.Unmarshal(raw, &document); err == nil {
			return document.records(), nil
		}
		logBackground("storage settings cache entry is not valid", nil)
	}

	records, err := s.loadStorageRecordsFromDB(ctx)
	if err != nil {
		return storageRecordMap{}, err
	}
	if payload, encodeErr := json.Marshal(records.document()); encodeErr == nil {
		if cacheErr := s.cacheSet(ctx, cacheKeyStorageSettings, payload, storageCacheTTLSeconds); cacheErr != nil {
			logBackground("storage settings cache write failed", cacheErr)
		}
	}
	return records, nil
}
