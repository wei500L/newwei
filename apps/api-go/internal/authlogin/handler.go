package authlogin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Handler dispatches the eleven exact routes. Anything else answers 404: the
// gateway only routes these paths and methods here, so an unexpected request
// must never be silently served by the wrong branch.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler wires the shared authenticator and the login service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP routes one request to its endpoint.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case PathLogin:
		h.serveLogin(w, r)
	case PathRefresh:
		h.serveRefresh(w, r)
	case PathSendLoginCode:
		h.serveSendLoginCode(w, r)
	case PathLoginWithCode:
		h.serveLoginWithCode(w, r)
	case PathPasswordForgot:
		h.servePasswordForgot(w, r)
	case PathPasswordReset:
		h.servePasswordReset(w, r)
	case PathMfaVerifyLogin:
		h.serveMfaVerifyLogin(w, r)
	case PathMfaEnrollmentStart:
		h.serveMfaEnrollmentStart(w, r)
	case PathMfaEnrollmentComplete:
		h.serveMfaEnrollmentComplete(w, r)
	case PathSendVerification:
		h.serveSendVerification(w, r)
	case PathVerifyEmail:
		h.serveVerifyEmail(w, r)
	default:
		http.NotFound(w, r)
	}
}

// requirePost rejects any non-POST method for an owned path. The route table
// already whitelists POST, so this only guards direct handler use.
func requirePost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return false
	}
	return true
}

// ---- public routes ----

func (h *Handler) serveLogin(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	request, ok := h.readLogin(w, r)
	if !ok {
		return
	}
	outcome, err := h.svc.login(r.Context(), request.Email, request.Password, request.OrgID,
		h.requestIP(r), requestUserAgent(r))
	h.writeLoginOutcome(w, r, outcome, err)
}

func (h *Handler) serveRefresh(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseRefreshRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	session, err := h.svc.refresh(r.Context(), request.RefreshToken, request.OrgID,
		h.requestIP(r), requestUserAgent(r))
	h.writeResponse(w, r, http.StatusOK, session, err)
}

func (h *Handler) serveSendLoginCode(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseEmailOnlyRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.sendLoginCode(r.Context(), request.Email)
	h.writeResponse(w, r, http.StatusOK, result, err)
}

func (h *Handler) serveLoginWithCode(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseLoginWithCodeRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	outcome, err := h.svc.loginWithCode(r.Context(), request.Email, request.Code, request.OrgID,
		h.requestIP(r), requestUserAgent(r))
	h.writeLoginOutcome(w, r, outcome, err)
}

func (h *Handler) servePasswordForgot(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseEmailOnlyRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// Forgot keeps the controller's own IP resolution (resolveRequestIp), which
	// prefers req.ip but falls back to the forwarded header and the socket.
	result, err := h.svc.requestPasswordReset(r.Context(), request.Email, h.resolveRequestIP(r), requestUserAgent(r))
	h.writeResponse(w, r, http.StatusOK, result, err)
}

func (h *Handler) servePasswordReset(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseResetPasswordRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.resetPassword(r.Context(), request.Token, request.Password, h.requestIP(r))
	h.writeResponse(w, r, http.StatusOK, result, err)
}

func (h *Handler) serveMfaVerifyLogin(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseMfaCodeRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	session, err := h.svc.completeMfaLogin(r.Context(), request.ChallengeID, request.Code,
		h.requestIP(r), requestUserAgent(r))
	h.writeResponse(w, r, http.StatusOK, session, err)
}

func (h *Handler) serveMfaEnrollmentStart(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseMfaEnrollmentStartRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.beginEnrollmentChallenge(r.Context(), request.ChallengeID,
		h.requestIP(r), requestUserAgent(r))
	// This route has no @HttpCode(200), so a successful enrollment start is a 201.
	h.writeResponse(w, r, http.StatusCreated, result, err)
}

func (h *Handler) serveMfaEnrollmentComplete(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseMfaCodeRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.completeMfaEnrollmentLogin(r.Context(), request.ChallengeID, request.Code,
		h.requestIP(r), requestUserAgent(r))
	h.writeResponse(w, r, http.StatusOK, result, err)
}

// ---- authenticated routes ----

func (h *Handler) serveSendVerification(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseEmailOnlyRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.sendVerificationCode(r.Context(), identity.UserID, identity.OrgID, request.Email, h.requestIP(r))
	h.writeResponse(w, r, http.StatusOK, result, err)
}

func (h *Handler) serveVerifyEmail(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	body, ok := h.readBody(w, r)
	if !ok {
		return
	}
	request, err := parseVerifyEmailRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	profile, err := h.svc.verifyEmail(r.Context(), identity.UserID, identity.OrgID, request.Code, h.requestIP(r))
	h.writeProfile(w, r, profile, err)
}

// ---- plumbing ----

// readLogin validates a login body. It reports false when the response was
// already written, so the caller only has to return.
func (h *Handler) readLogin(w http.ResponseWriter, r *http.Request) (loginRequest, bool) {
	body, ok := h.readBody(w, r)
	if !ok {
		return loginRequest{}, false
	}
	request, err := parseLoginRequest(body)
	if err != nil {
		writeServiceError(w, r, err)
		return loginRequest{}, false
	}
	return request, true
}

func (h *Handler) readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
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

// writeLoginOutcome renders whichever of the three trusted-login results came
// back. The concrete-type switch keeps the response set closed.
func (h *Handler) writeLoginOutcome(w http.ResponseWriter, r *http.Request, outcome loginOutcome, err error) {
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	switch typed := outcome.(type) {
	case sessionResult:
		h.writeResponse(w, r, http.StatusOK, typed, nil)
	case mfaChallengeResult:
		h.writeResponse(w, r, http.StatusOK, typed, nil)
	case enrollmentChallengeResult:
		h.writeResponse(w, r, http.StatusOK, typed, nil)
	default:
		authhttp.WriteInternalFailure(w, r)
	}
}

// encodedResponse is a response body that renders itself as JSON.
type encodedResponse interface{ responseBody() }

func (sessionResult) responseBody()             {}
func (mfaChallengeResult) responseBody()        {}
func (enrollmentChallengeResult) responseBody() {}
func (enrollmentCompleteResult) responseBody()  {}
func (mfaEnrollmentStartResult) responseBody()  {}
func (emailCodeSendResult) responseBody()       {}
func (okResult) responseBody()                  {}

// writeResponse renders one body the way Express res.json does: explicit charset
// and no trailing newline. HTML escaping is disabled because Go's default would
// rewrite `&`, `<` and `>` inside the otpauth URI (or any configured value) into
// \u0026 style escapes, which Express never produces.
func (h *Handler) writeResponse(w http.ResponseWriter, r *http.Request, status int, body encodedResponse, err error) {
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload, encodeErr := marshalNoEscape(body)
	if encodeErr != nil {
		writeServiceError(w, r, encodeErr)
		return
	}
	writeRawJSON(w, status, payload)
}

// writeProfile renders the authenticated profile, which is produced by the
// reused account-security port and therefore carries no marker method of its
// own. The bytes go through the same no-HTML-escaping encoder as every other
// body.
func (h *Handler) writeProfile(w http.ResponseWriter, r *http.Request, profile authenticatedUser, err error) {
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload, encodeErr := marshalNoEscape(profile)
	if encodeErr != nil {
		writeServiceError(w, r, encodeErr)
		return
	}
	writeRawJSON(w, http.StatusOK, payload)
}

// marshalNoEscape encodes a value without Go's HTML escaping, matching Express
// res.json byte for byte.
func marshalNoEscape[T any](value T) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func writeRawJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// requestIP mirrors `req.ip`: the Express trust-proxy resolved client address.
// The body is never consulted for an address.
func (h *Handler) requestIP(r *http.Request) *string {
	return clientIP(r, h.svc.cfg.TrustProxy)
}

// resolveRequestIP mirrors the controller's resolveRequestIp helper. Express
// always defines `req.ip` once a socket exists, so the documented fallback chain
// (forwarded header, then socket address) collapses onto the same value.
func (h *Handler) resolveRequestIP(r *http.Request) *string {
	return clientIP(r, h.svc.cfg.TrustProxy)
}

// clientIP reproduces the NestJS `trust proxy` resolution: with TRUST_PROXY
// unset the socket address is used and X-Forwarded-For is ignored, so a client
// cannot spoof the login and password-reset buckets. A numeric hop count indexes
// the forwarded chain from the right; any other configured value trusts the
// leftmost entry.
func clientIP(r *http.Request, trustProxy string) *string {
	if r == nil {
		return nil
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsed
	}
	host = strings.TrimPrefix(host, "::ffff:")
	trust := strings.TrimSpace(trustProxy)
	if trust == "" {
		return nonEmptyString(host)
	}
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded == "" {
		return nonEmptyString(host)
	}
	parts := strings.Split(forwarded, ",")
	hops := 1
	if parsed, err := strconv.Atoi(trust); err == nil && parsed > 0 {
		hops = parsed
	}
	index := len(parts) - hops
	if index < 0 {
		index = 0
	}
	ip := strings.TrimPrefix(strings.TrimSpace(parts[index]), "::ffff:")
	if ip == "" {
		return nonEmptyString(host)
	}
	return &ip
}

func requestUserAgent(r *http.Request) *string {
	if r == nil {
		return nil
	}
	return nonEmptyString(r.Header.Get("user-agent"))
}

func nonEmptyString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// ---- body reading ----

type bodyKind int

const (
	// bodyAbsent means the content type was not JSON; NestJS validates an empty
	// object in that case.
	bodyAbsent bodyKind = iota
	bodyOK
	bodyInvalidJSON
	bodyTooLarge
)

// readRequestBody reads a JSON body with the same 10 MiB limit main.ts configures.
func readRequestBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, bodyByteLimit)
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
