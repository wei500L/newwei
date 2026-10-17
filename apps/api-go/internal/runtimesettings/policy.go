package runtimesettings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// Rate limit policy bounds, copied from rate-limit-policy.service.ts.
const (
	policyMinLimit         = 0
	policyMaxLimit         = 100000
	policyMinWindowSeconds = 1
	policyMaxWindowSeconds = 86400
)

// policyFeaturePattern is FEATURE_PATTERN = /^[a-z][a-z0-9_.]*$/.
var policyFeaturePattern = regexp.MustCompile(`^[a-z][a-z0-9_.]*$`)

// rateLimitPolicy is the public representation of one RateLimitPolicy row. The
// field order is the JSON key order the NestJS service returns.
type rateLimitPolicy struct {
	Feature       string   `json:"feature"`
	UserLimit     int      `json:"userLimit"`
	IPLimit       int      `json:"ipLimit"`
	WindowSeconds int      `json:"windowSeconds"`
	Enabled       bool     `json:"enabled"`
	Description   *string  `json:"description,omitempty"`
	CreatedAt     nestTime `json:"createdAt"`
	UpdatedAt     nestTime `json:"updatedAt"`
}

// rateLimitPolicyCacheEntry is the Redis payload for one policy, mirroring
// `{ policy: RateLimitPolicy | null }` with a 60 second TTL.
type rateLimitPolicyCacheEntry struct {
	Policy *rateLimitPolicy `json:"policy"`
}

// rateLimitPolicyCreateRequest mirrors CreateRateLimitPolicyDto. Every field is
// raw JSON so the typed validators can emit class-validator wording.
type rateLimitPolicyCreateRequest struct {
	Feature       json.RawMessage `json:"feature"`
	UserLimit     json.RawMessage `json:"userLimit"`
	IPLimit       json.RawMessage `json:"ipLimit"`
	WindowSeconds json.RawMessage `json:"windowSeconds"`
	Enabled       json.RawMessage `json:"enabled"`
	Description   json.RawMessage `json:"description"`
}

// rateLimitPolicyUpdateRequest mirrors UpdateRateLimitPolicyDto: every field is
// optional.
type rateLimitPolicyUpdateRequest struct {
	UserLimit     json.RawMessage `json:"userLimit"`
	IPLimit       json.RawMessage `json:"ipLimit"`
	WindowSeconds json.RawMessage `json:"windowSeconds"`
	Enabled       json.RawMessage `json:"enabled"`
	Description   json.RawMessage `json:"description"`
}

// rateLimitPolicyWrite is the normalized create payload.
type rateLimitPolicyWrite struct {
	UserLimit     int
	IPLimit       int
	WindowSeconds int
	Enabled       bool
	// Description is the value to persist; nil means SQL NULL.
	Description *string
}

// rateLimitPolicyPatch is the update payload. Pointer fields distinguish
// "absent" (nil, keep the stored value) from "provided".
type rateLimitPolicyPatch struct {
	UserLimit     *int
	IPLimit       *int
	WindowSeconds *int
	Enabled       *bool
	// Description is the replacement value; nil means SQL NULL.
	Description *string
	// TouchDescription reports whether the request supplied the description
	// key, so update writes the column (including NULL) instead of preserving
	// the stored value. This is the fix for the "cannot clear description"
	// defect: Prisma's undefined means "leave unchanged", so an explicit empty
	// string must become NULL rather than undefined.
	TouchDescription bool
}

// rateLimitPolicyAuditMetadata is the AuditLog.metadata document for policy
// create/update. Key order matches `{ feature, ...normalized }`.
type rateLimitPolicyAuditMetadata struct {
	Feature       string  `json:"feature"`
	UserLimit     int     `json:"userLimit"`
	IPLimit       int     `json:"ipLimit"`
	WindowSeconds int     `json:"windowSeconds"`
	Enabled       bool    `json:"enabled"`
	Description   *string `json:"description,omitempty"`
}

// rateLimitPolicyDeleteMetadata is the AuditLog.metadata document for delete.
type rateLimitPolicyDeleteMetadata struct {
	Feature string `json:"feature"`
}

// parseCreateRateLimitPolicy validates a POST body and normalizes the feature.
func parseCreateRateLimitPolicy(body []byte) (string, rateLimitPolicyWrite, error) {
	var dto rateLimitPolicyCreateRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return "", rateLimitPolicyWrite{}, err
	}
	var problems validationErrors
	feature, _ := matchesField(&problems, dto.Feature, "feature", "/^[a-z][a-z0-9_.]*$/", func(value string) bool {
		return policyFeaturePattern.MatchString(value)
	})
	userLimit, _ := numberField(&problems, dto.UserLimit, "userLimit", true, policyMinLimit, policyMaxLimit)
	ipLimit, _ := numberField(&problems, dto.IPLimit, "ipLimit", true, policyMinLimit, policyMaxLimit)
	windowSeconds, _ := numberField(&problems, dto.WindowSeconds, "windowSeconds", true, policyMinWindowSeconds, policyMaxWindowSeconds)
	enabled, enabledPresent := boolField(&problems, dto.Enabled, "enabled", false)
	description := descriptionValue(&problems, dto.Description)
	if err := problems.err(); err != nil {
		return "", rateLimitPolicyWrite{}, err
	}
	normalized, err := normalizePolicyFeature(feature)
	if err != nil {
		return "", rateLimitPolicyWrite{}, err
	}
	if !enabledPresent {
		enabled = true
	}
	return normalized, rateLimitPolicyWrite{
		UserLimit:     clampInt(userLimit, policyMinLimit, policyMaxLimit),
		IPLimit:       clampInt(ipLimit, policyMinLimit, policyMaxLimit),
		WindowSeconds: clampInt(windowSeconds, policyMinWindowSeconds, policyMaxWindowSeconds),
		Enabled:       enabled,
		Description:   description,
	}, nil
}

// parseUpdateRateLimitPolicy validates a PUT body. The feature comes from the
// path and is normalized separately.
func parseUpdateRateLimitPolicy(body []byte) (rateLimitPolicyPatch, error) {
	var dto rateLimitPolicyUpdateRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return rateLimitPolicyPatch{}, err
	}
	var problems validationErrors
	patch := rateLimitPolicyPatch{}
	if value, ok := numberField(&problems, dto.UserLimit, "userLimit", false, policyMinLimit, policyMaxLimit); ok {
		patch.UserLimit = &value
	}
	if value, ok := numberField(&problems, dto.IPLimit, "ipLimit", false, policyMinLimit, policyMaxLimit); ok {
		patch.IPLimit = &value
	}
	if value, ok := numberField(&problems, dto.WindowSeconds, "windowSeconds", false, policyMinWindowSeconds, policyMaxWindowSeconds); ok {
		patch.WindowSeconds = &value
	}
	if value, ok := boolField(&problems, dto.Enabled, "enabled", false); ok {
		patch.Enabled = &value
	}
	if present(dto.Description) {
		patch.TouchDescription = true
		patch.Description = descriptionValue(&problems, dto.Description)
	}
	if err := problems.err(); err != nil {
		return rateLimitPolicyPatch{}, err
	}
	return patch, nil
}

// descriptionValue validates an optional @IsString description and normalizes
// it the way the service does: null, an empty string and a whitespace-only
// string all become nil (SQL NULL). A non-blank value is trimmed.
func descriptionValue(problems *validationErrors, raw json.RawMessage) *string {
	if !present(raw) || isNull(raw) {
		return nil
	}
	text, ok := stringField(problems, raw, "description", false)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizePolicyFeature applies trim().toLowerCase() and re-validates, exactly
// like the service's normalizeFeature (a 400 "Invalid rate limit feature name"
// when the result does not match FEATURE_PATTERN).
func normalizePolicyFeature(feature string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(feature))
	if normalized == "" || !policyFeaturePattern.MatchString(normalized) {
		return "", &httpError{status: http.StatusBadRequest, message: "Invalid rate limit feature name"}
	}
	return normalized, nil
}

// clampInt mirrors the service clamp helper (NaN or below min becomes min).
func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// intOr returns *value when set, otherwise fallback.
func intOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

// boolOr returns *value when set, otherwise fallback.
func boolOr(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

// policyCacheKey builds rate_limit_policy:<feature>.
func policyCacheKey(feature string) string {
	return rateLimitPolicyCachePrefix + feature
}

// rateLimitPolicyColumns is the shared SELECT projection.
const rateLimitPolicyColumns = "feature, userLimit, ipLimit, windowSeconds, enabled, description, createdAt, updatedAt"

// rateLimitPolicyRow is the MySQL projection of one RateLimitPolicy row.
type rateLimitPolicyRow struct {
	Feature       string
	UserLimit     int
	IPLimit       int
	WindowSeconds int
	Enabled       bool
	Description   sql.NullString
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// toPolicy converts the storage row into the public representation. A NULL
// description is omitted from the JSON (omitempty on a nil pointer).
func (r rateLimitPolicyRow) toPolicy() rateLimitPolicy {
	policy := rateLimitPolicy{
		Feature:       r.Feature,
		UserLimit:     r.UserLimit,
		IPLimit:       r.IPLimit,
		WindowSeconds: r.WindowSeconds,
		Enabled:       r.Enabled,
		CreatedAt:     nestTime(r.CreatedAt),
		UpdatedAt:     nestTime(r.UpdatedAt),
	}
	if r.Description.Valid {
		description := r.Description.String
		policy.Description = &description
	}
	return policy
}

// scanRateLimitPolicyRow reads one row from a *sql.Row.
func scanRateLimitPolicyRow(row *sql.Row) (rateLimitPolicy, error) {
	var record rateLimitPolicyRow
	err := row.Scan(&record.Feature, &record.UserLimit, &record.IPLimit, &record.WindowSeconds,
		&record.Enabled, &record.Description, &record.CreatedAt, &record.UpdatedAt)
	if err != nil {
		return rateLimitPolicy{}, err
	}
	return record.toPolicy(), nil
}

// listRateLimitPolicies orders by feature ascending (the contract order). The
// result is never nil so the JSON body is [] rather than null.
func (s *Service) listRateLimitPolicies(ctx context.Context) ([]rateLimitPolicy, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+rateLimitPolicyColumns+" FROM RateLimitPolicy ORDER BY feature ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	policies := make([]rateLimitPolicy, 0)
	for rows.Next() {
		var record rateLimitPolicyRow
		if err := rows.Scan(&record.Feature, &record.UserLimit, &record.IPLimit, &record.WindowSeconds,
			&record.Enabled, &record.Description, &record.CreatedAt, &record.UpdatedAt); err != nil {
			return nil, err
		}
		policies = append(policies, record.toPolicy())
	}
	return policies, rows.Err()
}

// findRateLimitPolicy returns the row for a normalized feature. found is false
// when the row does not exist.
func (s *Service) findRateLimitPolicy(ctx context.Context, feature string) (rateLimitPolicy, bool, error) {
	if s == nil || s.db == nil {
		return rateLimitPolicy{}, false, errNoDatabase
	}
	policy, err := scanRateLimitPolicyRow(s.db.QueryRowContext(ctx,
		"SELECT "+rateLimitPolicyColumns+" FROM RateLimitPolicy WHERE feature = ? LIMIT 1", feature))
	if errors.Is(err, sql.ErrNoRows) {
		return rateLimitPolicy{}, false, nil
	}
	if err != nil {
		return rateLimitPolicy{}, false, err
	}
	return policy, true, nil
}

// getRateLimitPolicy mirrors RateLimitPolicyService.getPolicy: Redis first (a
// cached null still means "not found"), then MySQL with a 60 second write-back.
// Cache failures only log; the database stays authoritative on a miss.
func (s *Service) getRateLimitPolicy(ctx context.Context, feature string) (*rateLimitPolicy, error) {
	normalized, err := normalizePolicyFeature(feature)
	if err != nil {
		return nil, err
	}
	cacheKey := policyCacheKey(normalized)
	if raw, found, cacheErr := s.cacheGet(ctx, cacheKey); cacheErr != nil {
		logCacheFailure("rate limit policy", normalized, cacheErr)
	} else if found {
		var entry rateLimitPolicyCacheEntry
		if json.Unmarshal(raw, &entry) == nil {
			return entry.Policy, nil
		}
		logCacheFailure("rate limit policy", normalized, errors.New("cache entry is not a policy document"))
	}

	policy, found, err := s.findRateLimitPolicy(ctx, normalized)
	if err != nil {
		return nil, err
	}
	var result *rateLimitPolicy
	if found {
		result = &policy
	}
	if encoded, encodeErr := json.Marshal(rateLimitPolicyCacheEntry{Policy: result}); encodeErr == nil {
		if cacheErr := s.cacheSet(ctx, cacheKey, encoded, rateLimitPolicyCacheTTLSeconds); cacheErr != nil {
			logCacheFailure("rate limit policy", normalized, cacheErr)
		}
	}
	return result, nil
}

// createRateLimitPolicy mirrors createPolicy plus the concurrency fix: a unique
// key violation from a concurrent insert (MySQL 1062 / Prisma P2002) becomes
// 409 Conflict instead of an uncaught 500.
func (s *Service) createRateLimitPolicy(ctx context.Context, orgID, actorID, feature string, write rateLimitPolicyWrite) (rateLimitPolicy, error) {
	if s == nil || s.db == nil {
		return rateLimitPolicy{}, errNoDatabase
	}
	if _, found, err := s.findRateLimitPolicy(ctx, feature); err != nil {
		return rateLimitPolicy{}, err
	} else if found {
		return rateLimitPolicy{}, policyConflict(feature)
	}

	now := nowMillis()
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO RateLimitPolicy (feature, userLimit, ipLimit, windowSeconds, enabled, description, createdAt, updatedAt, updatedById) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		feature, write.UserLimit, write.IPLimit, write.WindowSeconds, write.Enabled,
		write.Description, now, now, nullableActorID(actorID))
	if err != nil {
		if isDuplicateKeyError(err) {
			// The row was created between the existence check and the insert.
			return rateLimitPolicy{}, policyConflict(feature)
		}
		return rateLimitPolicy{}, err
	}

	created, found, err := s.findRateLimitPolicy(ctx, feature)
	if err != nil {
		return rateLimitPolicy{}, err
	}
	if !found {
		return rateLimitPolicy{}, errNoDatabase
	}
	metadata, marshalErr := json.Marshal(rateLimitPolicyAuditMetadata{
		Feature:       feature,
		UserLimit:     created.UserLimit,
		IPLimit:       created.IPLimit,
		WindowSeconds: created.WindowSeconds,
		Enabled:       created.Enabled,
		Description:   created.Description,
	})
	if marshalErr == nil {
		s.writeAuditLogBestEffort(ctx, orgID, actorID, "rate_limit_policy_create", metadata)
	}
	s.storePolicyCache(ctx, feature, &created)
	return created, nil
}

// updateRateLimitPolicy mirrors updatePolicy: merge the patch onto the stored
// row, normalize, update, and 404 when the row vanished concurrently.
func (s *Service) updateRateLimitPolicy(ctx context.Context, orgID, actorID, feature string, patch rateLimitPolicyPatch) (rateLimitPolicy, error) {
	if s == nil || s.db == nil {
		return rateLimitPolicy{}, errNoDatabase
	}
	normalized, err := normalizePolicyFeature(feature)
	if err != nil {
		return rateLimitPolicy{}, err
	}
	existing, found, err := s.findRateLimitPolicy(ctx, normalized)
	if err != nil {
		return rateLimitPolicy{}, err
	}
	if !found {
		return rateLimitPolicy{}, notFoundPolicy(normalized)
	}

	write := rateLimitPolicyWrite{
		UserLimit:     clampInt(intOr(patch.UserLimit, existing.UserLimit), policyMinLimit, policyMaxLimit),
		IPLimit:       clampInt(intOr(patch.IPLimit, existing.IPLimit), policyMinLimit, policyMaxLimit),
		WindowSeconds: clampInt(intOr(patch.WindowSeconds, existing.WindowSeconds), policyMinWindowSeconds, policyMaxWindowSeconds),
		Enabled:       boolOr(patch.Enabled, existing.Enabled),
		Description:   existing.Description,
	}
	// The description fix: an explicitly supplied value (including "" or
	// whitespace) always overwrites the column; only an absent key preserves it.
	if patch.TouchDescription {
		write.Description = patch.Description
	}

	if _, err := s.db.ExecContext(ctx,
		"UPDATE RateLimitPolicy SET userLimit = ?, ipLimit = ?, windowSeconds = ?, enabled = ?, description = ?, updatedAt = ?, updatedById = ? WHERE feature = ?",
		write.UserLimit, write.IPLimit, write.WindowSeconds, write.Enabled, write.Description,
		nowMillis(), nullableActorID(actorID), normalized); err != nil {
		return rateLimitPolicy{}, err
	}

	updated, found, err := s.findRateLimitPolicy(ctx, normalized)
	if err != nil {
		return rateLimitPolicy{}, err
	}
	if !found {
		// The row was deleted between the read and the write (Prisma P2025).
		return rateLimitPolicy{}, notFoundPolicy(normalized)
	}
	metadata, marshalErr := json.Marshal(rateLimitPolicyAuditMetadata{
		Feature:       normalized,
		UserLimit:     updated.UserLimit,
		IPLimit:       updated.IPLimit,
		WindowSeconds: updated.WindowSeconds,
		Enabled:       updated.Enabled,
		Description:   updated.Description,
	})
	if marshalErr == nil {
		s.writeAuditLogBestEffort(ctx, orgID, actorID, "rate_limit_policy_update", metadata)
	}
	s.storePolicyCache(ctx, normalized, &updated)
	return updated, nil
}

// deleteRateLimitPolicy mirrors deletePolicy plus the concurrency fix: deleting
// an already removed row returns 404 instead of an uncaught Prisma P2025.
func (s *Service) deleteRateLimitPolicy(ctx context.Context, orgID, actorID, feature string) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	normalized, err := normalizePolicyFeature(feature)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, "DELETE FROM RateLimitPolicy WHERE feature = ?", normalized)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return notFoundPolicy(normalized)
	}
	metadata, marshalErr := json.Marshal(rateLimitPolicyDeleteMetadata{Feature: normalized})
	if marshalErr == nil {
		s.writeAuditLogBestEffort(ctx, orgID, actorID, "rate_limit_policy_delete", metadata)
	}
	if cacheErr := s.cacheDel(ctx, policyCacheKey(normalized)); cacheErr != nil {
		logCacheFailure("rate limit policy", normalized, cacheErr)
	}
	return nil
}

// storePolicyCache writes the policy cache entry and only logs failures, the
// way the NestJS service treats cache writes on the write path.
func (s *Service) storePolicyCache(ctx context.Context, feature string, policy *rateLimitPolicy) {
	encoded, err := json.Marshal(rateLimitPolicyCacheEntry{Policy: policy})
	if err != nil {
		return
	}
	if cacheErr := s.cacheSet(ctx, policyCacheKey(feature), encoded, rateLimitPolicyCacheTTLSeconds); cacheErr != nil {
		logCacheFailure("rate limit policy", feature, cacheErr)
	}
}

// policyConflict builds the 409 a duplicate feature produces.
func policyConflict(feature string) error {
	return &httpError{
		status:  http.StatusConflict,
		message: "Rate limit policy already exists for " + feature,
	}
}

// notFoundPolicy builds the 404 the update/delete paths return.
func notFoundPolicy(feature string) error {
	return &httpError{status: http.StatusNotFound, message: "Rate limit policy not found for " + feature}
}

// isDuplicateKeyError reports a MySQL 1062 unique-key violation, the error a
// concurrent Prisma create surfaces as P2002.
func isDuplicateKeyError(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
