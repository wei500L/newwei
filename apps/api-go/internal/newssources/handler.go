package newssources

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	collectionPath = "/api/admin/news-sources"
	maxJSONBytes   = 10 << 20
	permRead       = "crawl.read"
	permWrite      = "crawl.write"
)

type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == collectionPath && r.Method == http.MethodGet:
		h.serveList(w, r)
	case r.URL.Path == collectionPath && r.Method == http.MethodPost:
		h.serveCreate(w, r)
	case r.URL.Path == collectionPath+"/options" && r.Method == http.MethodGet:
		h.serveOptions(w, r)
	case r.URL.Path == collectionPath+"/groups" && r.Method == http.MethodGet:
		h.serveGroups(w, r)
	case r.URL.Path == collectionPath+"/opml-presets" && r.Method == http.MethodGet:
		h.servePresets(w, r)
	case r.URL.Path == collectionPath+"/batch/frequency" && r.Method == http.MethodPost:
		h.serveFrequency(w, r)
	case r.URL.Path == collectionPath+"/opml/preview" && r.Method == http.MethodPost:
		h.servePreview(w, r)
	case r.URL.Path == collectionPath+"/opml/import" && r.Method == http.MethodPost:
		h.serveImport(w, r)
	case r.URL.Path == collectionPath+"/batch/group" && r.Method == http.MethodPatch:
		h.serveGroup(w, r)
	case r.URL.Path == collectionPath+"/batch/active" && r.Method == http.MethodPatch:
		h.serveActive(w, r)
	case r.URL.Path == collectionPath+"/batch" && r.Method == http.MethodDelete:
		h.serveBatchDelete(w, r)
	default:
		id, action, ok := sourceAction(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		switch {
		case action == "" && r.Method == http.MethodPatch:
			h.serveUpdate(w, r, id)
		case action == "" && r.Method == http.MethodDelete:
			h.serveDelete(w, r, id)
		case action == "run" && r.Method == http.MethodPost:
			h.serveRun(w, r, id)
		case action == "schedule" && r.Method == http.MethodPost:
			h.serveSchedule(w, r, id)
		default:
			http.NotFound(w, r)
		}
	}
}

func sourceAction(path string) (string, string, bool) {
	const prefix = collectionPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := path[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") && !strings.HasSuffix(rest, "/run") && !strings.HasSuffix(rest, "/schedule") {
		parts := strings.Split(rest, "/")
		if len(parts) == 2 && (parts[1] == "run" || parts[1] == "schedule") && parts[0] != "" {
			return parts[0], parts[1], true
		}
		return "", "", false
	}
	if strings.HasSuffix(rest, "/run") {
		id := strings.TrimSuffix(rest, "/run")
		if id == "" || strings.Contains(id, "/") {
			return "", "", false
		}
		return id, "run", true
	}
	if strings.HasSuffix(rest, "/schedule") {
		id := strings.TrimSuffix(rest, "/schedule")
		if id == "" || strings.Contains(id, "/") {
			return "", "", false
		}
		return id, "schedule", true
	}
	if strings.Contains(rest, "/") {
		return "", "", false
	}
	return rest, "", true
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	query, err := parseListQuery(r.URL.Query())
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.List(r.Context(), identity.OrgID, query)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveOptions(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.Options(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveGroups(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.Groups(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) servePresets(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, permRead) == nil {
		return
	}
	writeJSON(w, http.StatusOK, h.svc.Presets())
}

func (h *Handler) serveCreate(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	input, err := parseCreate(r.Context(), body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.Create(r.Context(), identity.OrgID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveUpdate(w http.ResponseWriter, r *http.Request, id string) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	input, err := parseUpdate(r.Context(), body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.Update(r.Context(), identity.OrgID, id, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDelete(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	if err := h.svc.Delete(r.Context(), identity.OrgID, id); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) serveRun(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	payload, err := h.svc.RunNow(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveSchedule(w http.ResponseWriter, r *http.Request, id string) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	next, err := parseSchedule(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.Schedule(r.Context(), identity.OrgID, id, next)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveFrequency(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	frequency, err := parseFrequency(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.UpdateFrequency(r.Context(), identity.OrgID, frequency)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) servePreview(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	payload, err := h.svc.PreviewOPML(r.Context(), identity.OrgID, body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveImport(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	payload, err := h.svc.ImportOPML(r.Context(), identity.OrgID, body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveGroup(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	ids, group, _, _, err := parseIDs(body, true, false)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.UpdateGroup(r.Context(), identity.OrgID, ids, group)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveActive(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	ids, _, _, active, err := parseIDs(body, false, true)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.UpdateActive(r.Context(), identity.OrgID, ids, active)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveBatchDelete(w http.ResponseWriter, r *http.Request) {
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	ids, _, _, _, err := parseIDs(body, false, false)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.DeleteMany(r.Context(), identity.OrgID, ids)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
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
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

func readJSON(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil || !jsonContent(r.Header.Get("Content-Type")) {
		return []byte("{}"), true
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			authhttp.WritePayloadTooLarge(w, r)
			return nil, false
		}
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return []byte("{}"), true
	}
	if !json.Valid(data) {
		authhttp.WriteBadRequest(w, r, "Expected property name or '}' in JSON at position 1")
		return nil, false
	}
	return data, true
}

func jsonContent(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
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
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	log.Printf("news sources: %v", err)
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
