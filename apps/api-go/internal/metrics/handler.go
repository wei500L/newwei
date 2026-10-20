package metrics

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

const (
	// metricsPath is the single scraped path.
	metricsPath = "/api/metrics"
	// permissionMetricsRead is @Permissions("metrics.read") on the controller.
	permissionMetricsRead = "metrics.read"
	// permissionDeniedMessage is PlatformAccessService.assertPlatformAdmin's
	// message.
	permissionDeniedMessage = "Platform admin access required"
	// machineActorPrefix is the identity prefix MachineTokenService.validate
	// uses. It cannot satisfy a GlobalRoleAssignment lookup.
	machineActorPrefix = "machine:"
)

// platformDecision is the resolvePlatformMetricsAccess result.
type platformDecision int

const (
	// decisionAbsent means the bearer is not a MachineAccessToken.
	decisionAbsent platformDecision = iota
	// decisionMachineAllowed means the token's creator is currently a platform
	// administrator.
	decisionMachineAllowed
	// decisionMachineDenied means a machine token exists but is unusable or its
	// creator is not a platform administrator.
	decisionMachineDenied
)

// Handler serves GET /api/metrics.
type Handler struct {
	auth     *authhttp.Authenticator
	db       *sql.DB
	registry *Registry
	now      func() time.Time
}

// NewHandler builds the scrape handler. db is required for the platform-admin
// and machine-token checks.
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, registry *Registry) *Handler {
	if registry == nil {
		registry = defaultRegistry
	}
	return &Handler{auth: auth, db: db, registry: registry, now: time.Now}
}

// ServeHTTP authenticates, checks metrics.read, resolves the platform-admin
// decision and writes the Prometheus text.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != metricsPath {
		http.NotFound(w, r)
		return
	}
	if h == nil || h.db == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	decision, err := h.resolvePlatformMetricsAccess(r.Context(), rawBearer(r))
	if err != nil {
		log.Printf("metrics: platform metrics access: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if decision == decisionMachineDenied {
		authhttp.WriteHTTPException(w, r, http.StatusForbidden, permissionDeniedMessage)
		return
	}
	if decision != decisionMachineAllowed {
		allowed, err := h.isPlatformAdmin(r.Context(), identity.UserID)
		if err != nil {
			log.Printf("metrics: platform admin lookup: %v", err)
			authhttp.WriteDatabaseFailure(w, r)
			return
		}
		if !allowed {
			authhttp.WriteHTTPException(w, r, http.StatusForbidden, permissionDeniedMessage)
			return
		}
	}

	body := h.registry.Render()
	w.Header().Set("Content-Type", ContentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

// authorize mirrors the other migrated admin routes: Bearer required, mtk_
// tokens through the machine lookup, everything else through the JWT verifier,
// then the metrics.read permission.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.authenticateMachine(r.Context(), raw)
		if err != nil {
			if status, message, ok := machineStatus(err); ok {
				authhttp.WriteHTTPException(w, r, status, message)
			} else {
				log.Printf("metrics: machine token: %v", err)
				authhttp.WriteDatabaseFailure(w, r)
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
	if !identity.HasPermission(permissionMetricsRead) {
		authhttp.WriteForbidden(w, r, []string{permissionMetricsRead})
		return nil
	}
	return identity
}

// authenticateMachine mirrors MachineTokenService.validate: SHA-256 tokenHash
// lookup joined with an active organization, lastUsedAt bump, permissions from
// the row only.
func (h *Handler) authenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	sum := sha256.Sum256([]byte(token))
	var id, orgID string
	var permissions []byte
	var expires, revoked sql.NullTime
	var active int
	err := h.db.QueryRowContext(ctx, `
SELECT t.id, t.orgId, t.permissions, t.expiresAt, t.revokedAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:])).Scan(
		&id, &orgID, &permissions, &expires, &revoked, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &machineError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid || active == 0 || (expires.Valid && !expires.Time.After(h.now())) {
		return nil, &machineError{status: http.StatusUnauthorized, message: "Invalid machine token"}
	}
	_, _ = h.db.ExecContext(ctx, `UPDATE MachineAccessToken SET lastUsedAt = ? WHERE id = ?`, h.now().UTC().Truncate(time.Millisecond), id)
	return authhttp.NewIdentity(machineActorPrefix+id, orgID, permissionList(permissions)), nil
}

// resolvePlatformMetricsAccess mirrors MachineTokenService.resolvePlatformMetricsAccess.
func (h *Handler) resolvePlatformMetricsAccess(ctx context.Context, bearer string) (platformDecision, error) {
	if bearer == "" {
		return decisionAbsent, nil
	}
	sum := sha256.Sum256([]byte(bearer))
	var createdBy sql.NullString
	var expires, revoked sql.NullTime
	var active int
	err := h.db.QueryRowContext(ctx, `
SELECT t.createdById, t.revokedAt, t.expiresAt, o.isActive
FROM MachineAccessToken t
JOIN Org o ON o.id = t.orgId
WHERE t.tokenHash = ?`, hex.EncodeToString(sum[:])).Scan(&createdBy, &revoked, &expires, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return decisionAbsent, nil
	}
	if err != nil {
		return decisionAbsent, err
	}
	if revoked.Valid || (expires.Valid && !expires.Time.After(h.now())) || active == 0 || !createdBy.Valid {
		return decisionMachineDenied, nil
	}
	allowed, err := h.isPlatformAdmin(ctx, createdBy.String)
	if err != nil {
		return decisionAbsent, err
	}
	if allowed {
		return decisionMachineAllowed, nil
	}
	return decisionMachineDenied, nil
}

// isPlatformAdmin mirrors PlatformAccessService.isPlatformAdmin.
func (h *Handler) isPlatformAdmin(ctx context.Context, userID string) (bool, error) {
	if userID == "" || strings.HasPrefix(userID, machineActorPrefix) {
		return false, nil
	}
	var id string
	err := h.db.QueryRowContext(ctx,
		"SELECT id FROM GlobalRoleAssignment WHERE userId = ? AND role = 'platform_admin' LIMIT 1",
		userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// machineError carries the machine-token 401 message.
type machineError struct {
	status  int
	message string
}

func (e *machineError) Error() string { return e.message }

// machineStatus extracts the machine-token status.
func machineStatus(err error) (int, string, bool) {
	var target *machineError
	if errors.As(err, &target) {
		return target.status, target.message, true
	}
	return 0, "", false
}

// permissionList reads the JSON permissions array; a non-array grants nothing.
func permissionList(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var parsed []any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	out := make([]string, 0, len(parsed))
	for _, entry := range parsed {
		if text, ok := entry.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// rawBearer extracts the Bearer token without a fallback.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
