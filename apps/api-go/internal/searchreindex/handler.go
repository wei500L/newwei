package searchreindex

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Exact request paths served by this unit. The controller prefix is
// "admin/search" and the global REST prefix is "api".
const (
	searchReindexStartPath = "/api/admin/search/reindex"
	searchReindexJobPrefix = "/api/admin/search/reindex/"
)

// permissionSettingsManage is the @Permissions value of both controller methods.
const permissionSettingsManage = "settings.manage"

// Handler serves the two migrated reindex routes. Identity comes only from the
// authentication chain; a query parameter or body field named orgId never
// participates.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler builds a handler around the shared authenticator and the reindex
// service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the two migrated routes by exact path shape.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == searchReindexStartPath:
		h.serveStart(w, r)
	case strings.HasPrefix(r.URL.Path, searchReindexJobPrefix):
		h.serveJob(w, r, segmentAfter(r.URL.Path, searchReindexJobPrefix))
	default:
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
	}
}

// serveStart handles POST /api/admin/search/reindex: it returns the queued job
// snapshot with HTTP 201, or the coded 409 conflict when the organization already
// has a running rebuild.
func (h *Handler) serveStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	job, err := h.svc.startReindex(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	body, err := json.Marshal(job)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBody(w, http.StatusCreated, body)
}

// serveJob handles GET /api/admin/search/reindex/:jobId. A missing, expired or
// foreign job is serialized as JSON null with HTTP 200, keeping the current
// contract instead of a 404.
func (h *Handler) serveJob(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet || jobID == "" {
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	job, err := h.svc.getJob(r.Context(), identity.OrgID, jobID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	body, err := json.Marshal(job)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSONBody(w, http.StatusOK, body)
}

// authorize runs the shared authentication chain and enforces settings.manage:
//   - missing Authorization or non-Bearer -> 401;
//   - mtk_ machine token -> MachineAuthenticator (SHA-256 tokenHash lookup);
//   - other token -> authhttp.Authenticate (JWT verify, Redis blacklist and
//     MySQL membership/permission re-derivation);
//   - permission missing -> 403.
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
		if h.svc.machines == nil {
			authhttp.WriteUnauthorized(w, r, "Invalid machine token")
			return nil
		}
		resolved, err := h.svc.machines.AuthenticateMachine(r.Context(), raw)
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
	if !identity.HasPermission(permissionSettingsManage) {
		authhttp.WriteForbidden(w, r, []string{permissionSettingsManage})
		return nil
	}
	return identity
}

// rawBearer extracts a Bearer token from the Authorization header.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// segmentAfter returns the single path segment following prefix, or an empty
// string when the remainder is empty or contains another separator.
func segmentAfter(path, prefix string) string {
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}

// writeJSONBody writes an already-marshaled JSON payload without a trailing
// newline, matching the Express res.json byte shape.
func writeJSONBody(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
