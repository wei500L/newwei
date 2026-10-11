package analysistasks

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	routeCreate = "create"
	routeUpdate = "update"
	routeDelete = "delete"
	routeMove   = "move"
)

// Handler 处理任务卡片的四条写路由。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 先读 JSON，再鉴权。创建和移动返回 201，更新返回 200，删除返回 {ok:true}。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	kind, id, ok := matchRoute(r.Method, r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	raw, err := analysiscollab.ReadJSONBody(r)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errServiceUnavailable)
		return
	}

	switch kind {
	case routeCreate:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.CreateTaskSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		card, err := h.svc.CreateTask(r.Context(), principal.OrgID, principal.Actor, id, body)
		writeTask(w, r, http.StatusCreated, card, err)
	case routeUpdate:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.UpdateTaskSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		card, err := h.svc.UpdateTask(r.Context(), principal.OrgID, principal.Actor, id, body)
		writeTask(w, r, http.StatusOK, card, err)
	case routeDelete:
		if err := h.svc.DeleteTask(r.Context(), principal.OrgID, principal.Actor, id); err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		analysiscollab.WriteOK(w)
	case routeMove:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.MoveTaskSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.MoveTask(r.Context(), principal.OrgID, principal.Actor, id, body)
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		analysiscollab.WriteJSON(w, r, http.StatusCreated, board, false)
	default:
		http.NotFound(w, r)
	}
}

func writeTask(w http.ResponseWriter, r *http.Request, status int, card analysiscollab.TaskCard, err error) {
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, status, card, false)
}

func matchRoute(method, path string) (kind, id string, ok bool) {
	switch method {
	case http.MethodPost:
		if boardID, found := pathBetween(path, "/api/analysis/boards/", "/tasks"); found {
			return routeCreate, boardID, true
		}
		if taskID, found := pathBetween(path, "/api/analysis/tasks/", "/move"); found {
			return routeMove, taskID, true
		}
	case http.MethodPatch:
		if taskID, found := pathSegment(path, "/api/analysis/tasks/"); found {
			return routeUpdate, taskID, true
		}
	case http.MethodDelete:
		if taskID, found := pathSegment(path, "/api/analysis/tasks/"); found {
			return routeDelete, taskID, true
		}
	}
	return "", "", false
}

func pathBetween(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	if len(path) < len(prefix)+len(suffix) {
		return "", false
	}
	return singleSegment(path[len(prefix) : len(path)-len(suffix)])
}

func pathSegment(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	return singleSegment(path[len(prefix):])
}

func singleSegment(value string) (string, bool) {
	if value == "" || strings.Contains(value, "/") {
		return "", false
	}
	return value, true
}
