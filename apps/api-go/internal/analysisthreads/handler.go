// Package analysisthreads 实现分析讨论和评论。
//
//	GET/PUT      /api/analysis/threads/{subjectType}/{subjectId}
//	POST         /api/analysis/threads/{subjectType}/{subjectId}/comments
//	PATCH/DELETE /api/analysis/comments/{commentId}
//
// 主体是否可读、以及视图或任务删除时的讨论清理，都走 analysiscollab。
// 本包不在那些删除里清理讨论；写入前会先 LockSubjectForWrite。
package analysisthreads

import (
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	threadsPrefix  = "/api/analysis/threads/"
	commentsPrefix = "/api/analysis/comments/"
	commentsTail   = "/comments"
)

type routeKind int

const (
	routeGetThread routeKind = iota
	routePutThread
	routeCreateComment
	routeUpdateComment
	routeDeleteComment
)

type route struct {
	kind        routeKind
	subjectType string
	subjectID   string
	commentID   string
}

// Handler 承接讨论和评论的五条路由。鉴权身份里的 orgId 是唯一组织边界。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 只接受恰好两段的讨论路径、其后精确接 /comments 的创建，
// 以及恰好一段的评论路径。更长、更短或方法不匹配都是 404。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	matched, ok := matchRoute(r.Method, r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch matched.kind {
	case routeGetThread:
		h.serveGet(w, r, matched.subjectType, matched.subjectID)
	case routePutThread:
		h.servePut(w, r, matched.subjectType, matched.subjectID)
	case routeCreateComment:
		h.serveCreateComment(w, r, matched.subjectType, matched.subjectID)
	case routeUpdateComment:
		h.serveUpdateComment(w, r, matched.commentID)
	case routeDeleteComment:
		h.serveDeleteComment(w, r, matched.commentID)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveGet(w http.ResponseWriter, r *http.Request, subjectType, subjectID string) {
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisRead)
	if !ok {
		return
	}
	parsed, err := analysiscollab.ParseSubjectType(subjectType)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	thread, err := h.svc.GetThread(r.Context(), principal.OrgID, principal.Actor.ID, parsed, subjectID)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	if thread == nil {
		analysiscollab.WriteNull(w, true)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusOK, thread, true)
}

func (h *Handler) servePut(w http.ResponseWriter, r *http.Request, subjectType, subjectID string) {
	raw, ok := readBody(w, r)
	if !ok {
		return
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	parsed, err := analysiscollab.ParseSubjectType(subjectType)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	body, err := analysiscollab.ValidateBody(raw, analysiscollab.UpsertThreadSpecs())
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	thread, err := h.svc.UpsertThread(r.Context(), principal.OrgID, principal.Actor, parsed, subjectID, body.StringPtr("noteMarkdown"))
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	if thread == nil {
		analysiscollab.WriteNull(w, false)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusOK, thread, false)
}

func (h *Handler) serveCreateComment(w http.ResponseWriter, r *http.Request, subjectType, subjectID string) {
	raw, ok := readBody(w, r)
	if !ok {
		return
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	parsed, err := analysiscollab.ParseSubjectType(subjectType)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	body, err := analysiscollab.ValidateBody(raw, analysiscollab.CreateCommentSpecs())
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	comment, err := h.svc.CreateComment(r.Context(), principal.OrgID, principal.Actor, parsed, subjectID, body.String("bodyMarkdown"))
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusCreated, comment, false)
}

func (h *Handler) serveUpdateComment(w http.ResponseWriter, r *http.Request, commentID string) {
	raw, ok := readBody(w, r)
	if !ok {
		return
	}
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	body, err := analysiscollab.ValidateBody(raw, analysiscollab.UpdateCommentSpecs())
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	comment, err := h.svc.UpdateComment(r.Context(), principal.OrgID, principal.Actor, commentID, body.String("bodyMarkdown"))
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteJSON(w, r, http.StatusOK, comment, false)
}

func (h *Handler) serveDeleteComment(w http.ResponseWriter, r *http.Request, commentID string) {
	principal, ok := analysiscollab.Authenticate(w, r, h.auth, analysiscollab.PermAnalysisWrite)
	if !ok {
		return
	}
	if h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if err := h.svc.DeleteComment(r.Context(), principal.OrgID, principal.Actor, commentID); err != nil {
		analysiscollab.WriteError(w, r, err)
		return
	}
	analysiscollab.WriteOK(w)
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := analysiscollab.ReadJSONBody(r)
	if err != nil {
		analysiscollab.WriteError(w, r, err)
		return nil, false
	}
	return raw, true
}

func matchRoute(method, urlPath string) (route, bool) {
	if strings.HasPrefix(urlPath, threadsPrefix) {
		rest := urlPath[len(threadsPrefix):]
		if method == http.MethodPost {
			if !strings.HasSuffix(rest, commentsTail) {
				return route{}, false
			}
			parts := pathSegments(strings.TrimSuffix(rest, commentsTail))
			if len(parts) != 2 {
				return route{}, false
			}
			return route{kind: routeCreateComment, subjectType: parts[0], subjectID: parts[1]}, true
		}
		parts := pathSegments(rest)
		if len(parts) != 2 {
			return route{}, false
		}
		switch method {
		case http.MethodGet:
			return route{kind: routeGetThread, subjectType: parts[0], subjectID: parts[1]}, true
		case http.MethodPut:
			return route{kind: routePutThread, subjectType: parts[0], subjectID: parts[1]}, true
		default:
			return route{}, false
		}
	}
	if strings.HasPrefix(urlPath, commentsPrefix) {
		parts := pathSegments(urlPath[len(commentsPrefix):])
		if len(parts) != 1 {
			return route{}, false
		}
		switch method {
		case http.MethodPatch:
			return route{kind: routeUpdateComment, commentID: parts[0]}, true
		case http.MethodDelete:
			return route{kind: routeDeleteComment, commentID: parts[0]}, true
		default:
			return route{}, false
		}
	}
	return route{}, false
}

func pathSegments(rest string) []string {
	if rest == "" || strings.HasPrefix(rest, "/") || strings.HasSuffix(rest, "/") {
		return nil
	}
	parts := strings.Split(rest, "/")
	for _, part := range parts {
		if part == "" {
			return nil
		}
	}
	return parts
}
