# REFACTOR-HTTP-KIT-001 · HTTP JSON 读写、时间格式与小工具收敛

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-HTTP-KIT-001.prompt.md)

## 任务记录

- 状态：**planned**（提示词已写好，尚未发出或认领）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：REFACTOR-HTTP-ROUTER-001 合入且 CI 成功；可与 BULLMQ-WORKER 并行。
- 分支：`codex/refactor-http-kit`；worktree：`/Users/oo/project/newwei-refactor-http-kit`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-http-kit` / [#171](https://github.com/wei500L/newwei/pull/171) / Ready（非 draft）。
- 最终代码 head SHA：`51936af747b6be62a583d4b491d52024c5768e83`（其后仅有本交付记录的文档提交）。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：run [41976860452](https://github.com/wei500L/newwei/actions/runs/41976860452)，event `pull_request`，head `51936af747b6`，`conclusion=success`；`verify` / `vector-integration` / `api-go-user-settings-integration` 三主 job success，`contract-baseline-regen` / `go-modules-regen` skipped（skipped 不算通过）。
- 实际范围 / 排除项：新增 `internal/httpx/json.go`（WriteRawJSON、ReadJSON 分类错误、IsJSONContentType，并复用既有 WriteJSON）、`internal/timefmt`、`internal/jsvalue`；`contract.FormatDateTime` 改为调用 timefmt；删除并替换各业务包的规范 `writeJSON`（12）、`writeJSONBody`（2）、`writeJSONBytes`（2）、`writeRawJSON`（2）、`nowMillis`（33）、`isoTime`（6）、相同 `formatISO`（2）、`asString`（2）、`asInt`（1）。排除：语义不同的 writeJSON/时间/宽松转换副本保留；`readJSON`、`writeError`、`authorize` 未迁移，见剩余问题。
- 有意行为变更：仅 `httpx.WriteJSON` 的 marshal 失败分支由“空 500 体”统一为 `http.Error("Internal server error", 500)`；正常响应字节、状态码、header 与 Redis/Mongo/MySQL/BullMQ 契约均不变。
- 剩余问题：`readJSON`（8 份，非 JSON/空体默认与 400 文案不同）、`writeError`（5 份语义各异）、`authorize`（45 份，AUTH-CHAIN 后仅约 6 份为转发，其余依赖各自 svc.AuthenticateMachine/writeServiceError）、其余不同布局的时间格式化与 `toInt64`/`asFloat`/`asBool` 等未纳入本批。本机未安装依赖、未运行 go build/test/vet/Docker；运行证据仅为精确 head 的普通 CI。
