package crawlstrategyruns

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
	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// Handler serves the two crawl-strategy execution entries under go takeover:
// POST /api/admin/crawl-frontier/workflows/:id/trial-run and
// POST /api/admin/crawl-frontier/workflow-runs/:runId/replay. Both require
// crawl.read and take the organization from the authenticated identity.

const (
	crawlFrontierBase = "/api/admin/crawl-frontier"
	trialRunSuffix    = "/trial-run"
	replaySuffix      = "/replay"
	maxJSONBytes      = 10 << 20
	permissionRead    = "crawl.read"
)

// Handler is the HTTP entry for the runtime.
type Handler struct {
	auth *authhttp.Authenticator
	rt   *Runtime
}

// NewHandler builds the handler.
func NewHandler(auth *authhttp.Authenticator, rt *Runtime) *Handler {
	return &Handler{auth: auth, rt: rt}
}

// ServeHTTP dispatches the two paths.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if id, ok := singleSegmentAction(r.URL.Path, crawlFrontierBase+"/workflows/", trialRunSuffix); ok {
		if r.Method == http.MethodPost {
			h.serveTrialRun(w, r, id)
			return
		}
	}
	if id, ok := singleSegmentAction(r.URL.Path, crawlFrontierBase+"/workflow-runs/", replaySuffix); ok {
		if r.Method == http.MethodPost {
			h.serveReplay(w, r, id)
			return
		}
	}
	authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
}

func (h *Handler) serveTrialRun(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	input, err := validateTrialRun(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.rt.TrialRunWorkflow(r.Context(), identity.OrgID, identity.UserID, id, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (h *Handler) serveReplay(w http.ResponseWriter, r *http.Request, runID string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	input, err := validateReplay(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.rt.ReplayRun(r.Context(), identity.OrgID, identity.UserID, runID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.rt == nil || h.auth == nil {
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
		resolved, err := h.rt.workflows.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(permissionRead) {
		authhttp.WriteForbidden(w, r, []string{permissionRead})
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

// singleSegmentAction matches `prefix + <one segment> + suffix`.
func singleSegmentAction(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	rest := strings.TrimSuffix(path[len(prefix):], suffix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
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
		authhttp.WriteBadRequest(w, r, invalidJSONMessage)
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
	var discovery *crawlmetadata.DiscoveryError
	if errors.As(err, &discovery) {
		authhttp.WriteBadRequest(w, r, discovery.Error())
		return
	}
	var policy *crawlprofile.PolicyError
	if errors.As(err, &policy) {
		authhttp.WriteBadRequest(w, r, policy.Message)
		return
	}
	if crawlStatus := crawl4ai.StatusOf(err); crawlStatus != 0 {
		if crawlStatus >= 400 && crawlStatus < 500 {
			authhttp.WriteHTTPException(w, r, crawlStatus, err.Error())
			return
		}
	}
	log.Printf("crawl strategy runs: %v", err)
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
