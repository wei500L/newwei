package infrastructuresettings

import "regexp"

// Named enums for the closed value sets this unit exposes.

// SettingSource reports where a settings payload came from.
type SettingSource string

const (
	// SettingSourceEnv is returned when no SystemSetting row exists.
	SettingSourceEnv SettingSource = "env"
	// SettingSourceDB is returned when a SystemSetting row exists.
	SettingSourceDB SettingSource = "db"
	// SettingSourceNone is the runtime-secret "no record" marker.
	SettingSourceNone SettingSource = "none"
)

// VectorTokenSource reports which token the vector service would use.
type VectorTokenSource string

const (
	// VectorTokenSourceStored means the stored configuration supplies the token.
	VectorTokenSourceStored VectorTokenSource = "stored"
	// VectorTokenSourceEnv means the environment default supplies the token.
	VectorTokenSourceEnv VectorTokenSource = "env"
	// VectorTokenSourceNone means no token is configured at all.
	VectorTokenSourceNone VectorTokenSource = "none"
)

// CrawlImageStorageProvider is the closed provider set of `crawl_image_storage`.
type CrawlImageStorageProvider string

const (
	// CrawlImageStorageMySQL is the default provider when nothing is stored.
	CrawlImageStorageMySQL CrawlImageStorageProvider = "mysql"
	// CrawlImageStorageS3 selects object storage.
	CrawlImageStorageS3 CrawlImageStorageProvider = "s3"
)

// crawlImageStorageProviders lists the accepted provider values in DTO order.
var crawlImageStorageProviders = []string{"mysql", "s3"}

// Runtime-secret grammar. The message text elsewhere quotes these patterns, so
// they are declared once.
var (
	sourceIDRe  = regexp.MustCompile(`(?i)^[a-z0-9_-]+$`)
	secretKeyRe = regexp.MustCompile(`^[a-zA-Z0-9._:-]+$`)
)
