package llmgatewayops

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
)

// BasePath is the public prefix shared with the seven profile routes.
const BasePath = "/api/system-settings/llm-gateways"

// Static sub-paths of this batch. They are more specific than the profile
// dynamic rule, so they win the longest-prefix match and are never mistaken for
// a profile id.
const (
	// governancePath is the governance document route.
	governancePath = BasePath + "/proxy-governance"
	// governancePreflightPath is the enable-readiness route.
	governancePreflightPath = governancePath + "/preflight"
	// governanceRotateKeyPath is the managed key rotation route.
	governanceRotateKeyPath = governancePath + "/rotate-key"
	// modelsConfigPath is the ad-hoc model list route.
	modelsConfigPath = BasePath + "/models-config"
	// testConfigPath is the ad-hoc diagnostic route.
	testConfigPath = BasePath + "/test-config"
)

// Profile sub-resource tails.
const (
	// tailModels lists the models of one profile.
	tailModels = "models"
	// tailTest runs the three probes of one profile.
	tailTest = "test"
	// tailProxyHealth runs the health pair of one profile.
	tailProxyHealth = "proxy-health"
	// tailProxyModelInfo returns the sanitized model info of one profile.
	tailProxyModelInfo = "proxy-model-info"
	// tailProxyLBTest runs the load balancing smoke test of one profile.
	tailProxyLBTest = "proxy-lb-test"
)

// Authorizer is the narrow authentication surface this handler needs.
type Authorizer interface {
	// Authorize returns the actor identity or nil after writing the error.
	Authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity
}

// Handler serves the twelve governance and diagnostics routes.
type Handler struct {
	auth Authorizer
	svc  *Service
}

// NewHandler wires the shared authenticator and the service.
func NewHandler(auth *llmgatewayprofiles.Authenticator, svc *Service) *Handler {
	if auth == nil {
		return &Handler{svc: svc}
	}
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one request. Methods outside the contract answer 404, but
// the routing table never sends them here.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case governancePath:
		h.serveGovernance(w, r)
		return
	case governancePreflightPath:
		h.serveGovernancePreflight(w, r)
		return
	case governanceRotateKeyPath:
		h.serveGovernanceRotateKey(w, r)
		return
	case modelsConfigPath:
		h.serveModelsConfig(w, r)
		return
	case testConfigPath:
		h.serveTestConfig(w, r)
		return
	}
	profileID, tail, ok := splitProfileSubresource(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch tail {
	case tailModels:
		h.serveModels(w, r, profileID)
	case tailTest:
		h.serveTest(w, r, profileID)
	case tailProxyHealth:
		h.serveProxyHealth(w, r, profileID)
	case tailProxyModelInfo:
		h.serveProxyModelInfo(w, r, profileID)
	case tailProxyLBTest:
		h.serveProxyLBTest(w, r, profileID)
	default:
		http.NotFound(w, r)
	}
}

// splitProfileSubresource extracts "<id>/<tail>" after BasePath. The id must be a
// single non-empty segment; the tail must be one of the five known sub-resources.
func splitProfileSubresource(path string) (string, string, bool) {
	prefix := BasePath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := path[len(prefix):]
	separator := strings.Index(rest, "/")
	if separator <= 0 || separator == len(rest)-1 {
		return "", "", false
	}
	id := rest[:separator]
	tail := rest[separator+1:]
	if strings.Contains(tail, "/") {
		return "", "", false
	}
	return id, tail, true
}

// ---- governance routes ----

// serveGovernance handles GET, PUT and DELETE of the governance document.
func (h *Handler) serveGovernance(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		identity := h.auth.Authorize(w, r)
		if identity == nil {
			return
		}
		result, err := h.svc.GetSettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSONResponse(w, r, http.StatusOK, result)
	case http.MethodPut:
		identity := h.auth.Authorize(w, r)
		if identity == nil {
			return
		}
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseGovernanceUpdateInput(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		result, err := h.svc.UpdateSettings(r.Context(), identity.OrgID, identity.UserID, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSONResponse(w, r, http.StatusOK, result)
	case http.MethodDelete:
		identity := h.auth.Authorize(w, r)
		if identity == nil {
			return
		}
		result, err := h.svc.ResetToDefaults(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSONResponse(w, r, http.StatusOK, result)
	default:
		http.NotFound(w, r)
	}
}

// serveGovernancePreflight handles POST /proxy-governance/preflight.
func (h *Handler) serveGovernancePreflight(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseGovernancePreflightInput(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.GetPreflight(r.Context(), input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusCreated, result)
}

// serveGovernanceRotateKey handles POST /proxy-governance/rotate-key.
func (h *Handler) serveGovernanceRotateKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r)
	if identity == nil {
		return
	}
	result, err := h.svc.RotateManagedRuntimeKey(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusCreated, result)
}

// ---- ad-hoc diagnostics ----

// serveModelsConfig handles POST /models-config.
func (h *Handler) serveModelsConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	if h.auth.Authorize(w, r) == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseModelsConfigInput(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.ListModelsConfig(r.Context(), input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusCreated, result)
}

// serveTestConfig handles POST /test-config.
func (h *Handler) serveTestConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseTestConfigInput(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.TestConfig(r.Context(), input, probeActor{OrgID: identity.OrgID, UserID: identity.UserID})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusCreated, result)
}

// ---- profile sub-resources ----

// serveModels handles GET /:id/models.
func (h *Handler) serveModels(w http.ResponseWriter, r *http.Request, profileID string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if h.auth.Authorize(w, r) == nil {
		return
	}
	result, err := h.svc.ListModels(r.Context(), profileID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusOK, result)
}

// serveTest handles POST /:id/test.
func (h *Handler) serveTest(w http.ResponseWriter, r *http.Request, profileID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseTestInput(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.TestProfile(r.Context(), profileID, input, probeActor{OrgID: identity.OrgID, UserID: identity.UserID})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusCreated, result)
}

// serveProxyHealth handles GET /:id/proxy-health.
func (h *Handler) serveProxyHealth(w http.ResponseWriter, r *http.Request, profileID string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if h.auth.Authorize(w, r) == nil {
		return
	}
	result, err := h.svc.CheckProxyHealth(r.Context(), profileID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusOK, result)
}

// serveProxyModelInfo handles GET /:id/proxy-model-info. Only the literal "1" or
// "true" enables force.
func (h *Handler) serveProxyModelInfo(w http.ResponseWriter, r *http.Request, profileID string) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if h.auth.Authorize(w, r) == nil {
		return
	}
	force := r.URL.Query().Get("force")
	result, err := h.svc.GetProxyModelInfo(r.Context(), profileID, force == "1" || force == "true")
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusOK, result)
}

// serveProxyLBTest handles POST /:id/proxy-lb-test.
func (h *Handler) serveProxyLBTest(w http.ResponseWriter, r *http.Request, profileID string) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseLBTestInput(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.TestProxyLoadBalancing(r.Context(), profileID, input, probeActor{OrgID: identity.OrgID, UserID: identity.UserID})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResponse(w, r, http.StatusCreated, result)
}

// ---- body handling ----

// maxBodyBytes mirrors apps/api/src/main.ts json({limit:"10mb"}).
const maxBodyBytes = 10 << 20

// bodyKind classifies the raw body the way Express body-parser does.
type bodyKind int

const (
	// bodyAbsent means the content type was not JSON; NestJS validates an
	// empty object in that case.
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

// writeJSONResponse renders one typed response body with the content type
// Express res.json produces (no trailing newline, explicit charset).
func writeJSONResponse[T any](w http.ResponseWriter, r *http.Request, status int, payload T) {
	data, err := json.Marshal(payload)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
