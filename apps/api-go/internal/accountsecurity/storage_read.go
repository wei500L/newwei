package accountsecurity

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// This file reproduces the read side of StorageSettingsService.getStorageConfig
// plus StorageService.isPublicUrl. The avatar check only resolves configuration
// and compares prefixes: it never contacts S3, never signs an upload URL and
// never requests the avatar URL.

// storageSettingsCacheKey and its TTL mirror STORAGE_SETTINGS_CACHE_KEY /
// SETTINGS_CACHE_TTL_SECONDS.
const storageSettingsCacheKey = "storage:settings"
const storageSettingsCacheTTLSeconds = 60

// The nine SystemSetting keys the storage reader loads, in the exact order
// NestJS declares them.
const (
	settingKeyCrawlImageStorage        = "crawl_image_storage"
	settingKeyS3AccessKeyID            = "storage_s3_access_key_id"
	settingKeyS3SecretAccessKey        = "storage_s3_secret_access_key"
	settingKeyS3Region                 = "storage_s3_region"
	settingKeyS3Bucket                 = "storage_s3_bucket"
	settingKeyS3Endpoint               = "storage_s3_endpoint"
	settingKeyS3PublicBaseURL          = "storage_s3_public_base_url"
	settingKeyS3ForcePathStyle         = "storage_s3_force_path_style"
	settingKeyS3PresignedURLTTLSeconds = "storage_s3_presigned_url_ttl_seconds"
	storageSettingsKnownKeyCount       = 9
)

// storageSettingValues is the typed view of the stored settings. A nil
// json.RawMessage means the row is absent; a present value keeps its JSON type
// so the asString/asBoolean/asNumber semantics can be applied per field.
type storageSettingValues struct {
	CrawlImageStorage     json.RawMessage `json:"crawl_image_storage,omitempty"`
	AccessKeyID           json.RawMessage `json:"storage_s3_access_key_id,omitempty"`
	SecretAccessKey       json.RawMessage `json:"storage_s3_secret_access_key,omitempty"`
	Region                json.RawMessage `json:"storage_s3_region,omitempty"`
	Bucket                json.RawMessage `json:"storage_s3_bucket,omitempty"`
	Endpoint              json.RawMessage `json:"storage_s3_endpoint,omitempty"`
	PublicBaseURL         json.RawMessage `json:"storage_s3_public_base_url,omitempty"`
	ForcePathStyle        json.RawMessage `json:"storage_s3_force_path_style,omitempty"`
	PresignedURLTTLSecond json.RawMessage `json:"storage_s3_presigned_url_ttl_seconds,omitempty"`
}

// setField implements strictObjectTarget for the cached-settings object.
func (v *storageSettingValues) setField(name string, value json.RawMessage) bool {
	switch name {
	case settingKeyCrawlImageStorage:
		v.CrawlImageStorage = value
	case settingKeyS3AccessKeyID:
		v.AccessKeyID = value
	case settingKeyS3SecretAccessKey:
		v.SecretAccessKey = value
	case settingKeyS3Region:
		v.Region = value
	case settingKeyS3Bucket:
		v.Bucket = value
	case settingKeyS3Endpoint:
		v.Endpoint = value
	case settingKeyS3PublicBaseURL:
		v.PublicBaseURL = value
	case settingKeyS3ForcePathStyle:
		v.ForcePathStyle = value
	case settingKeyS3PresignedURLTTLSeconds:
		v.PresignedURLTTLSecond = value
	default:
		return false
	}
	return true
}

// storageConfig is the resolved effective configuration.
type storageConfig struct {
	AccessKeyID            string
	SecretAccessKey        string
	Region                 string
	Bucket                 string
	Endpoint               *string
	PublicBaseURL          string
	ForcePathStyle         bool
	PresignedURLTTLSeconds float64
}

// loadStorageSettingValues mirrors loadSettings: a cache hit returns the cached
// object (a Redis failure is logged and falls back to MySQL, exactly like the
// NestJS try/catch), otherwise the nine rows are read and the object is cached
// best-effort with a 60 second TTL.
func (s *Service) loadStorageSettingValues(ctx context.Context) (storageSettingValues, error) {
	if raw, found, err := s.cacheGetJSON(ctx, storageSettingsCacheKey); err != nil {
		logRedisFailure("storage settings read", storageSettingsCacheKey, err)
	} else if found {
		var cached storageSettingValues
		if _, decodeErr := decodeStrictObject(raw, &cached); decodeErr == nil {
			return cached, nil
		}
	}

	if s == nil || s.db == nil {
		return storageSettingValues{}, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `key`, `value` FROM SystemSetting WHERE `key` IN ("+
			"?, ?, ?, ?, ?, ?, ?, ?, ?) LIMIT ?",
		settingKeyCrawlImageStorage,
		settingKeyS3AccessKeyID,
		settingKeyS3SecretAccessKey,
		settingKeyS3Region,
		settingKeyS3Bucket,
		settingKeyS3Endpoint,
		settingKeyS3PublicBaseURL,
		settingKeyS3ForcePathStyle,
		settingKeyS3PresignedURLTTLSeconds,
		storageSettingsKnownKeyCount)
	if err != nil {
		return storageSettingValues{}, dbWrap(err)
	}
	defer rows.Close()

	var values storageSettingValues
	for rows.Next() {
		var key string
		var raw []byte
		if err := rows.Scan(&key, &raw); err != nil {
			return storageSettingValues{}, dbWrap(err)
		}
		values.setField(key, json.RawMessage(raw))
	}
	if err := rows.Err(); err != nil {
		return storageSettingValues{}, dbWrap(err)
	}

	encoded, marshalErr := json.Marshal(values)
	if marshalErr == nil {
		if cacheErr := s.cacheSet(ctx, storageSettingsCacheKey, encoded, storageSettingsCacheTTLSeconds); cacheErr != nil {
			logRedisFailure("storage settings write", storageSettingsCacheKey, cacheErr)
		}
	}
	return values, nil
}

// effectiveStorageConfig mirrors getStorageConfig: each field prefers a stored
// value and falls back to the S3_* environment default.
func (s *Service) effectiveStorageConfig(ctx context.Context) (storageConfig, error) {
	values, err := s.loadStorageSettingValues(ctx)
	if err != nil {
		return storageConfig{}, err
	}
	config := storageConfig{
		AccessKeyID:            stringOrEnv(values.AccessKeyID, s.cfg.S3AccessKeyID),
		SecretAccessKey:        s.resolveStorageSecret(values.SecretAccessKey),
		Region:                 stringOrEnv(values.Region, s.cfg.S3Region),
		Bucket:                 stringOrEnv(values.Bucket, s.cfg.S3Bucket),
		PublicBaseURL:          stringOrEnv(values.PublicBaseURL, s.cfg.S3PublicBaseURL),
		ForcePathStyle:         boolOrEnv(values.ForcePathStyle, s.cfg.S3ForcePathStyle),
		PresignedURLTTLSeconds: numberOrEnv(values.PresignedURLTTLSecond, float64(s.cfg.S3PresignedURLTTLSeconds)),
	}
	if endpoint := stringOrEnvPtr(values.Endpoint, s.cfg.S3Endpoint); endpoint != nil {
		config.Endpoint = endpoint
	}
	return config, nil
}

// isPublicURL mirrors StorageService.isPublicUrl: resolve the configuration,
// reject an incomplete one with the exact 400, then require the value to start
// with the public base URL (with exactly one trailing slash removed) followed by
// "/". A same-hostname or arbitrary-suffix match is deliberately not accepted.
func (s *Service) isPublicURL(ctx context.Context, value string) (bool, error) {
	config, err := s.effectiveStorageConfig(ctx)
	if err != nil {
		return false, err
	}
	if config.AccessKeyID == "" || config.SecretAccessKey == "" ||
		config.Bucket == "" || config.PublicBaseURL == "" {
		return false, badRequest("Storage configuration is incomplete")
	}
	base := strings.TrimSuffix(config.PublicBaseURL, "/")
	return strings.HasPrefix(value, base+"/"), nil
}

// StorageRuntimeConfig exposes the same resolved snapshot as
// effectiveStorageConfig in the objectstorage shape, so the avatar upload
// signer reuses this reader instead of duplicating the nine-key lookup, the
// Redis cache fallback and the secret decryption. It never contacts S3.
func (s *Service) StorageRuntimeConfig(ctx context.Context) (objectstorage.RuntimeConfig, error) {
	config, err := s.effectiveStorageConfig(ctx)
	if err != nil {
		return objectstorage.RuntimeConfig{}, err
	}
	runtime := objectstorage.RuntimeConfig{
		AccessKeyID:            config.AccessKeyID,
		SecretAccessKey:        config.SecretAccessKey,
		Region:                 config.Region,
		Bucket:                 config.Bucket,
		PublicBaseURL:          config.PublicBaseURL,
		ForcePathStyle:         config.ForcePathStyle,
		PresignedURLTTLSeconds: config.PresignedURLTTLSeconds,
	}
	if config.Endpoint != nil {
		runtime.Endpoint = *config.Endpoint
	}
	return runtime, nil
}

// stringOrEnv mirrors `asString(stored) ?? fallback`.
func stringOrEnv(raw json.RawMessage, fallback string) string {
	if value, ok := jsonString(raw); ok {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return fallback
}

// stringOrEnvPtr is the nullable variant: the key stays absent when neither a
// stored value nor an environment default exists.
func stringOrEnvPtr(raw json.RawMessage, fallback string) *string {
	if value, ok := jsonString(raw); ok {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return &trimmed
		}
	}
	if fallback == "" {
		return nil
	}
	value := fallback
	return &value
}

// boolOrEnv mirrors `asBoolean(stored) ?? fallback`.
func boolOrEnv(raw json.RawMessage, fallback bool) bool {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "true":
		return true
	case "false":
		return false
	default:
		return fallback
	}
}

// numberOrEnv mirrors `asNumber(stored) ?? fallback`: only a finite JSON number
// overrides the environment default.
func numberOrEnv(raw json.RawMessage, fallback float64) float64 {
	if value, ok := jsIsFiniteNumber(raw); ok {
		return value
	}
	return fallback
}
