package socketio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

// AuthSession is the identity material established for one namespace socket.
type AuthSession struct {
	UserID    string
	OrgID     string
	JTI       string
	ExpiresAt time.Time
}

// AuthError is a business rejection of the presented identity: a missing or
// invalid token, a revoked token, or an authz membership/permission rejection.
// Transports map it to the namespace error event and disconnect(true). Any
// other error returned by Authenticate is an infrastructure failure (Redis or
// MySQL query error) and must be handled as such.
type AuthError struct {
	Message string
}

func (e *AuthError) Error() string { return e.Message }

// Authenticator reuses the api-go authn/authz chain for Socket.IO handshakes. A
// Socket.IO handshake does not carry the Authorization header on every client,
// so the token is resolved explicitly from the handshake request and the CONNECT
// auth payload.
type Authenticator struct {
	verifier  *authn.Verifier
	blacklist authn.Blacklist
	authz     authz.Repository
}

// NewAuthenticator wires the shared authentication dependencies. The caller
// keeps ownership of the underlying clients.
func NewAuthenticator(verifier *authn.Verifier, blacklist authn.Blacklist, repo authz.Repository) *Authenticator {
	return &Authenticator{verifier: verifier, blacklist: blacklist, authz: repo}
}

// Authenticate verifies rawToken and re-derives the identity from the database.
//
// Error contract:
//   - *AuthError means the identity was rejected (missing/invalid/revoked token
//     or an authz.Rejection). The message matches the NestJS gateway wording:
//     "Missing auth token", "Invalid token", "Token revoked" or the authz
//     rejection message.
//   - any other error is an infrastructure failure (Redis/MySQL lookup); callers
//     must not treat it as a rejection.
func (a *Authenticator) Authenticate(ctx context.Context, rawToken string) (AuthSession, error) {
	if strings.TrimSpace(rawToken) == "" {
		return AuthSession{}, &AuthError{Message: "Missing auth token"}
	}
	token, err := a.verifier.Verify(rawToken)
	if err != nil {
		return AuthSession{}, &AuthError{Message: "Invalid token"}
	}
	if token.JTI != "" {
		revoked, revokeErr := a.blacklist.Revoked(ctx, token.JTI)
		if revokeErr != nil {
			return AuthSession{}, fmt.Errorf("blacklist query failed: %w", revokeErr)
		}
		if revoked {
			return AuthSession{}, &AuthError{Message: "Token revoked"}
		}
	}
	authorization, authzErr := a.authz.Authorize(ctx, token.Subject, token.OrgID)
	if authzErr != nil {
		var rejection *authz.Rejection
		if errors.As(authzErr, &rejection) {
			return AuthSession{}, &AuthError{Message: rejection.Message}
		}
		return AuthSession{}, fmt.Errorf("authorization query failed: %w", authzErr)
	}
	return AuthSession{
		UserID:    authorization.UserID,
		OrgID:     authorization.OrgID,
		JTI:       token.JTI,
		ExpiresAt: token.ExpiresAt,
	}, nil
}

// TokenSource identifies one bearer-token carrier inspected during the
// handshake. The NestJS gateways use two different precedence orders (see
// ExtractTokenInOrder), so the transport chooses the order per namespace.
type TokenSource int

const (
	// TokenFromHeader is the HTTP Authorization: Bearer header.
	TokenFromHeader TokenSource = iota
	// TokenFromAuth is the Socket.IO CONNECT auth payload: {"token":"..."}.
	TokenFromAuth
	// TokenFromQuery is the Engine.IO handshake query string: ?token=...
	TokenFromQuery
)

// ExtractToken resolves the access token with the NotificationsGateway
// precedence (#124): Authorization Bearer header, then the Socket.IO CONNECT
// auth payload, then the "token" query parameter. Other namespaces use
// ExtractTokenInOrder with their own NestJS order.
func ExtractToken(request *http.Request, authPayload []byte) string {
	return ExtractTokenInOrder(request, authPayload, []TokenSource{
		TokenFromHeader,
		TokenFromAuth,
		TokenFromQuery,
	})
}

// ExtractTokenInOrder applies the NestJS per-namespace token precedence. The
// first non-empty token in order wins:
//   - /newsnow, /queue, /situation-monitor: header, auth, query;
//   - /ops, /quality: auth, query, header.
//
// A nil request makes the header/query sources empty (useful for tests and for
// callers that hand over only the auth payload).
func ExtractTokenInOrder(request *http.Request, authPayload []byte, order []TokenSource) string {
	for _, source := range order {
		switch source {
		case TokenFromHeader:
			if token := tokenFromHeader(request); token != "" {
				return token
			}
		case TokenFromAuth:
			if token := tokenFromAuthPayload(authPayload); token != "" {
				return token
			}
		case TokenFromQuery:
			if token := tokenFromQuery(request); token != "" {
				return token
			}
		}
	}
	return ""
}

// tokenFromHeader parses "Authorization: Bearer <token>". The scheme match is
// case-insensitive, mirroring jsonwebtoken/passport usage in the gateways.
func tokenFromHeader(request *http.Request) string {
	if request == nil {
		return ""
	}
	header := strings.TrimSpace(request.Header.Get("Authorization"))
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// tokenFromQuery returns the first "token" query value. NestJS reads
// handshake.query.token[0] when the parameter repeats.
func tokenFromQuery(request *http.Request) string {
	if request == nil {
		return ""
	}
	values := request.URL.Query()["token"]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// tokenFromAuthPayload reads {"token": "..."} from the CONNECT auth object.
func tokenFromAuthPayload(authPayload []byte) string {
	if len(authPayload) == 0 {
		return ""
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(authPayload, &payload); err != nil {
		return ""
	}
	return payload.Token
}

// ResolveClientIP returns the client address used for rate-limit and backoff
// keys. X-Forwarded-For is only honored when the deployment trusts its proxy
// chain (TRUST_PROXY configured), matching resolveSocketClientIp; the
// IPv4-mapped IPv6 prefix is stripped so Go and NestJS produce identical Redis
// keys.
func ResolveClientIP(request *http.Request, trustProxy bool) string {
	if request == nil {
		return ""
	}
	ip := ""
	if trustProxy {
		if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
			ip = strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	if ip == "" {
		host, _, err := net.SplitHostPort(request.RemoteAddr)
		if err != nil {
			host = request.RemoteAddr
		}
		ip = host
	}
	return strings.TrimPrefix(strings.TrimSpace(ip), "::ffff:")
}

// RequestOrigin normalizes the handshake Origin header (falling back to
// Referer) to scheme://host for the CORS allow-list check.
func RequestOrigin(request *http.Request) string {
	if request == nil {
		return ""
	}
	raw := strings.TrimSpace(request.Header.Get("Origin"))
	if raw == "" {
		raw = strings.TrimSpace(request.Header.Get("Referer"))
	}
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return raw
	}
	return parsed.Scheme + "://" + parsed.Host
}
