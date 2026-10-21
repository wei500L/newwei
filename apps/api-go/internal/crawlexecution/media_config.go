package crawlexecution

// This file ports the configuration, content-type and storage-provider helpers
// shared by the crawl media branch of apps/api/src/modules/crawl:
// crawl-result.service.ts (CrawlMediaConfig) and crawl-media-asset.service.ts
// (sanitizeStoredContentType / normalizeContentType / pickExtension /
// StorageSettingsService.getCrawlImageStorageProvider).

import (
	"context"
	"database/sql"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// defaultBinaryContentType is DEFAULT_BINARY_CONTENT_TYPE: the S3 upload
// content type when the asset has no usable media type.
const defaultBinaryContentType = "application/octet-stream"

// mediaConfig is CrawlMediaConfig (env.crawl4aiConfig.media). The values come
// from the CRAWL_MEDIA_* environment defaults (15000 ms, 2097152 bytes, 6
// assets) through Config.
type mediaConfig struct {
	// FetchTimeoutMs is CRAWL_MEDIA_FETCH_TIMEOUT_MS: the per-download abort
	// timer. A non-positive value aborts immediately, like setTimeout(abort, 0).
	FetchTimeoutMs int
	// MaxBytes is CRAWL_MEDIA_MAX_BYTES: the per-asset byte ceiling.
	MaxBytes int
	// MaxPerResult is CRAWL_MEDIA_MAX_PER_RESULT: the stored-asset ceiling of
	// one crawl result; a non-positive value disables asset collection.
	MaxPerResult int
}

// mediaSettings projects env.crawl4aiConfig.media from Config.
func (s *Service) mediaSettings() mediaConfig {
	if s == nil {
		return mediaConfig{}
	}
	return mediaConfig{
		FetchTimeoutMs: s.cfg.MediaFetchTimeoutMs,
		MaxBytes:       s.cfg.MediaMaxBytes,
		MaxPerResult:   s.cfg.MediaMaxPerResult,
	}
}

// mediaStorageConfigReader is the storage configuration reader the media writer
// needs. objectstorage.ConfigReader satisfies it (the interface is declared in
// objectstorage/config.go); *infrastructuresettings.Service and
// *accountsecurity.Service implement it.
type mediaStorageConfigReader interface {
	StorageRuntimeConfig(ctx context.Context) (objectstorage.RuntimeConfig, error)
}

// mediaStorageProviderReader is the optional provider capability. A reader that
// implements it decides the crawl media provider from the `crawl_image_storage`
// setting; otherwise the provider of the runtime snapshot is used (empty means
// mysql), exactly like getCrawlImageStorageProvider's default.
type mediaStorageProviderReader interface {
	CrawlImageStorageProvider(ctx context.Context) (string, error)
}

// mediaObjectWriter is the S3 subset of *objectstorage.Client. It is kept as an
// interface so the media store tests can record uploads and deletions without
// S3.
type mediaObjectWriter interface {
	PutObject(ctx context.Context, objectKey, body, contentType, cacheControl string) objectstorage.CheckResult
	DeleteObject(ctx context.Context, objectKey string) objectstorage.CheckResult
}

// mediaStorageDependencies exposes the wiring service.go owns: the MySQL handle
// and the storage configuration reader. Keeping the field access in one place
// means a wiring rename stays inside this package.
func (s *Service) mediaStorageDependencies() (*sql.DB, mediaStorageConfigReader) {
	if s == nil {
		return nil, nil
	}
	return s.db, s.storage
}

// mediaContentTypeAliases is CONTENT_TYPE_ALIASES.
var mediaContentTypeAliases = map[string]string{
	"image/jpg": "image/jpeg",
	"image/svg": "image/svg+xml",
	"audio/mp3": "audio/mpeg",
	"jpg":       "image/jpeg",
	"jpeg":      "image/jpeg",
	"png":       "image/png",
	"webp":      "image/webp",
	"gif":       "image/gif",
	"svg":       "image/svg+xml",
	"svg+xml":   "image/svg+xml",
	"avif":      "image/avif",
	"bmp":       "image/bmp",
	"mp4":       "video/mp4",
	"webm":      "video/webm",
	"ogg":       "audio/ogg",
	"wav":       "audio/wav",
	"mp3":       "audio/mpeg",
	"mpeg":      "audio/mpeg",
	"aac":       "audio/aac",
	"flac":      "audio/flac",
}

// sanitizeStoredContentType is sanitizeStoredContentType: normalize the value,
// then keep it only when it is an image, video or audio type. Everything else
// (text/html, application/octet-stream, a malformed value) becomes NULL on the
// CrawlMediaAsset row.
func sanitizeStoredContentType(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := normalizeMediaContentType(*value)
	if normalized == "" {
		return nil
	}
	if strings.HasPrefix(normalized, "image/") ||
		strings.HasPrefix(normalized, "video/") ||
		strings.HasPrefix(normalized, "audio/") {
		canonical := normalized
		return &canonical
	}
	return nil
}

// normalizeMediaContentType is normalizeContentType: strip parameters,
// lowercase, resolve aliases and validate the "type/subtype" shape.
func normalizeMediaContentType(value string) string {
	if value == "" {
		return ""
	}
	base := value
	if index := strings.Index(base, ";"); index >= 0 {
		base = base[:index]
	}
	normalized := strings.ToLower(strings.TrimSpace(base))
	if normalized == "" {
		return ""
	}
	if alias, ok := mediaContentTypeAliases[normalized]; ok {
		normalized = alias
	}
	if !isValidMediaContentType(normalized) {
		return ""
	}
	return normalized
}

// isValidMediaContentType is the CONTENT_TYPE_PATTERN test
// `^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$`. The pattern only accepts a
// single slash because "/" is not in either character class.
func isValidMediaContentType(value string) bool {
	slash := strings.Index(value, "/")
	if slash <= 0 || slash != strings.LastIndex(value, "/") || slash == len(value)-1 {
		return false
	}
	for _, part := range []string{value[:slash], value[slash+1:]} {
		for _, char := range part {
			if !isMediaContentTypeChar(char) {
				return false
			}
		}
	}
	return true
}

// isMediaContentTypeChar is the character class of CONTENT_TYPE_PATTERN.
func isMediaContentTypeChar(char rune) bool {
	if char >= 'a' && char <= 'z' {
		return true
	}
	if char >= '0' && char <= '9' {
		return true
	}
	switch char {
	case '!', '#', '$', '&', '^', '_', '.', '+', '-':
		return true
	default:
		return false
	}
}

// pickExtension is pickExtension: the file extension for a content type. The
// order of the substring checks is part of the contract (jpeg before png, ...)
// and "mpeg" intentionally maps to mp3.
func pickExtension(contentType *string) string {
	if contentType == nil {
		return ""
	}
	normalized := strings.ToLower(*contentType)
	switch {
	case strings.Contains(normalized, "jpeg"):
		return "jpg"
	case strings.Contains(normalized, "png"):
		return "png"
	case strings.Contains(normalized, "webp"):
		return "webp"
	case strings.Contains(normalized, "gif"):
		return "gif"
	case strings.Contains(normalized, "svg"):
		return "svg"
	case strings.Contains(normalized, "mp4"):
		return "mp4"
	case strings.Contains(normalized, "webm"):
		return "webm"
	case strings.Contains(normalized, "mpeg"):
		return "mp3"
	default:
		return ""
	}
}

// normalizeMediaProvider mirrors StorageSettingsService.asProvider plus the
// DEFAULT_CRAWL_IMAGE_STORAGE_PROVIDER fallback: trim, lowercase, accept only
// "mysql" and "s3" and fall back to mysql for anything else.
func normalizeMediaProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case objectstorage.ProviderS3:
		return objectstorage.ProviderS3
	case objectstorage.ProviderMySQL:
		return objectstorage.ProviderMySQL
	default:
		return objectstorage.ProviderMySQL
	}
}
