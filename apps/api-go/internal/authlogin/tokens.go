package authlogin

import (
	"context"
	"regexp"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// tokenSigner signs access tokens and owns the two configured lifetimes. It is
// the only place that touches JWT_SECRET or produces token material.
type tokenSigner struct {
	secret           []byte
	issuer           string
	audience         string
	accessExpiresIn  string
	refreshExpiresIn string
}

func newTokenSigner(cfg Config) *tokenSigner {
	return &tokenSigner{
		secret:           []byte(cfg.JWTSecret),
		issuer:           cfg.JWTIssuer,
		audience:         cfg.JWTAudience,
		accessExpiresIn:  cfg.AccessExpiresIn,
		refreshExpiresIn: cfg.RefreshExpiresIn,
	}
}

// accessTokenClaims is the signed payload. sub/orgId/permissions are the claims
// the rest of the system reads; iss/aud/exp/iat/jti come from RegisteredClaims.
// Permission claims are advisory only: every authorization decision re-derives
// them from MySQL.
type accessTokenClaims struct {
	OrgID       string   `json:"orgId"`
	Permissions []string `json:"permissions"`
	jwt.RegisteredClaims
}

// parseTimespan mirrors EnvService's numeric+[smhd] parser. A malformed value is
// the same 400 the NestJS signing path would answer with.
func parseTimespan(value string) (time.Duration, error) {
	match := timespanRe.FindStringSubmatch(value)
	if match == nil {
		return 0, badRequest("Invalid timespan format")
	}
	var amount int64
	for _, digit := range match[1] {
		amount = amount*10 + int64(digit-'0')
	}
	var unit time.Duration
	switch match[2] {
	case "s":
		unit = time.Second
	case "m":
		unit = time.Minute
	case "h":
		unit = time.Hour
	case "d":
		unit = 24 * time.Hour
	default:
		unit = time.Second
	}
	return time.Duration(amount) * unit, nil
}

var timespanRe = regexp.MustCompile(`^(\d+)([smhd])$`)

// signAccessToken issues the HS256 access token with the same claim set NestJS
// signs: sub, orgId, permissions, iat, exp, iss, aud and a UUID jti. The jti is
// what makes the token revocable through the shared access-token blacklist.
func (s *Service) signAccessToken(userID, orgID string, permissions []string) (issuedAccessToken, error) {
	expiresIn, err := parseTimespan(s.signer.accessExpiresIn)
	if err != nil {
		return issuedAccessToken{}, err
	}
	expiresInSeconds := int64(expiresIn / time.Second)
	if expiresInSeconds < 1 {
		expiresInSeconds = 1
	}
	jti, err := newUUIDv4()
	if err != nil {
		return issuedAccessToken{}, err
	}
	now := time.Now()
	claims := accessTokenClaims{
		OrgID:       orgID,
		Permissions: permissions,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			Issuer:    s.signer.issuer,
			Audience:  jwt.ClaimStrings{s.signer.audience},
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Duration(expiresInSeconds) * time.Second)),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        jti,
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.signer.secret)
	if err != nil {
		return issuedAccessToken{}, err
	}
	return issuedAccessToken{Token: signed, ExpiresAt: claims.ExpiresAt.Time}, nil
}

// accessTokenExpiresInSeconds renders the `expiresIn` field both NestJS and the
// web client expect: whole seconds remaining, floored at 900 when the claim is
// somehow absent.
func accessTokenExpiresInSeconds(issued issuedAccessToken) int {
	if issued.ExpiresAt.IsZero() {
		return 900
	}
	remaining := int(issued.ExpiresAt.Sub(time.Now()) / time.Second)
	if remaining < 0 {
		return 0
	}
	return remaining
}

// refreshTokenPattern is NestJS's parseRefreshToken pattern, kept byte-identical
// so both implementations accept exactly the same token shapes: the current
// tokenId[.orgId].secret form and the legacy tokenId.secret form.
var refreshTokenPattern = regexp.MustCompile(
	`^(?P<tokenId>[A-Za-z0-9_-]+)(?:\.(?P<orgId>[A-Za-z0-9_-]+))?\.(?P<secret>[A-Fa-f0-9]{32,128})$`)

// parseRefreshToken splits a refresh token into its three parts. A malformed
// token is the shared 401 "Invalid refresh token" — never a 400, because the
// credential's shape must not be distinguishable from a wrong credential.
func parseRefreshToken(refreshToken string) (refreshCredential, error) {
	match := refreshTokenPattern.FindStringSubmatch(refreshToken)
	if match == nil {
		return refreshCredential{}, unauthorized(invalidRefreshTokenMessage)
	}
	tokenID := match[refreshTokenPattern.SubexpIndex("tokenId")]
	secret := match[refreshTokenPattern.SubexpIndex("secret")]
	if tokenID == "" || secret == "" {
		return refreshCredential{}, unauthorized(invalidRefreshTokenMessage)
	}
	return refreshCredential{
		TokenID: tokenID,
		OrgID:   match[refreshTokenPattern.SubexpIndex("orgId")],
		Secret:  secret,
	}, nil
}

// signRefreshToken creates and persists one refresh token.
//
// The token embeds a fresh UUID id, the organization and a 32-byte random
// secret; only a cost-10 bcrypt hash of the secret is stored, so a database read
// cannot reconstruct a usable credential. The stored id is what the atomic
// revoke-on-rotate claim and the shared revocation list key on.
func (s *Service) signRefreshToken(ctx context.Context, userID, orgID string, ipAddress, userAgent *string) (issuedRefreshToken, error) {
	if s.db == nil {
		return issuedRefreshToken{}, errNoDatabase
	}
	lifetime, err := parseTimespan(s.signer.refreshExpiresIn)
	if err != nil {
		return issuedRefreshToken{}, err
	}
	tokenID, err := newUUIDv4()
	if err != nil {
		return issuedRefreshToken{}, err
	}
	secret, err := randomHex(refreshSecretBytes)
	if err != nil {
		return issuedRefreshToken{}, err
	}
	tokenHash, err := accountsecurity.HashLoginPassword(secret)
	if err != nil {
		return issuedRefreshToken{}, err
	}
	now := nowMillis()
	expiresAt := now.Add(lifetime)
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO `RefreshToken` (`id`, `userId`, `tokenHash`, `expiresAt`, `createdAt`, `revokedAt`, `ipAddress`, `userAgent`) "+
			"VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
		tokenID, userID, tokenHash, expiresAt, now, osNullString(ipAddress), osNullString(userAgent)); err != nil {
		return issuedRefreshToken{}, dbWrap(err)
	}
	token := tokenID + "." + secret
	if orgID != "" {
		token = tokenID + "." + orgID + "." + secret
	}
	return issuedRefreshToken{Token: token, ExpiresAt: expiresAt}, nil
}

// refreshGraceCacheKey is auth:refresh:<tokenId>:<sha256(secret)> so the grace
// window is scoped to the exact credential, not just its id.
func refreshGraceCacheKey(tokenID, secret string) string {
	return refreshGraceCacheKeyPrefix + tokenID + ":" + hashSHA256Hex(secret)
}
