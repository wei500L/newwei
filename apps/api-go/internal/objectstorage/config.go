package objectstorage

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"
)

// Provider values mirror the Prisma CrawlImageStorageProvider enum.
const (
	ProviderMySQL = "mysql"
	ProviderS3    = "s3"
)

// DefaultRegion is the fallback AWS region, identical to EnvService.storageConfig
// (`S3_REGION ?? "us-east-1"`). The configuration reader normally supplies it;
// it is re-applied here so a snapshot built elsewhere cannot produce a client
// without a region.
const DefaultRegion = "us-east-1"

// MinExplicitTTLSeconds is Math.max(30, ...) from StorageService.createObjectReadUrl:
// an explicit per-call TTL is floored and never drops below this value.
const MinExplicitTTLSeconds = 30

// ErrIncompleteConfig mirrors the BadRequestException StorageService.refreshClient
// throws when accessKeyId, secretAccessKey, bucket or publicBaseUrl is missing.
// Error() is the raw HttpException message, which is exactly what the REST error
// body carries.
var ErrIncompleteConfig = errors.New("Storage configuration is incomplete")

// IncompleteConfigText is the NestJS StorageService.formatAwsError rendering of
// ErrIncompleteConfig (`${error.name}: ${error.message}`), used as the
// mode-level error of the storage connection test result.
const IncompleteConfigText = "BadRequestException: Storage configuration is incomplete"

// RuntimeConfig is one resolved storage configuration snapshot. The
// configuration reader fills it with database values taking precedence over the
// S3_* environment fallbacks; Provider is always valid and defaults to mysql.
type RuntimeConfig struct {
	// Provider is the Prisma CrawlImageStorageProvider ("mysql" or "s3").
	// It decides the diagnostics branch; it never decides how an individual
	// media record is read (that always follows the record's own provider).
	Provider string
	// AccessKeyID, SecretAccessKey, Bucket and PublicBaseURL form the
	// completeness condition of StorageService.refreshClient.
	AccessKeyID     string
	SecretAccessKey string
	Region          string
	Bucket          string
	// Endpoint is empty when neither a database value nor an environment
	// default exists; the client then uses the standard AWS endpoint.
	Endpoint string
	// PublicBaseURL is kept because it is part of the NestJS completeness
	// condition, even though private media GETs never target it.
	PublicBaseURL string
	// ForcePathStyle selects path-style (true) vs virtual-hosted (false)
	// addressing.
	ForcePathStyle bool
	// PresignedURLTTLSeconds is the configured default TTL. It is a float
	// because the NestJS reader accepts any finite stored number.
	PresignedURLTTLSeconds float64
}

// Complete reports whether the snapshot satisfies the NestJS refreshClient
// completeness condition (accessKeyId, secretAccessKey, bucket, publicBaseUrl).
func (c RuntimeConfig) Complete() bool {
	return c.AccessKeyID != "" && c.SecretAccessKey != "" && c.Bucket != "" && c.PublicBaseURL != ""
}

// NormalizedPublicBaseURL removes one trailing slash, mirroring
// `config.publicBaseUrl.replace(/\/$/, "")`.
func (c RuntimeConfig) NormalizedPublicBaseURL() string {
	return strings.TrimSuffix(c.PublicBaseURL, "/")
}

// EffectiveRegion returns the configured region or DefaultRegion.
func (c RuntimeConfig) EffectiveRegion() string {
	if c.Region == "" {
		return DefaultRegion
	}
	return c.Region
}

// ConfigReader resolves the current storage configuration snapshot. It is
// implemented by infrastructuresettings.Service and injected by main, so the
// runtime settings cache, the decryption fallbacks and the environment
// defaults stay in exactly one place.
type ConfigReader interface {
	StorageRuntimeConfig(ctx context.Context) (RuntimeConfig, error)
}

// ReadURLOptions carries the response-parameter overrides of one presigned GET,
// mirroring ObjectReadUrlOptions.
type ReadURLOptions struct {
	// ExpiresInSeconds is the explicit per-call TTL. A nil pointer means
	// "absent", which selects the configuration TTL; a non-nil value that is
	// not a positive integer also falls back to the configuration TTL, exactly
	// like the NestJS `typeof === "number" && > 0` guard.
	ExpiresInSeconds *int
	// ResponseContentType, ResponseContentDisposition and ResponseCacheControl
	// become signed response-content-* query parameters. Empty values are
	// omitted from the signature.
	ResponseContentType        string
	ResponseContentDisposition string
	ResponseCacheControl       string
}

// effectiveTTLSeconds applies the createObjectReadUrl TTL rules: an explicit
// positive TTL is floored and raised to MinExplicitTTLSeconds; anything else
// uses the configuration TTL unchanged.
func (c RuntimeConfig) effectiveTTLSeconds(opts ReadURLOptions) float64 {
	if opts.ExpiresInSeconds != nil && *opts.ExpiresInSeconds > 0 {
		seconds := float64(*opts.ExpiresInSeconds)
		if seconds < MinExplicitTTLSeconds {
			return MinExplicitTTLSeconds
		}
		return seconds
	}
	return c.PresignedURLTTLSeconds
}

// presignExpiry converts the effective TTL into the presigner option. A
// non-positive or non-finite TTL yields zero, which leaves the SDK's documented
// 900 second default in place (the same thing a falsy `expiresIn` does in the
// JavaScript presigner).
func presignExpiry(ttlSeconds float64) time.Duration {
	if math.IsNaN(ttlSeconds) || math.IsInf(ttlSeconds, 0) || ttlSeconds <= 0 {
		return 0
	}
	return time.Duration(math.Floor(ttlSeconds)) * time.Second
}
