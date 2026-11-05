# REFACTOR-LOCKS-001 · Redis 租约与 MySQL GET_LOCK 各收敛为一份

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-LOCKS-001.prompt.md)

## 任务记录

- 状态：**merged**（PR #166，整合 #168 → `51525856`；2026-11-05 规划窗口核实合入 main，最新 main `6ab26a54` 普通 CI success）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-SAFE-GOROUTINE-001 合入且 CI 成功；可与 RUNTIME-WIRING 并行。
- 分支：`codex/refactor-locks`；worktree：`/Users/oo/project/newwei-refactor-locks`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-locks` / [#166](https://github.com/wei500L/newwei/pull/166) / Ready（非 draft）。
- 最终代码 head SHA：`0ab38a558c669a26d3322611291177b96d82abdf`（本交付记录为同分支追加的文档提交，不改代码）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41838309587](https://github.com/wei500L/newwei/actions/runs/41838309587)，`conclusion=success`，`headSha=0ab38a558c669a26d3322611291177b96d82abdf`；`verify`（含 Build、Go tests、Lint、Typecheck、Web 组件测试、Go 契约门）、`api-go-user-settings-integration`、`vector-integration`、`globe-vendor` 均 success；`contract-baseline-regen`/`go-modules-regen` skipped（regen，不计通过）。此前同分支首轮 run 41834995647 在 verify 的 Go tests 上仅因新加 `TestWithRenewableLockCancelsOnLost` 的测试替身写错而失败，修正测试后新 head 全绿。
- 实际范围：新增 `internal/platform/mysqllock`；重写 `internal/cronlock`（`Store` 接口、`WithLease`、`RenewMode`、`Acquire/Lease`、`WithLock/WithRenewableLock` 保持语义）；迁移 searchreindex / newsbackfilljobs / auditoutbox / crawlmaintenance / newsnowsources / gdeltsnapshot 六处 Redis 互斥租约到 cronlock 并删除各自脚本/续期/释放副本；6 个 MySQL GET_LOCK 域（dataruntimesettings / infrastructuresettings / authfactors / platformgovernance / modelaccesssettings / llmgatewayprofiles）改调 mysqllock，modelaccess 与 llmgateway 不再新建独立连接池，`cmd/api/llm_gateway_profiles.go` 删除 lockDB 创建。**排除**：telegramclient 长租约按提示词允许保留（生命周期与 cronlock 回调模型差异大）；tick gate 与缓存/去重/限流类 SetNX 全部保持原样；额外发现的 `contentsubscriptions`/`situationmonitors`/`newsindicator` 三份 `fn(ctx,*sql.Conn)` 式 GET_LOCK 与 `newsnowhottest`/`crawlreadtelemetry`/`qualityoverview`/`classificationrssops` 的缓存重建锁在允许范围外，已在 PR 说明并建议后续任务。
- 有意行为变更：①`platformgovernance` 获得释放失败逐出连接（缺陷修复，原会把仍持锁会话还回池）；②RELEASE_LOCK 超时统一 5s 且统一 `context.WithoutCancel`；③`mysqllock` 将 GET_LOCK NULL 归为不可用（dataruntime/authfactors/infra/modelaccess/llmgw 映射不变，仅 platformgovernance 由 409 变 500，NULL 仅内部错误出现）；④modelaccess/llmgateway 不再每次新建连接池。物理 Redis key、锁名、GET_LOCK 等待秒数、锁 value 形制、token 校验释放均不变。
- 剩余问题：本机未安装依赖、未运行 `go build`/`go test`/`go vet`/Docker/服务，运行证据仅普通 CI 精确 head；未连接真实 Redis/MySQL/Mongo/LiteLLM；滚动发布与 NestJS 混合版本互斥仅静态等价保证，未做实机验证。

