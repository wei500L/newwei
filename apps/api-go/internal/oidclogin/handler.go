package oidclogin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

const bodyByteLimit = 10 << 20

// Handler is the public HTTP adapter for the three exact routes.
type Handler struct {
	svc *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{svc: service}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == PathStart:
		h.serveStart(w, r)
	case r.Method == http.MethodGet && r.URL.Path == PathCallback:
		h.serveCallback(w, r)
	case r.Method == http.MethodPost && r.URL.Path == PathExchange:
		h.serveExchange(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveStart redirects to the real IdP authorization URL. A missing "org"
// query parameter is not defaulted: the source dereferences the value, so the
// missing-parameter boundary stays a server error rather than silently choosing
// an organization.
func (h *Handler) serveStart(w http.ResponseWriter, r *http.Request) {
	values, present := r.URL.Query()["org"]
	if !present {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	identifier := ""
	if len(values) > 0 {
		identifier = values[0]
	}
	target, err := h.svc.Start(r.Context(), identifier)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// serveCallback always answers a 302 to the web callback page after the
// front-end URL is built. Business failures are URL-encoded into the error
// parameter and never become a JSON 4xx; success writes exactly one of the
// handoff/challenge parameters.
func (h *Handler) serveCallback(w http.ResponseWriter, r *http.Request) {
	frontend, err := h.svc.frontendCallbackURL()
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	query := r.URL.Query()
	result, callbackErr := h.svc.Callback(r.Context(), CallbackParams{
		State:     queryPointer(query, "state"),
		Code:      queryPointer(query, "code"),
		Error:     queryPointer(query, "error"),
		IPAddress: authloginClientIP(r, h.svc.cfg.TrustProxy),
		UserAgent: requestUserAgent(r),
	})
	callbackQuery := frontend.Query()
	if callbackErr != nil {
		callbackQuery.Set("error", callbackErrorMessage(callbackErr))
	} else {
		switch {
		case result.HandoffToken != "":
			callbackQuery.Set("handoffToken", result.HandoffToken)
		case result.EnrollmentChallengeID != "":
			callbackQuery.Set("enrollmentChallengeId", result.EnrollmentChallengeID)
		case result.AuthChallengeID != "":
			callbackQuery.Set("challengeId", result.AuthChallengeID)
		default:
			callbackQuery.Set("error", "OIDC login failed")
		}
	}
	frontend.RawQuery = callbackQuery.Encode()
	http.Redirect(w, r, frontend.String(), http.StatusFound)
}

// serveExchange validates the DTO exactly like @IsString: a missing, null or
// non-string handoffToken is a 400, while an empty string reaches the service
// and answers the source 401.
func (h *Handler) serveExchange(w http.ResponseWriter, r *http.Request) {
	body, kind := readJSONBody(r)
	switch kind {
	case bodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return
	case bodyInvalid:
		authhttp.WriteBadRequest(w, r, "Unexpected token in JSON body")
		return
	}
	var request struct {
		HandoffToken json.RawMessage `json:"handoffToken"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		authhttp.WriteBadRequest(w, r, "handoffToken must be a string")
		return
	}
	trimmed := bytes.TrimSpace(request.HandoffToken)
	if len(trimmed) == 0 || string(trimmed) == "null" || trimmed[0] != '"' {
		authhttp.WriteBadRequest(w, r, "handoffToken must be a string")
		return
	}
	var handoffToken string
	if err := json.Unmarshal(trimmed, &handoffToken); err != nil {
		authhttp.WriteBadRequest(w, r, "handoffToken must be a string")
		return
	}
	result, err := h.svc.Exchange(r.Context(), handoffToken, requestUserAgent(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSONResult(w, http.StatusOK, result)
}

type bodyKind int

const (
	bodyOK bodyKind = iota
	bodyAbsent
	bodyInvalid
	bodyTooLarge
)

func readJSONBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return []byte("{}"), bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, bodyByteLimit)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalid
	}
	if len(bytes.TrimSpace(data)) == 0 || !json.Valid(data) {
		return data, bodyInvalid
	}
	return data, bodyOK
}

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

func queryPointer(values url.Values, key string) *string {
	if _, present := values[key]; !present {
		return nil
	}
	value := values.Get(key)
	return &value
}

func requestUserAgent(r *http.Request) *string {
	value := r.Header.Get("user-agent")
	if value == "" {
		return nil
	}
	return &value
}

// authloginClientIP keeps the shared TRUST_PROXY resolution behind the exported
// authlogin port.
func authloginClientIP(r *http.Request, trustProxy string) *string {
	return authlogin.ClientIP(r, trustProxy)
}

func writeJSONResult(w http.ResponseWriter, status int, body ExchangeResult) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return
	}
	_, _ = w.Write(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
}
