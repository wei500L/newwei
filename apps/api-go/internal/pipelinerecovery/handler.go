package pipelinerecovery

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	runsPath = "/api/admin/quality/pipeline/runs"

	// permissionManage matches @Permissions("settings.manage") on the controller.
	permissionManage = "settings.manage"
)

// Handler serves the single migrated route.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the exact runs path. Replay and rollback are not
// registered: they stay on NestJS until the item pipeline producer lands.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != runsPath {
		http.NotFound(w, r)
		return
	}
	h.serveRuns(w, r)
}

func (h *Handler) serveRuns(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	itemMetaID, limit, err := parseRunsQuery(r)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.svc.GetRuns(r.Context(), identity.OrgID, itemMetaID, limit)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, encoded)
}

// parseRunsQuery mirrors the controller's query handling: itemMetaId is
// trimmed and required, limit is `limit ? Number(limit) : undefined` with the
// Number.isFinite check.
func parseRunsQuery(r *http.Request) (string, *float64, error) {
	itemMetaID := trimmedItemMetaID(querySingleValue(r, "itemMetaId"))
	if itemMetaID == "" {
		return "", nil, newStatus(400, "itemMetaId is required")
	}
	return itemMetaID, parseLimit(r), nil
}

// parseLimit mirrors the controller: `limit ? Number(limit) : undefined` plus the
// Number.isFinite check, so a blank or non-numeric value means "use the default".
func parseLimit(r *http.Request) *float64 {
	raw := querySingleValue(r, "limit")
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || value != value {
		return nil
	}
	if value > 1e308 || value < -1e308 {
		return nil
	}
	return &value
}

// authorize mirrors the other migrated admin routes: Bearer token required, mtk_
// tokens go through adminlogs, everything else through the JWT verifier plus the
// MySQL membership re-derivation, and settings.manage is required.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
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
	if !identity.HasPermission(permissionManage) {
		authhttp.WriteForbidden(w, r, []string{permissionManage})
		return nil
	}
	return identity
}

// rawBearer extracts the Bearer token without any fallback.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// querySingleValue reads a query parameter that must appear exactly once.
func querySingleValue(r *http.Request, name string) string {
	values := r.URL.Query()[name]
	if len(values) != 1 {
		return ""
	}
	return values[0]
}

// trimmedItemMetaID mirrors the controller's trim of the itemMetaId query.
func trimmedItemMetaID(raw string) string {
	return strings.TrimSpace(raw)
}

func writeJSON(w http.ResponseWriter, status int, payload json.RawMessage) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// writeServiceError renders the GlobalExceptionFilter shape for typed errors and
// falls back to a logged 500.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if status, message, ok := statusOf(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	if status, message, ok := adminlogs.HTTPStatus(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	log.Printf("pipeline recovery: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
