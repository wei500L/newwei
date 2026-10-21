package crawlfrontierruns

// The three write handlers reuse the read unit's identity chain, body reader and
// error writer. Only the success status differs from the read routes: none of
// the three NestJS handlers has an @HttpCode, so a POST succeeds with 201 like
// the cancellation routes above.

import (
	"errors"
	"net/http"
)

// errWriteServiceMissing guards against a mis-wired gateway that registered a
// write rule without attaching the write service.
var errWriteServiceMissing = errors.New("crawlfrontierruns: crawl frontier write service is not configured")

// serveCreateRun serves POST /runs (createRun).
func (h *Handler) serveCreateRun(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	if h.writes == nil {
		writeServiceError(w, r, errWriteServiceMissing)
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	fields, err := parseObjectBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	input, err := validateCreateRunBody(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.writes.CreateFrontierRun(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

// serveRetryNode serves POST /nodes/:id/retry (retryNode).
func (h *Handler) serveRetryNode(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	if h.writes == nil {
		writeServiceError(w, r, errWriteServiceMissing)
		return
	}
	payload, err := h.writes.RetryNode(r.Context(), identity.OrgID, id)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

// serveRetryNodes serves POST /nodes/retry (retryNodes).
func (h *Handler) serveRetryNodes(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	if h.writes == nil {
		writeServiceError(w, r, errWriteServiceMissing)
		return
	}
	body, ok := readJSON(w, r)
	if !ok {
		return
	}
	fields, err := parseObjectBody(body)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	ids, err := validateBulkBody(fields)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.writes.RetryNodes(r.Context(), identity.OrgID, ids)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}
