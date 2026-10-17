package llmgatewayprofiles

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

// BasePath is the public prefix of the seven migrated routes.
const BasePath = "/api/system-settings/llm-gateways"

// Static one-segment paths of the batch.
const (
	activePath          = BasePath + "/active"
	embeddingActivePath = BasePath + "/embedding-active"
	rerankActivePath    = BasePath + "/rerank-active"
)

// unmigratedStaticPaths lists the /llm-gateways sub-paths that must keep flowing
// to NestJS through the legacy proxy.
//
// Only proxy-governance and proxy-load-balancing can actually be reached by this
// batch's routing table, because they are the only unmigrated paths shaped like
// one dynamic segment under PUT/DELETE/OPTIONS. The remaining entries are listed
// for completeness: their longer paths or non-PUT/DELETE methods are never
// matched by the rules added here, so they already fall through to the /api/
// legacy prefix and need no exception.
var unmigratedStaticPaths = map[string]bool{
	BasePath + "/proxy-governance":            true,
	BasePath + "/proxy-governance/preflight":  true,
	BasePath + "/proxy-governance/rotate-key": true,
	BasePath + "/proxy-load-balancing":        true,
	BasePath + "/test-config":                 true,
	BasePath + "/models-config":               true,
}

// IsUnmigratedStaticPath reports whether path is a static route that must be
// forwarded to NestJS unchanged instead of being treated as a profile id. The
// wiring consults it before authentication, body decoding and CORS handling so a
// static path can never receive a Go profile 404/400.
func IsUnmigratedStaticPath(path string) bool {
	return unmigratedStaticPaths[path]
}

// Handler serves the seven taken-over routes. It performs authentication, body
// decoding and response writing; all persistence and normalization lives in
// Service.
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
	case BasePath:
		h.serveCollection(w, r)
	case activePath:
		h.serveActiveSelection(w, r)
	case embeddingActivePath:
		h.serveEmbeddingActiveSelection(w, r)
	case rerankActivePath:
		h.serveRerankActiveSelection(w, r)
	default:
		id, ok := profileIDFromPath(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.serveProfileItem(w, r, id)
	}
}

// profileIDFromPath extracts the dynamic profile id: exactly one non-empty path
// segment with no further slash. No UUID shape is required because existing
// profile ids are not guaranteed to be UUIDs.
func profileIDFromPath(path string) (string, bool) {
	prefix := BasePath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := path[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

// ---- route handlers ----

// serveCollection handles GET (list) and POST (create).
func (h *Handler) serveCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		identity := h.auth.authorize(w, r)
		if identity == nil {
			return
		}
		settings, err := h.svc.List(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPost:
		identity := h.auth.authorize(w, r)
		if identity == nil {
			return
		}
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseProfileInput(body, true)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		created, err := h.svc.CreateProfile(r.Context(), identity.OrgID, identity.UserID, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusCreated, created)
	default:
		http.NotFound(w, r)
	}
}

// serveProfileItem handles PUT (update) and DELETE of one profile. DELETE has no
// request DTO, so no body is read for it.
func (h *Handler) serveProfileItem(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodPut:
		identity := h.auth.authorize(w, r)
		if identity == nil {
			return
		}
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		input, err := parseProfileInput(body, false)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		updated, err := h.svc.UpdateProfile(r.Context(), identity.OrgID, identity.UserID, id, input)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, updated)
	case http.MethodDelete:
		identity := h.auth.authorize(w, r)
		if identity == nil {
			return
		}
		if err := h.svc.DeleteProfile(r.Context(), identity.OrgID, identity.UserID, id); err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, deleteResponse{OK: true})
	default:
		http.NotFound(w, r)
	}
}

// serveActiveSelection handles PUT /active.
func (h *Handler) serveActiveSelection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseActiveSelection(body, false)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.SetActiveProfile(r.Context(), identity.OrgID, identity.UserID, input.ActiveID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, result)
}

// serveEmbeddingActiveSelection handles PUT /embedding-active.
func (h *Handler) serveEmbeddingActiveSelection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseActiveSelection(body, true)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	var mode *EmbeddingMode
	if input.Mode != nil {
		value := EmbeddingMode(*input.Mode)
		mode = &value
	}
	result, err := h.svc.SetEmbeddingActiveProfile(r.Context(), identity.OrgID, identity.UserID, input.ActiveID, mode)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, result)
}

// serveRerankActiveSelection handles PUT /rerank-active.
func (h *Handler) serveRerankActiveSelection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	input, err := parseActiveSelection(body, true)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	var mode *RerankMode
	if input.Mode != nil {
		value := RerankMode(*input.Mode)
		mode = &value
	}
	result, err := h.svc.SetRerankActiveProfile(r.Context(), identity.OrgID, identity.UserID, input.ActiveID, mode)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, result)
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

// encodeJSON renders the settings projection.
func (s SettingsPublic) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// encodeJSON renders one profile projection.
func (p PublicProfile) encodeJSON() ([]byte, error) { return json.Marshal(p) }

// encodeJSON renders the {"ok":true} body.
func (d deleteResponse) encodeJSON() ([]byte, error) { return json.Marshal(d) }

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
