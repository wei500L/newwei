package newssourcescheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// This file ports NewsSourceSchedulerService.ensureLegacyRssSeedCacheTtlMigrated
// and migrateLegacyRssSeedCacheTtlToModeDefault: the one-time startup migration
// that drops the legacy `seed.cacheTtlSeconds = 600` override from RSS sources
// so they inherit the current mode default (60s) instead of pinning the old 10
// minute cache.
//
// The migration belongs to the scheduler owner, not to a cron tick: NestJS runs
// it from onModuleInit regardless of the scheduler switch, so the Go scheduler
// runs it once when it starts (see Scheduler.Start). Keys, TTLs and the
// `news-source:rss:` cache invalidation are shared with NestJS, so both
// implementations exclude each other and the migration runs at most once per
// marker lifetime.

const (
	// legacyRSSSeedCacheTTLSeconds is LEGACY_RSS_SEED_CACHE_TTL_SECONDS, the
	// pre-mode-default value that must not survive as a source override.
	legacyRSSSeedCacheTTLSeconds = 600
	// rssSeedTTLMigrationLockKey is RSS_SEED_CACHE_TTL_MIGRATION_LOCK_KEY. The
	// physical Redis key is "lock:migration:news-source:rss-seed-cache-ttl-600"
	// because it goes through the CacheService-style lease.
	rssSeedTTLMigrationLockKey = "migration:news-source:rss-seed-cache-ttl-600"
	// rssSeedTTLMigrationDoneKey is RSS_SEED_CACHE_TTL_MIGRATION_DONE_KEY.
	rssSeedTTLMigrationDoneKey = "migration:news-source:rss-seed-cache-ttl-600:done"
	// rssSeedTTLMigrationDoneTTL is RSS_SEED_CACHE_TTL_MIGRATION_DONE_TTL_SECONDS.
	rssSeedTTLMigrationDoneTTL = 365 * 24 * time.Hour
	// rssSeedTTLMigrationLockTTL is the 120000 ms lock passed to withLock.
	rssSeedTTLMigrationLockTTL = 120 * time.Second
	// rssSeedTTLMigrationMaxRetries is RSS_SEED_CACHE_TTL_MIGRATION_MAX_RETRIES.
	rssSeedTTLMigrationMaxRetries = 3
	// rssSeedDiscoveryCachePrefix is the prefix CacheService.delByPrefix clears
	// after a row changed, so the next discovery run recomputes with the new TTL.
	rssSeedDiscoveryCachePrefix = "news-source:rss:"
)

// rssSeedTTLMigrationResult is what the migration reports back and stores in the
// done marker.
type rssSeedTTLMigrationResult struct {
	ScannedCount int `json:"scannedCount"`
	MatchedCount int `json:"matchedCount"`
	UpdatedCount int `json:"updatedCount"`
}

// rssSeedTTLMigrationMarker is the done-marker payload. completedAt is only
// written on a fresh run, exactly like the NestJS marker.
type rssSeedTTLMigrationMarker struct {
	CompletedAt string `json:"completedAt"`
	rssSeedTTLMigrationResult
}

// sourceConfigRow is one NewsSource row of the migration scan. Config stays raw
// because it is a Prisma Json column that must round-trip byte for byte except
// for the removed override.
type sourceConfigRow struct {
	ID     string
	Config []byte
}

// migrateLegacyRSSSeedCacheTTL is ensureLegacyRssSeedCacheTtlMigrated. A failure
// is never fatal: the caller logs it and the scheduler keeps ticking, exactly
// like the NestJS try/catch around the whole step.
func (s *Service) migrateLegacyRSSSeedCacheTTL(ctx context.Context) {
	if s == nil || s.repo == nil || s.cache == nil {
		return
	}
	var marker rssSeedTTLMigrationMarker
	if found, err := s.cacheGetJSON(ctx, rssSeedTTLMigrationDoneKey, &marker); err == nil && found {
		return
	}

	var result *rssSeedTTLMigrationResult
	_, err := s.withLock(ctx, rssSeedTTLMigrationLockKey, rssSeedTTLMigrationLockTTL, func(lockCtx context.Context) error {
		var latest rssSeedTTLMigrationMarker
		if found, getErr := s.cacheGetJSON(lockCtx, rssSeedTTLMigrationDoneKey, &latest); getErr == nil && found {
			return nil
		}
		migrated, migrateErr := s.migrateLegacyRSSSeedCacheTTLToModeDefault(lockCtx)
		if migrateErr != nil {
			return migrateErr
		}
		if migrated.UpdatedCount > 0 {
			// Discovery results cached under the legacy TTL would otherwise keep
			// serving for another full TTL window.
			if deleted, delErr := s.cache.DelByPrefix(lockCtx, rssSeedDiscoveryCachePrefix); delErr != nil {
				s.logWarn("failed to clear RSS discovery cache after seed TTL migration", "error", delErr)
			} else {
				s.logInfo("cleared RSS discovery cache after seed TTL migration", "deletedKeys", deleted)
			}
		}
		result = &migrated
		stored, marshalErr := json.Marshal(rssSeedTTLMigrationMarker{
			CompletedAt:               isoMillis(s.now()),
			rssSeedTTLMigrationResult: migrated,
		})
		if marshalErr != nil {
			return marshalErr
		}
		return s.cache.Set(lockCtx, rssSeedTTLMigrationDoneKey, string(stored), rssSeedTTLMigrationDoneTTL)
	})
	if err != nil {
		s.logWarn("failed to migrate legacy RSS seed cache TTL overrides", "error", err)
		return
	}
	if result != nil {
		s.logInfo("migrated legacy RSS seed cache TTL overrides",
			"scannedCount", result.ScannedCount,
			"matchedCount", result.MatchedCount,
			"updatedCount", result.UpdatedCount)
	}
}

// migrateLegacyRSSSeedCacheTTLToModeDefault is
// migrateLegacyRssSeedCacheTtlToModeDefault: scan every source, drop the 600 s
// RSS override and count the rows that actually changed.
func (s *Service) migrateLegacyRSSSeedCacheTTLToModeDefault(ctx context.Context) (rssSeedTTLMigrationResult, error) {
	rows, err := s.repo.ListSourceConfigs(ctx)
	if err != nil {
		return rssSeedTTLMigrationResult{}, err
	}
	result := rssSeedTTLMigrationResult{ScannedCount: len(rows)}
	for _, row := range rows {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, ctxErr
		}
		if _, ok := removeLegacyRSSSeedCacheTTLOverride(row.Config); !ok {
			continue
		}
		result.MatchedCount++
		updated, updateErr := s.replaceLegacyRSSSeedCacheTTLOverrideWithRetry(ctx, row.ID, row.Config)
		if updateErr != nil {
			return result, updateErr
		}
		if updated {
			result.UpdatedCount++
		}
	}
	return result, nil
}

// replaceLegacyRSSSeedCacheTTLOverrideWithRetry is
// updateLegacyRssSeedCacheTtlOverrideWithRetry: the UPDATE is conditional on the
// config that was read, so a concurrent edit is never overwritten. A lost race
// re-reads the row and retries with the fresh value.
func (s *Service) replaceLegacyRSSSeedCacheTTLOverrideWithRetry(ctx context.Context, sourceID string, initialConfig []byte) (bool, error) {
	current := initialConfig
	for attempt := 0; attempt < rssSeedTTLMigrationMaxRetries; attempt++ {
		migrated, ok := removeLegacyRSSSeedCacheTTLOverride(current)
		if !ok {
			return false, nil
		}
		updated, err := s.repo.ReplaceSourceConfigIfUnchanged(ctx, sourceID, current, migrated, s.now())
		if err != nil {
			return false, err
		}
		if updated > 0 {
			return true, nil
		}
		latest, found, err := s.repo.LoadSourceConfig(ctx, sourceID)
		if err != nil {
			return false, err
		}
		if !found {
			return false, nil
		}
		current = latest
	}
	return false, nil
}

// removeLegacyRSSSeedCacheTTLOverride is removeLegacyRssSeedCacheTtlOverride. It
// returns the rewritten config and whether the legacy override was present.
//
// The config is decoded into json.RawMessage leaves so every untouched section
// keeps its exact bytes and number formatting; only the removed key changes.
func removeLegacyRSSSeedCacheTTLOverride(configRaw []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(configRaw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &config); err != nil || config == nil {
		return nil, false
	}

	seedRaw, ok := config["seed"]
	if !ok {
		return nil, false
	}
	seedTrimmed := bytes.TrimSpace(seedRaw)
	if len(seedTrimmed) == 0 || seedTrimmed[0] != '{' {
		return nil, false
	}
	var seed map[string]json.RawMessage
	if err := json.Unmarshal(seedTrimmed, &seed); err != nil || seed == nil {
		return nil, false
	}

	modeRaw, ok := seed["mode"]
	if !ok {
		return nil, false
	}
	mode, ok := jsJSONString(modeRaw)
	if !ok || strings.ToLower(trimJS(mode)) != "rss" {
		return nil, false
	}

	rawTTL, ok := seed["cacheTtlSeconds"]
	if !ok {
		return nil, false
	}
	ttl, ok := jsNumberValue(rawTTL)
	if !ok || math.IsNaN(ttl) || math.IsInf(ttl, 0) || int(jsRound(ttl)) != legacyRSSSeedCacheTTLSeconds {
		return nil, false
	}

	delete(seed, "cacheTtlSeconds")
	encodedSeed, err := json.Marshal(seed)
	if err != nil {
		return nil, false
	}
	config["seed"] = json.RawMessage(encodedSeed)
	encodedConfig, err := json.Marshal(config)
	if err != nil {
		return nil, false
	}
	return encodedConfig, true
}

// jsJSONString accepts only a JSON string literal (json.Unmarshal also accepts
// null into a string, which would misread the mode).
func jsJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// jsNumberValue mirrors the `typeof rawTtl === "number" ? rawTtl : typeof
// rawTtl === "string" && rawTtl.trim().length > 0 ? Number(rawTtl) : NaN`
// branch: numbers and non-empty numeric strings, everything else invalid.
func jsNumberValue(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '"' {
		text, ok := jsJSONString(trimmed)
		if !ok || strings.TrimSpace(text) == "" {
			return 0, false
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil {
			return 0, false
		}
		return value, true
	}
	if trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9') {
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			return 0, false
		}
		return value, true
	}
	return 0, false
}
