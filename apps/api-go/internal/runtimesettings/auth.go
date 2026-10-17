package runtimesettings

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// requiredPermission is the single permission every runtime/governance settings
// route requires. Human permission sets always come from the MySQL membership
// re-derivation inside authhttp, never from JWT claims.
const requiredPermission = "settings.manage"

// Authenticator resolves the caller identity for every runtime settings route.
// It wraps the shared authhttp chain (human users) and adds the mtk_ machine
// token path, which authhttp deliberately rejects.
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
// caller must return immediately. Failure order matches NestJS: authentication
// (401) before permission (403), and fail-closed on Redis/MySQL errors.
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

// assertPlatformAdmin mirrors PlatformAccessService.assertPlatformAdmin: the
// audit-log retention setting is global, so only a platform admin may change
// it. Machine tokens can never satisfy the check because
// GlobalRoleAssignment.userId is a foreign key into User(id) and machine ids
// are not user rows.
func (a *Authenticator) assertPlatformAdmin(ctx context.Context, actorID string) error {
	if a == nil || a.db == nil {
		return errNoDatabase
	}
	if actorIsMachine(actorID) {
		return &httpError{status: http.StatusForbidden, message: "Platform admin access required"}
	}
	var id string
	err := a.db.QueryRowContext(ctx,
		"SELECT id FROM GlobalRoleAssignment WHERE userId = ? AND role = 'platform_admin' LIMIT 1",
		actorID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return &httpError{status: http.StatusForbidden, message: "Platform admin access required"}
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

// httpError is a status-coded failure that the handler maps onto the
// GlobalExceptionFilter response shapes. code/detail are only used by the 409
// conflict payloads that carry a safe error code.
type httpError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status == http.StatusConflict && coded.code != "":
			authhttp.WriteCodedConflict(w, r, coded.code, coded.message, coded.detail)
		case coded.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	if errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("runtimesettings: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
