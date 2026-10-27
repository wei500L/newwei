# GO-CUTOVER-PREREQS-001 · 补齐 Go 切默认前的横切能力

- 状态：`reserved`；提示词于 2026-10-27 发出，尚无编码开工证据。
- 规划基线：`f15f598d4358b4c9823054ef5a355618e1480a4e`；核对日期：2026-10-27（Europe/Moscow）。
- 来源：[#148](https://github.com/wei500L/newwei/pull/148) §7 第 1–4 项；四个稳定缺口见 [GAPS](../GAPS.md#2026-10-27-切默认前增量)。
- 执行提示词：[GO-CUTOVER-PREREQS-001.prompt.md](GO-CUTOVER-PREREQS-001.prompt.md)。
- 编码分支：`codex/go-cutover-prereqs`；建议 worktree：`/Users/oo/project/newwei-go-cutover-prereqs`，尚未创建。
- 记录已推送：`codex/plan-go-cutover-next` / [Ready 规划 PR #149](https://github.com/wei500L/newwei/pull/149)；编码 PR / head / merge SHA：无。规划 PR 的 CI 不能替代后续业务 PR 的 CI。
- 前置事实：#142–#147 的六个源 head 已逐一验证为 `origin/main` 祖先；#148 实际 merge 为 `0a48babea69700c7f9cd1bf2262f25d414469527`。
- 普通 CI：整合 head `79220a477cc8dad7df387fa67442c3bcd5d6a49e` 的 [run 40513400923](https://github.com/wei500L/newwei/actions/runs/40513400923) attempt 2 三个主要 job success，两个 regen job skipped；最新 main 的 [run 40518886959](https://github.com/wei500L/newwei/actions/runs/40518886959) 在 2026-10-27 17:21 MSK 交付复核时 **cancelled**（verify failure、vector-integration success、api-go-user-settings-integration cancelled），失败原因未证实，不能视为通过。前一 head `cc3782c0` 的 run 40518448341 亦 cancelled，其 Self-hosted Smoke success 不代替普通 CI。`f15f598d` 仅改 workflow 的 runs-on；不能据此断言失败由 runner 引起。
- 默认 / 部署 / 流量：本任务保持默认配置；未部署，真实流量与外部服务未验证。

## 范围与所有权

| 缺口 | 入口与事实源（规划基线） | 实现范围 |
|---|---|---|
| GAP-HTTP-HEADERS-001 | Nest `apps/api/src/main.ts:107` 的 `helmet()`；Go `apps/api-go/cmd/api/main.go:3367` 根 handler | Go HTTP 安全头；Swagger 与媒体响应的局部策略 |
| GAP-METRICS-WIRING-001 | `internal/metrics/families.go` 已有三类 API；Nest HTTP、ES、LiteLLM、pipeline metric provider 的真实调用点 | 根请求耗时、已有外部集成计数、租户 pipeline gauge 的生产接线 |
| GAP-EXCEPTION-WIRING-001 | Nest `common/filters/global-exception.filter.ts`；Go `cmd/api/legacy_fallback.go` 仅处理两类 404 | Go REST / GraphQL 错误到既有 `exceptionevents` 的事件接线 |
| GAP-ITEMS-BODY-001 | `internal/itemsingest/handler.go:150-151`；Nest `modules/items/items.controller.ts:28-30` | **`POST /api/items`** 的 JSON 上限与溢出错误契约 |

允许改 `apps/api-go/internal/{httpx,metrics,exceptioningest,graphqlread,apidocs,itemsingest}`、实际需要的 ES/LLM/告警 provider 调用点及 `cmd/api` 最小接线。保持所有 `API_GO_*` 默认、compose、Web 地址、Socket.IO 路径和 Node 服务不变。

共享 `cmd/api/main.go`、HTTP 包与 GraphQL 执行器只由本任务修改；后继 [GO-DEFAULT-CUTOVER-001](GO-DEFAULT-CUTOVER-001.md) 必须等本任务合入后再开工。保留 JWT、机器令牌、权限与 orgId 约束；指标不能新增租户数据读取入口，异常 orgId/userId 只能来自已验证身份。

## 验收与交接

四项均须有真实生产调用路径、行为测试和静态反证复核，不能只加导出函数或直接调用记录器的测试。使用普通 CI，记录最终精确 head 与逐 job 结果；本机不 build/test/install/Docker。交付 Ready PR，不合并、不 auto-merge。

报告补齐哪些错误会被记录、指标调用点、安全头策略、流式与 upgrade 兼容性、请求体边界，以及残留事实。编码窗口回填本任务和 PR，规划窗口统一回填共享地图；未合入 main 前四个 GAP 不关闭。

下一检查点：fetch 后核对实际 merge SHA、四项源码与最终 CI，再启动 GO-DEFAULT-CUTOVER-001。真实运行验收继续独立标为未完成。
