package crawlreadtelemetry

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// storagePresignCacheControl is the ResponseCacheControl every S3 media GET is
// signed with, matching `"private, max-age=300"` in the NestJS service.
const storagePresignCacheControl = "private, max-age=300"

// StorageReaderConfigured reports whether a runtime storage configuration
// reader was injected. Both constructors of this service — the REST crawl read
// handler and the GraphQL crawlTask root — must inject the same reader, so the
// wiring tests assert this predicate. It performs no I/O and reads no setting.
func (s *Service) StorageReaderConfigured() bool {
	return s != nil && s.storageConfig != nil
}

// storageSnapshot resolves one storage configuration snapshot for one request.
// The caller reads it once and reuses it for every asset of that request, so a
// detail page with many S3 assets never re-reads the nine settings per asset or
// per mode.
func (s *Service) storageSnapshot(ctx context.Context) (objectstorage.RuntimeConfig, error) {
	if s == nil || s.storageConfig == nil {
		return objectstorage.RuntimeConfig{}, errStorageConfigUnavailable
	}
	return s.storageConfig.StorageRuntimeConfig(ctx)
}

// storageClient resolves the per-request S3 client for the public media route.
// A configuration that fails the refreshClient completeness condition becomes
// the NestJS BadRequestException (HTTP 400), never a fake "asset not found".
func (s *Service) storageClient(ctx context.Context) (*objectstorage.Client, error) {
	snapshot, err := s.storageSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	client, err := objectstorage.NewClient(snapshot)
	if err != nil {
		if errors.Is(err, objectstorage.ErrIncompleteConfig) {
			return nil, newStatusError(http.StatusBadRequest, objectstorage.ErrIncompleteConfig.Error())
		}
		return nil, err
	}
	return client, nil
}

// storageSigningContext resolves the single snapshot shared by every asset of
// one detail response. It returns the clamped signed-URL TTL and the S3 client.
//
// The TTL now comes from the full storage configuration snapshot, so the
// S3_PRESIGNED_URL_TTL_SECONDS environment fallback is honoured instead of the
// database row being the only source. A configuration read failure keeps the
// NestJS default (300s) and disables S3 signing; the MySQL/HMAC projection is
// unaffected because it only needs the JWT secret.
func (s *Service) storageSigningContext(ctx context.Context) (int, *objectstorage.Client) {
	snapshot, err := s.storageSnapshot(ctx)
	if err != nil {
		log.Printf("crawl read telemetry: failed to read signed media URL TTL, using default: %v", err)
		return defaultSignedURLTTLSeconds, nil
	}
	ttlSeconds := normalizeSignedURLTTL(snapshot.PresignedURLTTLSeconds)
	client, err := objectstorage.NewClient(snapshot)
	if err != nil {
		// The detail projection deliberately does not fail the whole response
		// when the storage configuration cannot sign: NestJS catches the
		// per-asset createObjectReadUrl failure, logs a warning and leaves the
		// URL unset while keeping the asset and the other results.
		log.Printf("crawl read telemetry: storage configuration cannot sign S3 media URLs: %v", err)
		return ttlSeconds, nil
	}
	return ttlSeconds, client
}

// attachStoredS3URLs signs the preview and download URLs of one S3-provider
// asset. Each mode is attempted independently: a failed preview signature keeps
// the download URL and vice versa, exactly like the two NestJS try/catch blocks.
func attachStoredS3URLs(
	ctx context.Context,
	client *objectstorage.Client,
	asset *CrawlStoredMediaAsset,
	record crawlMediaAssetRow,
	contentType string,
	inlineSafe bool,
	fileName string,
	ttlSeconds int,
) {
	if client == nil || asset == nil {
		return
	}
	if !record.StorageKey.Valid || record.StorageKey.String == "" {
		// A record without its own key can never produce a URL.
		return
	}
	objectKey := record.StorageKey.String
	expiresInSeconds := ttlSeconds
	options := objectstorage.ReadURLOptions{
		ExpiresInSeconds:     &expiresInSeconds,
		ResponseContentType:  contentType,
		ResponseCacheControl: storagePresignCacheControl,
	}
	if inlineSafe {
		previewOptions := options
		previewOptions.ResponseContentDisposition = buildContentDisposition("inline", fileName)
		if previewURL, err := client.CreateObjectReadURL(ctx, objectKey, previewOptions); err != nil {
			log.Printf("crawl read telemetry: failed to sign S3 crawl media URL (asset=%s mode=preview): %v", record.ID, err)
		} else {
			asset.PreviewURL = &previewURL
		}
	}
	downloadOptions := options
	downloadOptions.ResponseContentDisposition = buildContentDisposition("attachment", fileName)
	if downloadURL, err := client.CreateObjectReadURL(ctx, objectKey, downloadOptions); err != nil {
		log.Printf("crawl read telemetry: failed to sign S3 crawl media URL (asset=%s mode=download): %v", record.ID, err)
	} else {
		asset.DownloadURL = &downloadURL
	}
}
