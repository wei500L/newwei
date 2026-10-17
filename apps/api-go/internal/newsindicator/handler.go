package newsindicator

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	basePath  = "/api/news-indicator"
	permRead  = "dashboards.read"
	permWrite = "settings.manage"
)

// Handler 只服务开关为 go 时接管的 3 条新闻指标接口。身份只来自鉴权链。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == basePath+"/associations" && r.Method == http.MethodGet:
		h.serveList(w, r)
	case path == basePath+"/refresh" && r.Method == http.MethodPost:
		h.serveRefresh(w, r)
	default:
		if id, ok := singleSegment(path, basePath+"/associations/"); ok && r.Method == http.MethodGet {
			h.serveDetail(w, r, id)
			return
		}
		http.NotFound(w, r)
	}
}

func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.ListAssociations(r.Context(), identity.OrgID, parseListOptions(r.URL.Query()))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveDetail(w http.ResponseWriter, r *http.Request, id string) {
	identity := h.authorize(w, r, permRead)
	if identity == nil {
		return
	}
	payload, err := h.svc.GetAssociation(r.Context(), identity.OrgID, id, parseGetOptions(r.URL.Query()))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if payload == nil {
		// NestJS 的 findFirst 返回 null：Express reply 对 null 走 res.send()，
		// 即 200 + 空响应体（不是 404）。
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveRefresh(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permWrite)
	if identity == nil {
		return
	}
	payload, err := h.svc.RefreshOrg(r.Context(), identity.OrgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// NestJS 的 POST 默认成功码是 201（控制器没有 @HttpCode 覆盖）。
	writeJSON(w, http.StatusCreated, payload)
}

// singleSegment 要求 prefix 之后恰好一个非空路径段。
func singleSegment(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := path[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var status *statusError
	if errors.As(err, &status) {
		authhttp.WriteHTTPException(w, r, status.status, status.message)
		return
	}
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	if errors.Is(err, errLockNotAcquired) {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
