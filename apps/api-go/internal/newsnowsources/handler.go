package newsnowsources

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// Exact paths owned by this unit.
const (
	// SourcePath is GET /api/news-aggregator/source.
	SourcePath = "/api/news-aggregator/source"
	// BatchPath is POST /api/news-aggregator/sources/batch.
	BatchPath = "/api/news-aggregator/sources/batch"
)

// sourceIDPattern mirrors /^[a-z0-9_-]+$/i.
var sourceIDPattern = regexp.MustCompile(`(?i)^[a-z0-9_-]+$`)

// Handler serves both public endpoints.
type Handler struct {
	service *Service
}

// NewHandler builds the handler on the shared service.
func NewHandler(service *Service) *Handler { return &Handler{service: service} }

// ServeHTTP dispatches the two exact routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == SourcePath && r.Method == http.MethodGet:
		h.getSource(w, r)
	case r.URL.Path == BatchPath && r.Method == http.MethodPost:
		h.getBatch(w, r)
	default:
		writeErrorBody(w, r, http.StatusMethodNotAllowed, "Method Not Allowed", "", "")
	}
}

// getSource validates id and latest in controller order, then fetches.
func (h *Handler) getSource(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	idValues := query["id"]
	if len(idValues) != 1 {
		writeAPIError(w, r, BadRequestError("id query is required"))
		return
	}
	id := strings.TrimSpace(idValues[0])
	if id == "" {
		writeAPIError(w, r, BadRequestError("id query is required"))
		return
	}
	if !sourceIDPattern.MatchString(id) {
		writeAPIError(w, r, BadRequestError("invalid source id format"))
		return
	}
	latest, err := parseLatestFlag(query["latest"])
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	response, fetchErr := h.service.FetchSource(r.Context(), id, latest)
	if fetchErr != nil {
		writeError(w, r, fetchErr)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// getBatch decodes {sources:[...]}, filters invalid members without failing the
// batch, and calls the service in input order.
func (h *Handler) getBatch(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeAPIError(w, r, BadRequestError("sources must be an array of source ids"))
		return
	}
	var payload struct {
		Sources json.RawMessage `json:"sources"`
	}
	if len(bytes.TrimSpace(body)) > 0 {
		if decodeErr := json.Unmarshal(body, &payload); decodeErr != nil {
			writeAPIError(w, r, BadRequestError("sources must be an array of source ids"))
			return
		}
	}
	trimmed := bytes.TrimSpace(payload.Sources)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		writeAPIError(w, r, BadRequestError("sources must be an array of source ids"))
		return
	}
	var members []json.RawMessage
	if decodeErr := json.Unmarshal(trimmed, &members); decodeErr != nil {
		writeAPIError(w, r, BadRequestError("sources must be an array of source ids"))
		return
	}
	valid := make([]string, 0, len(members))
	for _, member := range members {
		var value string
		if decodeErr := json.Unmarshal(member, &value); decodeErr != nil {
			continue
		}
		normalized := strings.TrimSpace(value)
		if normalized == "" || !sourceIDPattern.MatchString(normalized) {
			continue
		}
		valid = append(valid, normalized)
	}

	latest, flagErr := parseLatestFlag(r.URL.Query()["latest"])
	if flagErr != nil {
		writeAPIError(w, r, flagErr)
		return
	}
	response := h.service.FetchBatch(r.Context(), valid, latest)
	writeJSON(w, http.StatusCreated, response)
}

// parseLatestFlag mirrors parseBooleanFlag. The caller passes the raw query
// values so a repeated parameter (an array in Express) is rejected.
func parseLatestFlag(values []string) (bool, *APIError) {
	if len(values) == 0 {
		return false, nil
	}
	if len(values) > 1 {
		return false, BadRequestError("latest must be a boolean string")
	}
	raw := values[0]
	if raw == "" {
		return false, nil
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1", "yes", "y", "on":
		return true, nil
	case "false", "0", "no", "n", "off":
		return false, nil
	default:
		return false, BadRequestError("latest must be one of true/false, 1/0, yes/no, y/n, on/off")
	}
}

// writeJSON writes a success payload like Express res.json.
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

// writeAPIError writes one typed contract error.
func writeAPIError(w http.ResponseWriter, r *http.Request, err *APIError) {
	writeErrorBody(w, r, err.Status, err.Message, err.Code, err.Detail)
}

// writeError writes an error that may be a typed APIError.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	if typed, ok := err.(*APIError); ok {
		writeAPIError(w, r, typed)
		return
	}
	writeErrorBody(w, r, http.StatusInternalServerError, "Internal server error", "", "")
}

// httpErrorBody mirrors the GlobalExceptionFilter HTTP payload order.
type httpErrorBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code,omitempty"`
	Detail     string `json:"detail,omitempty"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// writeErrorBody writes the filtered error shape. 5xx keeps the safe code and
// detail but replaces the message with "Internal server error"; 4xx keeps the
// business message. sourceId/requiredKeys are never attached.
func writeErrorBody(w http.ResponseWriter, r *http.Request, status int, message, code, detail string) {
	if status >= 500 {
		message = "Internal server error"
	}
	body := httpErrorBody{
		StatusCode: status,
		Message:    message,
		Error:      errorName(status),
		Code:       code,
		TraceID:    "",
		Path:       requestPath(r),
		Timestamp:  "",
	}
	if detail != "" && strings.TrimSpace(detail) != "" {
		body.Detail = detail
	}
	if r != nil {
		body.TraceID = httpx.TraceIDFromContext(r.Context())
	}
	if body.TraceID == "" {
		// The gateway's trace middleware normally supplies this; a direct
		// invocation still honours the NestJS filter contract (ensureTraceId).
		body.TraceID = httpx.EnsureTraceID("")
	}
	body.Timestamp = isoMillis(millisOf(time.Now()))
	encoded, err := json.Marshal(body)
	if err != nil {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

// requestPath mirrors request.url: path plus the raw query.
func requestPath(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	if r.URL.RawQuery != "" {
		return r.URL.Path + "?" + r.URL.RawQuery
	}
	return r.URL.Path
}
