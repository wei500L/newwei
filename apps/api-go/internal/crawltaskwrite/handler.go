package crawltaskwrite

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// Paths served by this unit. The exact path and the method decide ownership;
// every other method and path keeps proxying to NestJS.
const (
	crawlTasksPath        = "/api/crawl-tasks"
	crawlTaskDeletePrefix = "/api/crawl-tasks/"
	maxJSONBytes          = 10 << 20
)

// Handler serves the three crawl task write routes.
type Handler struct {
	auth       *authhttp.Authenticator
	svc        *Service
	trustProxy string
}

// NewHandler builds the handler. trustProxy mirrors TRUST_PROXY for the
// client-IP rate limit bucket.
func NewHandler(auth *authhttp.Authenticator, svc *Service, trustProxy string) *Handler {
	return &Handler{auth: auth, svc: svc, trustProxy: trustProxy}
}

// ServeHTTP dispatches the three routes.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == crawlTasksPath && r.Method == http.MethodPost:
		h.serveCreate(w, r)
	case strings.HasPrefix(path, crawlTaskDeletePrefix):
		rest := strings.TrimPrefix(path, crawlTaskDeletePrefix)
		if rest == "" {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(rest, "/retry") {
			id := strings.TrimSuffix(rest, "/retry")
			if r.Method == http.MethodPost && id != "" && !strings.Contains(id, "/") {
				h.serveRetry(w, r, decodePathSegment(id))
				return
			}
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodDelete && !strings.Contains(rest, "/") {
			h.serveDelete(w, r, decodePathSegment(rest))
			return
		}
	}
	http.NotFound(w, r)
}

// authorize runs the shared authentication chain and enforces crawl.write.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	if h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(permissionCrawlWrite) {
		authhttp.WriteForbidden(w, r, []string{permissionCrawlWrite})
		return nil
	}
	return identity
}

func (h *Handler) serveCreate(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	validation := crawloptions.ValidateCreateTaskREST(r.Context(), body, h.svc.Validator())
	if len(validation.Messages) > 0 {
		authhttp.WriteBadRequest(w, r, strings.Join(validation.Messages, "; "))
		return
	}
	ctx := WithTraceID(r.Context(), httpx.TraceIDFromContext(r.Context()))
	view, err := h.svc.CreateTask(ctx, identity, validation.Input, h.clientIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (h *Handler) serveDelete(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	ctx := WithTraceID(r.Context(), httpx.TraceIDFromContext(r.Context()))
	if err := h.svc.DeleteTask(ctx, identity, id); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, deleteResponse{OK: true})
}

func (h *Handler) serveRetry(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	ctx := WithTraceID(r.Context(), httpx.TraceIDFromContext(r.Context()))
	view, err := h.svc.RetryTask(ctx, identity, id, h.clientIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

// clientIP mirrors resolveRequestIp through the shared TRUST_PROXY-aware
// helper.
func (h *Handler) clientIP(r *http.Request) *string {
	return authlogin.ClientIP(r, h.trustProxy)
}

// deleteResponse is the {ok:true} payload of DELETE /api/crawl-tasks/:id.
type deleteResponse struct {
	OK bool `json:"ok"`
}

// readJSON reads the body with the same 10 MiB ceiling the other Go write
// handlers use.
func readJSON(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	reader := http.MaxBytesReader(w, r.Body, maxJSONBytes)
	body, err := io.ReadAll(reader)
	if err != nil {
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return nil, false
	}
	return body, true
}

// writeServiceError maps the service errors onto the NestJS HTTP shape.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	var validation *validationError
	if errors.As(err, &validation) {
		authhttp.WriteBadRequest(w, r, strings.Join(validation.Messages(), "; "))
		return
	}
	var policy *crawloptions.PolicyError
	if errors.As(err, &policy) {
		authhttp.WriteBadRequest(w, r, policy.Message)
		return
	}
	var typed *statusError
	if errors.As(err, &typed) {
		if typed.status >= http.StatusInternalServerError {
			// NestJS does not expose an error field for a non-HttpException
			// 500/503; the payload is just statusCode + message.
			authhttp.WriteInternalFailure(w, r)
			return
		}
		authhttp.WriteHTTPException(w, r, typed.status, typed.message)
		return
	}
	if unavailable(err) {
		log.Printf("crawltaskwrite: database unavailable: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("crawltaskwrite: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// writeJSON writes the Express res.json byte shape (no trailing newline).
func writeJSON(w http.ResponseWriter, status int, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// decodePathSegment applies decodeURIComponent-equivalent decoding.
func decodePathSegment(raw string) string {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return raw
	}
	return decoded
}
