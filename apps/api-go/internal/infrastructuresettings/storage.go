package infrastructuresettings

import (
	"context"
	"encoding/json"
	"math"
	"strings"
)

// storageAdminSettings is the public storage settings model. `endpoint` is
// omitted entirely when neither a database value nor an environment default
// exists. accessKeyId keeps the historical admin display contract: the full
// configured access key id, never a fingerprint.
type storageAdminSettings struct {
	CrawlImageStorage string  `json:"crawlImageStorage"`
	Region            string  `json:"region"`
	Bucket            string  `json:"bucket"`
	Endpoint          *string `json:"endpoint,omitempty"`
	PublicBaseURL     string  `json:"publicBaseUrl"`
	ForcePathStyle    bool    `json:"forcePathStyle"`
	// PresignedURLTTLSeconds is a float because the NestJS reader accepts any
	// finite stored number without re-applying the DTO's integer bound. An
	// integer value still serializes without a decimal point.
	PresignedURLTTLSeconds float64 `json:"presignedUrlTtlSeconds"`
	AccessKeyID            string  `json:"accessKeyId"`
	HasSecretAccessKey     bool    `json:"hasSecretAccessKey"`
	SecretDecryptionFailed bool    `json:"secretDecryptionFailed"`
}

// storageUpdates is the normalized PATCH payload. Pointer fields distinguish
// "absent" (leave untouched) from an explicit value; the three Set flags cover
// the fields whose cleared form is the JSON literal null.
type storageUpdates struct {
	CrawlImageStorage *string
	AccessKeyID       *string
	SecretAccessKey   *string
	Region            *string
	Bucket            *string
	EndpointSet       bool
	Endpoint          *string
	PublicBaseURL     *string
	ForcePathStyleSet bool
	ForcePathStyle    *bool
	PresignedTTLSet   bool
	PresignedTTL      *int
}

// getStorageAdminSettings mirrors getAdminSettings.
func (s *Service) getStorageAdminSettings(ctx context.Context) (storageAdminSettings, error) {
	records, err := s.loadStorageRecords(ctx)
	if err != nil {
		return storageAdminSettings{}, err
	}
	secretValue, decryptionFailed := s.resolveStorageSecret(records.get(settingKeyS3SecretAccessKey))

	return storageAdminSettings{
		CrawlImageStorage:      string(storageProvider(records.get(settingKeyCrawlImageStorage))),
		Region:                 stringOrEnv(records.get(settingKeyS3Region), s.cfg.S3Region),
		Bucket:                 stringOrEnv(records.get(settingKeyS3Bucket), s.cfg.S3Bucket),
		Endpoint:               endpointOrEnv(records.get(settingKeyS3Endpoint), s.cfg.S3Endpoint),
		PublicBaseURL:          stringOrEnv(records.get(settingKeyS3PublicBaseURL), s.cfg.S3PublicBaseURL),
		ForcePathStyle:         boolOrEnv(records.get(settingKeyS3ForcePathStyle), s.cfg.S3ForcePathStyle),
		PresignedURLTTLSeconds: floatOrEnv(records.get(settingKeyS3PresignedURLTTLSecond), float64(s.cfg.S3PresignedURLTTLSeconds)),
		AccessKeyID:            stringOrEnv(records.get(settingKeyS3AccessKeyID), s.cfg.S3AccessKeyID),
		HasSecretAccessKey:     secretValue != "",
		SecretDecryptionFailed: decryptionFailed,
	}, nil
}

// updateStorageSettings mirrors updateStorageSettings: normalize, then one
// transaction for every effective field, then the audit row and the cache
// eviction. The platform-admin gate lives in the handler (it must run after DTO
// validation, exactly like the NestJS controller order).
func (s *Service) updateStorageSettings(ctx context.Context, orgID, actorID string, dto storageSettingsRequest) (storageAdminSettings, error) {
	updates := normalizeStorageUpdates(dto)
	ops, err := s.buildStorageOps(ctx, updates)
	if err != nil {
		return storageAdminSettings{}, err
	}

	if len(ops) > 0 {
		if err := s.applyStorageOps(ctx, ops, nullableActorID(actorID)); err != nil {
			return storageAdminSettings{}, err
		}
		metadata, err := json.Marshal(buildStorageAuditMetadata(updates))
		if err != nil {
			return storageAdminSettings{}, err
		}
		if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, "storage_settings_update", metadata); err != nil {
			return storageAdminSettings{}, err
		}
	}

	if err := s.cacheDel(ctx, cacheKeyStorageSettings); err != nil {
		logBackground("failed to invalidate storage settings cache", err)
	}
	return s.getStorageAdminSettings(ctx)
}

// buildStorageOps renders the normalized update set as the ordered upsert list.
// The order matches the NestJS normalizeUpdates assignment order so the audit
// metadata and the transaction touch the same fields in the same sequence.
func (s *Service) buildStorageOps(ctx context.Context, updates storageUpdates) ([]storageWriteOp, error) {
	ops := make([]storageWriteOp, 0, 9)
	add := func(key string, isPublic bool, value json.RawMessage) {
		ops = append(ops, storageWriteOp{Key: key, Value: value, IsPublic: isPublic, Description: descriptionStorageSetting})
	}

	if updates.CrawlImageStorage != nil {
		add(settingKeyCrawlImageStorage, true, stringRaw(updates.CrawlImageStorage))
	}
	if updates.AccessKeyID != nil {
		add(settingKeyS3AccessKeyID, false, stringRaw(updates.AccessKeyID))
	}
	if updates.SecretAccessKey != nil {
		encoded, err := s.encodeSecretForStorage(ctx, *updates.SecretAccessKey)
		if err != nil {
			if secretErr, ok := err.(*secretError); ok {
				return nil, secretErr.asHTTPError()
			}
			return nil, err
		}
		value, err := encoded.toRawValue()
		if err != nil {
			return nil, err
		}
		add(settingKeyS3SecretAccessKey, false, value)
	}
	if updates.Region != nil {
		add(settingKeyS3Region, true, stringRaw(updates.Region))
	}
	if updates.Bucket != nil {
		add(settingKeyS3Bucket, true, stringRaw(updates.Bucket))
	}
	if updates.EndpointSet {
		add(settingKeyS3Endpoint, true, stringRaw(updates.Endpoint))
	}
	if updates.PublicBaseURL != nil {
		add(settingKeyS3PublicBaseURL, true, stringRaw(updates.PublicBaseURL))
	}
	if updates.ForcePathStyleSet {
		if updates.ForcePathStyle == nil {
			add(settingKeyS3ForcePathStyle, true, json.RawMessage("null"))
		} else {
			add(settingKeyS3ForcePathStyle, true, boolRaw(*updates.ForcePathStyle))
		}
	}
	if updates.PresignedTTLSet {
		if updates.PresignedTTL == nil {
			add(settingKeyS3PresignedURLTTLSecond, true, json.RawMessage("null"))
		} else {
			add(settingKeyS3PresignedURLTTLSecond, true, numberRaw(*updates.PresignedTTL))
		}
	}
	return ops, nil
}

// normalizeStorageUpdates mirrors normalizeUpdates field by field: strings are
// trimmed and blank values are ignored, endpoint/forcePathStyle/
// presignedUrlTtlSeconds keep their explicit clearing branch, and
// crawlImageStorage is re-normalized defensively.
func normalizeStorageUpdates(dto storageSettingsRequest) storageUpdates {
	updates := storageUpdates{}

	if !skippedOptional(dto.CrawlImageStorageRaw) {
		if value, ok := storedTrimmedString(dto.CrawlImageStorageRaw); ok {
			normalized := strings.ToLower(value)
			if normalized == string(CrawlImageStorageMySQL) || normalized == string(CrawlImageStorageS3) {
				updates.CrawlImageStorage = &normalized
			}
		}
	}
	updates.AccessKeyID = trimmedUpdateValue(dto.AccessKeyIDRaw)
	updates.SecretAccessKey = trimmedUpdateValue(dto.SecretAccessKeyRaw)
	updates.Region = trimmedUpdateValue(dto.RegionRaw)
	updates.Bucket = trimmedUpdateValue(dto.BucketRaw)
	if present(dto.EndpointRaw) {
		updates.EndpointSet = true
		updates.Endpoint = trimmedUpdateValue(dto.EndpointRaw)
	}
	updates.PublicBaseURL = trimmedUpdateValue(dto.PublicBaseURLRaw)
	if present(dto.ForcePathStyleRaw) {
		updates.ForcePathStyleSet = true
		if !isNull(dto.ForcePathStyleRaw) {
			if value, ok := storedBoolean(dto.ForcePathStyleRaw); ok {
				updates.ForcePathStyle = &value
			}
		}
	}
	if present(dto.PresignedURLTTLSecondsRaw) {
		updates.PresignedTTLSet = true
		if !isNull(dto.PresignedURLTTLSecondsRaw) {
			if value, ok := storedJSONNumber(dto.PresignedURLTTLSecondsRaw); ok {
				intValue := saturateInt(value)
				updates.PresignedTTL = &intValue
			}
		}
	}
	return updates
}

// trimmedUpdateValue returns the trimmed value for the always-string update
// branches; null and blank values leave the setting untouched.
func trimmedUpdateValue(raw json.RawMessage) *string {
	if skippedOptional(raw) {
		return nil
	}
	value, ok := storedTrimmedString(raw)
	if !ok {
		return nil
	}
	return &value
}

// buildStorageAuditMetadata renders the audit payload: the secret is masked
// entirely and the access key id is reduced to its first four UTF-16 code units
// plus "***". Everything else keeps its normalized value, JSON null included.
func buildStorageAuditMetadata(updates storageUpdates) storageAuditMetadata {
	metadata := storageAuditMetadata{}
	if updates.CrawlImageStorage != nil {
		metadata.CrawlImageStorage = updates.CrawlImageStorage
	}
	if updates.AccessKeyID != nil {
		fingerprint := utf16Slice(*updates.AccessKeyID, 0, 4) + "***"
		metadata.AccessKeyIDFingerprint = &fingerprint
	}
	if updates.SecretAccessKey != nil {
		masked := "***"
		metadata.SecretAccessKey = &masked
	}
	if updates.Region != nil {
		metadata.Region = updates.Region
	}
	if updates.Bucket != nil {
		metadata.Bucket = updates.Bucket
	}
	if updates.EndpointSet {
		metadata.Endpoint = stringRaw(updates.Endpoint)
	}
	if updates.PublicBaseURL != nil {
		metadata.PublicBaseURL = updates.PublicBaseURL
	}
	if updates.ForcePathStyleSet {
		if updates.ForcePathStyle == nil {
			metadata.ForcePathStyle = json.RawMessage("null")
		} else {
			metadata.ForcePathStyle = boolRaw(*updates.ForcePathStyle)
		}
	}
	if updates.PresignedTTLSet {
		if updates.PresignedTTL == nil {
			metadata.PresignedURLTTLSeconds = json.RawMessage("null")
		} else {
			metadata.PresignedURLTTLSeconds = numberRaw(*updates.PresignedTTL)
		}
	}
	return metadata
}

// resolveStorageSecret mirrors resolveSecret. Unlike the vector token, a stored
// plaintext secret is returned untrimmed, and a decryption failure is reported
// through the public secretDecryptionFailed flag while still falling back to the
// environment value.
func (s *Service) resolveStorageSecret(raw json.RawMessage) (string, bool) {
	value := parseStoredSecretValue(raw)
	switch value.kind {
	case secretPlaintext:
		if value.plaintext == "" {
			return s.cfg.S3SecretAccessKey, false
		}
		return value.plaintext, false
	case secretEncrypted:
		key := s.settingsKey()
		if key == nil {
			logBackground("missing SYSTEM_SETTINGS_ENCRYPTION_KEY for storage secret", nil)
			return s.cfg.S3SecretAccessKey, true
		}
		plain, err := decryptStringValueV1(value.encrypted, key)
		if err != nil {
			logBackground("failed to decrypt storage secret", err)
			return s.cfg.S3SecretAccessKey, true
		}
		return plain, false
	default:
		return s.cfg.S3SecretAccessKey, false
	}
}

// storageProvider normalizes a stored provider value; anything unrecognised
// falls back to the fixed "mysql" default (which is not derived from any
// environment variable).
func storageProvider(raw json.RawMessage) CrawlImageStorageProvider {
	value, ok := storedTrimmedString(raw)
	if !ok {
		return CrawlImageStorageMySQL
	}
	normalized := strings.ToLower(value)
	if normalized == string(CrawlImageStorageS3) {
		return CrawlImageStorageS3
	}
	if normalized == string(CrawlImageStorageMySQL) {
		return CrawlImageStorageMySQL
	}
	return CrawlImageStorageMySQL
}

// stringOrEnv mirrors `asString(stored) ?? fallback`.
func stringOrEnv(raw json.RawMessage, fallback string) string {
	if value, ok := storedTrimmedString(raw); ok {
		return value
	}
	return fallback
}

// endpointOrEnv mirrors the endpoint branch: the key is omitted when neither a
// stored value nor an environment default exists.
func endpointOrEnv(raw json.RawMessage, fallback string) *string {
	if value, ok := storedTrimmedString(raw); ok {
		return &value
	}
	if fallback == "" {
		return nil
	}
	value := fallback
	return &value
}

// boolOrEnv mirrors `asBoolean(stored) ?? fallback`.
func boolOrEnv(raw json.RawMessage, fallback bool) bool {
	if value, ok := storedBoolean(raw); ok {
		return value
	}
	return fallback
}

// floatOrEnv mirrors `asNumber(stored) ?? fallback`: only a finite JSON number
// overrides the environment default, and the DTO's bounds (and its integer
// requirement) are deliberately not re-applied to stored values.
func floatOrEnv(raw json.RawMessage, fallback float64) float64 {
	if value, ok := storedJSONNumber(raw); ok {
		return value
	}
	return fallback
}

// storedJSONNumber returns a finite JSON number (never a numeric string).
func storedJSONNumber(raw json.RawMessage) (float64, bool) {
	trimmed := trimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return 0, false
	}
	value, ok := jsonNumberStrict(trimmed)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}
