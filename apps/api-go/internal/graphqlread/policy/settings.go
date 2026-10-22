package policy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"time"
)

const (
	// rateLimitSettingsCacheKey is the shared Redis document NestJS and the Go
	// settings/runtime-settings services read and write
	// (RATE_LIMIT_CACHE_KEY in rate-limit-config.service.ts).
	rateLimitSettingsCacheKey = "rate_limit:settings"

	// rateLimitLoginSettingKey is the SystemSetting row holding the login bucket.
	// RATE_LIMIT_SETTING_KEYS.login in
	// apps/api/src/modules/system-settings/rate-limit-config.service.ts.
	rateLimitLoginSettingKey = "rate_limit_login"

	// settingsReadTimeout bounds the MySQL fallback so a slow or unavailable
	// database cannot extend a GraphQL request by more than one short query. The
	// Redis eval timeout (100ms) and the slow-call threshold (200ms) in
	// rate-limiter.service.ts are the same order of magnitude.
	settingsReadTimeout = 200 * time.Millisecond
)

// RateLimitSettingsReader supplies the admin-configured login bucket when the
// shared Redis document is missing. LoginBucket reports ok=false for "no
// configured value" and returns err only for an infrastructure failure; BudgetFor
// falls back to the environment defaults in both cases.
type RateLimitSettingsReader interface {
	LoginBucket(ctx context.Context) (limit int, windowSeconds int, ok bool, err error)
}

// loginBucketValue is the JSON stored in SystemSetting.value for
// rate_limit_login. RateLimitConfigService.updateRateLimitSettings writes
// { limit, windowSeconds } (toPrismaJson(normalized[bucket])), and
// normalizeBucket reads exactly those two fields.
type loginBucketValue struct {
	Limit         json.Number `json:"limit"`
	WindowSeconds json.Number `json:"windowSeconds"`
}

// MySQLSettingsReader reads the login bucket from the SystemSetting table, which
// is what NestJS loads when its rate_limit:settings cache misses:
// getRateLimitSettings (rate-limit-config.service.ts) reads the cache, then
// loadSettings() queries prisma.systemSetting for the three rate-limit keys, and
// only then falls back to the environment. The Prisma model is
// `model SystemSetting { key String @id, value Json }`
// (packages/db/prisma/schema.prisma) with no @@map, so the table is SystemSetting
// with `key`/`value` columns; the Go services that already read this row use the
// same spelling (internal/authlogin/ratelimit.go, internal/runtimesettings).
//
// Only the login bucket is read: the GraphQL budget is max(login.limit*30, 120).
type MySQLSettingsReader struct {
	db *sql.DB
}

// NewMySQLSettingsReader returns a reader over the shared MySQL handle. A nil
// handle makes LoginBucket report "no configured value", so the limiter keeps the
// environment defaults.
func NewMySQLSettingsReader(db *sql.DB) *MySQLSettingsReader {
	return &MySQLSettingsReader{db: db}
}

// LoginBucket implements RateLimitSettingsReader.
func (r *MySQLSettingsReader) LoginBucket(ctx context.Context) (int, int, bool, error) {
	if r == nil || r.db == nil {
		return 0, 0, false, nil
	}
	var raw []byte
	err := r.db.QueryRowContext(ctx,
		"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", rateLimitLoginSettingKey).Scan(&raw)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, 0, false, nil
		}
		return 0, 0, false, err
	}
	var value loginBucketValue
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, 0, false, err
	}
	limit, okLimit := floorJSONNumber(value.Limit)
	window, okWindow := floorJSONNumber(value.WindowSeconds)
	if !okLimit || !okWindow {
		return 0, 0, false, nil
	}
	return limit, window, true, nil
}

// floorJSONNumber mirrors RateLimitConfigService.normalizeBucket, which applies
// Math.floor to both fields. A value that is not a number reports "no configured
// value" instead of Nest's clamp-to-minimum, because the caller applies the same
// clamp and the environment default is the safer choice for a corrupted row.
func floorJSONNumber(value json.Number) (int, bool) {
	if value == "" {
		return 0, false
	}
	parsed, err := value.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return int(math.Floor(parsed)), true
}
