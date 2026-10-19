package gdeltsnapshot

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

// refreshPath is the exact route this handler owns. The controller declares it
// under the "system-settings/situation-monitor" prefix with the global "api"
// prefix.
const refreshPath = "/api/system-settings/situation-monitor/external-snapshot/refresh"

// requiredPermission is the controller-level @Permissions("settings.manage").
const requiredPermission = "settings.manage"

// machineTokenPrefix marks the mtk_ machine credentials that JwtAuthGuard
// accepts alongside human JWTs.
const machineTokenPrefix = "mtk_"

// errInvalidMachineToken maps to the NestJS UnauthorizedException.
var errInvalidMachineToken = errors.New("gdeltsnapshot: invalid machine token")

// Handler serves the forced-refresh route. Identity always comes from the
// authentication chain or the machine-token lookup; no query parameter or body
// field participates.
type Handler struct {
	auth    *authhttp.Authenticator
	db      *sql.DB
	service *Service
}

// NewHandler wires the shared authenticator, the machine-token pool and the
// snapshot service.
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, service *Service) *Handler {
	return &Handler{auth: auth, db: db, service: service}
}

// ServeHTTP answers POST on the exact refresh path with HTTP 201 and the status
// summary. Any other method or path is a 404, which the routing table prevents
// from reaching this handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if r.URL.Path != refreshPath || r.Method != http.MethodPost {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	if h.authorize(w, r) == nil {
		return
	}

	summary, err := h.service.ForceRefresh(r.Context())
	if err != nil {
		log.Printf("gdeltsnapshot: forced refresh failed: %v", err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	body, err := marshalJSON(summary)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(body)
}

// authorize mirrors the NestJS guard order: 401 before 403, the human chain or
// the machine-token lookup first, then the settings.manage check.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}

	var identity *authhttp.Identity
	if strings.HasPrefix(raw, machineTokenPrefix) {
		resolved, err := h.authenticateMachine(r.Context(), raw)
		if err != nil {
			switch {
			case errors.Is(err, errInvalidMachineToken):
				authhttp.WriteUnauthorized(w, r, "Invalid machine token")
			case errors.Is(err, errNoDatabase):
				authhttp.WriteDatabaseFailure(w, r)
			default:
				authhttp.WriteInternalFailure(w, r)
			}
			return nil
		}
		identity = resolved
	} else {
		if h.auth == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = h.auth.Authenticate(w, r)
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
// Only string entries grant anything, exactly like the NestJS filter.
type machineTokenPermissions []string

// authenticateMachine mirrors MachineTokenService.validate: SHA-256 of the raw
// token looked up against MachineAccessToken.tokenHash joined to Org.isActive,
// rejecting revoked, expired and inactive-organization rows, refreshing
// lastUsedAt best-effort and returning the machine identity with the row's own
// permissions. Without this path an mtk_ token with settings.manage would work
// on NestJS but not on Go.
func (h *Handler) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if h.db == nil {
		return nil, errNoDatabase
	}
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var rawPermissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := h.db.QueryRowContext(ctx, `
SELECT token.id, token.orgId, token.permissions, token.expiresAt, token.revokedAt, org.isActive
FROM MachineAccessToken token
JOIN Org org ON org.id = token.orgId
WHERE token.tokenHash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&id, &orgID, &rawPermissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errInvalidMachineToken
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(time.Now())) {
		return nil, errInvalidMachineToken
	}
	// lastUsedAt is best-effort in NestJS too; a failed refresh never fails the
	// request.
	_, _ = h.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`,
		time.Now().UTC().Truncate(time.Millisecond), id)

	permissions := machineTokenPermissions{}
	if len(rawPermissions) > 0 {
		if err := json.Unmarshal(rawPermissions, &permissions); err != nil {
			// A non-array permissions document grants nothing.
			permissions = nil
		}
	}
	return authhttp.NewIdentity("machine:"+id, orgID, permissions), nil
}

// rawBearer extracts the raw Authorization token. It deliberately does not
// filter mtk_ tokens because this handler resolves them itself.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
