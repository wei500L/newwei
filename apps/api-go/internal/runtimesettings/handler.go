package runtimesettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Route paths taken over by WithRuntimeSettings. They are repeated here because
// the handler dispatches on the request path itself.
const (
	pathRateLimitPolicies   = "/api/system-settings/rate-limit-policies"
	pathRateLimitPoliciesID = "/api/system-settings/rate-limit-policies/"
	pathRateLimits          = "/api/system-settings/rate-limits"
	pathAuthCache           = "/api/system-settings/auth-cache"
	pathAuditLog            = "/api/system-settings/audit-log"
	pathMultiTenant         = "/api/system-settings/multi-tenant-schedulers"
	pathNewsSourceScheduler = "/api/system-settings/news-source-scheduler"
	pathNewsNow             = "/api/system-settings/newsnow-personalization"
	pathNewsNowMetrics      = "/api/system-settings/newsnow-personalization/metrics"
)

// Handler serves the eighteen runtime/governance settings routes. It performs
// authentication, body decoding and response writing; all persistence and
// normalization lives in Service.
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
	case pathRateLimitPolicies:
		h.serveRateLimitPolicyCollection(w, r)
	case pathRateLimits:
		h.serveRateLimits(w, r)
	case pathAuthCache:
		h.serveAuthCache(w, r)
	case pathAuditLog:
		h.serveAuditLog(w, r)
	case pathMultiTenant:
		h.serveMultiTenantSchedulers(w, r)
	case pathNewsSourceScheduler:
		h.serveNewsSourceScheduler(w, r)
	case pathNewsNowMetrics:
		h.serveNewsNowMetrics(w, r)
	case pathNewsNow:
		h.serveNewsNowPersonalization(w, r)
	default:
		if feature, ok := featureFromPath(r.URL.Path); ok {
			h.serveRateLimitPolicyItem(w, r, feature)
			return
		}
		http.NotFound(w, r)
	}
}

// featureFromPath extracts a single :feature path segment.
func featureFromPath(path string) (string, bool) {
	if !strings.HasPrefix(path, pathRateLimitPoliciesID) {
		return "", false
	}
	feature := path[len(pathRateLimitPoliciesID):]
	if feature == "" || strings.Contains(feature, "/") {
		return "", false
	}
	return feature, true
}

// ---- route handlers ----

// serveRateLimitPolicyCollection handles GET (list) and POST (create).
func (h *Handler) serveRateLimitPolicyCollection(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		policies, err := h.svc.listRateLimitPolicies(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, rateLimitPolicyList(policies))
	case http.MethodPost:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		feature, write, err := parseCreateRateLimitPolicy(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		created, err := h.svc.createRateLimitPolicy(r.Context(), identity.OrgID, identity.UserID, feature, write)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusCreated, created)
	default:
		http.NotFound(w, r)
	}
}

// serveRateLimitPolicyItem handles GET/PUT/DELETE for one :feature.
func (h *Handler) serveRateLimitPolicyItem(w http.ResponseWriter, r *http.Request, feature string) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		policy, err := h.svc.getRateLimitPolicy(r.Context(), feature)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if policy == nil {
			writeServiceError(w, r, &httpError{status: http.StatusNotFound, message: "Rate limit policy not found"})
			return
		}
		writeResponse(w, r, http.StatusOK, *policy)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		patch, err := parseUpdateRateLimitPolicy(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		updated, err := h.svc.updateRateLimitPolicy(r.Context(), identity.OrgID, identity.UserID, feature, patch)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, updated)
	case http.MethodDelete:
		if err := h.svc.deleteRateLimitPolicy(r.Context(), identity.OrgID, identity.UserID, feature); err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, deleteResponse{OK: true})
	default:
		http.NotFound(w, r)
	}
}

// serveRateLimits handles the global rate limit buckets.
func (h *Handler) serveRateLimits(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getRateLimitSettings(r.Context())
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
		dto, err := parseUpdateRateLimitSettings(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateRateLimitSettings(r.Context(), identity.OrgID, identity.UserID, dto)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveAuthCache handles the auth profile cache settings.
func (h *Handler) serveAuthCache(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getAuthCacheSettings(r.Context())
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
		dto, err := parseUpdateAuthCacheSettings(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateAuthCacheSettings(r.Context(), identity.OrgID, identity.UserID, dto)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveAuditLog handles the global audit log retention. Only the PUT requires a
// platform admin; the GET is available to any settings.manage holder.
func (h *Handler) serveAuditLog(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		days, err := h.svc.getAuditLogRetention(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, auditLogRetentionResponse{RetentionDays: days})
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		dto, err := parseUpdateAuditLogRetention(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		// The retention setting is global: only platform admins may change it.
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		days, _ := numberField(&validationErrors{}, dto.RetentionDays, "retentionDays", true, auditLogMinRetentionDays, auditLogMaxRetentionDays)
		normalized, err := h.svc.updateAuditLogRetention(r.Context(), identity.OrgID, identity.UserID, days)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, auditLogRetentionResponse{RetentionDays: normalized})
	default:
		http.NotFound(w, r)
	}
}

// serveMultiTenantSchedulers handles the multi-tenant scheduler concurrency.
func (h *Handler) serveMultiTenantSchedulers(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.readMultiTenantSchedulerSettings(r.Context())
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
		normalized, err := parseMultiTenantSchedulerRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateMultiTenantSchedulerSettings(r.Context(), identity.OrgID, identity.UserID, normalized)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveNewsSourceScheduler handles the news source scheduler settings.
func (h *Handler) serveNewsSourceScheduler(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getNewsSourceSchedulerSettings(r.Context())
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
		values, err := parseNewsSourceSchedulerRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateNewsSourceSchedulerSettings(r.Context(), identity.OrgID, identity.UserID, values)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveNewsNowPersonalization handles the NewsNow personalization settings.
func (h *Handler) serveNewsNowPersonalization(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.readNewsNowPersonalizationSettings(r.Context())
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
		values, err := parseNewsNowPersonalizationRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateNewsNowPersonalizationSettings(r.Context(), identity.OrgID, identity.UserID, values)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveNewsNowMetrics handles GET /newsnow-personalization/metrics.
func (h *Handler) serveNewsNowMetrics(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	values, presentFlag := r.URL.Query()["days"]
	raw := ""
	if len(values) > 0 {
		raw = values[0]
	}
	windowDays := metricsWindowDays(raw, presentFlag, len(values) > 1)
	writeResponse(w, r, http.StatusOK, h.svc.getNewsNowMetricsSnapshot(r.Context(), windowDays))
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
	defer limited.Close()
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
// interface keeps the responder free of any untyped parameter.
type encodedResponse interface {
	// encodeJSON renders the response body.
	encodeJSON() ([]byte, error)
}

// deleteResponse is the {"ok":true} body DELETE returns.
type deleteResponse struct {
	OK bool `json:"ok"`
}

// rateLimitPolicyList is the named list type so it can implement encodedResponse.
type rateLimitPolicyList []rateLimitPolicy

// encodeJSON renders the body with the standard encoder.
func (p rateLimitPolicy) encodeJSON() ([]byte, error)     { return json.Marshal(p) }
func (l rateLimitPolicyList) encodeJSON() ([]byte, error) { return json.Marshal(l) }
func (s rateLimitSettings) encodeJSON() ([]byte, error)   { return json.Marshal(s) }
func (s authCacheSettings) encodeJSON() ([]byte, error)   { return json.Marshal(s) }
func (s auditLogRetentionResponse) encodeJSON() ([]byte, error) {
	return json.Marshal(s)
}
func (s multiTenantSchedulerSettings) encodeJSON() ([]byte, error) { return json.Marshal(s) }
func (s newsSourceSchedulerSettings) encodeJSON() ([]byte, error)  { return json.Marshal(s) }
func (s newsNowPersonalizationSettings) encodeJSON() ([]byte, error) {
	return json.Marshal(s)
}
func (s newsNowMetricsSnapshot) encodeJSON() ([]byte, error) { return json.Marshal(s) }
func (d deleteResponse) encodeJSON() ([]byte, error)         { return json.Marshal(d) }

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
