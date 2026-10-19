package runtimediagnostics

import (
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
)

// Paths owned by the runtime diagnostics switch.
const (
	assistantSafetyPath = "/api/system-settings/assistant-safety/diagnostics"
	realtimeRuntimePath = "/api/system-settings/realtime-signals/runtime"
)

// Permission required by both diagnostics routes.
const diagnosticsPermission = "settings.manage"

// Handler serves the two read-only GET routes.
type Handler struct {
	auth     *platformgovernance.Authenticator
	safety   *SafetyService
	realtime *RealtimeService
}

// NewHandler wires the authenticator and both diagnostics services.
func NewHandler(auth *platformgovernance.Authenticator, safety *SafetyService, realtime *RealtimeService) *Handler {
	return &Handler{auth: auth, safety: safety, realtime: realtime}
}

// ServeHTTP dispatches one taken-over request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil {
		settingshttp.WriteServiceError(w, r, settingshttp.ServiceUnavailable("Internal server error"))
		return
	}
	identity := h.auth.Authorize(w, r, diagnosticsPermission)
	if identity == nil {
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case assistantSafetyPath:
		if h.safety == nil {
			settingshttp.WriteServiceError(w, r, settingshttp.ServiceUnavailable("Internal server error"))
			return
		}
		result, err := h.safety.Run(r.Context())
		if err != nil {
			settingshttp.WriteServiceError(w, r, err)
			return
		}
		settingshttp.WriteJSON(w, r, http.StatusOK, result)
	case realtimeRuntimePath:
		if h.realtime == nil {
			settingshttp.WriteServiceError(w, r, settingshttp.ServiceUnavailable("Internal server error"))
			return
		}
		result, err := h.realtime.Run(r.Context(), identity.OrgID)
		if err != nil {
			settingshttp.WriteServiceError(w, r, err)
			return
		}
		settingshttp.WriteJSON(w, r, http.StatusOK, result)
	default:
		http.NotFound(w, r)
	}
}
