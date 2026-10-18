// Package authlogin implements the eleven POST /api/auth routes owned by the
// auth-login migration unit: password login, session refresh, passwordless
// email-code login, the two public MFA challenges (verify-login plus the forced
// enrollment start/complete pair), password recovery, and the authenticated
// email-change chain.
//
// Everything here is a faithful port of the NestJS auth chain
// (apps/api/src/modules/auth): the same user/membership/role/permission
// re-derivation from MySQL, the same access-token claims, the same refresh
// rotation protocol (grace cache, shared lock, single-use claim, blacklist), the
// same email-code keys and single-use deletion, the same challenge
// consumption/attempt/lock rules, the same password-reset transaction, and the
// same best-effort audit with its outbox fallback. Shared keys, column formats
// and TTLs are byte-compatible so a deployment can roll back to NestJS — or run
// both — without invalidating sessions, codes or challenges in flight.
package authlogin

import (
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// The eleven exact paths owned by this unit.
const (
	PathLogin                 = "/api/auth/login"
	PathRefresh               = "/api/auth/refresh"
	PathSendLoginCode         = "/api/auth/send-login-code"
	PathLoginWithCode         = "/api/auth/login-with-code"
	PathMfaVerifyLogin        = "/api/auth/mfa/verify-login"
	PathMfaEnrollmentStart    = "/api/auth/mfa/enrollment/start"
	PathMfaEnrollmentComplete = "/api/auth/mfa/enrollment/complete"
	PathPasswordForgot        = "/api/auth/password/forgot"
	PathPasswordReset         = "/api/auth/password/reset"
	PathSendVerification      = "/api/auth/send-verification"
	PathVerifyEmail           = "/api/auth/verify-email"
)

// Shared Redis keys. Every one of them is the literal key NestJS uses, so the
// two implementations observe the same counters and the same single-use state.
const (
	emailCodeKeyPrefix         = "auth:email-code:"
	emailCodeAttemptsKeyPrefix = "auth:email-code:attempts:"
	emailCodeCooldownKeyPrefix = "auth:email-code:cooldown:"
	emailCodeSettingsCacheKey  = "auth_email_code:settings"
	emailCodeSettingsRowKey    = "auth_email_code_settings"
	emailCodeSettingsCacheTTL  = 60

	systemSecurityRowKey   = "system_security"
	systemSecurityCacheKey = "auth:system-security"
	systemSecurityCacheTTL = 60

	rateLimitSettingsCacheKey  = "rate_limit:settings"
	rateLimitPolicyCachePrefix = "rate_limit_policy:"
	rateLimitPolicyCacheTTL    = 60
	passwordResetPolicyFeature = "auth.password_reset"

	refreshGraceCacheKeyPrefix = "auth:refresh:"
	lockKeyPrefix              = "lock:"
)

// Shared business messages and limits.
const (
	emailCodeLength               = 8
	invalidEmailCodeMessage       = "Verification code is invalid or expired"
	invalidCredentialsMessage     = "Invalid credentials"
	invalidRefreshTokenMessage    = "Invalid refresh token"
	refreshTokenExpiredMessage    = "Refresh token expired"
	userNotFoundMessage           = "User not found"
	tooManyLoginAttemptsMessage   = "Too many login attempts. Please try again later."
	passwordResetRateLimitMessage = "Too many password reset requests. Please wait before trying again."
	passwordResetTokenMessage     = "Password reset token is invalid or expired"
	invalidAccessTokenMessage     = "Invalid access token"
	emailCodeCooldownMessage      = "Please wait before requesting another code"
	newEmailSameMessage           = "New email must be different from current email"
	emailInUseMessage             = "Email is already in use"
	emailPendingMessage           = "Email is already pending verification"
	passwordTooShortMessage       = "Password must be at least 8 characters"

	mfaLoginChallengeInvalidMessage      = "MFA challenge is invalid or expired"
	mfaEnrollmentChallengeInvalidMessage = "MFA enrollment challenge is invalid or expired"
	mfaChallengeLockedMessage            = "Too many MFA verification attempts. Please sign in again."
	mfaEnrollmentNotInitializedMessage   = "MFA enrollment is not initialized"
	mfaEnrollmentIncompleteMessage       = "MFA enrollment could not be completed"

	mfaChallengeTTL       = 10 * time.Minute
	mfaEnrollmentTTL      = 15 * time.Minute
	passwordResetTTL      = 30 * time.Minute
	bcryptCost            = 10
	refreshSecretBytes    = 32
	passwordResetSecret   = 32
	minPasswordLength     = 8
	minRefreshTokenLength = 20
	refreshGraceLockFloor = 10 * time.Second
	retryDelayMs          = 50
	bodyByteLimit         = 10 << 20
)

// Email-code normalization bounds (AuthEmailCodeSettingsService).
const (
	emailCodeMinTTLSeconds      = 60
	emailCodeMaxTTLSeconds      = 1800
	emailCodeMinCooldownSeconds = 10
	emailCodeMaxCooldownSeconds = 3600
	emailCodeMinMaxAttempts     = 1
	emailCodeMaxMaxAttempts     = 10
)

// Rate-limit bucket normalization bounds (RateLimitConfigService).
const (
	rateLimitMinLimit         = 1
	rateLimitMaxLimit         = 1000
	rateLimitMinWindowSeconds = 5
	rateLimitMaxWindowSeconds = 86400

	passwordResetDefaultEmailLimit = 3
	passwordResetDefaultIPLimit    = 10
	passwordResetDefaultWindow     = 900
)

// SMTPConfig is this unit's own copy of the transport settings so the package
// stays independent of the config layer. Every field mirrors Env.smtpConfig.
type SMTPConfig struct {
	Host                  string
	Port                  int
	Secure                bool
	User                  string
	Pass                  string
	From                  string
	Pool                  bool
	ConnectionTimeoutMs   int
	GreetingTimeoutMs     int
	SocketTimeoutMs       int
	TLSRejectUnauthorized bool
}

// Config carries the environment-derived inputs the login chain needs.
type Config struct {
	JWTSecret   string
	JWTIssuer   string
	JWTAudience string
	// AccessExpiresIn / RefreshExpiresIn keep the raw timespan text
	// ("15m", "7d"), because NestJS parses them per signing call and answers a
	// malformed value with the same 400 the request would get there.
	AccessExpiresIn  string
	RefreshExpiresIn string

	AuthRefreshGraceSeconds int

	AuthMfaChallengeMaxAttempts int

	AuthEmailCodeTTLSeconds      int
	AuthEmailCodeCooldownSeconds int
	AuthEmailCodeMaxAttempts     int

	RateLimitLogin       int
	RateLimitLoginWindow int
	// RateLimitFailOpen mirrors RATE_LIMIT_REDIS_FAIL_OPEN (default false). When
	// it is false a limiter outage answers the throttle instead of opening an
	// unthrottled window.
	RateLimitFailOpen bool

	// NextAuthURL is only used to build the password-reset link.
	NextAuthURL string

	// TrustProxy mirrors TRUST_PROXY and decides how the client IP is resolved
	// for the rate-limit buckets and the audit records. The empty value keeps the
	// conservative default: the socket address, never a forwarded header.
	TrustProxy string

	// EncryptionKeyRaw / EncryptionKeyPresent / NodeEnv are forwarded verbatim
	// to the reused MFA factor service, which owns the secret-encoding policy.
	EncryptionKeyRaw     string
	EncryptionKeyPresent bool
	NodeEnv              string

	SMTP SMTPConfig
}

// emailCodeScene distinguishes the email-change code from the login code. The
// value is part of the Redis key, so it must stay "bind" / "login".
type emailCodeScene string

const (
	sceneBind  emailCodeScene = "bind"
	sceneLogin emailCodeScene = "login"
)

// mfaPolicy is the system-wide MFA requirement stored in system_security.
type mfaPolicy string

const (
	mfaPolicyOff        mfaPolicy = "off"
	mfaPolicyAdminsOnly mfaPolicy = "admins_only"
	mfaPolicyAllUsers   mfaPolicy = "all_users"
)

// loginRequirement is the decision completeTrustedLogin makes after the
// credential verified.
type loginRequirement string

const (
	loginRequirementNone   loginRequirement = "none"
	loginRequirementVerify loginRequirement = "verify"
	loginRequirementEnroll loginRequirement = "enroll"
)

// emailCodePayload is the cached code envelope. It stores only the SHA-256 of
// the code: the plaintext never leaves the request that generated it.
type emailCodePayload struct {
	CodeHash string  `json:"codeHash"`
	Email    string  `json:"email"`
	UserID   *string `json:"userId,omitempty"`
}

// emailCodeSettings is the normalized code policy.
type emailCodeSettings struct {
	TTLSeconds      int `json:"ttlSeconds"`
	CooldownSeconds int `json:"cooldownSeconds"`
	MaxAttempts     int `json:"maxAttempts"`
}

// systemSecuritySettings only decodes mfaPolicy. The raw JSON is kept as a
// RawMessage because a stored non-string value must mean "off" instead of
// failing the whole read.
type systemSecuritySettings struct {
	MfaPolicy json.RawMessage `json:"mfaPolicy"`
}

// rateLimitBucket is one entry of the rate_limit:settings document.
type rateLimitBucket struct {
	Limit         int `json:"limit"`
	WindowSeconds int `json:"windowSeconds"`
}

// loginRateLimitSettings decodes only the login bucket; the other buckets are
// irrelevant here and are ignored by the JSON decoder.
type loginRateLimitSettings struct {
	Login rateLimitBucket `json:"login"`
}

// rateLimitPolicyRecord mirrors the RateLimitPolicy row the password-reset
// policy reads.
type rateLimitPolicyRecord struct {
	Feature       string `json:"feature"`
	UserLimit     int    `json:"userLimit"`
	IPLimit       int    `json:"ipLimit"`
	WindowSeconds int    `json:"windowSeconds"`
	Enabled       bool   `json:"enabled"`
}

// rateLimitPolicyCacheEntry is the shape RateLimitPolicyService caches at
// rate_limit_policy:<feature>; a null policy is a legitimate cached value.
type rateLimitPolicyCacheEntry struct {
	Policy *rateLimitPolicyRecord `json:"policy"`
}

// passwordResetPolicy is the resolved forgot-password throttle.
type passwordResetPolicy struct {
	UserLimit     int
	IPLimit       int
	WindowSeconds int
}

// loginChallengePayload is the AuthChallenge.payload document. The field set and
// the omitempty behaviour match the NestJS object literals: an mfa_login
// challenge carries no action, an mfa_enrollment one always does.
type loginChallengePayload struct {
	OrgID     string  `json:"orgId"`
	IPAddress *string `json:"ipAddress"`
	UserAgent *string `json:"userAgent"`
	Action    string  `json:"action,omitempty"`
}

// loginUser is the login-chain user projection. It is an alias of the
// account-security port type so the sql.Row scan stays single-sourced.
type loginUser = accountsecurity.LoginUser

// loginMembership is the login-chain membership projection.
type loginMembership = accountsecurity.LoginMembership

// authenticatedUser is the JSON body every session and challenge response
// carries. It is the same type GET /me returns, so a client cannot observe a
// different field set or a different null/empty-array convention.
type authenticatedUser = accountsecurity.LoginProfile

// organizationOption is one organization entry of the session result.
type organizationOption = accountsecurity.LoginOrganization

// sessionResult is the successful login/refresh body. Field order matches the
// NestJS object literal in finalizeLogin and refresh.
type sessionResult struct {
	User          authenticatedUser    `json:"user"`
	AccessToken   string               `json:"accessToken"`
	RefreshToken  string               `json:"refreshToken"`
	Organizations []organizationOption `json:"organizations"`
	ExpiresIn     int                  `json:"expiresIn"`
}

// mfaChallengeResult is the login response when the account must present a
// second factor. It never carries a token: the session is issued only after
// /mfa/verify-login succeeds.
type mfaChallengeResult struct {
	User               authenticatedUser    `json:"user"`
	Organizations      []organizationOption `json:"organizations"`
	MFARequired        bool                 `json:"mfaRequired"`
	AuthChallengeID    string               `json:"authChallengeId"`
	ChallengeExpiresAt string               `json:"challengeExpiresAt"`
}

// enrollmentChallengeResult is the login response when the policy forces the
// account to bind a second factor first.
type enrollmentChallengeResult struct {
	User                  authenticatedUser    `json:"user"`
	Organizations         []organizationOption `json:"organizations"`
	MFAEnrollmentRequired bool                 `json:"mfaEnrollmentRequired"`
	EnrollmentChallengeID string               `json:"enrollmentChallengeId"`
	ChallengeExpiresAt    string               `json:"challengeExpiresAt"`
}

// enrollmentCompleteResult is the forced-enrollment completion body: the full
// session plus the one-time plaintext recovery codes. The session members are
// repeated instead of embedding sessionResult, so the serialization order is
// explicit and independent of embedding rules.
type enrollmentCompleteResult struct {
	User          authenticatedUser    `json:"user"`
	AccessToken   string               `json:"accessToken"`
	RefreshToken  string               `json:"refreshToken"`
	Organizations []organizationOption `json:"organizations"`
	ExpiresIn     int                  `json:"expiresIn"`
	RecoveryCodes []string             `json:"recoveryCodes"`
}

// mfaEnrollmentStartResult is the POST /mfa/enrollment/start body (201).
type mfaEnrollmentStartResult struct {
	Secret     string `json:"secret"`
	OtpauthURI string `json:"otpauthUri"`
}

// emailCodeSendResult is the shared body of send-login-code and
// send-verification: the same shape whether or not a mail was actually sent.
type emailCodeSendResult struct {
	OK              bool `json:"ok"`
	CooldownSeconds int  `json:"cooldownSeconds"`
}

// okResult is the body of password/forgot and password/reset.
type okResult struct {
	OK bool `json:"ok"`
}

// refreshCredential is a parsed refresh token: tokenId[.orgId].secret.
type refreshCredential struct {
	TokenID string
	OrgID   string
	Secret  string
}

// refreshTokenRow is the claimed RefreshToken row the rotation compares against.
type refreshTokenRow struct {
	UserID    string
	TokenHash string
	ExpiresAt time.Time
}

// passwordResetTokenRow is the row resolved from a reset token hash.
type passwordResetTokenRow struct {
	UserID    string
	ExpiresAt time.Time
	UsedAt    *time.Time
}

// authChallengeRow is one AuthChallenge row with its attempt budget.
type authChallengeRow struct {
	ID             string
	Type           string
	UserID         *string
	OrgID          *string
	Payload        []byte
	ExpiresAt      time.Time
	ConsumedAt     *time.Time
	FailedAttempts int
	LockedAt       *time.Time
}

// consumedChallenge is the payload the challenge consumers hand back to the
// session flow.
type consumedChallenge struct {
	UserID        string
	OrgID         string
	IPAddress     *string
	UserAgent     *string
	Action        string
	RecoveryCodes []string
}

// issuedAccessToken is a freshly signed access token and its absolute expiry.
type issuedAccessToken struct {
	Token     string
	ExpiresAt time.Time
}

// issuedRefreshToken is a freshly persisted refresh token and its expiry.
type issuedRefreshToken struct {
	Token     string
	ExpiresAt time.Time
}

// challengeType values are the AuthChallengeType enum members this unit writes
// and reads.
const (
	challengeTypeMfaLogin      = "mfa_login"
	challengeTypeMfaEnrollment = "mfa_enrollment"
)
