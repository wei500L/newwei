package notificationssocket

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

// authenticator reuses the existing authn/authz chain. A Socket.IO handshake
// does not have a normal Authorization header on every client, so the token
// is passed in explicitly after the CONNECT packet is decoded.
type authenticator struct {
	verifier  *authn.Verifier
	blacklist authn.Blacklist
	authz     authz.Repository
}

type session struct {
	userID    string
	orgID     string
	jti       string
	expiresAt time.Time
}

type authError struct {
	message string
}

func (e *authError) Error() string { return e.message }

func (a *authenticator) authenticate(ctx context.Context, rawToken string) (session, error) {
	if strings.TrimSpace(rawToken) == "" {
		return session{}, &authError{message: "Missing auth token"}
	}
	identity, failure := authhttp.ResolveHandshakeToken(ctx, a.verifier, a.blacklist, a.authz, rawToken)
	if failure != nil {
		switch failure.Status {
		case http.StatusUnauthorized:
			switch failure.Message {
			case "Unauthorized":
				return session{}, &authError{message: "Invalid token"}
			case "Access token revoked":
				return session{}, &authError{message: "Token revoked"}
			default:
				return session{}, &authError{message: failure.Message}
			}
		case http.StatusInternalServerError:
			return session{}, fmt.Errorf("blacklist query failed: %s", failure.Message)
		default:
			return session{}, fmt.Errorf("authorization query failed: %s", failure.Message)
		}
	}
	return session{
		userID:    identity.UserID,
		orgID:     identity.OrgID,
		jti:       identity.TokenID(),
		expiresAt: identity.TokenExpiresAt(),
	}, nil
}

// extractToken mirrors NotificationsGateway.extractToken precedence:
// Authorization header, then handshake auth, then query token.
func extractToken(request *http.Request, authPayload []byte) string {
	if header := request.Header.Get("Authorization"); header != "" {
		trimmed := strings.TrimSpace(header)
		if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "bearer ") {
			if token := strings.TrimSpace(trimmed[7:]); token != "" {
				return token
			}
		}
	}
	if len(authPayload) > 0 {
		var payload struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(authPayload, &payload); err == nil && payload.Token != "" {
			return payload.Token
		}
	}
	if token := request.URL.Query().Get("token"); token != "" {
		return token
	}
	return ""
}

// resolveClientIP mirrors resolveSocketClientIp: X-Forwarded-For is only
// honored when TRUST_PROXY is configured, and the IPv4-mapped prefix is
// removed so the Redis rate-limit keys match NestJS.
func resolveClientIP(request *http.Request, trustProxy bool) string {
	ip := ""
	if trustProxy {
		forwarded := request.Header.Get("X-Forwarded-For")
		if forwarded != "" {
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
	ip = strings.TrimSpace(ip)
	return strings.TrimPrefix(ip, "::ffff:")
}

func requestOrigin(request *http.Request) string {
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
