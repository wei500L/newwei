package modelaccesssettings

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Route paths taken over by WithModelAccessSettings. They are repeated here
// because the handler dispatches on the request path itself.
const (
	pathModelService              = "/api/system-settings/model-service"
	pathOpenAiKeys                = "/api/system-settings/openai-keys"
	pathOpenAiKeysKeyPrefix       = "/api/system-settings/openai-keys/key/"
	pathInternalOpenAiKeys        = "/api/internal/litellm/openai-keys"
	pathInternalOpenAiKeysApplied = "/api/internal/litellm/openai-keys/applied"
)

// Handler serves the ten model access settings routes. It performs
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

// ServeHTTP dispatches one taken-over request. The two internal endpoints are
// split off BEFORE the human chain, so a JWT or mtk_ token is never treated as an
// internal caller and the internal token is never treated as a user. Methods
// outside the contract answer 404, but the routing table never sends them here.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if route := internalRouteForPath(r.URL.Path); route != internalRouteNone {
		h.serveInternal(w, r, route)
		return
	}
	switch r.URL.Path {
	case pathModelService:
		h.serveModelService(w, r)
	case pathOpenAiKeys:
		h.serveOpenAiKeys(w, r)
	default:
		if fingerprint, ok := fingerprintFromPath(r.URL.Path); ok {
			h.serveRemoveOpenAiKey(w, r, fingerprint)
			return
		}
		http.NotFound(w, r)
	}
}

// fingerprintFromPath extracts the single :fingerprint segment. The segment is
// taken verbatim (no trimming, no case folding), matching the NestJS @Param
// binding.
func fingerprintFromPath(path string) (string, bool) {
	if !strings.HasPrefix(path, pathOpenAiKeysKeyPrefix) {
		return "", false
	}
	fingerprint := path[len(pathOpenAiKeysKeyPrefix):]
	if fingerprint == "" || strings.Contains(fingerprint, "/") {
		return "", false
	}
	return fingerprint, true
}

// ---- model service ----

// serveModelService handles GET (read), PUT (replace) and DELETE (reset).
func (h *Handler) serveModelService(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getModelServiceSettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		// The DTO runs before the platform admin gate, exactly like NestJS, where
		// the ValidationPipe executes before the service method.
		request, err := parseUpdateModelServiceSettingsRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateModelServiceSettings(r.Context(), identity.OrgID, identity.UserID, request)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	case http.MethodDelete:
		// No DTO: authentication/permission, then the in-service platform gate.
		settings, err := h.svc.resetModelServiceSettings(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// ---- openai keys ----

// serveOpenAiKeys handles GET (read), PUT (replace), POST (append) and DELETE
// (reset).
func (h *Handler) serveOpenAiKeys(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getOpenAiKeysSettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	case http.MethodPut:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		request, err := parseUpdateOpenAiKeysSettingsRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateOpenAiKeysSettings(r.Context(), identity.OrgID, identity.UserID, request)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	case http.MethodPost:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		request, err := parseUpdateOpenAiKeysSettingsRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.appendOpenAiKeys(r.Context(), identity.OrgID, identity.UserID, request)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusCreated, settings)
	case http.MethodDelete:
		settings, err := h.svc.resetOpenAiKeys(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveRemoveOpenAiKey handles DELETE /key/:fingerprint.
func (h *Handler) serveRemoveOpenAiKey(w http.ResponseWriter, r *http.Request, fingerprint string) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodDelete:
		settings, err := h.svc.removeOpenAiKeyByFingerprint(r.Context(), identity.OrgID, identity.UserID, fingerprint)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// ---- internal (LITELLM_CONFIG_INTERNAL_TOKEN only) ----

// serveInternal handles routes 9 and 10. The internal bearer guard always runs
// first; the route-10 DTO runs after it.
func (h *Handler) serveInternal(w http.ResponseWriter, r *http.Request, route internalRoute) {
	if !h.svc.authorizeInternal(w, r) {
		return
	}
	switch route {
	case internalRouteGetKeys:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		response, err := h.svc.getPlaintextKeys(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		// Only the source IP, the count and a fixed event text are logged: never
		// the response, the Authorization header, a decrypted value or an
		// encrypted payload.
		log.Printf("modelaccesssettings: fetched plaintext OpenAI keys via internal endpoint sourceIp=%s keyCount=%d",
			clientIP(r), len(response.OpenaiApiKeys))
		writeJSON(w, r, http.StatusOK, response)
	case internalRouteReportApplied:
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		request, err := parseReportAppliedRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.svc.reportAppliedKeyFingerprints(r.Context(), request); err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeJSON(w, r, http.StatusCreated, okResponse{OK: true})
	default:
		http.NotFound(w, r)
	}
}

// clientIP resolves a log-safe source IP: the first X-Forwarded-For entry, then
// the peer address. It mirrors resolveRequestIp's precedence closely enough for a
// log line and never carries credentials.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if first := strings.TrimSpace(strings.Split(forwarded, ",")[0]); first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
	// bodyOK means the body decoded as JSON (an empty body counts: body-parser
	// turns a zero-length JSON body into {}).
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
	// body-parser special-cases a zero-length JSON body as {}; any other
	// unparseable content (including a whitespace-only body) is a syntax error.
	if len(data) == 0 {
		return []byte("{}"), bodyOK
	}
	if !json.Valid(data) {
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
		// Node's exact SyntaxError text is version specific; this generic message
		// keeps the 400 + error shape.
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
	encodeJSON() ([]byte, error)
}

// encodeJSON renders one response with the standard encoder.
func (b modelServiceSettingsPublic) encodeJSON() ([]byte, error) { return json.Marshal(b) }
func (b openAiKeysSettingsPublic) encodeJSON() ([]byte, error)   { return json.Marshal(b) }
func (b openAiKeysInternalResponse) encodeJSON() ([]byte, error) { return json.Marshal(b) }
func (b okResponse) encodeJSON() ([]byte, error)                 { return json.Marshal(b) }

// writeJSON renders one response body with the content type Express res.json
// produces (no trailing newline, explicit charset).
func writeJSON(w http.ResponseWriter, r *http.Request, status int, body encodedResponse) {
	payload, err := body.encodeJSON()
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
