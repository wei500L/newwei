package situationsignals

import (
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// RefreshHandler serves POST /api/situation-monitor/refresh. It owns exactly one
// route, registered under legacyproxy.SituationRefreshKey, so the independent
// refresh switch never shares a handler with the seven signal routes.
type RefreshHandler struct {
	auth    *Authenticator
	service *RefreshService
}

// NewRefreshHandler wires the refresh handler.
func NewRefreshHandler(auth *Authenticator, service *RefreshService) *RefreshHandler {
	return &RefreshHandler{auth: auth, service: service}
}

// ServeHTTP implements the controller's @Post("refresh") + @Permissions("items.read"):
// authentication (401), items.read permission (403), then the refresh, answered
// with 201 like NestJS's default POST status.
//
// crawl.write is read from the same re-derived permission set as items.read and
// never from the request body; a caller without it still gets a refresh, with the
// crawl part reported as not permitted.
func (h *RefreshHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != refreshPath || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.service.Refresh(r.Context(), identity.OrgID, identity.HasPermission(crawlWritePermission))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}
