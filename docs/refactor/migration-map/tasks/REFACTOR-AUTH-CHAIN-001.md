# REFACTOR-AUTH-CHAIN-001 · 鉴权链单一实现、机器令牌统一、强制 jti

返回[总计划](../BACKEND-REFACTOR-PLAN.md) · [通用纪律](REFACTOR-COMMON.md) · [执行提示词](REFACTOR-AUTH-CHAIN-001.prompt.md)

## 任务记录

- 状态：**planned**（提示词已写好，尚未发出或认领）。
- 规划基线：`origin/main = 18c41879858d70d5d1b335b4bdab81e68ccdb693`；规划时间：2026-11-04。
- 来源：2026-11-04 api-go 纯静态横向审查（见总计划“背景与目标”）。
- 前置：无。
- 分支：`codex/refactor-auth-chain`；worktree：`/Users/oo/project/newwei-refactor-auth-chain`。
- 验证口径：静态自查 + 普通 CI 精确 head；不部署、不连接真实外部服务。

## 交付记录（编码窗口填写）

- 分支 / PR / Ready：`codex/refactor-auth-chain` / [#164](https://github.com/wei500L/newwei/pull/164) / Ready（非 draft）。
- 最终 head SHA（代码）：`19d7be2e8b838364724c0da467c0c61efd7374ed`。
- 普通 CI run 与结论（`gh run view --json conclusion,headSha`）：[run 41822706699](https://github.com/wei500L/newwei/actions/runs/41822706699)，headSha `19d7be2e`，**conclusion=success**；`verify` / `vector-integration` / `globe-vendor` / `api-go-user-settings-integration` 均 success，两个 regen job skipped（skipped 不算通过）。
- 实际范围 / 排除项：`internal/authn`（强制 jti）、`internal/authhttp`（resolve 单一核心 + Identity 访问器 + `AuthenticateWithMachine` + `MachineResolver` + socket 核心）、`accountsecurity` 人类/机器链、`metrics`/`health` 机器路径、三个 socket 包、按提示词列出的全部机器令牌 SQL 副本（26 处，含 adminlogs/llmlogs/crawl*/newssources/rbacapi/newsindicator/newsnow*/platformgovernance/settings 各包）、`cmd/api` 单次 verifier/blacklist/authenticator/MachineResolver 构造。排除：`authlogin/passwordreset.go`、`identityonboarding/*`、`accountsecurity/machine_tokens.go` 的 tokenHash（非机器令牌/属管理面）；未改 `apps/web`。
- 有意行为变更：① 强制 jti——缺 jti 或全空白的 access token 一律 401（唯一签发点恒生成 UUIDv4 jti，正常用户不受影响）；② 7 个改用 `AuthenticateWithMachine` 的包装包，机器令牌路径的 DB 错误由部分 500 统一为 fail-closed 503（401 文案不变）；③ lastUsedAt 统一 `now().UTC().Truncate(ms)`；④ newsnowclusteringops 的 permissions 不再 TrimSpace（按 NestJS `typeof==="string"` 语义只丢弃非字符串项）。
- 剩余问题：`realtimesocket` 保留分步 `verifyToken`/`ensureNotRevoked`/`authorize`（B2 revalidation 需要单步与顺序），复用同一 `authn`/`authz` 原语并继承强制 jti，未改用一次性入口；`MachineResolver` 为无状态 `{db, now}`，各包在共享 `*sql.DB` 上按需实例化（权威 SQL/有效性/权限实现仍只有一份）。未在本机构建/运行 `go build`/`go test`/`go vet`、Docker 或服务，未连接真实 MySQL/Redis/Mongo；验证仅静态审查 + 普通 CI 精确 head。集成测试曾暴露 `Org.planTier` 在最小测试 schema 缺失，已按调用方拆分查询列集修正（head `19d7be2e`）。
