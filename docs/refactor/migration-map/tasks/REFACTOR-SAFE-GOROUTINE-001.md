# REFACTOR-SAFE-GOROUTINE-001 · 后台 goroutine panic 隔离

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-SAFE-GOROUTINE-001.prompt.md)

## 任务记录

- 状态：**merged**（PR #162，整合 #165 → `742ebdba`；2026-11-05 规划窗口核实合入 main，最新 main `6ab26a54` 普通 CI success）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：无。
- 分支：`codex/refactor-safe-goroutine`；worktree：`/Users/oo/project/newwei-refactor-safe-goroutine`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-safe-goroutine` / [#162](https://github.com/wei500L/newwei/pull/162) / Ready（非 draft）。
- 最终 head SHA（代码）：`88d8376c1e50bbd693b7b9ac9eccd599be42a445`（本交付记录为同分支追加的文档提交，不改代码）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41817077172](https://github.com/wei500L/newwei/actions/runs/41817077172)，`conclusion=success`，`headSha=88d8376c1e50bbd693b7b9ac9eccd599be42a445`。`verify`（含 Build、`Go tests (api-go gateway + vector-go)`、Lint、Typecheck、Web 组件测试、Go 契约门）、`api-go-user-settings-integration`、`vector-integration`、`globe-vendor` 均 success；`contract-baseline-regen`/`go-modules-regen` skipped（regen，不计通过，也非主 job）。
- 实际范围 / 排除项：新增 `apps/api-go/internal/safego`（`Go`/`Call` + 单测），`internal/metrics` 加 `api_go_goroutine_panics_total{name}` 计数器；对 118 个文件的全部后台 `go` 启动点按 A/B/C 接入（长循环外层 `safego.Go` + 单轮 `safego.Call`；每 job/每 org 处理 `safego.Call` 走既有失败路径；fire-and-forget `safego.Go`）。**排除**：D 类纯同步辅助保持原样（各 `Close/Stop/shutdown` 的 `wg.Wait(); close(done)` 排空 helper，以及 `cmd/api/main.go:2112`、`cmd/ais-relay/main.go:59` 的 `http.Server.ListenAndServe` serve goroutine），完整清单见 PR 描述。未改业务逻辑、Redis key、队列协议、对外契约、鉴权/租户/事务。
- 有意行为变更：①后台 goroutine panic 不再使进程退出（记录带堆栈日志 + 计数后该 goroutine 结束，不重启）；②长循环单轮 panic 只影响该轮；③worker handler/processor panic 作为该 job 普通失败走既有重试/失败/stalled 路径；④`classificationalert.EvaluateOrg` 内部 recover 改为 `safego.Call`（结果仍 `OrgOutcomeFailed`，仅内部 error 文案微调）；⑤新增指标 family `api_go_goroutine_panics_total`。
- 剩余问题：本机未安装依赖/未运行 `go build`/`go test`/`go vet`/Docker/服务，运行证据仅普通 CI 精确 head；未连接真实 Redis/MySQL/Mongo/LiteLLM 等外部服务。未新增 worker 级“处理器 panic→任务失败”集成测试（现有 worker 测试均 `//go:build integration` 需真实 Redis、无 fake，按提示词不新建脚手架；`safego` 自身有单测）。已知取舍：少数 channel 会合式扇出若在发送前 panic，单接收者可能阻塞（进程不崩），为不改扇出结构而保留，已在 PR 标注。
