package queueops

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

// queueManagePermission is the permission every route requires. It is the same
// organization-level permission Bull Board checks, but this console additionally
// requires the platform administrator role (audit finding B1): Bull Board lets any
// organization manager read every tenant's job data.
const queueManagePermission = "queue.manage"

// The twelve exact route paths. Queue names and job ids are never path segments:
// a BullMQ job id may contain "/" and ":", and the legacy proxy only supports at
// most two dynamic segments per rule.
const (
	pathQueues      = "/api/admin/queue-ops/queues"
	pathJobs        = "/api/admin/queue-ops/jobs"
	pathJobDetail   = "/api/admin/queue-ops/jobs/detail"
	pathJobRetry    = "/api/admin/queue-ops/jobs/retry"
	pathJobDelete   = "/api/admin/queue-ops/jobs/delete"
	pathJobPromote  = "/api/admin/queue-ops/jobs/promote"
	pathRetryFailed = "/api/admin/queue-ops/queues/retry-failed"
	pathClean       = "/api/admin/queue-ops/queues/clean"
	pathPause       = "/api/admin/queue-ops/queues/pause"
	pathResume      = "/api/admin/queue-ops/queues/resume"
	pathDLQReplay   = "/api/admin/queue-ops/dlq/replay"
	pathDLQDelete   = "/api/admin/queue-ops/dlq/delete"
)

// Handler serves the queue operations console.
type Handler struct {
	auth     *authhttp.Authenticator
	platform *platformgovernance.Authenticator
	svc      *Service
}

// NewHandler wires the shared authentication chain, the platform-admin gate and
// the console service.
func NewHandler(auth *authhttp.Authenticator, platform *platformgovernance.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, platform: platform, svc: svc}
}

// ServeHTTP dispatches the twelve exact paths.
//
// The routing table only sends a matching method to this handler, so a method
// mismatch here is a defensive 405 rather than the normal path. Everything else
// is a 404.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.platform == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	switch r.URL.Path {
	case pathQueues:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		h.serveQueues(w, r)
	case pathJobs:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		h.serveJobs(w, r)
	case pathJobDetail:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		h.serveJobDetail(w, r)
	case pathJobRetry:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveJobRetry(w, r)
	case pathJobDelete:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveJobDelete(w, r)
	case pathJobPromote:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveJobPromote(w, r)
	case pathRetryFailed:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveRetryFailed(w, r)
	case pathClean:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveClean(w, r)
	case pathPause:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.servePause(w, r)
	case pathResume:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveResume(w, r)
	case pathDLQReplay:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveDLQReplay(w, r)
	case pathDLQDelete:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		h.serveDLQDelete(w, r)
	default:
		http.NotFound(w, r)
	}
}

// authorize runs the full three-step chain: authentication (401), the
// organization-level queue.manage permission (403) and the platform administrator
// gate (403). It returns nil after writing the failure response.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(queueManagePermission) {
		authhttp.WriteForbidden(w, r, []string{queueManagePermission})
		return nil
	}
	if !h.platform.RequirePlatformAdmin(w, r, identity.UserID) {
		return nil
	}
	return identity
}

func (h *Handler) serveQueues(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r) == nil {
		return
	}
	payload, err := h.svc.ListQueues(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveJobs(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r) == nil {
		return
	}
	query, err := parseJobsQuery(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.ListJobs(r.Context(), query)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveJobDetail(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r) == nil {
		return
	}
	query, err := parseJobDetailQuery(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.JobDetail(r.Context(), query)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveJobRetry(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body jobRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, jobID, err := validateJobRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.Retry(r.Context(), actorOf(identity), queue, jobID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveJobDelete(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body jobRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, jobID, err := validateJobRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.Delete(r.Context(), actorOf(identity), queue, jobID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveJobPromote(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body jobRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, jobID, err := validateJobRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.Promote(r.Context(), actorOf(identity), queue, jobID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRetryFailed(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body retryFailedRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, err := validateQueueRequest(queueRequest{Queue: body.Queue})
	if err != nil {
		writeError(w, r, err)
		return
	}
	limit, err := validateBatchLimit(body.Limit, batchDefaultLimit, batchMaxLimit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.RetryFailed(r.Context(), actorOf(identity), queue, limit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveClean(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body cleanRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, err := validateQueueRequest(queueRequest{Queue: body.Queue})
	if err != nil {
		writeError(w, r, err)
		return
	}
	state, err := parseCleanState(body.State)
	if err != nil {
		writeError(w, r, err)
		return
	}
	grace, err := validateGrace(body.Grace)
	if err != nil {
		writeError(w, r, err)
		return
	}
	limit, err := validateBatchLimit(body.Limit, batchDefaultLimit, batchMaxLimit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.Clean(r.Context(), actorOf(identity), queue, state, grace, limit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) servePause(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body queueRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, err := validateQueueRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.Pause(r.Context(), actorOf(identity), queue)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveResume(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body queueRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	queue, err := validateQueueRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	payload, err := h.svc.Resume(r.Context(), actorOf(identity), queue)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDLQReplay(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body dlqReplayRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	plan, err := validateDLQReplayRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if plan.Single {
		result, err := h.svc.ReplayDLQ(r.Context(), actorOf(identity), plan.JobIDs[0], plan.DryRun)
		if err != nil {
			writeError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, DLQReplayResponse{Results: []DLQReplayResult{result}})
		return
	}
	payload, err := h.svc.ReplayDLQBatch(r.Context(), actorOf(identity), plan)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDLQDelete(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body dlqDeleteRequest
	if !readJSONBody(w, r, &body) {
		return
	}
	jobIDs, single, err := validateDLQDeleteRequest(body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if single {
		result, err := h.svc.DeleteDLQ(r.Context(), actorOf(identity), jobIDs[0])
		if err != nil {
			writeError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, DLQDeleteResponse{Results: []DLQDeleteResult{result}})
		return
	}
	payload, err := h.svc.DeleteDLQBatch(r.Context(), actorOf(identity), jobIDs)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// actorOf projects a verified identity onto the audit actor.
func actorOf(identity *authhttp.Identity) Actor {
	if identity == nil {
		return Actor{}
	}
	return Actor{OrgID: identity.OrgID, UserID: identity.UserID}
}

// requireMethod answers 405 for a method the route does not serve.
func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	authhttp.WriteHTTPException(w, r, http.StatusMethodNotAllowed, "Method Not Allowed")
	return false
}

// readJSONBody decodes one request body into its typed DTO. An empty or malformed
// body is the same 400 the ValidationPipe/body-parser pair produces.
func readJSONBody[T any](w http.ResponseWriter, r *http.Request, target *T) bool {
	reader := http.MaxBytesReader(w, r.Body, maxJSONBytes)
	body, err := io.ReadAll(reader)
	if err != nil {
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		authhttp.WriteBadRequest(w, r, "Unexpected end of JSON input")
		return false
	}
	if err := json.Unmarshal(body, target); err != nil {
		authhttp.WriteBadRequest(w, r, "Invalid JSON body")
		return false
	}
	return true
}

// writeJSON writes one JSON response the way Express res.json does: a
// content-type header and the marshalled body, without a trailing newline.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
