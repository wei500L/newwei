package qualityoverview

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	newsSourcesPath     = "/api/admin/quality/news-sources"
	pipelinePath        = "/api/admin/quality/pipeline"
	overviewPath        = "/api/admin/quality/overview"
	taskLogsPath        = "/api/admin/quality/task-logs"
	taskLogsSummaryPath = "/api/admin/quality/task-logs/summary"

	// 5 条统一的 @Permissions("settings.manage")。
	permissionManage = "settings.manage"
)

// Handler 只服务开关为 go 时接管的质量面板 5 条 GET。身份只来自鉴权链，
// orgId 一律取自身份（query 里的 orgId 不参与）。
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP 的 5 条路径与注册的路由规则一一对应（都是精确路径 + GET）。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case newsSourcesPath:
		h.serveNewsSources(w, r)
	case pipelinePath:
		h.servePipeline(w, r)
	case overviewPath:
		h.serveOverview(w, r)
	case taskLogsPath:
		h.serveTaskLogs(w, r)
	case taskLogsSummaryPath:
		h.serveTaskLogsSummary(w, r)
	default:
		http.NotFound(w, r)
	}
}

// authorize 与 adminlogs / llmlogs 的 authorize 相同：
//   - 缺少 Authorization 或不是 Bearer → 401；
//   - token 以 mtk_ 开头 → adminlogs 的 AuthenticateMachine（SHA-256 查
//     MachineAccessToken.tokenHash，连 Org.isActive，更新 lastUsedAt）；
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

func (h *Handler) serveNewsSources(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	window, hasWindow := parseWindowOption(querySingle(r.URL.Query(), "windowHours"))
	payload, err := h.svc.NewsSourceQuality(r.Context(), identity.OrgID, window, hasWindow)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) servePipeline(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	window, hasWindow := parseWindowOption(querySingle(r.URL.Query(), "windowMinutes"))
	payload, err := h.svc.PipelineQuality(r.Context(), identity.OrgID, window, hasWindow)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveOverview(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	window, hasWindow := parseWindowOption(querySingle(r.URL.Query(), "windowMinutes"))
	payload, err := h.svc.Overview(r.Context(), identity.OrgID, window, hasWindow)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) serveTaskLogs(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	filters := adminlogs.TaskLogListFilters{
		Queue:  normalizeText(querySingle(query, "queue")),
		JobID:  normalizeText(querySingle(query, "jobId")),
		Stage:  normalizeText(querySingle(query, "stage")),
		Status: normalizeTaskLogStatus(querySingle(query, "status")),
		Start:  parseSinceQuery(querySingle(query, "sinceMinutes")),
	}
	items, err := h.svc.TaskLogItems(r.Context(), identity.OrgID, filters, parseListLimit(querySingle(query, "limit")))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// 列表直接返回 items 数组（不是 {page, pageSize, total, items}）。
	writeJSON(w, http.StatusOK, items)
}

func (h *Handler) serveTaskLogsSummary(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := r.URL.Query()
	// summary 不接收 jobId。
	filters := adminlogs.TaskLogListFilters{
		Queue:  normalizeText(querySingle(query, "queue")),
		Stage:  normalizeText(querySingle(query, "stage")),
		Status: normalizeTaskLogStatus(querySingle(query, "status")),
		Start:  parseSinceQuery(querySingle(query, "sinceMinutes")),
	}
	summary, err := h.svc.TaskLogSummary(r.Context(), identity.OrgID, filters)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

// parseSinceQuery 把 sinceMinutes 收成可选时间下界（仅当 floor > 0 时生效）。
func parseSinceQuery(raw string) *time.Time {
	minutes, active := parseSinceMinutes(raw)
	if !active {
		return nil
	}
	start := time.Now().Add(-time.Duration(minutes) * time.Minute)
	return &start
}

// querySingle 读一个查询参数：恰好出现一次时返回其值；缺失或重复出现返回
// 空串——两种情况在控制器里都当 undefined（与 adminlogs 同一种做法）。
func querySingle(values url.Values, name string) string {
	items := values[name]
	if len(items) != 1 {
		return ""
	}
	return items[0]
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
		log.Printf("quality overview: response encode failed: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}

func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	// 机器令牌无效等定型错误复用 adminlogs 的 HTTP 映射（401）。
	if status, message, ok := adminlogs.HTTPStatus(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	log.Printf("quality overview: %v", err)
	if unavailable(err) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	authhttp.WriteInternalFailure(w, r)
}
