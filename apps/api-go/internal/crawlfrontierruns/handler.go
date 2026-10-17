package crawlfrontierruns

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	basePath           = "/api/admin/crawl-frontier"
	runsPath           = basePath + "/runs"
	runsPrefix         = runsPath + "/"
	nodesPrefix        = basePath + "/nodes/"
	workflowRunsPath   = basePath + "/workflow-runs"
	workflowRunsPrefix = workflowRunsPath + "/"
	maxJSONBytes       = 10 << 20
	permRead           = "crawl.read"
	permWrite          = "crawl.write"
)

// document is implemented by every successful response payload, which keeps
// writeJSON strongly typed without an untyped parameter.
type document interface {
	isDocument()
}

// Handler serves the eleven takeover routes. Identity comes from the
// authentication chain only.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler builds a handler around the shared authenticator and service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches by URL path and method. The route table already limits
// methods, but the handler re-checks them defensively and returns 404 for every
// unexpected shape.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == runsPath && r.Method == http.MethodGet:
		h.serveList(w, r)
	case path == runsPath+"/cancel" && r.Method == http.MethodPost:
		h.serveCancelRuns(w, r)
	default:
		switch {
		case r.Method == http.MethodGet:
			if runID, candidateID, ok := candidateTarget(path, runsPrefix, "/workflow-candidates/"); ok {
				h.serveRunCandidate(w, r, runID, candidateID)
				return
			}
			if runID, ok := suffixTarget(path, runsPrefix, "/workflow-candidates"); ok {
				h.serveRunCandidates(w, r, runID)
				return
			}
			if runID, ok := suffixTarget(path, runsPrefix, "/workflow-run"); ok {
				h.serveRunWorkflowRun(w, r, runID)
				return
			}
			if runID, ok := singleSegment(path, runsPrefix); ok {
				h.serveRun(w, r, runID)
				return
			}
			if nodeID, ok := singleSegment(path, nodesPrefix); ok {
				h.serveNode(w, r, nodeID)
				return
			}
			if runID, candidateID, ok := candidateExplanationTarget(path); ok {
				h.serveWorkflowCandidate(w, r, runID, candidateID)
				return
			}
			if runID, ok := suffixTarget(path, workflowRunsPrefix, "/candidates"); ok {
				h.serveWorkflowCandidates(w, r, runID)
				return
			}
			if runID, ok := singleSegment(path, workflowRunsPrefix); ok {
				h.serveWorkflowRun(w, r, runID)
				return
			}
		case r.Method == http.MethodPost:
			if runID, ok := suffixTarget(path, runsPrefix, "/cancel"); ok {
				h.serveCancelRun(w, r, runID)
				return
			}
		}
		http.NotFound(w, r)
	}
}

// singleSegment parses `<prefix><segment>` and URL-decodes the segment the way
// Express decodes @Param. A decode failure falls back to the raw text, matching
// the existing crawl handlers.
func singleSegment(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := path[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return decodePathSegment(rest), true
}

// suffixTarget parses `<prefix><segment><suffix>`.
func suffixTarget(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	rest := strings.TrimSuffix(path[len(prefix):], suffix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return decodePathSegment(rest), true
}

// candidateTarget parses `<prefix><runID><middle><candidateID>`.
func candidateTarget(path, prefix, middle string) (string, string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := path[len(prefix):]
	index := strings.LastIndex(rest, middle)
	if index <= 0 {
		return "", "", false
	}
	runID := rest[:index]
	candidateID := rest[index+len(middle):]
	if runID == "" || strings.Contains(runID, "/") || candidateID == "" || strings.Contains(candidateID, "/") {
		return "", "", false
	}
	return decodePathSegment(runID), decodePathSegment(candidateID), true
}

// candidateExplanationTarget parses
// `<workflow-runs prefix><runID>/candidates/<candidateID>/explanation`.
func candidateExplanationTarget(path string) (string, string, bool) {
	if !strings.HasPrefix(path, workflowRunsPrefix) {
		return "", "", false
	}
	rest := path[len(workflowRunsPrefix):]
	index := strings.LastIndex(rest, "/candidates/")
	if index <= 0 {
		return "", "", false
	}
	runID := rest[:index]
	remainder := rest[index+len("/candidates/"):]
	const suffix = "/explanation"
	if !strings.HasSuffix(remainder, suffix) {
		return "", "", false
	}
	candidateID := strings.TrimSuffix(remainder, suffix)
	if runID == "" || strings.Contains(runID, "/") || candidateID == "" || strings.Contains(candidateID, "/") {
		return "", "", false
	}
	return decodePathSegment(runID), decodePathSegment(candidateID), true
}

// decodePathSegment applies decodeURIComponent-equivalent decoding. The raw
// text is kept when the escape sequence is invalid.
func decodePathSegment(raw string) string {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return raw
	}
	return decoded
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	query, err := validateListQuery(r.URL.RawQuery)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.ListRuns(r.Context(), identity.OrgID, query)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRun(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetRun(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRunWorkflowRun(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetRunWorkflowRunView(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRunCandidates(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetRunWorkflowCandidates(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRunCandidate(w http.ResponseWriter, r *http.Request, id, candidateID string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetRunWorkflowCandidate(r.Context(), identity.OrgID, id, candidateID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveNode(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetNode(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveWorkflowRun(w http.ResponseWriter, r *http.Request, runID string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetWorkflowRun(r.Context(), identity.OrgID, runID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveWorkflowCandidates(w http.ResponseWriter, r *http.Request, runID string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetWorkflowRunCandidates(r.Context(), identity.OrgID, runID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveWorkflowCandidate(w http.ResponseWriter, r *http.Request, runID, candidateID string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetWorkflowCandidate(r.Context(), identity.OrgID, runID, candidateID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveCancelRun(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	payload, err := h.svc.CancelRun(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// The controller has no @HttpCode, so POST succeeds with 201.
	writeJSON(w, http.StatusCreated, payload)
}

func (h *Handler) serveCancelRuns(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	fields, err := parseObjectBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	ids, err := validateBulkBody(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.CancelRuns(r.Context(), identity.OrgID, ids)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// POST /runs/cancel also succeeds with 201.
	writeJSON(w, http.StatusCreated, payload)
}

// ---- Request and response helpers (same contract as the other crawl units) ----

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
	log.Printf("crawl frontier runs: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload document) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
