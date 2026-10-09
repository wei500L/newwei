// Package dashboardstats 接管 GET /api/dashboard/stats。
//
// 只在 API_GO_DASHBOARD_STATS_MODE=go 时由 main 注册。默认 legacy，
// 该路径继续代理 NestJS。回滚就是把模式改回 legacy，不改表、不复制数据。
//
// 请求链与 user-settings 只读 GET 相同：access token 验签、Redis 撤销
// 检查、MySQL membership/RBAC 重推导、items.read。orgId 只来自这次
// 重推导。不读 JWT permissions，不读 query/body 里的 orgId，也不把请求
// 转回 NestJS。
//
// 数据与 DashboardService.stats 的 Promise.all 一致：
//   - MySQL ItemMeta 按 orgId 计数；
//   - Mongo processeditems 按同一 orgId 计数；
//   - Mongo tasklogs 中 queue=itemPipeline 的最近 10 条；
//   - Redis 组织计数 hash。Redis 失败时五个计数归零且
//     queueCountsAvailable=false，请求仍成功。
// MySQL 或 Mongo 任一失败则整请求失败，不用 0 冒充空数据。
// 不启动队列 worker，不写 Redis 计数。
package dashboardstats

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Path 是唯一接管的精确路径。
const Path = "/api/dashboard/stats"

// requiredPermission 与 @Permissions("items.read") 相同。
const requiredPermission = "items.read"

// requestAuth 是 authhttp.Authenticator 上用到的方法。
type requestAuth interface {
	Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity
}

// opener 在失败时已经写出响应。成功时 orgID 是服务端确认的组织。
type opener interface {
	Open(http.ResponseWriter, *http.Request) (orgID string, ok bool)
}

type membershipGate struct {
	auth requestAuth
}

func (g membershipGate) Open(w http.ResponseWriter, r *http.Request) (string, bool) {
	identity := g.auth.Authenticate(w, r)
	if identity == nil {
		return "", false
	}
	if !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return "", false
	}
	return identity.OrgID, true
}

// Handler 写出与 NestJS stats 相同的 JSON。
type Handler struct {
	gate opener
	src  source
}

// NewHandler 使用生产鉴权链。
func NewHandler(auth *authhttp.Authenticator, src source) *Handler {
	return &Handler{gate: membershipGate{auth: auth}, src: src}
}

// statsBody 的字段顺序与 DashboardService.stats 的返回对象一致。
type statsBody struct {
	ItemCount            int64       `json:"itemCount"`
	ProcessedCount       int64       `json:"processedCount"`
	Queue                queueCounts `json:"queue"`
	QueueCountsAvailable bool        `json:"queueCountsAvailable"`
	RecentQueueLogs      []recentLog `json:"recentQueueLogs"`
}

// ServeHTTP 只接受 GET。其他方法不应进入（路由白名单）；进来则 404。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	orgID, ok := h.gate.Open(w, r)
	if !ok {
		return
	}
	body, status, err := h.load(r.Context(), orgID)
	if err != nil {
		log.Printf("dashboard stats: load failed (status=%d)", status)
		if status == http.StatusServiceUnavailable {
			authhttp.WriteDatabaseFailure(w, r)
			return
		}
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// load 并行执行三路查询，对齐 Promise.all。
// MySQL 失败 → 503（与本网关其他 Prisma 查询失败相同）。
// Mongo 计数或 TaskLog 失败 → 500（mongoose 错误在 Nest 生产环境是 500）。
// 两路都失败时保留 MySQL 的 503。Redis 失败不进入这里。
func (h *Handler) load(ctx context.Context, orgID string) ([]byte, int, error) {
	var (
		itemCount    int64
		itemErr      error
		processed    int64
		processedErr error
		logs         []recentLog
		logsErr      error
		queue        queueCounts
		queueOK      bool
	)
	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		itemCount, itemErr = h.src.CountItems(ctx, orgID)
	}()
	go func() {
		defer wg.Done()
		processed, processedErr = h.src.CountProcessed(ctx, orgID)
	}()
	go func() {
		defer wg.Done()
		logs, logsErr = h.src.RecentLogs(ctx, orgID)
	}()
	go func() {
		defer wg.Done()
		queue, queueOK = h.src.QueueCounts(ctx, orgID)
	}()
	wg.Wait()

	if itemErr != nil {
		return nil, http.StatusServiceUnavailable, itemErr
	}
	if processedErr != nil {
		return nil, http.StatusInternalServerError, processedErr
	}
	if logsErr != nil {
		return nil, http.StatusInternalServerError, logsErr
	}
	if logs == nil {
		logs = []recentLog{}
	}
	if !queueOK {
		queue = zeroQueue()
	}
	encoded, err := json.Marshal(statsBody{
		ItemCount:            itemCount,
		ProcessedCount:       processed,
		Queue:                queue,
		QueueCountsAvailable: queueOK,
		RecentQueueLogs:      logs,
	})
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return encoded, http.StatusOK, nil
}
