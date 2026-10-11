// Package analysisviews 提供分析工作台保存视图的五条路由。
//
//	GET/POST         /api/analysis/views
//	GET/PATCH/DELETE /api/analysis/views/{id}
//
// 校验、查询串、权限和行锁使用 analysiscollab。orgId 只来自身份。
package analysisviews

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const viewsCollectionPath = "/api/analysis/views"

// Handler 处理保存视图。main 稍后把它注册到 legacyproxy.AnalysisViewsKey。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler 绑定鉴权链和视图服务。
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 接收原始 URL。详情路径恰好一段；更长或其他方法是 404。
// 带正文的方法在鉴权前读取 JSON。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	id, collection, ok := matchViewPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch {
	case collection && r.Method == http.MethodGet:
		h.list(w, r)
	case collection && r.Method == http.MethodPost:
		h.create(w, r)
	case !collection && r.Method == http.MethodGet:
		h.get(w, r, id)
	case !collection && r.Method == http.MethodPatch:
		h.update(w, r, id)
	case !collection && r.Method == http.MethodDelete:
		h.delete(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisRead)
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errDatabase)
		return
	}
	views, err := h.svc.ListViews(r.Context(), principal, r.URL.RawQuery)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusOK, views, true)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request, id string) {
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisRead)
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errDatabase)
		return
	}
	view, err := h.svc.GetView(r.Context(), principal, id)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusOK, view, true)
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	raw, ok := readMutationBody(w, r)
	if !ok {
		return
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errDatabase)
		return
	}
	view, err := h.svc.CreateView(r.Context(), principal, raw)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusCreated, view, false)
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request, id string) {
	raw, ok := readMutationBody(w, r)
	if !ok {
		return
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errDatabase)
		return
	}
	view, err := h.svc.UpdateView(r.Context(), principal, id, raw)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusOK, view, false)
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request, id string) {
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errDatabase)
		return
	}
	if err := h.svc.DeleteView(r.Context(), principal, id); err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteOK(w)
}

func readMutationBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := analysiscollab.ReadJSONBody(r)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return nil, false
	}
	return raw, true
}

func matchViewPath(path string) (id string, collection bool, ok bool) {
	if path == viewsCollectionPath {
		return "", true, true
	}
	const prefix = viewsCollectionPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", false, false
	}
	id = path[len(prefix):]
	if id == "" || strings.Contains(id, "/") {
		return "", false, false
	}
	return id, false, true
}
