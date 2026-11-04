package authfactors

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Authenticator resolves the caller identity for every route in this unit. It
// wraps the shared authhttp chain (human users: JWT verification, Redis
// access-token blacklist, MySQL membership and permission re-derivation) and
// adds the mtk_ machine token path, which authhttp deliberately rejects.
type Authenticator struct {
	chain *authhttp.Authenticator
	db    *sql.DB
}

// NewAuthenticator wires the human chain and the machine-token lookup pool.
func NewAuthenticator(chain *authhttp.Authenticator, db *sql.DB) *Authenticator {
	return &Authenticator{chain: chain, db: db}
}

// authorize runs the full authentication chain and, when permission is
// non-empty, the permission check.
//
// On failure it writes the contract-equivalent error and returns nil, so the
// caller must return immediately. The order matches NestJS exactly:
// authentication (401) before permission (403), and fail-closed on Redis or
// MySQL errors. The MFA routes pass an empty permission because they are
// `@AllowAuthenticated()`; the OIDC routes pass "settings.manage".
//
// A machine token never receives any privilege beyond the permissions stored on
// its own row, and its org id comes from that row — never from the request.
func (a *Authenticator) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if a == nil || a.chain == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	return a.chain.AuthenticateWithMachine(w, r, permission)
}

// machineTokenPermissions is the typed shape of MachineAccessToken.permissions.
// Only string entries are kept; anything else is ignored and never becomes a
// wildcard.
type machineTokenPermissions []string

// authenticateMachine mirrors the machine-token path used by every other Go
// domain: SHA-256 of the raw token looked up against
// MachineAccessToken.tokenHash, joined to Org.isActive, rejecting revoked,
// expired or inactive tokens, refreshing lastUsedAt, and returning the identity
// "machine:<tokenId>" with the token row's own orgId and permissions.
func (a *Authenticator) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if a == nil || a.db == nil {
		return nil, errNoDatabase
	}
	identity, err := authhttp.NewMachineResolver(a.db, nil).Resolve(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, &httpError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	return identity, err
}

// rawBearer extracts the raw token from an Authorization header. It does not
// filter mtk_ tokens (unlike authn.ExtractBearerToken) because this package
// handles them itself.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
