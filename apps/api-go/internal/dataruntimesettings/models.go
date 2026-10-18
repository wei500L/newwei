package dataruntimesettings

import (
	"database/sql"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Handler paths. Every route is registered as an exact path with an explicit
// method whitelist, so longer paths, trailing slashes, HEAD and unlisted methods
// keep falling back to NestJS.
const (
	pathRealtime           = "/api/system-settings/realtime-signals"
	pathArchivePreparation = "/api/system-settings/archive-preparation"
	pathArchiveStatus      = "/api/admin/archive-preparation/status"
	pathNominatim          = "/api/system-settings/geo/nominatim"
)

// SystemSetting primary keys and descriptions owned by this unit. Each domain
// owns exactly one global row; there is no org dimension on SystemSetting.
const (
	settingKeyRealtime = "realtime_signals_settings"
	// descriptionRealtime is written on both the insert and the update branch.
	descriptionRealtime = "Realtime signals settings (source toggles, thresholds, and API credentials)."

	// settingKeyAcledAuthState is the derived OAuth state row. It is deleted
	// together with the settings row and never read for a public response,
	// because the ACLED API stays disabled.
	settingKeyAcledAuthState = "realtime_signals_acled_auth_state"

	settingKeyArchivePreparation = "archive_preparation_settings"
	// descriptionArchivePreparation is written on both branches.
	descriptionArchivePreparation = "Archive background preparation settings (batch sizes and embedding/rerank concurrency)."

	settingKeyNominatim = "geo_nominatim_identity"
	// descriptionNominatim is only used on the insert branch: the NestJS upsert
	// omits description from its update block, so an existing row keeps its
	// value.
	descriptionNominatim = "Nominatim geocoding identity settings (User-Agent / email)"

	// settingKeySystemSecurity is read (never written) to resolve the secret
	// encryption policy.
	settingKeySystemSecurity = "system_security"
)

// Redis cache keys and TTLs.
//
// Three deliberately different cache shapes are used, matching NestJS:
//   - the realtime-settings cache and the ACLED auth-state cache are
//     {exists,value} envelopes, so "no row yet" is cached too;
//   - the archive-preparation cache stores the raw settings object (or JSON
//     null) directly, with no envelope;
//   - system_security is an {exists,value} envelope read only.
const (
	cacheKeyRealtime            = "realtime-signals:settings"
	realtimeCacheTTLSeconds     = 30
	cacheKeyAcledAuthState      = "realtime-signals:acled-auth-state"
	acledAuthCacheTTLSeconds    = 30
	cacheKeyArchivePreparation  = "archive_preparation:settings"
	archiveSettingsCacheTTL     = 30
	cacheKeySystemSecurity      = "system_security:settings"
	systemSecurityCacheTTL      = 60
	archiveStatusIndexKey       = "archive:preparation:status:index"
	archiveStatusTTLSeconds     = 60 * 60
	archiveStatusRecentLimit    = 10
	archiveStatusKeySegmentOrg  = 4
	archiveStatusKeyMinSegments = 6
)

// Global MySQL session lock names. The settings are process-wide singletons, so
// the names carry no tenant suffix and must stay below MySQL's 64 character
// GET_LOCK limit. They are byte-identical to the constants in
// apps/api/src/modules/system-settings/data-runtime-settings.lock.ts and are
// deliberately distinct from every other migration unit's lock names.
const (
	lockRealtime  = "data-runtime-settings:realtime:v1"
	lockNominatim = "data-runtime-settings:nominatim:v1"
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
// field mirrors a NestJS EnvService getter / apiEnvSchema entry with the same
// default, so the two implementations agree when no SystemSetting row exists.
//
// Note the deliberate OpenSky precedence: apiEnvSchema gives
// REALTIME_SIGNALS_OPENSKY_ENABLED, REALTIME_SIGNALS_OPENSKY_INTERVAL_SEC and
// REALTIME_SIGNALS_OPENSKY_BASE_URL their own defaults, so the
// `get(OPENSKY_*) ?? get(ADSB_*)` fallback in EnvService.realtimeSignalsConfig
// can never reach the ADSB_* variables. The ADSB_* names are intentionally not
// consulted here either: "fixing" that precedence would change the effective
// configuration of every existing deployment.
type Config struct {
	RealtimeEnabled                  bool
	RealtimeRequestTimeoutMs         int
	RealtimeMaxRetries               int
	RealtimeOpenskyEnabled           bool
	RealtimeOpenskyIntervalSec       int
	RealtimeOpenskyDailyCreditBudget int
	RealtimeOpenskyDayIntervalSec    int
	RealtimeOpenskyNightIntervalSec  int
	RealtimeOpenskyDayStartHourHKT   int
	RealtimeOpenskyNightStartHourHKT int
	RealtimeOpenskyWarningRemaining  int
	RealtimeOpenskyCriticalRemaining int
	RealtimeOpenskyBaseURL           string
	RealtimeOpenskyTokenURL          string
	RealtimeOpenskyClientID          string
	RealtimeOpenskyClientSecret      string
	RealtimeAisEnabled               bool
	RealtimeAisIntervalSec           int
	RealtimeUnrestEnabled            bool
	RealtimeUnrestIntervalSec        int
	RealtimeOutagesEnabled           bool
	RealtimeOutagesIntervalSec       int
	RealtimeKeywordSpikeEnabled      bool
	RealtimeKeywordSpikeIntervalSec  int
	RealtimePizzintEnabled           bool
	RealtimePizzintIntervalSec       int
	RealtimeGdeltTensionEnabled      bool
	RealtimeGdeltTensionIntervalSec  int
	RealtimePolymarketLeadsEnabled   bool
	RealtimePolymarketIntervalSec    int
	RealtimeKeywordSpikeMinCount     int
	RealtimeKeywordSpikeMultiplier   float64
	RealtimePredictionShiftThreshold float64
	RealtimePredictionNewsThreshold  int
	RealtimeAisBaseURL               string
	RealtimeAisSharedSecret          string
	RealtimeAcledOauthUsername       string
	RealtimeAcledOauthPassword       string
	RealtimeAcledOauthClientID       string
	RealtimeCloudflareAPIToken       string
	RealtimeWingbitsAPIKey           string
	RealtimePolymarketProxyURL       string

	// NominatimUserAgentDefault mirrors GEO_NOMINATIM_USER_AGENT (default
	// "modular-api"). NominatimEmailDefault mirrors GEO_NOMINATIM_EMAIL, which
	// is optional and validated as an e-mail by apiEnvSchema.
	NominatimUserAgentDefault string
	NominatimEmailDefault     string

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
	// nominatimCache is the retained per-process 30 second cache of the Nominatim
	// identity. Unlike NestJS's single-threaded event loop, the Go server needs
	// an explicit lock around it.
	nominatimCache processCache
}

// NewService wires the data runtime settings data access. db and redisClient are
// the same connections the other Go domains use.
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

// actorIsMachine reports whether the actor id belongs to a machine token. An
// empty actor id is treated the same way: it is never a User row.
func actorIsMachine(actorID string) bool {
	return actorID == "" || (len(actorID) >= len(machineActorPrefix) && actorID[:len(machineActorPrefix)] == machineActorPrefix)
}

// nullableActorID converts an actor id into the value that may be written to the
// nullable User foreign keys. Machine tokens and empty ids become SQL NULL;
// writing "machine:<tokenId>" would violate the foreign key and surface as an
// HTTP 500.
func nullableActorID(actorID string) *string {
	if actorIsMachine(actorID) {
		return nil
	}
	return &actorID
}

// nowMillis returns the current UTC time truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// nestTimestamp renders a timestamp exactly like JavaScript's
// Date.prototype.toISOString (UTC, millisecond precision, trailing Z).
func nestTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// logBackground records a failure on a path where NestJS only logs a warning and
// continues (cache read tolerance, best-effort cache invalidation, plaintext
// secret fallback). A nil error logs the message alone.
func logBackground(kind string, err error) {
	if err == nil {
		log.Printf("dataruntimesettings: %s", kind)
		return
	}
	log.Printf("dataruntimesettings: %s: %v", kind, err)
}

// errNoDatabase is returned when the MySQL pool was not injected. The handler
// maps it to the same fail-closed 503 NestJS produces for Prisma errors.
var errNoDatabase = errNotConfigured("mysql is not configured")

// errNoRedis is returned when the Redis client was not injected.
var errNoRedis = errNotConfigured("redis is not configured")

// errNotConfigured is a named error type so the package keeps a single shape for
// "dependency missing" without exporting a bare string.
type errNotConfigured string

// Error implements the error interface.
func (e errNotConfigured) Error() string { return "dataruntimesettings: " + string(e) }
