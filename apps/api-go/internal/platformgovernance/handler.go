package platformgovernance

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Route paths taken over by WithPlatformGovernanceSettings. They are repeated
// here because the handler dispatches on the request path itself.
const (
	pathSecurity               = "/api/system-settings/security"
	pathAssistantQuota         = "/api/system-settings/assistant-quota"
	pathAssistantSafety        = "/api/system-settings/assistant-safety"
	pathAssistantSafetyMetrics = "/api/system-settings/assistant-safety/metrics"
	pathTaskLogs               = "/api/system-settings/task-logs"
	pathLlmRequestLogs         = "/api/system-settings/llm-request-logs"
	pathLlmRequestLogsReset    = "/api/system-settings/llm-request-logs/metadata-policy/reset"
)

// Handler serves the sixteen platform governance settings routes. It performs
// authentication, DTO validation, the platform-admin gate, body decoding and
// response writing; all persistence and normalization lives in Service.
type Handler struct {
	auth *Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the data access service.
func NewHandler(auth *Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one taken-over request. Methods outside the contract are
// answered with 404, but the routing table never sends them here.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case pathSecurity:
		h.serveSecurity(w, r)
	case pathAssistantQuota:
		h.serveAssistantQuota(w, r)
	case pathAssistantSafetyMetrics:
		h.serveAssistantSafetyMetrics(w, r)
	case pathAssistantSafety:
		h.serveAssistantSafety(w, r)
	case pathTaskLogs:
		h.serveTaskLogs(w, r)
	case pathLlmRequestLogsReset:
		h.serveLlmRequestLogsMetadataReset(w, r)
	case pathLlmRequestLogs:
		h.serveLlmRequestLogs(w, r)
	default:
		http.NotFound(w, r)
	}
}

// ---- route handlers ----

// serveSecurity handles GET (read) and PUT (global write, platform admin only).
func (h *Handler) serveSecurity(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.securitySettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseUpdateSecurity(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		// The DTO is validated before the platform gate, exactly like the
		// NestJS ValidationPipe running before the handler body.
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateSecuritySettings(r.Context(), identity.OrgID, identity.UserID, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveAssistantQuota handles GET, PUT and DELETE.
func (h *Handler) serveAssistantQuota(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.assistantQuotaSettings(r.Context(), identity.OrgID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseUpdateQuota(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateAssistantQuotaSettings(r.Context(), identity.OrgID, identity.UserID, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodDelete:
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.resetAssistantQuotaSettings(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveAssistantSafety handles GET, PUT and DELETE. Diagnostics and every other
// assistant-safety sub-path stay on NestJS.
func (h *Handler) serveAssistantSafety(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.assistantSafetySettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseUpdateSafety(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateAssistantSafetySettings(r.Context(), identity.OrgID, identity.UserID, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodDelete:
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.resetAssistantSafetySettings(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveAssistantSafetyMetrics handles GET /assistant-safety/metrics.
//
// `?days=` mirrors the NestJS controller: a single value goes through Number(),
// every other shape (absent, repeated) keeps the 14 day default.
func (h *Handler) serveAssistantSafetyMetrics(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	days := 14.0
	if values := r.URL.Query()["days"]; len(values) == 1 {
		parsed := jsStringToNumber(values[0])
		if !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			days = parsed
		}
	}
	rows, err := h.svc.assistantSafetyMetrics(r.Context(), identity.OrgID, days)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, assistantSafetyMetricsList(rows))
}

// serveTaskLogs handles GET, PUT and DELETE.
func (h *Handler) serveTaskLogs(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.taskLogSettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseUpdateTaskLog(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateTaskLogSettings(r.Context(), identity.OrgID, identity.UserID, int64(input.RetentionDays))
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodDelete:
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.resetTaskLogSettings(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveLlmRequestLogs handles GET, PUT and DELETE.
func (h *Handler) serveLlmRequestLogs(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.llmLogSettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseUpdateLlmLog(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateLlmLogSettings(r.Context(), identity.OrgID, identity.UserID, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodDelete:
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.resetLlmLogSettings(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveLlmRequestLogsMetadataReset handles POST
// /llm-request-logs/metadata-policy/reset. NestJS answers 201 for @Post
// handlers, so the success status is 201 and not 200.
func (h *Handler) serveLlmRequestLogsMetadataReset(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
		writeServiceError(w, r, err)
		return
	}
	settings, err := h.svc.resetLlmLogMetadataPolicy(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, settings)
}

// ---- body handling ----

// maxBodyBytes mirrors apps/api/src/main.ts json({limit:"10mb"}).
const maxBodyBytes = 10 << 20

// bodyKind classifies the raw body the way Express body-parser does.
type bodyKind int

const (
	// bodyAbsent means the content type was not JSON; NestJS validates an empty
	// object in that case.
	bodyAbsent bodyKind = iota
	// bodyOK means the body decoded as JSON.
	bodyOK
	// bodyInvalidJSON means the body was not valid JSON.
	bodyInvalidJSON
	// bodyTooLarge means the body exceeded the configured limit.
	bodyTooLarge
)

// readRequestBody reads a JSON body with a hard size limit.
func readRequestBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	defer func() {
		_ = limited.Close()
	}()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

// readBodyOrFail reads the body and writes the contract-equivalent error when it
// cannot be used. It returns false when the caller must stop.
func readBodyOrFail(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, kind := readRequestBody(r)
	switch kind {
	case bodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return nil, false
	case bodyInvalidJSON:
		authhttp.WriteBadRequest(w, r, "Unexpected token in JSON body")
		return nil, false
	case bodyAbsent:
		return []byte("{}"), true
	default:
		return body, true
	}
}

// isJSONContentType reports whether the header selects the JSON body parser.
func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return media == "application/json"
}

// ---- responses ----

// encodedResponse is a response body that renders itself as JSON. Using a named
// interface keeps the responder free of an untyped parameter.
type encodedResponse interface {
	// encodeJSON renders the response body.
	encodeJSON() ([]byte, error)
}

// assistantSafetyMetricsList is the named list type so it can implement
// encodedResponse.
type assistantSafetyMetricsList []AssistantSafetyMetricsRow

// encodeJSON renders the body with the standard encoder.
func (s SecuritySettingsResponse) encodeJSON() ([]byte, error)       { return json.Marshal(s) }
func (s AssistantQuotaSettingsResponse) encodeJSON() ([]byte, error) { return json.Marshal(s) }
func (s AssistantSafetySettingsResponse) encodeJSON() ([]byte, error) {
	return json.Marshal(s)
}
func (l assistantSafetyMetricsList) encodeJSON() ([]byte, error) { return json.Marshal(l) }
func (s TaskLogSettingsResponse) encodeJSON() ([]byte, error)    { return json.Marshal(s) }
func (s LlmRequestLogSettingsResponse) encodeJSON() ([]byte, error) {
	return json.Marshal(s)
}

// writeResponse renders one response body with the content type Express res.json
// produces (no trailing newline, explicit charset).
func writeResponse(w http.ResponseWriter, r *http.Request, status int, body encodedResponse) {
	payload, err := body.encodeJSON()
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
