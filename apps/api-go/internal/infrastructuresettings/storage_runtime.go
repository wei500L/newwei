package infrastructuresettings

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// StorageRuntimeConfig resolves one storage configuration snapshot for the
// object-storage consumers (the crawl media signing paths and the storage
// diagnostics handler).
//
// It reuses exactly the settings capability the seven infrastructure routes
// already use: the shared `storage:settings` Redis entry with its 60 second TTL
// and database fallback, the nine SystemSetting keys, and the plaintext /
// encrypted secret resolution with the environment fallback. The admin display
// model (masked secret, hasSecretAccessKey flags) is never used as business
// configuration.
//
// The snapshot is read once per request by the callers, so one media detail
// request signs every asset from the same configuration without re-reading the
// nine settings per asset.
func (s *Service) StorageRuntimeConfig(ctx context.Context) (objectstorage.RuntimeConfig, error) {
	records, err := s.loadStorageRecords(ctx)
	if err != nil {
		return objectstorage.RuntimeConfig{}, err
	}
	// The decryption failure flag is only meaningful for the admin display
	// model; here the documented fallback value is used, exactly like
	// getStorageConfig.
	secret, _ := s.resolveStorageSecret(records.get(settingKeyS3SecretAccessKey))

	config := objectstorage.RuntimeConfig{
		Provider:               string(storageProvider(records.get(settingKeyCrawlImageStorage))),
		AccessKeyID:            stringOrEnv(records.get(settingKeyS3AccessKeyID), s.cfg.S3AccessKeyID),
		SecretAccessKey:        secret,
		Region:                 stringOrEnv(records.get(settingKeyS3Region), s.cfg.S3Region),
		Bucket:                 stringOrEnv(records.get(settingKeyS3Bucket), s.cfg.S3Bucket),
		PublicBaseURL:          stringOrEnv(records.get(settingKeyS3PublicBaseURL), s.cfg.S3PublicBaseURL),
		ForcePathStyle:         boolOrEnv(records.get(settingKeyS3ForcePathStyle), s.cfg.S3ForcePathStyle),
		PresignedURLTTLSeconds: floatOrEnv(records.get(settingKeyS3PresignedURLTTLSecond), float64(s.cfg.S3PresignedURLTTLSeconds)),
	}
	if endpoint := endpointOrEnv(records.get(settingKeyS3Endpoint), s.cfg.S3Endpoint); endpoint != nil {
		config.Endpoint = *endpoint
	}
	if config.Region == "" {
		config.Region = objectstorage.DefaultRegion
	}
	return config, nil
}
