package infrastructuresettings

import (
	"database/sql"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Handler paths. Every rule is registered as an exact path with an explicit
// method whitelist, so longer paths, trailing slashes and unlisted methods keep
// falling back to NestJS.
const (
	pathVectorService   = "/api/system-settings/vector-service"
	pathStorageSettings = "/api/admin/settings/storage"
	pathRuntimeSecrets  = "/api/system-settings/news-source-runtime-secrets"
)

// SystemSetting primary keys and descriptions owned by this unit. Each domain
// owns exactly one global row (the storage domain owns nine); there is no org
// dimension on SystemSetting.
const (
	settingKeyVectorService = "vector_service"
	// descriptionVectorService is written on both the insert and the update
	// branch, exactly like the NestJS upsert.
	descriptionVectorService = "Vector service integration (semantic search/dedupe) configuration."

	settingKeyCrawlImageStorage       = "crawl_image_storage"
	settingKeyS3AccessKeyID           = "storage_s3_access_key_id"
	settingKeyS3SecretAccessKey       = "storage_s3_secret_access_key"
	settingKeyS3Region                = "storage_s3_region"
	settingKeyS3Bucket                = "storage_s3_bucket"
	settingKeyS3Endpoint              = "storage_s3_endpoint"
	settingKeyS3PublicBaseURL         = "storage_s3_public_base_url"
	settingKeyS3ForcePathStyle        = "storage_s3_force_path_style"
	settingKeyS3PresignedURLTTLSecond = "storage_s3_presigned_url_ttl_seconds"
	// descriptionStorageSetting is written only on the insert branch: Prisma's
	// update block omits description, so an existing row keeps its value.
	descriptionStorageSetting = "Storage configuration"

	settingKeyRuntimeSecrets = "news_source_runtime_secrets"
	// descriptionRuntimeSecrets is written on both branches.
	descriptionRuntimeSecrets = "Runtime secrets for news aggregator sources (cookie/token/headers), editable in admin UI."

	// settingKeySystemSecurity is read (never written) to resolve the secret
	// encryption policy.
	settingKeySystemSecurity = "system_security"
)

// Redis cache keys and TTLs. The vector-service cache uses the exists/value
// envelope; the storage cache is a direct object keyed by the full
// SystemSetting key; the runtime-secret domain has no Redis cache at all (its
// management reads are database-authoritative). system_security is read-only.
const (
	cacheKeyVectorService     = "vector_service:settings"
	vectorCacheTTLSeconds     = 30
	cacheKeyStorageSettings   = "storage:settings"
	storageCacheTTLSeconds    = 60
	cacheKeySystemSecurity    = "system_security:settings"
	systemSecurityTTLSeconds  = 30
	runtimeSecretsMaxEntries  = 2000
	runtimeSecretsMaxUpserts  = 500
	runtimeSecretsKeyMaxRunes = 128
	runtimeSecretsValMaxRunes = 8192
)

// Global MySQL session lock names. The settings are process-wide singletons, so
// the names carry no tenant suffix. They are byte-identical to the constants in
// apps/api/src/modules/system-settings/infrastructure-settings.lock.ts, and are
// deliberately distinct from every other migration unit's lock names.
const (
	lockVectorService        = "infra-settings:vector-service:v1"
	lockNewsSourceRuntimeKey = "infra-settings:news-source-runtime-secrets:v1"
	// lockWaitSeconds is the GET_LOCK timeout used by both sides.
	lockWaitSeconds = 10
	// lockReleaseTimeout bounds the RELEASE_LOCK call, which must not depend on
	// the (possibly cancelled) request context.
	lockReleaseTimeout = 5 * time.Second
)

// machineActorPrefix is the user-id prefix produced by the machine-token path.
// SystemSetting.updatedById and AuditLog.actorId are foreign keys into User(id),
// so a machine identity is written as SQL NULL.
const machineActorPrefix = "machine:"

// Config carries the environment-derived defaults the handlers need. Every
// field mirrors a NestJS EnvService getter with the same default, so the two
// implementations agree when no SystemSetting row exists yet.
type Config struct {
	VectorEnabled         bool
	VectorFallbackToMongo bool
	VectorBaseURL         string
	VectorToken           string
	VectorTimeoutMs       int
	VectorMaxRetries      int

	S3AccessKeyID            string
	S3SecretAccessKey        string
	S3Region                 string
	S3Bucket                 string
	S3Endpoint               string
	S3PublicBaseURL          string
	S3ForcePathStyle         bool
	S3PresignedURLTTLSeconds int

	// EncryptionKeyRaw keeps the untrimmed SYSTEM_SETTINGS_ENCRYPTION_KEY so
	// "missing" and "present but invalid" stay distinguishable.
	EncryptionKeyRaw string
	// EncryptionKeyPresent mirrors the NestJS `if (!raw)` presence test.
	EncryptionKeyPresent bool
	// NodeEnv is compared against the exact string "production".
	NodeEnv string
}

// Service owns the MySQL pool, the Redis client and the environment defaults
// shared with the rest of the gateway. All methods are safe for concurrent use.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	cfg   Config
}

// NewService wires the infrastructure settings data access. db and redisClient
// are the same connections the other Go domains use.
func NewService(db *sql.DB, redisClient *redis.Client, cfg Config) *Service {
	return &Service{db: db, redis: redisClient, cfg: cfg}
}

// Config exposes the resolved defaults (used by tests).
func (s *Service) Config() Config {
	if s == nil {
		return Config{}
	}
	return s.cfg
}

// actorIsMachine reports whether the actor id belongs to a machine token.
func actorIsMachine(actorID string) bool {
	return actorID == "" || len(actorID) >= len(machineActorPrefix) && actorID[:len(machineActorPrefix)] == machineActorPrefix
}

// nullableActorID converts an actor id into the value that may be written to
// the nullable User foreign keys. Machine tokens and empty ids become SQL NULL;
// writing "machine:<tokenId>" would violate the foreign key and surface as an
// HTTP 500.
func nullableActorID(actorID string) *string {
	if actorIsMachine(actorID) {
		return nil
	}
	return &actorID
}

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// nestTimestamp renders a timestamp exactly like JavaScript's
// Date.prototype.toISOString (UTC, millisecond precision, trailing Z).
func nestTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// logBackground records a failure on a path where NestJS only logs a warning
// and continues (cache read tolerance, best-effort eviction). A nil error logs
// the message alone.
func logBackground(kind string, err error) {
	if err == nil {
		log.Printf("infrastructuresettings: %s", kind)
		return
	}
	log.Printf("infrastructuresettings: %s: %v", kind, err)
}

// errNoDatabase is returned when the MySQL pool was not injected. The handler
// maps it to the same fail-closed 503 NestJS produces for Prisma errors.
var errNoDatabase = errNotConfigured("mysql is not configured")

// errNoRedis is returned when the Redis client was not injected.
var errNoRedis = errNotConfigured("redis is not configured")

// errNotConfigured is a named error type so the package keeps a single shape
// for "dependency missing" without exporting a bare string.
type errNotConfigured string

// Error implements the error interface.
func (e errNotConfigured) Error() string { return "infrastructuresettings: " + string(e) }
