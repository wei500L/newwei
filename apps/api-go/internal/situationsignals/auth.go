package situationsignals

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// machineActorPrefix matches the identity shape the other Go domains and
// NestJS MachineTokenService.validate produce ("machine:<tokenId>").
const machineActorPrefix = "machine:"

// Authenticator resolves the caller for every situation monitor signal route.
//
// It wraps the shared authhttp chain (HS256 verification, Redis revocation
// list, MySQL membership re-derivation, never the JWT permission claims) and
// adds the mtk_ machine-token path that authhttp deliberately rejects.
type Authenticator struct {
	chain *authhttp.Authenticator
	db    *sql.DB
}

// NewAuthenticator wires the human chain and the machine-token lookup pool.
func NewAuthenticator(chain *authhttp.Authenticator, db *sql.DB) *Authenticator {
	return &Authenticator{chain: chain, db: db}
}

// MachineTokenPermissions is the typed shape of MachineAccessToken.permissions.
type MachineTokenPermissions []string

// authorize runs authentication and then the permission check for one route.
//
// Failure order matches NestJS (guards run before pipes): authentication (401)
// before permission (403), and fail-closed on Redis / MySQL errors. On failure
// it writes the contract-equivalent error and returns nil, so the caller must
// return immediately. A nil identity with no response written only happens when
// the request has already been answered.
func (a *Authenticator) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if a == nil || a.chain == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	return a.chain.AuthenticateWithMachine(w, r, permission)
}

// authenticateMachine mirrors MachineTokenService.validate: SHA-256 of the raw
// token looked up against MachineAccessToken.tokenHash, joined to Org.isActive,
// rejecting revoked, expired or inactive tokens, refreshing lastUsedAt, and
// returning the identity "machine:<tokenId>" with the token row's own orgId and
// permissions. The token's permissions are the only source of authority — the
// token row can never borrow a user's role.
func (a *Authenticator) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if a == nil || a.db == nil {
		return nil, errNoDatabase
	}
	identity, err := authhttp.NewMachineResolver(a.db, nil).Resolve(ctx, token)
	if errors.Is(err, authhttp.ErrInvalidMachineToken) {
		return nil, newStatus(http.StatusUnauthorized, "Invalid machine token")
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

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var status *statusError
	if errors.As(err, &status) {
		switch {
		case status.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, status.message)
		case status.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, status.status, status.message)
		}
		return
	}
	log.Printf("situationsignals: %v", err)
	// A missing pool or a connection-class failure is a dependency outage, not a
	// generic server error: NestJS surfaces Prisma connectivity failures as 503.
	if errors.Is(err, errNoDatabase) || unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}
