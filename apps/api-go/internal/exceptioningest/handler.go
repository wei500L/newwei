package exceptioningest

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

// The two migrated paths. Both rules are exact path + POST in the proxy route
// table, so the handler only ever sees those exact paths.
const (
	clientPath   = "/api/observability/exception-events/client"
	internalPath = "/api/internal/observability/exception-events"

	// maxJSONBytes mirrors the other takeover units' JSON body ceiling.
	maxJSONBytes = 10 << 20
)

// Handler serves the two migrated exception-report POST endpoints. The client
// endpoint keeps @AllowAuthenticated (identity only, no permission check); the
// internal endpoint keeps the LiteLLM internal token guard.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler builds a handler around the shared authenticator and service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches by exact path. The proxy route table already limits the
// methods to POST and preflight OPTIONS.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case clientPath:
		h.serveClient(w, r)
	case internalPath:
		h.serveInternal(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveClient mirrors ClientExceptionEventsController.report:
// authenticated identity -> normalize (invalid payloads do not spend quota) ->
// user bucket -> optional IP bucket -> best-effort insert -> 201 {"ok":true}.
func (h *Handler) serveClient(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil || h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	event, message := normalizeClientReport(body, r.Header.Get("x-trace-id"))
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	if !h.enforceClientRateLimit(w, r, identity.OrgID, identity.UserID) {
		return
	}
	h.svc.RecordClient(r.Context(), identity.OrgID, identity.UserID, event)
	writeOK(w)
}

// serveInternal mirrors InternalExceptionEventsController.report. It does not
// run the user JWT chain: only the internal bearer token is accepted.
func (h *Handler) serveInternal(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if !h.svc.authorizeInternal(w, r) {
		return
	}
	body, ok := readJSONBody(w, r)
	if !ok {
		return
	}
	event, message := normalizeInternalReport(body, r.Header.Get("x-trace-id"))
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	h.svc.RecordInternal(r.Context(), event)
	writeOK(w)
}

// enforceClientRateLimit consumes the user bucket first and the IP bucket
// second, exactly like the controller. The keys are the controller's logical
// keys; consumeRateLimit adds the shared "rate:" Redis prefix.
func (h *Handler) enforceClientRateLimit(w http.ResponseWriter, r *http.Request, orgID, userID string) bool {
	cfg := h.svc.config
	userKey := "observability:client-exception:user:" + orgID + ":" + userID
	if !h.svc.consumeRateLimit(r.Context(), userKey, cfg.UserRateLimit, cfg.RateLimitWindowSeconds) {
		authhttp.WriteHTTPException(w, r, http.StatusTooManyRequests,
			"Too many client exception events from this user. Please retry later.")
		return false
	}
	ip := h.svc.clientIP(r)
	if ip == "" {
		return true
	}
	ipKey := "observability:client-exception:ip:" + orgID + ":" + ip
	if !h.svc.consumeRateLimit(r.Context(), ipKey, cfg.IPRateLimit, cfg.RateLimitWindowSeconds) {
		authhttp.WriteHTTPException(w, r, http.StatusTooManyRequests,
			"Too many client exception events from this IP. Please retry later.")
		return false
	}
	return true
}

// readJSONBody reads the request body the way express.json would: a non-JSON
// content type or an empty body is an empty object, an unparseable body is 400,
// and an oversized body maps to the same 500 the Nest production filter emits.
func readJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.Body == nil || !jsonContentType(r.Header.Get("Content-Type")) {
		return []byte("{}"), true
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			authhttp.WritePayloadTooLarge(w, r)
			return nil, false
		}
		authhttp.WriteBadRequest(w, r, invalidJSONMessage)
		return nil, false
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return []byte("{}"), true
	}
	if !json.Valid(trimmed) {
		authhttp.WriteBadRequest(w, r, invalidJSONMessage)
		return nil, false
	}
	return trimmed, true
}

func jsonContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	return err == nil && media == "application/json"
}

// writeOK writes the legacy success payload with HTTP 201.
func writeOK(w http.ResponseWriter) {
	encoded, err := json.Marshal(okResponse{OK: true})
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(encoded)
}
