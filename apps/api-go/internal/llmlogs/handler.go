package llmlogs

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// 三条精确路径（全局前缀 api）。
	basePath    = "/api/llm-logs"
	exportPath  = basePath + "/export"
	summaryPath = basePath + "/summary"

	// 权限与控制器上的 @Permissions("settings.manage") 一致。
	permissionManage = "settings.manage"
)

// Handler 只服务开关为 go 时接管的三条只读 GET。身份只来自鉴权链。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 的分派顺序与路由规则一致（三条都是精确路径，互不为前缀）。
// 更长路径与未列出的方法在路由层已经回落 NestJS，不会走到这里。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case basePath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveList(w, r)
	case exportPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveExport(w, r)
	case summaryPath:
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.serveSummary(w, r)
	default:
		http.NotFound(w, r)
	}
}

// serveList 与控制器 list 同序：先 page/pageSize，再 parseLogFilter。
func (h *Handler) serveList(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	values := r.URL.Query()
	page, pageSize, err := parsePagination(values)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	filter, err := parseListFilter(values, identity.OrgID)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.QueryLogs(r.Context(), filter, page, pageSize)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveSummary 与控制器 summary 同参（没有 model/requestType/status）。
func (h *Handler) serveSummary(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	filter, err := parseSummaryFilter(r.URL.Query(), identity.OrgID)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	payload, err := h.svc.GetUsageSummary(r.Context(), filter)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveExport 与 exportLogsCsvStream 同序：校验日期窗口 → 探测行数 →
// 建立游标 → 写成功审计 → 输出 CSV。任一步失败都写失败审计再返回，
// 审计失败不阻断响应。
func (h *Handler) serveExport(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	filter, err := parseListFilter(r.URL.Query(), identity.OrgID)
	if err != nil {
		writeInputError(w, r, err)
		return
	}

	startedAt := time.Now()
	actorID := auditActorID(identity)
	normalized := normalizeFilterForExport(filter)
	rowCount := int64(0)

	fail := func(cause error) {
		message := cause.Error()
		h.svc.WriteExportAuditLog(r.Context(), exportAuditArgs{
			OrgID:        normalized.OrgID,
			ActorID:      actorID,
			Outcome:      "failure",
			RowCount:     rowCount,
			DurationMs:   time.Since(startedAt).Milliseconds(),
			Filter:       normalized,
			ErrorMessage: &message,
		})
		writeInputError(w, r, cause)
	}

	if err := ValidateExportDateWindow(normalized); err != nil {
		fail(err)
		return
	}
	where := buildWhere(normalized)
	rowCount, err = h.svc.ResolveExportRowCount(r.Context(), where)
	if err != nil {
		fail(err)
		return
	}
	cursor, openErr := h.svc.OpenExportCursor(r.Context(), where)
	if openErr != nil {
		fail(openErr)
		return
	}
	defer func() { _ = cursor.Close(r.Context()) }()

	h.svc.WriteExportAuditLog(r.Context(), exportAuditArgs{
		OrgID:      normalized.OrgID,
		ActorID:    actorID,
		Outcome:    "success",
		RowCount:   rowCount,
		DurationMs: time.Since(startedAt).Milliseconds(),
		Filter:     normalized,
	})

	w.Header().Set("content-type", "text/csv; charset=utf-8")
	w.Header().Set("content-disposition", `attachment; filename="`+exportFilename+`"`)
	w.WriteHeader(http.StatusOK)
	if err := StreamExportCSV(r.Context(), w, cursor); err != nil {
		// 响应头已发出，不能再改状态码；与 NestJS 的流式失败一致。
		log.Printf("llm logs export: stream failed: %v", err)
	}
}

// authorize 与 newssources/crawlprofile/crawltemplate 的 authorize 相同：
//   - 缺少 Authorization 或不是 Bearer → 401；
//   - token 以 mtk_ 开头 → AuthenticateMachine（查不到/撤销/过期/组织
//     停用 → 401 Invalid machine token），不调用 authhttp.Authenticate；
//   - 其他 token → authhttp.Authenticate（membership 重推导；JWT 里的
//     permissions 不算）；
//   - 缺少 settings.manage → 403。
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.AuthenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if h.auth == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(permissionManage) {
		authhttp.WriteForbidden(w, r, []string{permissionManage})
		return nil
	}
	return identity
}

// auditActorID 对齐控制器传的 actorId：人类令牌用用户 id；机器令牌传
// null，避免 AuditLog.actorId 的外键失败。
func auditActorID(identity *authhttp.Identity) *string {
	if identity == nil || strings.HasPrefix(identity.UserID, "machine:") {
		return nil
	}
	actor := identity.UserID
	return &actor
}

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
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

func writeInputError(w http.ResponseWriter, r *http.Request, err error) {
	var input *inputError
	if errors.As(err, &input) {
		authhttp.WriteBadRequest(w, r, input.Message)
		return
	}
	writeServiceError(w, r, err)
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
	log.Printf("llm logs: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}
