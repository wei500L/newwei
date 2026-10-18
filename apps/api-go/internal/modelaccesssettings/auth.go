package modelaccesssettings

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// requiredPermission is the single permission every admin route in this batch
// requires. Human permission sets always come from the MySQL membership
// re-derivation inside authhttp, never from JWT claims.
const requiredPermission = "settings.manage"

// Authenticator resolves the caller identity for routes 1-8. It wraps the shared
// authhttp chain (human users) and adds the mtk_ machine-token path, which
// authhttp deliberately rejects.
type Authenticator struct {
	chain    *authhttp.Authenticator
	identity identityStore
}

// NewAuthenticator wires the human chain and the machine-token lookup.
func NewAuthenticator(chain *authhttp.Authenticator, db *sql.DB) *Authenticator {
	return &Authenticator{chain: chain, identity: &mysqlIdentity{db: db}}
}

// newAuthenticatorWithIdentity exists for the unit suite.
func newAuthenticatorWithIdentity(chain *authhttp.Authenticator, identity identityStore) *Authenticator {
	return &Authenticator{chain: chain, identity: identity}
}

// authorize runs the full authentication and permission chain.
//
// Failure order matches NestJS exactly: authentication (401) before permission
// (403), and fail-closed on Redis/MySQL errors. On failure it writes the
// contract-equivalent error and returns nil, so the caller must return
// immediately.
//
// The platform admin gate is NOT applied here: NestJS keeps it inside the service,
// which means the DTO validation (the ValidationPipe) runs first. The service
// methods call assertPlatformAdmin themselves.
func (a *Authenticator) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}

	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := a.authenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if a == nil || a.chain == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = a.chain.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}

	if !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return nil
	}
	return identity
}

// machineTokenPermissions is the typed shape of MachineAccessToken.permissions.
// Only string entries are kept; anything else is ignored.
type machineTokenPermissions []string

// authenticateMachine mirrors the machine-token path used by the other Go
// domains: SHA-256 of the raw token looked up against MachineAccessToken
// .tokenHash, joined to Org.isActive, rejecting revoked, expired or inactive
// tokens, refreshing lastUsedAt, and returning the identity "machine:<tokenId>"
// with the token row's own orgId and permissions.
//
// A machine identity can hold settings.manage, which satisfies the permission
// layer — it can therefore read routes 1 and 4. It can never satisfy the platform
// admin gate, so all six writes answer 403 and the "machine:<id>" value never
// reaches SystemSetting.updatedById.
func (a *Authenticator) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if a == nil || a.identity == nil {
		return nil, errNoDatabase
	}
	sum := sha256.Sum256([]byte(token))
	record, err := a.identity.MachineToken(ctx, hex.EncodeToString(sum[:]))
	if errors.Is(err, errMachineTokenNotFound) {
		return nil, &httpError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	if err != nil {
		return nil, err
	}
	if record.Revoked || !record.OrgActive || record.Expired {
		return nil, &httpError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	// lastUsedAt is refreshed best-effort, like the NestJS `.catch(() => undefined)`.
	_ = a.identity.TouchMachineToken(ctx, record.ID)
	return authhttp.NewIdentity(machineActorPrefix+record.ID, record.OrgID, record.Permissions), nil
}

// rawBearer extracts the raw token from an Authorization header. It does not
// filter mtk_ tokens (unlike authn.ExtractBearerToken) because this package
// handles them itself. The human branch is still authenticated end to end by the
// shared chain.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
