package authfactors

import "time"

// The seven exact paths owned by this unit.
const (
	PathMfaStatus  = "/api/auth/mfa"
	PathMfaEnroll  = "/api/auth/mfa/enroll"
	PathMfaVerify  = "/api/auth/mfa/verify-enroll"
	PathMfaDisable = "/api/auth/mfa/disable"
	PathMfaRotate  = "/api/auth/mfa/recovery/rotate"
	PathOidcConfig = "/api/auth/admin/oidc-config"
)

// requiredPermission is the single permission the organization OIDC
// configuration routes require. Human permission sets always come from the
// MySQL membership re-derivation inside authhttp, never from JWT claims.
const requiredPermission = "settings.manage"

// mfaIssuer is the fixed TOTP issuer label. The otpauth URI, the stored factor
// label and the issuer query parameter all use this literal, and the Go and
// NestJS implementations must agree byte for byte.
const mfaIssuer = "Modular"

// machineActorPrefix is the user-id prefix produced by the machine-token path
// (`machine:<tokenId>`). It is not a User row, so it can never own a factor.
const machineActorPrefix = "machine:"

// The authenticated MFA write routes answer 403 for machine identities. The
// text is shared with the NestJS implementation.
const mfaHumanRequiredMessage = "MFA management requires a human user"

// Business messages shared with the NestJS implementation.
const (
	mfaEnrollmentNotInitializedMessage = "MFA enrollment is not initialized"
	mfaInvalidCodeMessage              = "Invalid MFA verification code"
	mfaLockBusyMessage                 = "MFA settings are being updated by another request; retry later"
)

// Per-user MySQL session lock parameters.
const (
	// mfaUserLockPrefix is followed by the first 60 hex characters of the
	// SHA-256 of the UTF-8 user id, giving a 64 character name (MySQL's
	// GET_LOCK limit). The NestJS helper `mfaUserLockName` computes the
	// identical string, so one lock serializes Nest and Go writers for the
	// same user.
	mfaUserLockPrefix = "mfa:"
	// mfaLockHashHexChars is the number of digest characters kept.
	mfaLockHashHexChars = 60
	// mfaLockWaitSeconds is the GET_LOCK timeout. NestJS uses the same value.
	mfaLockWaitSeconds = 10
	// mfaLockReleaseTimeout bounds RELEASE_LOCK. It is derived from
	// context.WithoutCancel so a cancelled client request can never leave the
	// lock unreleased.
	mfaLockReleaseTimeout = 5 * time.Second
)

// TOTP parameters. RFC 6238 with SHA-1, six digits and a 30 second period,
// matching auth-flow.utils.ts exactly.
const (
	totpSecretBytes  = 20
	totpPeriodSecond = 30
	totpCodeDigits   = 6
	totpWindow       = 1
)

// Recovery-code parameters.
const (
	recoveryCodeCount = 8
	recoveryCodeBytes = 5
)

// SystemSetting / Redis cache constants for the shared secret-encoding policy.
const (
	// systemSecuritySettingKey is the global SystemSetting row that carries
	// `secretEncryptionEnabled`.
	systemSecuritySettingKey = "system_security"
	// systemSecurityCacheKey is the AuthSecurityService cache key. Unlike the
	// `system_security:settings` envelope used by the system-security settings
	// service, this key stores the raw settings value (or a non-object JSON
	// value), so the two caches are not interchangeable.
	systemSecurityCacheKey = "auth:system-security"
	// systemSecurityCacheTTLSeconds is the AuthSecurityService TTL.
	systemSecurityCacheTTLSeconds = 60
)

// profileCacheKeyPrefix is the AuthService profile cache key prefix
// (`profile:<userId>:<orgId>`, with `default` when no organization is given).
const profileCacheKeyPrefix = "profile:"

// profileCacheDefaultOrg is the organization segment used when a profile is
// cached without an explicit organization.
const profileCacheDefaultOrg = "default"
