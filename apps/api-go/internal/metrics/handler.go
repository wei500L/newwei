package metrics

import (
	"context"
	"database/sql"
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
	machines *authhttp.MachineResolver
	registry *Registry
	now      func() time.Time
}

// NewHandler builds the scrape handler. db is required for the platform-admin
// and machine-token checks.
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, registry *Registry) *Handler {
	if registry == nil {
		registry = defaultRegistry
	}
	machines := (*authhttp.MachineResolver)(nil)
	if auth != nil {
		machines = auth.Machines()
	}
	if machines == nil {
		// The scrape handler is also exercised directly with only a DB handle
		// (integration test), so fall back to a resolver over the same pool.
		machines = authhttp.NewMachineResolver(db, nil)
	}
	return &Handler{auth: auth, db: db, machines: machines, registry: registry, now: time.Now}
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

// authorize accepts both human JWTs (through the shared chain) and mtk_ machine
// tokens (through the shared machine resolver), then enforces metrics.read for
// both. It works with a nil chain as long as a DB pool is present, because the
// scrape handler is also constructed directly in integration tests.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.machines.Resolve(r.Context(), raw)
		if err != nil {
			if errors.Is(err, authhttp.ErrInvalidMachineToken) {
				authhttp.WriteUnauthorized(w, r, "Invalid machine token")
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

// resolvePlatformMetricsAccess mirrors MachineTokenService.resolvePlatformMetricsAccess.
func (h *Handler) resolvePlatformMetricsAccess(ctx context.Context, bearer string) (platformDecision, error) {
	if bearer == "" {
		return decisionAbsent, nil
	}
	if h.machines == nil {
		return decisionAbsent, errors.New("metrics: machine resolver is not configured")
	}
	token, found, err := h.machines.LookupRaw(ctx, bearer)
	if err != nil {
		return decisionAbsent, err
	}
	if !found {
		return decisionAbsent, nil
	}
	if token.RevokedAt != nil || (token.ExpiresAt != nil && !token.ExpiresAt.After(h.now())) || !token.OrgActive || token.CreatedByID == "" {
		return decisionMachineDenied, nil
	}
	allowed, err := h.isPlatformAdmin(ctx, token.CreatedByID)
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

// rawBearer extracts the Bearer token without a fallback.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
