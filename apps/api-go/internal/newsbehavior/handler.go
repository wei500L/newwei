package newsbehavior

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// RecordPath 与 ProfilePath 是精确路径。多出来的段由 ServeHTTP 回 404。
	RecordPath  = "/api/user-news-behavior"
	ProfilePath = "/api/user-news-behavior/profile"

	itemsReadPermission = "items.read"
)

var (
	recordedBody = []byte(`{"recorded":true}`)
	clearedBody  = []byte(`{"cleared":true}`)
)

// ServeHTTP 只接受三条精确路由。方法不匹配与多余路径段都是 404，
// 与 Nest 未注册路由的结果一致。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	switch r.URL.Path {
	case RecordPath:
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		h.record(w, r)
	case ProfilePath:
		switch r.Method {
		case http.MethodGet:
			h.profile(w, r)
		case http.MethodDelete:
			h.clear(w, r)
		default:
			http.NotFound(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) record(w http.ResponseWriter, r *http.Request) {
	raw, kind := readJSONBody(r)
	switch kind {
	case bodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return
	case bodyInvalidJSON:
		authhttp.WriteBadRequest(w, r, invalidJSONMessage(raw))
		return
	case bodyAbsent:
		raw = []byte("{}")
	}

	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	input, message := validateRecordBody(raw)
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	if h.svc == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	duplicate, err := h.svc.record(r.Context(), identity.OrgID, identity.UserID, input)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	if duplicate {
		// Nest POST 默认 201。res.send() 无参数时不写正文，也不设 JSON Content-Type。
		w.WriteHeader(http.StatusCreated)
		return
	}
	writeJSON(w, http.StatusCreated, recordedBody)
}

func (h *Handler) profile(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	if h.svc == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	payload, err := h.svc.profileJSON(r.Context(), identity.OrgID, identity.UserID)
	if err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) clear(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	if h.svc == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if err := h.svc.clear(r.Context(), identity.OrgID, identity.UserID); err != nil {
		writeFailure(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, clearedBody)
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h.auth == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(itemsReadPermission) {
		authhttp.WriteForbidden(w, r, []string{itemsReadPermission})
		return nil
	}
	return identity
}

func writeFailure(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("user-news-behavior: %v", err)
	switch {
	case errors.Is(err, errDBUnavailable):
		authhttp.WriteDatabaseFailure(w, r)
	case errors.Is(err, errRedis):
		authhttp.WriteRedisFailure(w, r)
	default:
		authhttp.WriteInternalFailure(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
