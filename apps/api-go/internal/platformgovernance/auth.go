package platformgovernance

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// requiredPermission is the single permission every platform governance
// settings route requires. Human permission sets always come from the MySQL
// membership re-derivation inside authhttp, never from JWT claims.
const requiredPermission = "settings.manage"

// machineActorPrefix is the user-id prefix produced by authenticateMachine.
// SystemSetting.updatedById and AuditLog.actorId are foreign keys into User(id),
// so a machine identity must be written as NULL instead of "machine:<id>".
const machineActorPrefix = "machine:"

// Authenticator resolves the caller identity for every platform governance
// settings route. It wraps the shared authhttp chain (human users) and adds the
// mtk_ machine-token path, which authhttp deliberately rejects.
type Authenticator struct {
	chain *authhttp.Authenticator
	db    *sql.DB
}

// NewAuthenticator wires the human chain and the machine-token lookup pool.
func NewAuthenticator(chain *authhttp.Authenticator, db *sql.DB) *Authenticator {
	return &Authenticator{chain: chain, db: db}
}

// authorize runs the full authentication and permission chain.
//
// On failure it writes the contract-equivalent error and returns nil, so the
// caller must return immediately. The failure order matches NestJS:
// authentication (401) before permission (403), fail-closed on Redis/MySQL
// errors.
func (a *Authenticator) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	return a.Authorize(w, r, requiredPermission)
}

// Authorize runs the same chain for an arbitrary permission. The settings
// diagnostics batch reuses it for items.read (geocode) and settings.manage (the
// other six routes) instead of rebuilding a second machine-token lookup.
func (a *Authenticator) Authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
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

	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// RequirePlatformAdmin runs assertPlatformAdmin and writes the contract error
// itself. It returns false when the caller must stop.
func (a *Authenticator) RequirePlatformAdmin(w http.ResponseWriter, r *http.Request, actorID string) bool {
	if err := a.assertPlatformAdmin(r.Context(), actorID); err != nil {
		writeServiceError(w, r, err)
		return false
	}
	return true
}

// NullableActorID exposes the machine-to-NULL projection for the settings
// diagnostics audit rows.
func NullableActorID(actorID string) *string { return nullableActorID(actorID) }

// machineTokenPermissions is the typed shape of MachineAccessToken.permissions.
// Only string entries are kept; anything else is ignored, exactly like the
// permission list flattening used by the other Go domains.
type machineTokenPermissions []string

// authenticateMachine mirrors the machine-token path used by the other Go
// domains: SHA-256 of the raw token looked up against
// MachineAccessToken.tokenHash, joined to Org.isActive, rejecting revoked,
// expired or inactive tokens, refreshing lastUsedAt, and returning the identity
// "machine:<tokenId>" with the token row's own orgId and permissions.
func (a *Authenticator) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if a == nil || a.db == nil {
		return nil, errNoDatabase
	}
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var rawPermissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := a.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &rawPermissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &httpError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, &httpError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	_, _ = a.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, nowMillis(), id)

	var permissions machineTokenPermissions
	if len(rawPermissions) > 0 {
		if err := json.Unmarshal(rawPermissions, &permissions); err != nil {
			// A non-array permissions document grants nothing; it never becomes
			// a wildcard.
			permissions = nil
		}
	}
	return authhttp.NewIdentity(machineActorPrefix+id, orgID, permissions), nil
}

// assertPlatformAdmin mirrors PlatformAccessService.assertPlatformAdmin: these
// settings rows are global, so only a platform admin may change them.
//
// Machine tokens can never satisfy the check because GlobalRoleAssignment.userId
// is a foreign key into User(id) and machine ids are not user rows, so the Go
// implementation short-circuits to the same 403 instead of issuing a query that
// cannot match.
func (a *Authenticator) assertPlatformAdmin(ctx context.Context, actorID string) error {
	if actorIsMachine(actorID) {
		return forbidden()
	}
	if a == nil || a.db == nil {
		return errNoDatabase
	}
	var id string
	err := a.db.QueryRowContext(ctx,
		"SELECT id FROM GlobalRoleAssignment WHERE userId = ? AND role = 'platform_admin' LIMIT 1",
		actorID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return forbidden()
	}
	if err != nil {
		return err
	}
	return nil
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

// actorIsMachine reports whether the actor id belongs to a machine token rather
// than a human user.
func actorIsMachine(actorID string) bool {
	return actorID == "" || strings.HasPrefix(actorID, machineActorPrefix)
}

// nullableActorID converts an actor id into the value that may be written to the
// nullable User foreign keys. Machine tokens and empty ids become SQL NULL:
// writing "machine:<tokenId>" would violate the MySQL foreign key (1452) and
// surface as an HTTP 500.
func nullableActorID(actorID string) *string {
	if actorIsMachine(actorID) {
		return nil
	}
	return &actorID
}
