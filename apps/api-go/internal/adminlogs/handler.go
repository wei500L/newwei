package adminlogs

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	taskPath             = "/api/admin/logs/task"
	taskSummaryPath      = "/api/admin/logs/task/summary"
	errorsPath           = "/api/admin/logs/errors"
	errorsSummaryPath    = "/api/admin/logs/errors/summary"
	auditPath            = "/api/admin/logs/audit"
	adminErrorsPath      = "/api/admin/errors"
	adminErrorsStatsPath = "/api/admin/errors/stats"

	// permission 是 7 条 GET 统一的 @Permissions("settings.manage")。
	permission = "settings.manage"

	defaultPage     = 1
	defaultPageSize = 20
	maxPageSize     = 100
	defaultLimit    = 50
	maxLimit        = 200
)

// Handler 只服务开关为 go 时接管的管理端日志与异常读取 7 条 GET。
// 身份只来自鉴权链，orgId 一律取自身份（query 里的 orgId 不参与）。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 的 7 条路径与注册的路由规则一一对应（都是精确路径 + GET）。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case taskPath:
		h.serveTaskLogs(w, r)
	case taskSummaryPath:
		h.serveTaskLogSummary(w, r)
	case errorsPath:
		h.serveErrors(w, r)
	case errorsSummaryPath:
		h.serveErrorsSummary(w, r)
	case auditPath:
		h.serveAuditLogs(w, r)
	case adminErrorsPath:
		h.serveAdminErrors(w, r)
	case adminErrorsStatsPath:
		h.serveAdminErrorsStats(w, r)
	default:
		http.NotFound(w, r)
	}
}

// authorize 与 newssources/crawlprofile/crawltemplate 的 authorize 相同：
//   - 缺少 Authorization 或不是 Bearer → 401（文案与 authhttp.WriteUnauthorized 一致）；
//   - token 以 mtk_ 开头 → 本包的 AuthenticateMachine（不调用 authhttp.Authenticate，
//     因为它会拒绝 mtk_）；查不到/已撤销/已过期/组织停用 → 401 Invalid machine token；
//   - 其他 token → authhttp.Authenticate（membership 重推导；JWT 里的 permissions 不算）；
//   - 缺少 settings.manage → 403 authhttp.WriteForbidden。
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, required string) *authhttp.Identity {
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
	if !identity.HasPermission(required) {
		authhttp.WriteForbidden(w, r, []string{required})
		return nil
	}
	return identity
}

func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// ---- 7 条端点：校验顺序与 NestJS 控制器逐一对应 ----

func (h *Handler) serveTaskLogs(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	start, end, err := parseDateRange(querySingle(query, "start"), querySingle(query, "end"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	page, err := parsePositiveIntQuery("page", querySingle(query, "page"), defaultPage)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	pageSize, err := parsePositiveIntQuery("pageSize", querySingle(query, "pageSize"), defaultPageSize)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	status, err := normalizeTaskLogStatus(querySingle(query, "status"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	filters := taskLogFilters{
		queue:  normalizeText(querySingle(query, "queue")),
		jobId:  normalizeText(querySingle(query, "jobId")),
		stage:  normalizeText(querySingle(query, "stage")),
		status: status,
		start:  start,
		end:    end,
	}
	payload, err := h.svc.ListTaskLogs(r.Context(), identity.OrgID, filters, page, pageSize)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveTaskLogSummary(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	start, end, err := parseDateRange(querySingle(query, "start"), querySingle(query, "end"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	status, err := normalizeTaskLogStatus(querySingle(query, "status"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	filters := taskLogFilters{
		queue:  normalizeText(querySingle(query, "queue")),
		jobId:  normalizeText(querySingle(query, "jobId")),
		stage:  normalizeText(querySingle(query, "stage")),
		status: status,
		start:  start,
		end:    end,
	}
	payload, err := h.svc.SummarizeTaskLogs(r.Context(), identity.OrgID, filters)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveErrors(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	start, end, err := parseDateRange(querySingle(query, "start"), querySingle(query, "end"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	page, err := parsePositiveIntQuery("page", querySingle(query, "page"), defaultPage)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	pageSize, err := parsePositiveIntQuery("pageSize", querySingle(query, "pageSize"), defaultPageSize)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	kind, err := normalizeExceptionEventKind(querySingle(query, "kind"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	filters := exceptionFilters{
		kind:            kind,
		operationName:   normalizeText(querySingle(query, "operationName")),
		messageContains: normalizeText(querySingle(query, "messageContains")),
		start:           start,
		end:             end,
	}
	payload, err := h.svc.ListExceptionEvents(r.Context(), identity.OrgID, filters, page, pageSize)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveErrorsSummary(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	start, end, err := parseDateRange(querySingle(query, "start"), querySingle(query, "end"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	kind, err := normalizeExceptionEventKind(querySingle(query, "kind"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	filters := exceptionFilters{
		kind:            kind,
		operationName:   normalizeText(querySingle(query, "operationName")),
		messageContains: normalizeText(querySingle(query, "messageContains")),
		start:           start,
		end:             end,
	}
	payload, err := h.svc.ExceptionStats(r.Context(), identity.OrgID, filters)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveAuditLogs(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	start, end, err := parseDateRange(querySingle(query, "start"), querySingle(query, "end"))
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	page, err := parsePositiveIntQuery("page", querySingle(query, "page"), defaultPage)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	pageSize, err := parsePositiveIntQuery("pageSize", querySingle(query, "pageSize"), defaultPageSize)
	if err != nil {
		writeInputError(w, r, err)
		return
	}
	filters := auditFilters{
		search:   normalizeText(querySingle(query, "search")),
		resource: normalizeText(querySingle(query, "resource")),
		action:   normalizeText(querySingle(query, "action")),
		start:    start,
		end:      end,
	}
	payload, err := h.svc.ListAuditLogs(r.Context(), identity.OrgID, filters, page, pageSize)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// serveAdminErrors 对齐 admin-errors.controller.ts 的宽松参数规则：kind 不在
// 枚举内当 undefined，limit/offset 非有限数走缺省，都不抛 400。
func (h *Handler) serveAdminErrors(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	limit := float64(defaultLimit)
	if parsed, present := parseLimit(querySingle(query, "limit")); present {
		limit = parsed
	}
	offset := float64(0)
	if parsed, present := parseLimit(querySingle(query, "offset")); present {
		offset = parsed
	}
	kind := lenientExceptionEventKind(querySingle(query, "kind"))
	filters := exceptionFilters{
		kind:            kind,
		operationName:   normalizeText(querySingle(query, "operationName")),
		messageContains: normalizeText(querySingle(query, "messageContains")),
	}
	// admin/errors 的 start/end 由 service 的 parseDate 解析：非法日期忽略该
	// 条件、start > end 也不报错（照样查出 0 条）。
	filters.startRaw = querySingle(query, "start")
	filters.endRaw = querySingle(query, "end")
	payload, err := h.svc.ListExceptionEventsLenient(
		r.Context(), identity.OrgID, filters, clampLimit(limit), clampOffset(offset))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveAdminErrorsStats(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r, permission)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	kind := lenientExceptionEventKind(querySingle(query, "kind"))
	filters := exceptionFilters{
		kind:            kind,
		operationName:   normalizeText(querySingle(query, "operationName")),
		messageContains: normalizeText(querySingle(query, "messageContains")),
		startRaw:        querySingle(query, "start"),
		endRaw:          querySingle(query, "end"),
	}
	payload, err := h.svc.ExceptionStatsLenient(r.Context(), identity.OrgID, filters)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// ---- 响应写出 ----

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
	log.Printf("admin logs: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	// Mongo 查询失败与其它未捕获错误都是 500 Internal server error
	// （NestJS 侧同样由 GlobalExceptionFilter 兜底成这个形状）。
	authhttp.WriteInternalFailure(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("admin logs: response encode failed: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
