package authfactors

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Handler serves the seven authenticated MFA management and organization OIDC
// configuration routes. It performs authentication, body decoding and response
// writing; all persistence and normalization lives in Service.
//
// The evaluation order is fixed and matches NestJS:
//
//	authentication (401) -> permission (403) -> DTO validation (400)
//	-> human-identity gate for the MFA writes (403) -> lock, business and writes.
//
// The routing table only ever sends the seven exact method/path combinations
// here; anything else answers 404 so a mis-registration can never silently
// serve a different method.
type Handler struct {
	auth *Authenticator
	svc  *Service
}

// NewHandler wires the authenticator and the data access service.
func NewHandler(auth *Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches one taken-over request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case PathMfaStatus:
		h.serveMfaStatus(w, r)
	case PathMfaEnroll:
		h.serveMfaEnroll(w, r)
	case PathMfaVerify:
		h.serveMfaVerify(w, r)
	case PathMfaDisable:
		h.serveMfaDisable(w, r)
	case PathMfaRotate:
		h.serveMfaRotate(w, r)
	case PathOidcConfig:
		h.serveOidcConfig(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveMfaStatus handles GET /api/auth/mfa.
//
// The route only requires an authenticated caller (AllowAuthenticated), so no
// permission is checked. Only the authenticated user id is used: no other user
// id can be supplied by the request.
func (h *Handler) serveMfaStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	status, err := h.svc.GetStatus(r.Context(), identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, status)
}

// serveMfaEnroll handles POST /api/auth/mfa/enroll.
//
// The NestJS handler declares no @Body DTO, so the request body is deliberately
// never read or validated here: a missing, empty or arbitrary body must not
// change the outcome.
func (h *Handler) serveMfaEnroll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	// The account name is always the caller's own stored email, resolved by the
	// service; a machine identity is rejected there before anything is read.
	enrollment, err := h.svc.BeginEnrollment(r.Context(), identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, enrollment)
}

// serveMfaVerify handles POST /api/auth/mfa/verify-enroll.
func (h *Handler) serveMfaVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	dto, ok := h.readVerifyCode(w, r)
	if !ok {
		return
	}
	response, err := h.svc.VerifyEnrollment(r.Context(), identity.UserID, dto.Code)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, response)
}

// serveMfaDisable handles POST /api/auth/mfa/disable.
func (h *Handler) serveMfaDisable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	dto, ok := h.readVerifyCode(w, r)
	if !ok {
		return
	}
	status, err := h.svc.Disable(r.Context(), identity.UserID, dto.Code)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, status)
}

// serveMfaRotate handles POST /api/auth/mfa/recovery/rotate.
func (h *Handler) serveMfaRotate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.authorize(w, r, "")
	if identity == nil {
		return
	}
	dto, ok := h.readVerifyCode(w, r)
	if !ok {
		return
	}
	response, err := h.svc.RotateRecoveryCodes(r.Context(), identity.UserID, dto.Code)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, response)
}

// serveOidcConfig handles GET and PUT /api/auth/admin/oidc-config.
//
// Both methods require settings.manage on the caller's own organization. The
// configuration is a tenant setting, so there is deliberately no global
// platform-admin gate: a machine token whose stored permissions include
// settings.manage may read and write the configuration of its own organization.
func (h *Handler) serveOidcConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		identity := h.auth.authorize(w, r, requiredPermission)
		if identity == nil {
			return
		}
		config, err := h.svc.GetOidcConfig(r.Context(), identity.OrgID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, config)
	case http.MethodPut:
		identity := h.auth.authorize(w, r, requiredPermission)
		if identity == nil {
			return
		}
		body, ok := readBodyOrFail(w, r)
		if !ok {
			return
		}
		dto, err := parseOidcConfigRequest(body)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		config, err := h.svc.UpdateOidcConfig(r.Context(), identity.OrgID, dto)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, config)
	default:
		http.NotFound(w, r)
	}
}

// readVerifyCode decodes and validates a VerifyMfaCodeDto body. It returns
// false when it already wrote the error response.
func (h *Handler) readVerifyCode(w http.ResponseWriter, r *http.Request) (verifyMfaCodeRequest, bool) {
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return verifyMfaCodeRequest{}, false
	}
	dto, err := parseVerifyMfaCodeRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return verifyMfaCodeRequest{}, false
	}
	return dto, true
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

// encodedResponse is a response body that renders itself as JSON.
type encodedResponse interface {
	responseBody()
}

// writeResponse renders one response body with the content type Express
// res.json produces (no trailing newline, explicit charset).
//
// The encoder disables HTML escaping: Go's default would rewrite `&`, `<` and
// `>` inside the otpauth URI (and inside any configured issuer or client id) as
// \u0026 / \u003c / \u003e, which Express never does and which would break the
// byte-for-byte contract comparison.
func writeResponse(w http.ResponseWriter, r *http.Request, status int, body encodedResponse) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
