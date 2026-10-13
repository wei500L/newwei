package situationmonitors

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	listPath    = "/api/situation-monitor/monitors"
	previewPath = "/api/situation-monitor/monitors/preview"
	permission  = "items.read"
)

// Handler 只服务自定义监控的五条路由。身份只来自鉴权链。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == listPath && r.Method == http.MethodGet:
		h.serveList(w, r)
	case r.URL.Path == listPath && r.Method == http.MethodPost:
		h.serveCreate(w, r)
	case r.URL.Path == previewPath && r.Method == http.MethodPost:
		h.servePreview(w, r)
	case r.Method == http.MethodPatch || r.Method == http.MethodDelete:
		id, ok := monitorID(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPatch {
			h.serveUpdate(w, r, id)
			return
		}
		h.serveDelete(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func monitorID(path string) (string, bool) {
	const prefix = listPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	id := path[len(prefix):]
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.List(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveCreate(w http.ResponseWriter, r *http.Request) {
	body, kind := readBody(r)
	if !finishBody(w, r, body, kind) {
		return
	}
	if kind == bodyAbsent {
		body = []byte("{}")
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	input, err := validateCreate(body, false)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.Create(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) servePreview(w http.ResponseWriter, r *http.Request) {
	body, kind := readBody(r)
	if !finishBody(w, r, body, kind) {
		return
	}
	if kind == bodyAbsent {
		body = []byte("{}")
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	input, err := validateCreate(body, true)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.Preview(r.Context(), identity.OrgID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveUpdate(w http.ResponseWriter, r *http.Request, id string) {
	body, kind := readBody(r)
	if !finishBody(w, r, body, kind) {
		return
	}
	if kind == bodyAbsent {
		body = []byte("{}")
	}
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	patch, err := validateUpdate(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	payload, err := h.svc.Update(r.Context(), identity.OrgID, identity.UserID, id, patch)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDelete(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if err := h.svc.Delete(r.Context(), identity.OrgID, identity.UserID, id); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

func finishBody(w http.ResponseWriter, r *http.Request, body []byte, kind bodyKind) bool {
	switch kind {
	case bodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return false
	case bodyInvalidJSON:
		authhttp.WriteBadRequest(w, r, invalidJSONMessage(body))
		return false
	default:
		return true
	}
}

func writeInputError(w http.ResponseWriter, r *http.Request, err error) {
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	writeServiceError(w, r, err)
}

func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var status *statusError
	if errors.As(err, &status) {
		authhttp.WriteHTTPException(w, r, status.status, status.message)
		return
	}
	log.Printf("situation monitors: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
