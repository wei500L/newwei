package llmgatewayprofiles

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Config is the environment-derived configuration of the package. Every value is
// resolved by the shared config package from the same environment variables
// NestJS reads, so both implementations agree with an identical env.
type Config struct {
	// Env is the effective LITELLM_* profile default set.
	Env EnvDefaults
	// SettingsEncryptionKey is the raw SYSTEM_SETTINGS_ENCRYPTION_KEY value.
	// It is kept untrimmed because the NestJS presence check is a JavaScript
	// truthiness test on the raw value.
	SettingsEncryptionKey string
	// Production reports NODE_ENV === "production".
	Production bool
	// LockTimeoutSeconds is the GET_LOCK wait for the profiles write lock.
	LockTimeoutSeconds int
}

// Service owns the shared MySQL pool, the dedicated lock pool, the Redis client
// and the resolved configuration. All methods are safe for concurrent use.
type Service struct {
	db     *sql.DB
	lockDB *sql.DB
	redis  *redis.Client
	cfg    Config
	// lockFn replaces the MySQL session lock in unit tests. Production code
	// leaves it nil so withProfilesLock always uses GET_LOCK.
	lockFn func(ctx context.Context, fn func(context.Context) error) error
}

// NewService wires the data access. lockDB must be a pool that never retains
// idle connections; NewService enforces that so a released connection is always
// closed physically and a failed RELEASE_LOCK cannot survive in a pool.
func NewService(db *sql.DB, lockDB *sql.DB, redisClient *redis.Client, cfg Config) *Service {
	if lockDB != nil {
		lockDB.SetMaxIdleConns(0)
	}
	return &Service{db: db, lockDB: lockDB, redis: redisClient, cfg: cfg}
}

// Config exposes the resolved configuration (diagnostics and tests).
func (s *Service) Config() Config {
	if s == nil {
		return Config{}
	}
	return s.cfg
}

// List returns the full settings projection served by GET /llm-gateways.
func (s *Service) List(ctx context.Context) (SettingsPublic, error) {
	settings, err := s.loadSettingsCached(ctx)
	if err != nil {
		return SettingsPublic{}, err
	}
	return PublicSettingsOf(settings, s.hasAPIKey), nil
}

// profileDefaultsFor creates the builder defaults of a create operation from the
// effective environment configuration.
func profileDefaultsFor(env EnvDefaults) profileDefaults {
	return profileDefaults{
		APIBase:                   env.APIBase,
		AssistantModel:            nil,
		TimeoutMs:                 env.TimeoutMs,
		Temperature:               env.Temperature,
		TopP:                      env.TopP,
		MaxOutputTokens:           env.MaxOutputTokens,
		MaxRetries:                env.MaxRetries,
		AssistantWebSearchEnabled: defaultAssistantWebSearchEnabled,
		SendMetadata:              defaultSendMetadata,
		ResponseFormatMode:        DefaultProfileResponseFormatMode,
		APISurface:                DefaultProfileAPISurface,
	}
}

// updateDefaultsFor creates the builder defaults of an update operation from the
// existing normalized profile, exactly like the NestJS call that passes the
// stored profile as the fallback object.
func updateDefaultsFor(base StoredProfile) profileDefaults {
	return profileDefaults{
		APIBase:                   base.APIBase,
		AssistantModel:            base.AssistantModel,
		TimeoutMs:                 base.TimeoutMs,
		Temperature:               base.Temperature,
		TopP:                      base.TopP,
		MaxOutputTokens:           base.MaxOutputTokens,
		MaxRetries:                base.MaxRetries,
		AssistantWebSearchEnabled: nullableBoolValue(base.AssistantWebSearchEnabled, defaultAssistantWebSearchEnabled),
		SendMetadata:              nullableBoolValue(base.SendMetadata, defaultSendMetadata),
		ResponseFormatMode:        base.ResponseFormatMode,
		APISurface:                base.APISurface,
	}
}

// nullableBoolValue mirrors normalizeBoolean(value, fallback) for a tri-state
// stored boolean: an explicit null uses the fallback.
func nullableBoolValue(value NullableBool, fallback bool) bool {
	if value.Null {
		return fallback
	}
	return value.Value
}

// newUUIDv4 returns a random RFC 4122 version 4 UUID, the same shape Node's
// randomUUID() produces.
func newUUIDv4() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// truthyString mirrors JavaScript truthiness for the optional selection value:
// only a non-empty string is truthy.
func truthyString(value *string) bool {
	return value != nil && *value != ""
}

// findProfile returns the first profile with the given id, preserving the
// duplicate-id history of the document.
func findProfile(profiles []StoredProfile, id string) (StoredProfile, bool) {
	for _, profile := range profiles {
		if profile.ID == id {
			return profile, true
		}
	}
	return StoredProfile{}, false
}
