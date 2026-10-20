package crawltaskwrite

import (
	"errors"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// Paths served by the queue control unit.
const (
	queuePath            = "/api/admin/crawl4ai/queue"
	queuePausePath       = queuePath + "/pause"
	queueResumePath      = queuePath + "/resume"
	queueConcurrencyPath = queuePath + "/concurrency"
)

// QueueHandler serves the four crawl4ai queue administration routes. The
// routes are independent of the crawl task write switch.
type QueueHandler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewQueueHandler builds the handler.
func NewQueueHandler(auth *authhttp.Authenticator, svc *Service) *QueueHandler {
	return &QueueHandler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the four exact paths.
func (h *QueueHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case queuePath:
		if r.Method == http.MethodGet {
			h.serveStatus(w, r)
			return
		}
	case queuePausePath:
		if r.Method == http.MethodPost {
			h.servePause(w, r)
			return
		}
	case queueResumePath:
		if r.Method == http.MethodPost {
			h.serveResume(w, r)
			return
		}
	case queueConcurrencyPath:
		if r.Method == http.MethodPost {
			h.serveConcurrency(w, r)
			return
		}
	}
	http.NotFound(w, r)
}

func (h *QueueHandler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if h == nil || h.svc == nil || h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

func (h *QueueHandler) serveStatus(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, queueReadPermission) == nil {
		return
	}
	payload, err := h.svc.QueueStatus(r.Context())
	if err != nil {
		writeQueueError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *QueueHandler) servePause(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, queueManagePermission) == nil {
		return
	}
	payload, err := h.svc.PauseQueue(r.Context())
	if err != nil {
		writeQueueError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *QueueHandler) serveResume(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, queueManagePermission) == nil {
		return
	}
	payload, err := h.svc.ResumeQueue(r.Context())
	if err != nil {
		writeQueueError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (h *QueueHandler) serveConcurrency(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, queueManagePermission)
	if identity == nil {
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	value, err := parseConcurrencyBody(body)
	if err != nil {
		writeQueueError(w, r, err)
		return
	}
	ctx := WithTraceID(r.Context(), httpx.TraceIDFromContext(r.Context()))
	payload, err := h.svc.UpdateQueueConcurrency(ctx, identity, value)
	if err != nil {
		writeQueueError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

// writeQueueError maps queue control failures. Redis errors answer the generic
// 500; a MySQL failure answers 503.
func writeQueueError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	var validation *validationError
	if errors.As(err, &validation) {
		authhttp.WriteBadRequest(w, r, strings.Join(validation.Messages(), "; "))
		return
	}
	var typed *statusError
	if errors.As(err, &typed) {
		if typed.status >= http.StatusInternalServerError {
			authhttp.WriteInternalFailure(w, r)
			return
		}
		authhttp.WriteHTTPException(w, r, typed.status, typed.message)
		return
	}
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}
