package newsbackfilljobs

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
)

const (
	// llmBackfillRoutePrefix is the clustering failures collection prefix.
	llmBackfillRoutePrefix = "/api/system-settings/news-events/clustering/failures/"
	// llmBackfillRouteSuffix is the manual enqueue action.
	llmBackfillRouteSuffix = "/llm-backfill"
	// llmBackfillPermission mirrors @Permissions("settings.manage").
	llmBackfillPermission = "settings.manage"
)

// Handler serves POST
// /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill.
// It is registered only when API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE=go; the
// route table guarantees that no other path or method reaches it.
type Handler struct {
	auth       *authhttp.Authenticator
	clustering *newsnowclusteringops.Service
	service    *Service
}

// NewHandler builds the HTTP entry point.
func NewHandler(auth *authhttp.Authenticator, clustering *newsnowclusteringops.Service, service *Service) *Handler {
	return &Handler{auth: auth, clustering: clustering, service: service}
}

// ServeHTTP dispatches the single route.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.service == nil || h.clustering == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	groupID, ok := parseLlmBackfillGroupID(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	identity := h.authorize(w, r, llmBackfillPermission)
	if identity == nil {
		return
	}
	accepted, err := h.service.Enqueue(r.Context(), identity.OrgID, identity.UserID, groupID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, accepted)
}

// parseLlmBackfillGroupID extracts and URL-decodes the single dynamic segment.
func parseLlmBackfillGroupID(path string) (string, bool) {
	if !strings.HasPrefix(path, llmBackfillRoutePrefix) || !strings.HasSuffix(path, llmBackfillRouteSuffix) {
		return "", false
	}
	// The prefix and the suffix can both match a path shorter than their sum
	// (for example .../failures/llm-backfill), so bound the slice explicitly
	// instead of trusting the two independent prefix/suffix checks.
	if len(path) < len(llmBackfillRoutePrefix)+len(llmBackfillRouteSuffix) {
		return "", false
	}
	raw := path[len(llmBackfillRoutePrefix) : len(path)-len(llmBackfillRouteSuffix)]
	if raw == "" || strings.Contains(raw, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		decoded = raw
	}
	if decoded == "" || strings.Contains(decoded, "/") {
		return "", false
	}
	return decoded, true
}

// authorize resolves the caller identity and asserts settings.manage. Machine
// tokens bypass the JWT verifier and are validated against the MachineAccessToken
// table, exactly like the other clustering administration routes.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.clustering.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			h.writeError(w, r, err)
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
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// writeError maps a typed domain failure onto the NestJS error shape and any
// other failure onto the internal 500 shape.
func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if status, message, ok := newsnowclusteringops.HTTPStatusOf(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	log.Printf("newsbackfilljobs: llm backfill enqueue failed: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// llmBackfillResponse is the sealed success payload set of this handler.
type llmBackfillResponse interface {
	newsnowclusteringops.LlmBackfillAccepted
}

// writeJSON writes a success payload the way Express res.json does.
func writeJSON[T llmBackfillResponse](w http.ResponseWriter, status int, payload T) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("newsbackfilljobs: response encode failed: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// rawBearer extracts the bearer token without rejecting machine tokens.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
