// Package analysisboards 实现组织分析看板和列。
//
//	GET/POST         /api/analysis/boards
//	GET/PATCH/DELETE /api/analysis/boards/{boardId}
//	POST             /api/analysis/boards/{boardId}/columns
//	POST             /api/analysis/boards/{boardId}/columns/reorder
//	PATCH/DELETE     /api/analysis/columns/{columnId}
//
// main 会把同一个 Handler 注册到 /api/analysis/boards 和 /api/analysis/columns。
// POST /boards/{boardId}/tasks 不属于这里。组织看板没有 owner 限制。
package analysisboards

import (
	"errors"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	boardsPath    = "/api/analysis/boards"
	columnsPrefix = "/api/analysis/columns/"

	routeList         = "list"
	routeCreateBoard  = "create-board"
	routeGetBoard     = "get-board"
	routeUpdateBoard  = "update-board"
	routeArchiveBoard = "archive-board"
	routeCreateColumn = "create-column"
	routeReorder      = "reorder-columns"
	routeUpdateColumn = "update-column"
	routeDeleteColumn = "delete-column"
)

var errDatabase = errors.New("analysis: database is not configured")

// Handler 处理看板和列的九条路由。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler 绑定鉴权链和看板服务。
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// Service 把看板服务交给任务移动。Service 实现 analysiscollab.BoardReader。
func (h *Handler) Service() *Service {
	return h.svc
}

// ServeHTTP 同时识别看板路径和列路径。更长的路径、任务路径和方法不匹配都是 404。
// 带正文的方法在鉴权之前读取 JSON。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	kind, boardID, columnID, ok := matchRoute(r.Method, r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	var raw []byte
	if readsBody(kind) {
		var err error
		raw, err = analysiscollab.ReadJSONBody(r)
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, permissionFor(kind))
	if !ok {
		return
	}
	if h.svc == nil {
		analysiscollab.WriteError(w, r, errDatabase)
		return
	}
	ctx := r.Context()
	switch kind {
	case routeList:
		boards, err := h.svc.ListBoards(ctx, principal.OrgID, principal.Actor)
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		analysiscollab.WriteJSON(w, r, http.StatusOK, boards, true)
	case routeCreateBoard:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.CreateBoardSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.CreateBoard(ctx, principal.OrgID, principal.Actor, body)
		writeBoard(w, r, http.StatusCreated, board, err)
	case routeGetBoard:
		board, err := h.svc.GetBoard(ctx, principal.OrgID, principal.Actor, boardID)
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		analysiscollab.WriteJSON(w, r, http.StatusOK, board, true)
	case routeUpdateBoard:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.UpdateBoardSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.UpdateBoard(ctx, principal.OrgID, principal.Actor, boardID, body)
		writeBoard(w, r, http.StatusOK, board, err)
	case routeArchiveBoard:
		if err := h.svc.ArchiveBoard(ctx, principal.OrgID, principal.Actor, boardID); err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		analysiscollab.WriteOK(w)
	case routeCreateColumn:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.CreateColumnSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.CreateColumn(ctx, principal.OrgID, principal.Actor, boardID, body)
		writeBoard(w, r, http.StatusCreated, board, err)
	case routeReorder:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.ReorderColumnSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.ReorderColumns(ctx, principal.OrgID, principal.Actor, boardID, body)
		writeBoard(w, r, http.StatusCreated, board, err)
	case routeUpdateColumn:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.UpdateColumnSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.UpdateColumn(ctx, principal.OrgID, principal.Actor, columnID, body)
		writeBoard(w, r, http.StatusOK, board, err)
	case routeDeleteColumn:
		body, err := analysiscollab.ValidateBody(raw, analysiscollab.DeleteColumnSpecs())
		if err != nil {
			analysiscollab.WriteError(w, r, err)
			return
		}
		board, err := h.svc.DeleteColumn(ctx, principal.OrgID, principal.Actor, columnID, body.String("moveCardsToColumnId"))
		writeBoard(w, r, http.StatusOK, board, err)
	default:
		http.NotFound(w, r)
	}
}

func writeBoard(w http.ResponseWriter, r *http.Request, status int, board analysiscollab.BoardDetail, err error) {
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, status, board, false)
}

func readsBody(kind string) bool {
	switch kind {
	case routeCreateBoard, routeUpdateBoard, routeCreateColumn, routeReorder, routeUpdateColumn, routeDeleteColumn:
		return true
	default:
		return false
	}
}

func permissionFor(kind string) string {
	switch kind {
	case routeList, routeGetBoard:
		return analysiscollab.PermAnalysisRead
	default:
		return analysiscollab.PermAnalysisWrite
	}
}

func matchRoute(method, path string) (kind, boardID, columnID string, ok bool) {
	if path == boardsPath {
		switch method {
		case http.MethodGet:
			return routeList, "", "", true
		case http.MethodPost:
			return routeCreateBoard, "", "", true
		default:
			return "", "", "", false
		}
	}
	if id, found := cutSegment(path, boardsPath+"/"); found {
		switch method {
		case http.MethodGet:
			return routeGetBoard, id, "", true
		case http.MethodPatch:
			return routeUpdateBoard, id, "", true
		case http.MethodDelete:
			return routeArchiveBoard, id, "", true
		default:
			return "", "", "", false
		}
	}
	// /columns/reorder 必须先于 /columns，但 HasSuffix 已经把两者分开。
	// /boards/{id}/tasks 以及更长的尾巴都落在这里之外。
	if id, found := pathBetween(path, boardsPath+"/", "/columns/reorder"); found && method == http.MethodPost {
		return routeReorder, id, "", true
	}
	if id, found := pathBetween(path, boardsPath+"/", "/columns"); found && method == http.MethodPost {
		return routeCreateColumn, id, "", true
	}
	if id, found := cutSegment(path, columnsPrefix); found {
		switch method {
		case http.MethodPatch:
			return routeUpdateColumn, "", id, true
		case http.MethodDelete:
			return routeDeleteColumn, "", id, true
		default:
			return "", "", "", false
		}
	}
	return "", "", "", false
}

func pathBetween(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	if len(path) < len(prefix)+len(suffix) {
		return "", false
	}
	return oneSegment(path[len(prefix) : len(path)-len(suffix)])
}

func cutSegment(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	return oneSegment(path[len(prefix):])
}

func oneSegment(value string) (string, bool) {
	if value == "" || strings.Contains(value, "/") {
		return "", false
	}
	return value, true
}
