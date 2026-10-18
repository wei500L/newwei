package oidclogin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

// PathStart, PathCallback and PathExchange are the only paths this unit owns.
const (
	PathStart    = "/api/auth/sso/oidc/start"
	PathCallback = "/api/auth/oidc/callback"
	PathExchange = "/api/auth/sso/handoff/exchange"
)

// Shared Redis keys and TTLs. The literal prefixes and durations match the
// NestJS implementation so both processes observe the same state, discovery and
// JWKS cache entries.
const (
	stateCacheKeyPrefix       = "auth:oidc:state:"
	discoveryCacheKeyPrefix   = "oidc:discovery:"
	jwksCacheKeyPrefix        = "oidc:jwks:"
	stateTTL                  = 10 * time.Minute
	discoveryCacheTTL         = time.Hour
	jwksCacheTTL              = 24 * time.Hour
	fetchTimeout              = 8 * time.Second
	clockTolerance            = 60 * time.Second
	handoffTTL                = 5 * time.Minute
	codeVerifierBytes         = 32
	handoffTokenBytes         = 32
	challengeTypeSSOHandoff   = "sso_handoff"
	oidcLoginAuditAction      = "login_with_oidc"
	identityTokenInvalidError = "OIDC identity token validation failed"
	handoffInvalidError       = "SSO handoff token is invalid or expired"
	callbackInvalidError      = "OIDC callback is invalid"
	stateInvalidError         = "OIDC state is invalid or expired"
	notConfiguredError        = "OIDC is not configured for this organization"
	invitedAccountError       = "Your account must be invited or approved before using SSO"
	tokenExchangeError        = "OIDC token exchange failed"
	missingIDTokenError       = "OIDC response missing id_token"
	discoveryLoadError        = "Failed to load OIDC discovery document"
	discoveryInvalidError     = "OIDC discovery document is invalid"
	discoveryIssuerError      = "OIDC discovery issuer does not match configured issuer"
	apiBaseURLRequiredError   = "API_BASE_URL is required for OIDC"
	nextAuthCallbackPath      = "/auth/sso/callback"
	apiCallbackPath           = "/api/auth/oidc/callback"
)

// publicIDTokenAlgorithms is the exact verification allowlist. Discovery
// metadata is never used as a substitute: an IdP that only advertises RS256
// must still be able to present any of these asymmetric algorithms.
var publicIDTokenAlgorithms = []string{
	"RS256", "RS384", "RS512",
	"PS256", "PS384", "PS512",
	"ES256", "ES384", "ES512",
	"EdDSA",
}

// Config carries the environment-derived request-time inputs. The JWT and
// secret-encoding configuration is held by the reused authlogin/authfactors
// services, not repeated here.
type Config struct {
	// NextAuthURL is the web origin used to build the front-end callback URL.
	// It defaults to http://localhost:3000, exactly like the NestJS controller.
	NextAuthURL string
	// APIBaseURL is only used for the IdP redirect_uri. It stays a request-time
	// requirement so a missing value fails the start/callback request with the
	// source 400 instead of blocking gateway startup.
	APIBaseURL string
	// TrustProxy mirrors TRUST_PROXY for the audit and challenge IP address.
	TrustProxy string
}

// oidcDiscovery is the named discovery document this unit consumes. The
// optional signing-algorithm list is preserved in the cache document but is
// never used as the verification allowlist.
type oidcDiscovery struct {
	Issuer                           string   `json:"issuer"`
	AuthorizationEndpoint            string   `json:"authorization_endpoint"`
	TokenEndpoint                    string   `json:"token_endpoint"`
	JWKSUri                          string   `json:"jwks_uri"`
	IDTokenSigningAlgValuesSupported []string `json:"id_token_signing_alg_values_supported,omitempty"`
}

// orgOIDCConfig is the organization configuration subset the login chain reads.
// ClientSecret and Scopes keep their JSON column bytes: the secret goes through
// the shared AuthSecurity codec and the scopes are decoded by readScopes.
type orgOIDCConfig struct {
	OrgID                string
	Enabled              bool
	IssuerURL            string
	DiscoveryURL         string
	ClientID             string
	ClientSecret         []byte
	Scopes               []byte
	RequireEmailVerified bool
}

// orgRecord is one organization plus its optional OIDC configuration row.
type orgRecord struct {
	ID   string
	OIDC *orgOIDCConfig
}

// oidcState is the Redis value behind auth:oidc:state:<state>. The member names
// are the source names, so a NestJS callback can consume a state written by Go
// and vice versa.
type oidcState struct {
	OrgID        string `json:"orgId"`
	CodeVerifier string `json:"codeVerifier"`
	Nonce        string `json:"nonce"`
}

// CallbackParams mirrors the three public query values plus the requester
// metadata the trusted login records.
type CallbackParams struct {
	State     *string
	Code      *string
	Error     *string
	IPAddress *string
	UserAgent *string
}

// CallbackResult carries exactly one of the three front-end redirect branches.
// An empty member is not written to the URL.
type CallbackResult struct {
	HandoffToken          string
	AuthChallengeID       string
	EnrollmentChallengeID string
}

// handoffPayload is the AuthChallenge.payload document for sso_handoff rows.
// The encoded tokens are JSON values because the shared secret policy may store
// either a string or the system-settings v1 envelope.
type handoffPayload struct {
	AccessToken   json.RawMessage                     `json:"accessToken"`
	RefreshToken  json.RawMessage                     `json:"refreshToken"`
	ExpiresIn     int                                 `json:"expiresIn"`
	User          accountsecurity.LoginProfile        `json:"user"`
	Organizations []accountsecurity.LoginOrganization `json:"organizations"`
	UserAgent     *string                             `json:"userAgent"`
}

// handoffPayloadPresence distinguishes an absent JSON member from a present
// zero value when reading a stored payload. The source rejects a payload whose
// expiresIn is not a number, whose user is missing, or whose organizations are
// not an array; an empty organizations array is valid.
type handoffPayloadPresence struct {
	ExpiresIn     json.RawMessage `json:"expiresIn"`
	User          json.RawMessage `json:"user"`
	Organizations json.RawMessage `json:"organizations"`
}

// handoffChallenge is one sso_handoff AuthChallenge row as written by the
// callback and read by the exchange entry.
type handoffChallenge struct {
	ID         string
	Type       string
	UserID     *string
	OrgID      *string
	Payload    []byte
	ExpiresAt  time.Time
	ConsumedAt *time.Time
}

// ExchangeResult is the successful POST /sso/handoff/exchange body. The member
// order matches the NestJS object literal.
type ExchangeResult struct {
	User          accountsecurity.LoginProfile        `json:"user"`
	AccessToken   string                              `json:"accessToken"`
	RefreshToken  string                              `json:"refreshToken"`
	Organizations []accountsecurity.LoginOrganization `json:"organizations"`
	ExpiresIn     int                                 `json:"expiresIn"`
}

// TrustedLogin is the narrow port onto the migrated authlogin core. Production
// passes *authlogin.Service; tests inject a fake to exercise the three MFA
// branches without duplicating the core.
type TrustedLogin interface {
	BeginTrustedLogin(ctx context.Context, userID, orgID string, ipAddress, userAgent *string, action string) (authlogin.TrustedLoginResult, error)
}

// Directory reads the existing account and organization state. Every OIDC
// login is authorized against an already existing user and membership; this
// interface has no create/update member by design.
type Directory interface {
	// FindOrgByIdentifier applies the source lookup: the raw id value or the
	// lowercased slug.
	FindOrgByIdentifier(ctx context.Context, id, slug string) (*orgRecord, error)
	FindOrgByID(ctx context.Context, id string) (*orgRecord, error)
	FindUserIDByEmail(ctx context.Context, email string) (string, bool, error)
}

// ChallengeStore owns the AuthChallenge row used by the one-time handoff.
type ChallengeStore interface {
	CreateHandoff(ctx context.Context, challenge handoffChallenge) error
	LoadHandoff(ctx context.Context, id string) (handoffChallenge, bool, error)
	// ClaimHandoff performs one conditional UPDATE that includes the id, the
	// sso_handoff type, consumedAt IS NULL and a still-valid expiry. It reports
	// whether this caller won the claim.
	ClaimHandoff(ctx context.Context, id string, now time.Time) (bool, error)
}

// SecretCodec is the shared system-settings v1 secret policy.
type SecretCodec interface {
	EncodeLoginSecret(ctx context.Context, plain string) (json.RawMessage, error)
	DecodeLoginSecret(ctx context.Context, raw []byte) (string, bool, error)
}

// cacheStore is the Redis operation subset this unit needs. GetDel is a single
// atomic command, never Get followed by Del.
type cacheStore interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	GetDel(ctx context.Context, key string) ([]byte, bool, error)
}

// httpClient is the outbound HTTP subset, injectable for tests.
type httpClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// targetValidator is the shared SSRF/DNS policy. The default delegates to
// newssources.ValidateOutboundTargetURL; the HTTPS rule is applied before this
// call and is never relaxed by a test.
type targetValidator func(ctx context.Context, raw string) (reason string, allowed bool)

var (
	errNoDatabase = errors.New("oidclogin: mysql is not configured")
	errNoRedis    = errors.New("oidclogin: redis is not configured")
)
