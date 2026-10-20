package pipelinerecovery

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
)

const (
	replayPath   = "/api/admin/quality/pipeline/replay"
	rollbackPath = "/api/admin/quality/pipeline/rollback"
)

// pipelineWriteBody is the @Body() shape of both write routes. The fields are
// pointers so a missing key, an explicit null and a non-string value stay
// distinguishable during decoding.
type pipelineWriteBody struct {
	ItemMetaID *string `json:"itemMetaId"`
	RawItemID  *string `json:"rawItemId"`
}

// serveReplay handles POST /api/admin/quality/pipeline/replay. NestJS applies
// the default @Post status, so a successful write is 201.
func (h *Handler) serveReplay(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body pipelineWriteBody
	if err := decodeJSONBody(r, &body); err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.Replay(r.Context(), identity.OrgID, stringValue(body.ItemMetaID), stringValue(body.RawItemID))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

// serveRollback handles POST /api/admin/quality/pipeline/rollback.
func (h *Handler) serveRollback(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	var body pipelineWriteBody
	if err := decodeJSONBody(r, &body); err != nil {
		writeServiceError(w, r, err)
		return
	}
	result, err := h.svc.Rollback(r.Context(), identity.OrgID, stringValue(body.ItemMetaID), stringValue(body.RawItemID))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, encoded)
}

// stringValue dereferences an optional JSON string. A missing field behaves like
// an empty string, which then fails the org-scoped ItemMeta lookup with the same
// 404 "Item not found" as every other unknown id instead of matching an
// arbitrary row: Prisma drops `id: undefined` from the where clause, and this
// endpoint must never operate on an item the caller did not name.
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// decodeJSONBody mirrors the migrated POST handlers: a non-JSON content type or
// an empty body is an empty object, and a malformed body is the NestJS
// body-parser 400 shape.
func decodeJSONBody(r *http.Request, target *pipelineWriteBody) error {
	if r.Body == nil {
		return nil
	}
	contentType := r.Header.Get("Content-Type")
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "application/json" {
			return nil
		}
	}
	payload, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return newStatus(400, "Invalid JSON body")
	}
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(trimmed), target); err != nil {
		return newStatus(400, "Invalid JSON body")
	}
	return nil
}
