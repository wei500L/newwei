package accountsecurity

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

// Handler serves the eight account/session/machine-token routes. It performs
// authentication, body decoding, DTO validation and response writing; all
// persistence and normalization lives in Service.
//
// The evaluation order is fixed and matches NestJS: authentication (401) ->
// permission (403) -> DTO validation (400) -> service rules and data access.
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
	case "/api/auth/me":
		h.serveMe(w, r)
	case "/api/auth/profile":
		h.serveProfile(w, r)
	case "/api/auth/change-password":
		h.serveChangePassword(w, r)
	case "/api/auth/logout":
		h.serveLogout(w, r)
	case "/api/auth/machine-tokens":
		h.serveMachineTokens(w, r)
	default:
		h.serveMachineTokenByID(w, r)
	}
}

// serveMe handles GET /api/auth/me.
func (h *Handler) serveMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "")
	if identity == nil {
		return
	}

	if identity.IsMachine {
		machine := identity.Machine
		writeResponse(w, r, http.StatusOK, machineProfileResponse{
			ID:                    machineActorPrefix + machine.TokenID,
			Email:                 machine.Name + "@machine.local",
			EmailVerified:         nil,
			LastLoginAt:           nil,
			PendingEmail:          nil,
			OrgID:                 identity.OrgID,
			PrimaryRoleID:         nil,
			RoleIDs:               []string{},
			Permissions:           machine.Permissions,
			FirstName:             machine.Name,
			LastName:              "Machine",
			AvatarURL:             nil,
			IsActive:              true,
			PlanTier:              machine.PlanTier,
			SubscriptionStatus:    machine.SubscriptionStatus,
			GlobalRoles:           []string{},
			MFAEnabled:            false,
			MFARequired:           false,
			MFAEnrollmentRequired: false,
		})
		return
	}

	profile, err := h.svc.getProfile(r.Context(), identity.UserID, identity.ClaimOrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// GET /me layers the verified request metadata on the cached base profile.
	// Absent metadata stays omitted instead of being faked with 0.
	if identity.AccessTokenID != "" {
		profile.AccessTokenID = identity.AccessTokenID
	}
	if !identity.AccessTokenExpiresAt.IsZero() {
		millis := identity.AccessTokenExpiresAt.UnixMilli()
		profile.AccessTokenExpiresAt = &millis
	}
	writeResponse(w, r, http.StatusOK, profile)
}

// serveProfile handles PATCH /api/auth/profile. The response intentionally has
// no accessTokenId/accessTokenExpiresAt (unlike GET /me).
func (h *Handler) serveProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "")
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseUpdateProfileRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	profile, err := h.svc.updateProfile(r.Context(), identity.UserID, identity.ClaimOrgID, request)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, profile)
}

// serveChangePassword handles POST /api/auth/change-password.
func (h *Handler) serveChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "")
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseChangePasswordRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	currentPassword, _ := jsonString(request.CurrentPassword)
	newPassword, _ := jsonString(request.NewPassword)
	if err := h.svc.changePassword(r.Context(), identity.UserID, identity.ClaimOrgID, currentPassword, newPassword); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, okResponse{OK: true})
}

// serveLogout handles POST /api/auth/logout. The success status is 201 because
// the NestJS handler carries no @HttpCode(200).
func (h *Handler) serveLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "")
	if identity == nil {
		return
	}
	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	request, err := parseLogoutRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	refreshToken, logoutAll := logoutValues(request)
	if err := h.svc.logout(r.Context(), identity, refreshToken, logoutAll); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, okResponse{OK: true})
}

// serveMachineTokens handles GET/POST /api/auth/machine-tokens. Both require
// settings.manage.
func (h *Handler) serveMachineTokens(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodPost:
	default:
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "settings.manage")
	if identity == nil {
		return
	}

	if r.Method == http.MethodGet {
		items, err := h.svc.listMachineTokens(r.Context(), identity.OrgID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusOK, items)
		return
	}

	body, ok := readBodyOrFail(w, r)
	if !ok {
		return
	}
	values, err := parseCreateMachineTokenRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	created, err := h.svc.createMachineToken(r.Context(), identity, values)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusCreated, created)
}

// serveMachineTokenByID handles DELETE /api/auth/machine-tokens/:tokenId and
// POST /api/auth/machine-tokens/:tokenId/rotate. Only an exactly-one-segment
// tokenId is accepted, and /rotate must be the last segment.
func (h *Handler) serveMachineTokenByID(w http.ResponseWriter, r *http.Request) {
	rest, ok := strings.CutPrefix(r.URL.Path, "/api/auth/machine-tokens/")
	if !ok || rest == "" {
		http.NotFound(w, r)
		return
	}

	if strings.HasSuffix(rest, "/rotate") {
		tokenID := strings.TrimSuffix(rest, "/rotate")
		if tokenID == "" || strings.Contains(tokenID, "/") {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		identity := h.auth.Authorize(w, r, "settings.manage")
		if identity == nil {
			return
		}
		rotated, err := h.svc.rotateMachineToken(r.Context(), identity, tokenID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		writeResponse(w, r, http.StatusCreated, rotated)
		return
	}

	if strings.Contains(rest, "/") {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodDelete {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authorize(w, r, "settings.manage")
	if identity == nil {
		return
	}
	if err := h.svc.revokeMachineToken(r.Context(), identity.OrgID, rest); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeResponse(w, r, http.StatusOK, revokeResponse{Revoked: true})
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
