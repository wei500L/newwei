// Package health 是 api-go 首个真实业务迁移单元（迁移序 2：低副作用只读端点）。
//
// 迁移范围：
//   - GET /api/healthz/live：公开存活探针，返回 {"status":"ok"}。
//     对齐 apps/api/src/modules/health/health.controller.ts:75-84：
//     无版本号、无时间戳（避免未认证调用方的版本泄露）。
//
// 尚未迁移（NestJS 保留为事实源）：
//   - GET /api/healthz（AllowAuthenticated + 真实依赖探针：MySQL/Redis/
//     Mongo/crawl4ai/LLM/disk + 5s 缓存）——需要数据库连接层，属后续单元。
//
// 回滚：路由表中 /api/healthz/live 改回 ModeLegacy 即回滚（配置变更）。
package health

import (
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// LiveHandler 处理 GET /api/healthz/live。
//
// 契约对齐（NestJS HealthController.getLiveness）：
//   - 状态码 200；响应体恰好为 {"status":"ok"}（JSON 等价）。
//   - 公开端点：无 JWT、无权限校验；无 Cache-Control 头（NestJS 版没有）。
//   - 不读取请求体。
func LiveHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		// NestJS 路由只注册 GET：其他方法 404（由 Express 默认行为决定）。
		http.NotFound(w, r)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// LiveResult 返回 live 探针的 Result 形状（shadow 差分执行用）。
func LiveResult() *ExecResult {
	return &ExecResult{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"status":"ok"}` + "\n"),
	}
}

// ExecResult 是 health 模块的执行结果（实现 shadow.Executant 的 Result 契约）。
type ExecResult struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}
