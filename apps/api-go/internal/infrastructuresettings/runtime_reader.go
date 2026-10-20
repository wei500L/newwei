package infrastructuresettings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"
)

// runtimeReaderCacheTTL mirrors NewsSourceRuntimeSecretsService.CACHE_TTL_MS.
// Only the runtime reader uses this cache: the management GET/PUT paths keep
// reading MySQL directly and keep their own locking/merge behaviour.
const runtimeReaderCacheTTL = 30 * time.Second

// RuntimeSecretReader is the narrow read port the migrated NewsNow source fetch
// path uses. It owns one process-local 30 second snapshot of
// `news_source_runtime_secrets`, decrypts entries with the existing v1 envelope
// helper and never writes. Management CRUD is untouched.
type RuntimeSecretReader struct {
	db           *sql.DB
	encryption   string
	keyPresent   bool
	mu           sync.Mutex
	cached       *runtimeStoredSettings
	cachedAt     time.Time
	cachedLoaded bool
	now          func() time.Time
}

// NewRuntimeSecretReader builds the reader on the shared MySQL pool. It performs
// no query at construction time; the first SecretsForSource call loads the row.
func NewRuntimeSecretReader(db *sql.DB, encryptionKeyRaw string, encryptionKeyPresent bool) *RuntimeSecretReader {
	return &RuntimeSecretReader{
		db:         db,
		encryption: encryptionKeyRaw,
		keyPresent: encryptionKeyPresent,
		now:        time.Now,
	}
}

// SecretsForSource applies the requested source id first and the resolved id
// second, so a key present on both entries resolves to the resolved (canonical)
// value exactly like NewsSourceRuntimeSecretsService.getSecretsForSource.
//
// A stored-document read/parse failure is logged and yields an empty secret map:
// NestJS treats it as a warning and lets providers that need no secret run.
func (r *RuntimeSecretReader) SecretsForSource(ctx context.Context, sourceID, overrideSourceID string) map[string]string {
	out := make(map[string]string)
	if r == nil || r.db == nil || strings.TrimSpace(sourceID) == "" {
		return out
	}

	settings, err := r.load(ctx)
	if err != nil {
		log.Printf("infrastructuresettings: failed to load runtime secrets: %v", err)
		return out
	}
	if settings == nil {
		return out
	}

	key := r.settingsKey()
	r.apply(out, settings.Entries, sourceID, key)
	if overrideSourceID != "" && overrideSourceID != sourceID {
		r.apply(out, settings.Entries, overrideSourceID, key)
	}
	return out
}

// apply copies every matching entry into target. Entries are already unique by
// (sourceId, key) and sorted, so the last write for a duplicate key is still the
// single stored value.
func (r *RuntimeSecretReader) apply(target map[string]string, entries []runtimeStoredEntry, sourceID string, key []byte) {
	for _, entry := range entries {
		if entry.SourceID != sourceID {
			continue
		}
		decoded, err := r.decode(entry.Value, key)
		if err != nil {
			log.Printf("infrastructuresettings: failed to decode runtime secret %s.%s: %v", entry.SourceID, entry.Key, err)
			continue
		}
		if decoded != "" {
			target[entry.Key] = decoded
		}
	}
}

// decode mirrors decodeSecretValue: plaintext is trimmed and encrypted values
// require a valid key. A failed entry is skipped, not fatal.
func (r *RuntimeSecretReader) decode(value json.RawMessage, key []byte) (string, error) {
	parsed := parseStoredSecretValue(value)
	switch parsed.kind {
	case secretPlaintext:
		return strings.TrimSpace(parsed.plaintext), nil
	case secretEncrypted:
		if key == nil {
			return "", errors.New("encrypted runtime secret requires SYSTEM_SETTINGS_ENCRYPTION_KEY")
		}
		plain, err := decryptStringValueV1(parsed.encrypted, key)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(plain), nil
	default:
		return "", errors.New("invalid runtime secret entry format")
	}
}

// settingsKey mirrors resolveSettingsKey: absent or invalid keys produce nil so
// plaintext entries keep working and encrypted entries are skipped.
func (r *RuntimeSecretReader) settingsKey() []byte {
	if !r.keyPresent || strings.TrimSpace(r.encryption) == "" {
		return nil
	}
	key, err := decodeSystemSettingsKey(r.encryption)
	if err != nil {
		return nil
	}
	return key
}

// load returns the cached snapshot or reads it strictly from MySQL. Both a
// missing row and an unparsable row are cached for 30 seconds, matching the
// NestJS cache that stores `null` as well.
func (r *RuntimeSecretReader) load(ctx context.Context) (*runtimeStoredSettings, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.cachedLoaded && r.now().Sub(r.cachedAt) <= runtimeReaderCacheTTL {
		return r.cached, nil
	}

	settings, err := r.loadFromDB(ctx)
	if err != nil {
		// Do not poison the cache on a transient database failure.
		return nil, err
	}
	r.cached = settings
	r.cachedAt = r.now()
	r.cachedLoaded = true
	return settings, nil
}

// loadFromDB reads and strictly parses the global singleton row.
func (r *RuntimeSecretReader) loadFromDB(ctx context.Context) (*runtimeStoredSettings, error) {
	var raw []byte
	err := r.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", settingKeyRuntimeSecrets).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return parseRuntimeSecretsStrict(json.RawMessage(raw))
}
