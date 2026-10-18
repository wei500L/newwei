package settingswrite

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// Source policy storage and cache keys, byte-for-byte the NestJS literals. Every
// key appends the server-derived organization id; a client-supplied orgId never
// reaches these helpers.
const (
	sourcePolicySettingPrefix                        = "news_event_source_policy:"
	sourcePolicyCategoryAuthoritySettingPrefix       = "news_event_source_policy_category_authority:"
	sourcePolicyPresetSettingPrefix                  = "news_event_source_policy_preset:"
	sourcePolicyPresetCategoryAuthoritySettingPrefix = "news_event_source_policy_preset_category_authority:"

	sourcePolicyCachePrefix                        = "newsEvents:sourcePolicy:"
	sourcePolicyCategoryAuthorityCachePrefix       = "newsEvents:sourcePolicyCategoryAuthority:"
	sourcePolicyPresetCachePrefix                  = "newsEvents:sourcePolicyPreset:"
	sourcePolicyPresetCategoryAuthorityCachePrefix = "newsEvents:sourcePolicyPresetCategoryAuthority:"
)

// Source policy cache TTLs: the policy state and the active category authority
// live 60 seconds, the preset and the preset category authority 30.
const (
	sourcePolicyCacheTTLSeconds       = 60
	sourcePolicyPresetCacheTTLSeconds = 30
)

// sourcePolicyNoteMaxLength is the DTO @MaxLength of note.
const sourcePolicyNoteMaxLength = 500

// Audit literals. The action names and the resource match the NestJS service so
// the existing AuditLogOutbox replay worker consumes the same rows.
const (
	sourcePolicyActionUpdate       = "news_event_source_policy_update"
	sourcePolicyActionRollback     = "news_event_source_policy_rollback"
	sourcePolicyActionReset        = "news_event_source_policy_reset"
	sourcePolicyActionPresetUpdate = "news_event_source_policy_preset_update"
	sourcePolicyResource           = "system_settings"
)

// sourcePolicyWarningCacheWriteFailed is the syncWarnings code a mutation
// reports when the database write committed but Redis did not.
const sourcePolicyWarningCacheWriteFailed = "CACHE_WRITE_FAILED"

// errCacheUnavailable reports a missing Redis client. A deployment without
// Redis must not report a successful cache refresh, so this becomes the
// CACHE_WRITE_FAILED warning instead of a silent no-op.
var errCacheUnavailable = errors.New("settingswrite: redis is not configured")

// sourcePolicyStateAuditMetadata is the AuditLog.metadata of an update, rollback
// or reset: the new active revision, its timestamp and the full delta snapshot.
type sourcePolicyStateAuditMetadata struct {
	ActiveRevision int                                     `json:"activeRevision"`
	UpdatedAt      string                                  `json:"updatedAt"`
	Delta          settingscrawl.SourcePolicyDeltaDocument `json:"delta"`
}

// sourcePolicyPresetAuditMetadata is the AuditLog.metadata of a preset update.
type sourcePolicyPresetAuditMetadata struct {
	UpdatedAt string                                   `json:"updatedAt"`
	Note      *string                                  `json:"note"`
	Preset    settingscrawl.SourcePolicyPresetDocument `json:"preset"`
}

// sourcePolicyStateKey and the three sibling helpers compose the SystemSetting
// keys. The write and the NestJS reader therefore address one row per document.
func sourcePolicyStateKey(orgID string) string {
	return sourcePolicySettingPrefix + orgID
}

func sourcePolicyCategoryAuthorityKey(orgID string) string {
	return sourcePolicyCategoryAuthoritySettingPrefix + orgID
}

func sourcePolicyPresetKey(orgID string) string {
	return sourcePolicyPresetSettingPrefix + orgID
}

func sourcePolicyPresetCategoryAuthorityKey(orgID string) string {
	return sourcePolicyPresetCategoryAuthoritySettingPrefix + orgID
}

// sourcePolicyDescription is the SystemSetting description the NestJS service
// writes for the two policy documents and the two category-authority documents.
func sourcePolicyDescription(subject, orgID string) string {
	return subject + " (org=" + orgID + ")"
}

// sourcePolicyStateDescription is the description of the policy state row.
func sourcePolicyStateDescription(orgID string) string {
	return sourcePolicyDescription("News event source policy", orgID)
}

// sourcePolicyCategoryAuthorityDescription is the description of the active
// category-authority row.
func sourcePolicyCategoryAuthorityDescription(orgID string) string {
	return sourcePolicyDescription("News event source policy category authority", orgID)
}

// sourcePolicyPresetDescription is the description of the preset row.
func sourcePolicyPresetDescription(orgID string) string {
	return sourcePolicyDescription("News event source policy presets", orgID)
}

// sourcePolicyPresetCategoryAuthorityDescription is the description of the
// preset category-authority row.
func sourcePolicyPresetCategoryAuthorityDescription(orgID string) string {
	return sourcePolicyDescription("News event source policy preset category authority", orgID)
}

// setSourcePolicyCache writes one shared cache document and returns the failure
// instead of swallowing it. The caller keeps the committed database write and
// reports CACHE_WRITE_FAILED, exactly like the NestJS service after a rejected
// CacheService.set.
func (s *service) setSourcePolicyCache(ctx context.Context, key string, payload []byte, ttlSeconds int) error {
	if s == nil || s.redis == nil {
		return errCacheUnavailable
	}
	if ttlSeconds <= 0 {
		ttlSeconds = 1
	}
	if err := s.redis.Set(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Err(); err != nil {
		log.Printf("settingswrite: failed to refresh source policy cache key %q: %v", key, err)
		return err
	}
	return nil
}

// upsertSourcePolicyPreset writes the preset document and reads back the row's
// updatedAt in the same transaction. The timestamp is the value a later
// expectedUpdatedAt comparison sees, so it is taken from the row instead of
// from the application clock.
func (s *service) upsertSourcePolicyPreset(
	ctx context.Context,
	key string,
	payload []byte,
	description string,
	updatedByID *string,
) (time.Time, error) {
	if s == nil || s.db == nil {
		return time.Time{}, errDatabaseUnavailable
	}
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return time.Time{}, err
	}
	// The update branch refreshes value, updatedAt, updatedById and description
	// and leaves isPublic untouched, mirroring the Prisma upsert of the service.
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt, updatedById) "+
			"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, "+
			"updatedById = new_row.updatedById, description = new_row.description",
		key, payload, description, now, now, updatedByID); err != nil {
		_ = tx.Rollback()
		return time.Time{}, err
	}
	var updatedAt time.Time
	if err := tx.QueryRowContext(ctx,
		"SELECT updatedAt FROM SystemSetting WHERE `key` = ? LIMIT 1", key,
	).Scan(&updatedAt); err != nil {
		_ = tx.Rollback()
		return time.Time{}, err
	}
	if err := tx.Commit(); err != nil {
		return time.Time{}, err
	}
	return updatedAt, nil
}

// writeSourcePolicyAudit records one best-effort audit row. It never turns a
// committed write into an error: a failed insert enqueues the AuditLogOutbox
// payload the NestJS worker replays.
func writeSourcePolicyAudit[T any](
	db *sql.DB,
	ctx context.Context,
	identity contract.Identity,
	action string,
	metadata T,
) {
	writeAuditLogBestEffort(db, ctx, identity.OrgID, identity.UserID, sourcePolicyResource, action, metadata)
}
