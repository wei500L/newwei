# REFACTOR-HTTP-ROUTER-001 · 路由预编译、包改名与迁移期注释清理

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-HTTP-ROUTER-001.prompt.md)

## 任务记录

- 状态：**merged**（PR #169，`8d97b0a5`；2026-11-05 规划窗口核实合入 main，最新 main `6ab26a54` 普通 CI success）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-RUNTIME-WIRING-001 合入且 CI 成功；可与 BULLMQ-PRODUCER 并行。
- 分支：`codex/refactor-http-router`；worktree：`/Users/oo/project/newwei-refactor-http-router`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-http-router` / [#169](https://github.com/wei500L/newwei/pull/169) / Ready（非 draft）。
- 最终 head SHA：代码 head `84458f2542f647bef79ae2b52317922ed12b38f8`（本交付记录为后续文档回填提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41922706900](https://github.com/wei500L/newwei/actions/runs/41922706900)，headSha `84458f25`，**conclusion=success**；`verify` / `globe-vendor` / `vector-integration` / `api-go-user-settings-integration` 均 success，两个 regen job skipped（skipped 不算通过）。
- 实际范围 / 排除项：`internal/legacyproxy → internal/httproute`、`internal/nestnotfound → internal/notfound` 全量改名（`Gateway→Router`、`RegisterGoHandler→Handle`、`SetGoHandler→HandleProcessHealth`）；`New` 稳定排序一次 + `Freeze` 预解析 handler（`Rule.handler`）；新增等价测试 `router_equivalence_test.go` 对照参考线性实现；`cmd/api/main.go` 在 listener 启动前调用 `gateway.Freeze()`；CI `ci.yml`、`AGENTS.md`、`apps/api-go/README.md`（四态/shadow/canary 段重写为纯 Go 路由表）、两个 `PROVENANCE.md` 路径同步；route 层 `With*` 与各 `handler.go` 类型注释清理迁移期措辞。排除：service/store 等全量注释重写；`apps/api-go/README.md` 更早的“配置表/入口切换/smoke”段落中的历史 `API_GO_*`/`SHADOW_*`/`CANARY_*` 记录未在本任务重写；`docs/refactor` 共享地图未动（由规划窗口回填）。
- 有意行为变更：无对外 HTTP/GraphQL/Socket 契约变更；`Freeze` 之后注册 handler 会 panic（编程错误防护）；测试直接驱动 Router 时首请求惰性解析一次（生产在启动时 Freeze，不在请求期解析）。
- 剩余问题：任务指定 grep `mode 为 go|开关为 go|回落 NestJS|legacy 不追加|shadow` 在 `internal/httproute` + `internal/*/handler.go` 由 69 → 17，剩余 17 处均为“路由前缀互相遮蔽（shadow）”的正当英文，非迁移语义；路由 `*_routes.go` 仍有少数早期英文注释保留 “legacy /api/” 兜底措辞（不在该 grep 命中项），按最小改动原则未全量重写，可另开注释批次；未在本机构建/测试、未部署、未连接真实 MySQL/Redis/Mongo，运行证据仅为普通 CI 精确 head。
