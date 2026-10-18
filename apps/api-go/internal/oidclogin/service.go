package oidclogin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// Service owns the three public SSO entries. It shares MySQL, Redis and the
// trusted-login core with the other auth units; it opens no second pool and
// starts no background work.
type Service struct {
	cfg        Config
	cache      cacheStore
	directory  Directory
	challenges ChallengeStore
	login      TrustedLogin
	secrets    SecretCodec
	http       httpClient
	// validateTarget is the shared SSRF/DNS policy. HTTPS is checked before it
	// and is not part of the injectable seam.
	validateTarget targetValidator
	now            func() time.Time
}

// NewService wires the production dependencies. The caller supplies the reused
// trusted-login service and the shared secret codec so this package owns no JWT
// signing, no membership/MFA logic and no encryption algorithm.
func NewService(db *sql.DB, redisClient *redis.Client, cfg Config, login TrustedLogin, secrets SecretCodec) *Service {
	service := &Service{
		cfg:     cfg,
		login:   login,
		secrets: secrets,
		http:    &http.Client{},
		now:     time.Now,
	}
	if db != nil {
		service.directory = newMySQLDirectory(db)
		service.challenges = newMySQLChallengeStore(db)
	}
	service.cache = redisCache{client: redisClient}
	service.validateTarget = newssources.ValidateOutboundTargetURL
	return service
}

// Start builds the IdP authorization URL.
//
// Order follows the source: load the enabled organization configuration, fetch
// or read the discovery document, generate and persist the state/PKCE/nonce
// value, resolve the redirect_uri, then add the authorization parameters. A
// failed state write therefore cannot produce a usable login URL.
func (s *Service) Start(ctx context.Context, orgIdentifier string) (string, error) {
	if s.directory == nil {
		return "", errNoDatabase
	}
	org, err := s.directory.FindOrgByIdentifier(ctx, orgIdentifier, strings.ToLower(orgIdentifier))
	if err != nil {
		return "", err
	}
	if org == nil || org.OIDC == nil || !org.OIDC.Enabled {
		return "", badRequest(notConfiguredError)
	}

	discovery, err := s.fetchDiscovery(ctx, org.OIDC)
	if err != nil {
		return "", err
	}

	state, err := newUUID()
	if err != nil {
		return "", err
	}
	nonce, err := newUUID()
	if err != nil {
		return "", err
	}
	verifier, err := randomBase64URL(codeVerifierBytes)
	if err != nil {
		return "", err
	}
	challenge := sha256Base64URL(verifier)

	payload, err := json.Marshal(oidcState{
		OrgID:        org.ID,
		CodeVerifier: verifier,
		Nonce:        nonce,
	})
	if err != nil {
		return "", err
	}
	if err := s.cache.Set(ctx, stateCacheKey(state), payload, stateTTL); err != nil {
		return "", err
	}

	redirectURI, err := s.idpCallbackURL()
	if err != nil {
		return "", err
	}

	authorizationURL, err := url.Parse(discovery.AuthorizationEndpoint)
	if err != nil {
		return "", badRequest("OIDC authorization URL is invalid")
	}
	query := authorizationURL.Query()
	query.Set("client_id", org.OIDC.ClientID)
	query.Set("response_type", "code")
	query.Set("scope", strings.Join(readScopes(org.OIDC.Scopes), " "))
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	query.Set("nonce", nonce)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	authorizationURL.RawQuery = query.Encode()
	return authorizationURL.String(), nil
}

// Callback consumes the one-time state and continues the login chain.
//
// The state is claimed with one atomic GETDEL before the organization is
// reloaded, the code is exchanged and the id_token is verified. An explicit IdP
// error is answered first and leaves the state untouched, exactly like the
// source.
func (s *Service) Callback(ctx context.Context, params CallbackParams) (CallbackResult, error) {
	if s.directory == nil {
		return CallbackResult{}, errNoDatabase
	}
	if s.secrets == nil {
		return CallbackResult{}, fmt.Errorf("oidclogin: secret codec is not configured")
	}
	if params.Error != nil && *params.Error != "" {
		return CallbackResult{}, unauthorized("OIDC login failed: " + *params.Error)
	}
	if params.State == nil || *params.State == "" || params.Code == nil || *params.Code == "" {
		return CallbackResult{}, unauthorized(callbackInvalidError)
	}

	rawState, found, err := s.cache.GetDel(ctx, stateCacheKey(*params.State))
	if err != nil {
		return CallbackResult{}, err
	}
	if !found {
		return CallbackResult{}, unauthorized(stateInvalidError)
	}
	var state oidcState
	if err := json.Unmarshal(rawState, &state); err != nil {
		return CallbackResult{}, unauthorized(stateInvalidError)
	}

	org, err := s.directory.FindOrgByID(ctx, state.OrgID)
	if err != nil {
		return CallbackResult{}, err
	}
	if org == nil || org.OIDC == nil || !org.OIDC.Enabled {
		return CallbackResult{}, unauthorized(notConfiguredError)
	}

	discovery, err := s.fetchDiscovery(ctx, org.OIDC)
	if err != nil {
		return CallbackResult{}, err
	}
	clientSecret, secretFound, err := s.secrets.DecodeLoginSecret(ctx, org.OIDC.ClientSecret)
	if err != nil {
		return CallbackResult{}, err
	}
	if !secretFound {
		clientSecret = ""
	}

	redirectURI, err := s.idpCallbackURL()
	if err != nil {
		return CallbackResult{}, err
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {*params.Code},
		"redirect_uri":  {redirectURI},
		"client_id":     {org.OIDC.ClientID},
		"code_verifier": {state.CodeVerifier},
	}
	// Only a decoded non-empty secret is added. The source does not switch to
	// HTTP Basic authentication, so neither does this implementation.
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, discovery.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return CallbackResult{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.http.Do(request)
	if err != nil {
		return CallbackResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return CallbackResult{}, unauthorized(tokenExchangeError)
	}
	var tokenResponse struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&tokenResponse); err != nil {
		return CallbackResult{}, unauthorized(tokenExchangeError)
	}
	if tokenResponse.IDToken == "" {
		return CallbackResult{}, unauthorized(missingIDTokenError)
	}

	claims, err := s.verifyIDToken(ctx, tokenResponse.IDToken, discovery, org.OIDC.ClientID, state.Nonce, org.OIDC.RequireEmailVerified)
	if err != nil {
		return CallbackResult{}, err
	}

	// The source lowercases the verified email but does not trim it; the empty
	// check already ran during claim validation.
	userID, found, err := s.directory.FindUserIDByEmail(ctx, strings.ToLower(claims.verifiedEmail()))
	if err != nil {
		return CallbackResult{}, err
	}
	if !found {
		return CallbackResult{}, unauthorized(invitedAccountError)
	}

	if s.login == nil {
		return CallbackResult{}, fmt.Errorf("oidclogin: trusted login is not configured")
	}
	result, err := s.login.BeginTrustedLogin(ctx, userID, org.ID, params.IPAddress, params.UserAgent, oidcLoginAuditAction)
	if err != nil {
		return CallbackResult{}, err
	}
	switch {
	case result.MFA != nil:
		return CallbackResult{AuthChallengeID: result.MFA.AuthChallengeID}, nil
	case result.Enrollment != nil:
		return CallbackResult{EnrollmentChallengeID: result.Enrollment.EnrollmentChallengeID}, nil
	case result.Session != nil:
		handoffToken, err := s.createHandoff(ctx, result.Session, org.ID, params.UserAgent)
		if err != nil {
			return CallbackResult{}, err
		}
		return CallbackResult{HandoffToken: handoffToken}, nil
	default:
		return CallbackResult{}, fmt.Errorf("oidclogin: trusted login returned no result")
	}
}

// createHandoff encrypts the two session tokens with the shared AuthSecurity
// policy and stores the payload behind the SHA-256 of a fresh random token. The
// raw token is returned to the browser only; the row's primary key is its hash.
func (s *Service) createHandoff(ctx context.Context, session *authlogin.TrustedLoginSession, orgID string, userAgent *string) (string, error) {
	if s.challenges == nil {
		return "", errNoDatabase
	}
	accessToken, err := s.secrets.EncodeLoginSecret(ctx, session.AccessToken)
	if err != nil {
		return "", err
	}
	refreshToken, err := s.secrets.EncodeLoginSecret(ctx, session.RefreshToken)
	if err != nil {
		return "", err
	}
	organizations := session.Organizations
	if organizations == nil {
		organizations = []accountsecurity.LoginOrganization{}
	}
	payload, err := json.Marshal(handoffPayload{
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		ExpiresIn:     session.ExpiresIn,
		User:          session.User,
		Organizations: organizations,
		UserAgent:     userAgent,
	})
	if err != nil {
		return "", err
	}
	rawToken, err := randomHex(handoffTokenBytes)
	if err != nil {
		return "", err
	}
	expiresAt := s.now().UTC().Truncate(time.Millisecond).Add(handoffTTL)
	if err := s.challenges.CreateHandoff(ctx, handoffChallenge{
		ID:        hashOpaqueToken(rawToken),
		Type:      challengeTypeSSOHandoff,
		UserID:    stringPointer(session.User.ID),
		OrgID:     stringPointer(orgID),
		Payload:   payload,
		ExpiresAt: expiresAt,
	}); err != nil {
		return "", err
	}
	return rawToken, nil
}

// Exchange consumes one handoff row and returns the stored session.
//
// Every payload, user-agent and secret check runs before the single conditional
// UPDATE. The claim is the only write: no second session is minted, no login
// audit is repeated, and a concurrent exchange that loses the claim receives
// the same invalid-or-expired 401.
func (s *Service) Exchange(ctx context.Context, handoffToken string, userAgent *string) (ExchangeResult, error) {
	if s.challenges == nil {
		return ExchangeResult{}, errNoDatabase
	}
	if s.secrets == nil {
		return ExchangeResult{}, fmt.Errorf("oidclogin: secret codec is not configured")
	}
	challenge, found, err := s.challenges.LoadHandoff(ctx, hashOpaqueToken(handoffToken))
	if err != nil {
		return ExchangeResult{}, err
	}
	if !found || challenge.Type != challengeTypeSSOHandoff {
		return ExchangeResult{}, unauthorized(handoffInvalidError)
	}
	// The source compares millisecond timestamps; the database column has
	// millisecond precision, so an expiry equal to the current millisecond is
	// still valid.
	now := s.now().UTC().Truncate(time.Millisecond)
	if challenge.ConsumedAt != nil || challenge.ExpiresAt.Before(now) {
		return ExchangeResult{}, unauthorized(handoffInvalidError)
	}

	payload, err := parseHandoffPayload(challenge.Payload)
	if err != nil {
		return ExchangeResult{}, err
	}
	if !handoffUserAgentMatches(payload.UserAgent, userAgent) {
		return ExchangeResult{}, unauthorized(handoffInvalidError)
	}

	accessToken, accessFound, err := s.secrets.DecodeLoginSecret(ctx, payload.AccessToken)
	if err != nil {
		// A decryption/configuration failure keeps its own infrastructure
		// meaning; it is not converted into a successful or a business 401.
		return ExchangeResult{}, err
	}
	refreshToken, refreshFound, err := s.secrets.DecodeLoginSecret(ctx, payload.RefreshToken)
	if err != nil {
		return ExchangeResult{}, err
	}
	if !accessFound || accessToken == "" || !refreshFound || refreshToken == "" {
		return ExchangeResult{}, unauthorized(handoffInvalidError)
	}

	claimed, err := s.challenges.ClaimHandoff(ctx, challenge.ID, now)
	if err != nil {
		return ExchangeResult{}, err
	}
	if !claimed {
		return ExchangeResult{}, unauthorized(handoffInvalidError)
	}

	return ExchangeResult{
		User:          payload.User,
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		Organizations: payload.Organizations,
		ExpiresIn:     payload.ExpiresIn,
	}, nil
}

// parseHandoffPayload distinguishes absent members from present zero values.
// organizations=[] is valid, while a missing expiresIn/user/organizations, an
// object instead of an array, or a non-integer expiresIn is the source invalid
// handoff branch.
func parseHandoffPayload(raw []byte) (handoffPayload, error) {
	var presence handoffPayloadPresence
	if err := json.Unmarshal(raw, &presence); err != nil {
		return handoffPayload{}, unauthorized(handoffInvalidError)
	}
	if !isJSONNumber(presence.ExpiresIn) || !isJSONObject(presence.User) || !isJSONArray(presence.Organizations) {
		return handoffPayload{}, unauthorized(handoffInvalidError)
	}
	var payload handoffPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return handoffPayload{}, unauthorized(handoffInvalidError)
	}
	if payload.Organizations == nil {
		return handoffPayload{}, unauthorized(handoffInvalidError)
	}
	return payload, nil
}

func isJSONNumber(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return false
	}
	return (trimmed[0] >= '0' && trimmed[0] <= '9') || trimmed[0] == '-'
}

func isJSONObject(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return len(trimmed) > 0 && trimmed[0] == '{'
}

func isJSONArray(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return len(trimmed) > 0 && trimmed[0] == '['
}

// handoffUserAgentMatches compares only when both the recorded and the request
// values are non-empty, and trims both before comparing. A missing value on
// either side is not a mismatch.
func handoffUserAgentMatches(recorded, provided *string) bool {
	if recorded == nil || provided == nil || *recorded == "" || *provided == "" {
		return true
	}
	return strings.TrimSpace(*recorded) == strings.TrimSpace(*provided)
}

// apiSuffixPattern is the case-insensitive trailing "/api" removed from
// API_BASE_URL. It runs after every trailing slash was stripped.
var apiSuffixPattern = regexp.MustCompile(`(?i)/api$`)

// idpCallbackURL builds the IdP redirect_uri from API_BASE_URL. A missing value
// is the source request-time 400. Up to one trailing path "/api" is stripped
// case-insensitively so a base that already carries the global prefix does not
// produce /api/api/auth/oidc/callback.
func (s *Service) idpCallbackURL() (string, error) {
	raw := s.cfg.APIBaseURL
	if raw == "" {
		return "", badRequest(apiBaseURLRequiredError)
	}
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	base = apiSuffixPattern.ReplaceAllString(base, "")
	return base + apiCallbackPath, nil
}

// frontendCallbackURL reproduces `new URL("/auth/sso/callback", NEXTAUTH_URL)`:
// an absolute path replaces any base path, query and fragment.
func (s *Service) frontendCallbackURL() (*url.URL, error) {
	base, err := url.Parse(s.cfg.NextAuthURL)
	if err != nil || !base.IsAbs() || base.Host == "" {
		return nil, fmt.Errorf("oidclogin: NEXTAUTH_URL is invalid")
	}
	base.Path = nextAuthCallbackPath
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	return base, nil
}

func readScopes(raw []byte) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return []string{"openid", "email", "profile"}
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return []string{"openid", "email", "profile"}
	}
	scopes := make([]string, 0, len(values))
	for _, value := range values {
		var scope string
		// Non-string entries are dropped; a string keeps its original
		// whitespace, order and duplicates. A blank string is filtered.
		if err := json.Unmarshal(value, &scope); err != nil {
			continue
		}
		if strings.TrimSpace(scope) != "" {
			scopes = append(scopes, scope)
		}
	}
	if len(scopes) == 0 {
		return []string{"openid", "email", "profile"}
	}
	return scopes
}

func stateCacheKey(state string) string { return stateCacheKeyPrefix + state }

func hashOpaqueToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomHex(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func randomBase64URL(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func sha256Base64URL(value string) string {
	sum := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func newUUID() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16]), nil
}

func stringPointer(value string) *string { return &value }
