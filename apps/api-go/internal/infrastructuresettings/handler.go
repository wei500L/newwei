package infrastructuresettings

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

// Handler serves the seven infrastructure settings routes. It performs
// authentication, body decoding, the platform-admin gate and response writing;
// all persistence and normalization lives in Service.
//
// The evaluation order is fixed and matches NestJS: authentication
// (401) -> permission (403) -> DTO validation (400) -> platform-admin gate (403)
// -> business. A DELETE request has no DTO, so its gate runs right after the
// permission check.
type Handler struct {
	auth *Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the data access service.
func NewHandler(auth *Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one taken-over request. Methods outside the contract
// answer 404, but the routing table never sends them here.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case pathVectorService:
		h.serveVectorService(w, r)
	case pathStorageSettings:
		h.serveStorageSettings(w, r)
	case pathRuntimeSecrets:
		h.serveRuntimeSecrets(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveVectorService handles GET/PUT/DELETE /api/system-settings/vector-service.
func (h *Handler) serveVectorService(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getVectorPublicSettings(r.Context())
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
		dto, err := parseVectorSettingsRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateVectorSettings(r.Context(), identity.OrgID, identity.UserID, dto)
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
		settings, err := h.svc.resetVectorSettings(r.Context(), identity.OrgID, identity.UserID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveStorageSettings handles GET/PATCH /api/admin/settings/storage.
func (h *Handler) serveStorageSettings(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getStorageAdminSettings(r.Context())
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	case http.MethodPatch:
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		dto, err := parseStorageSettingsRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateStorageSettings(r.Context(), identity.OrgID, identity.UserID, dto)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
}

// serveRuntimeSecrets handles GET/PUT
// /api/system-settings/news-source-runtime-secrets.
func (h *Handler) serveRuntimeSecrets(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r)
	if identity == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := h.svc.getRuntimeSecretsPublic(r.Context())
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
		dto, err := parseRuntimeSecretsRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if err := h.auth.assertPlatformAdmin(r.Context(), identity.UserID); err != nil {
			writeServiceError(w, r, err)
			return
		}
		settings, err := h.svc.updateRuntimeSecrets(r.Context(), identity.OrgID, identity.UserID, dto)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, settings)
	default:
		http.NotFound(w, r)
	}
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
	encodeJSON() ([]byte, error)
}

// encodeJSON renders the public vector settings.
func (s vectorPublicSettings) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// encodeJSON renders the public storage settings.
func (s storageAdminSettings) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// encodeJSON renders the public runtime secrets.
func (s runtimeSecretsPublic) encodeJSON() ([]byte, error) { return json.Marshal(s) }

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
