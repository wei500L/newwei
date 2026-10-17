# 平台治理设置 16 条 HTTP 迁入 Go（API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE）

本单元把 `apps/api` 中「平台治理设置」这一组 16 条管理端 HTTP 用 Strangler Fig
方式迁到 `apps/api-go`。生产入口仍是 Web → NestJS，canary 关闭、不启用 shadow、
不改前端；回滚只需把一个环境变量改回 `legacy`。

## 1. 开关语义

| 取值 | 行为 |
|---|---|
| 未设置 / 空串 / `legacy` | 16 条全部经 `legacyproxy` 反向代理到 NestJS（默认） |
| `go` | 16 条由 Go handler 服务；NestJS 侧代码全部保留，代理规则不再命中它们 |
| 其他任何值 | 启动失败，错误文本一字不差：`API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE must be one of legacy|go` |

`go` 时启动前强制要求四项依赖，缺任一项启动失败（复用 `appendAuthRequirements`，
并追加 Mongo）：

```
JWT_SECRET is required when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go
DATABASE_URL is required when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go
REDIS_HOST is required when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go
MONGO_URI is required when API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE=go
```

`legacy` 下这些环境变量即使取非法值也不影响启动，行为与 `main` 完全一致。
`go` 时它们的解析严格对齐 NestJS zod schema（`env.schema.ts` /
`packages/utils/src/env.ts`），非法值启动失败：

| 变量 | 约束 | 默认 |
|---|---|---|
| `ASSISTANT_GUARDRAILS_ENABLED` | `envBoolean` | `true` |
| `ASSISTANT_GUARDRAILS` | 字符串；空串视为未设置 | `openai-moderation-pre` |
| `ASSISTANT_ORG_SUBMIT_LIMIT_PER_HOUR` | 整数 0–10000 | `30` |
| `ASSISTANT_ORG_MAX_IN_FLIGHT` | 整数 0–100 | `2` |
| `ASSISTANT_ORG_MONTHLY_TOKEN_BUDGET` | 整数 0–1e12 | `2000000` |
| `TASK_LOG_RETENTION_DAYS` | 正整数（服务层再 clamp 到 1–3650） | `14` |
| `SYSTEM_SETTINGS_ENCRYPTION_KEY` | 保留原串（不 trim），用于区分「未设置/空串」与「空白但存在」 | 空 |

## 2. 路由表

所有路由都要求 `settings.manage`。「平台门禁」= handler 内额外要求
`GlobalRoleAssignment(role='platform_admin')`。

| # | 方法 | 精确路径 | 平台门禁 | 成功码 | Go 接管 |
|---|---|---|---|---|---|
| 1 | GET | `/api/system-settings/security` | 否 | 200 | 是 |
| 2 | PUT | `/api/system-settings/security` | **是（本批新增）** | 200 | 是 |
| 3 | GET | `/api/system-settings/assistant-quota` | 否 | 200 | 是 |
| 4 | PUT | `/api/system-settings/assistant-quota` | **是（新增）** | 200 | 是 |
| 5 | DELETE | `/api/system-settings/assistant-quota` | **是（新增）** | 200 | 是 |
| 6 | GET | `/api/system-settings/assistant-safety` | 否 | 200 | 是 |
| 7 | PUT | `/api/system-settings/assistant-safety` | **是（新增）** | 200 | 是 |
| 8 | DELETE | `/api/system-settings/assistant-safety` | **是（新增）** | 200 | 是 |
| 9 | GET | `/api/system-settings/assistant-safety/metrics` | 否 | 200 | 是 |
| 10 | GET | `/api/system-settings/task-logs` | 否 | 200 | 是 |
| 11 | PUT | `/api/system-settings/task-logs` | 是（已有） | 200 | 是 |
| 12 | DELETE | `/api/system-settings/task-logs` | 是（已有） | 200 | 是 |
| 13 | GET | `/api/system-settings/llm-request-logs` | 否 | 200 | 是 |
| 14 | PUT | `/api/system-settings/llm-request-logs` | **是（新增）** | 200 | 是 |
| 15 | DELETE | `/api/system-settings/llm-request-logs` | **是（新增）** | 200 | 是 |
| 16 | POST | `/api/system-settings/llm-request-logs/metadata-policy/reset` | **是（新增）** | **201**（Nest `@Post` 默认） | 是 |

失败顺序与 Nest 一致：**401 未认证 → 403 缺权限 → 400 DTO 校验（仅带 body 的路由）
→ 403 平台门禁 → service 内 400/409/500**。平台门禁在 DTO 之后，因为 NestJS 的
全局 `ValidationPipe` 先于 handler 主体执行。

注册键 `PlatformGovernanceSettingsKey = "/api/system-settings#platform-governance"`
与 `RuntimeSettingsKey = "/api/system-settings"` 不同：两组开关独立，路径不重叠，
可以同时为 `go`。

### 仍留在 NestJS 的路径（必须回落）

- `GET /api/system-settings/assistant-safety/diagnostics`（实际请求 LiteLLM，不迁）
- `/api/system-settings/email`、`/archive-preparation`、`/realtime-signals`、
  `/situation-monitor`、`/vector-service`
- 上表 16 条路径的**其他方法**（如 `POST /api/system-settings/security`）
- 带尾斜杠或多一段的路径（如 `/api/system-settings/task-logs/`、`/task-logs/x`）

回落断言见 `apps/api-go/internal/legacyproxy/proxy_test.go` 的
`TestPlatformGovernanceSettingsUnmigratedRoutesStayNest` 与
`TestPlatformGovernanceSettingsAndRuntimeSettingsCoexist`。

## 3. 缓存键与 TTL

| 服务 | SystemSetting key | Redis 键 | TTL | 说明 |
|---|---|---|---|---|
| security | `system_security` | `system_security:settings` | 60s | 写入后同时 DEL `auth:system-security`（AuthSecurityService 的 MFA 缓存） |
| assistant-quota | `assistant_quota` | `assistant_quota:settings` | 30s | |
| assistant-safety | `assistant_safety` | `assistant_safety:settings` | 30s | |
| task-logs | `task_log_settings` | 无 | — | Go 每次读 DB |
| llm-request-logs | `llm_request_log_settings` | 无 | — | Go 每次读 DB |

缓存值形状与 Nest `CacheService` 逐字节一致（无前缀、`JSON.stringify`、`SET … EX`）：

```json
{"exists":true,"value":<DB 原始 JSON>}
{"exists":false}
```

行存在但 `value` 不是对象（含数组以外的标量）时省略 `value` 键，与 Nest
`value: settings ?? undefined` 的 JSON 省略语义一致。Redis 读写失败只记 warn 并
回落 DB（读）或忽略（写），与 Nest 相同。

## 4. 锁协议（CONC-01）

`llm-request-logs` 的三条写路由在 MySQL 会话锁内执行：

```
SELECT GET_LOCK('sys:llm_request_log_settings', 10)   -- 必须返回 1
  … 读 DB（不是缓存）→ 按字段合并 → 按需对账 TTL 索引 → upsert → 写审计 …
SELECT RELEASE_LOCK('sys:llm_request_log_settings')   -- 独立 2 秒 context，best-effort
```

- 锁名固定，因为设置是单个全局行。
- 拿不到锁返回 **409**
  `LLM request log settings are being updated by another request; retry later`。
- **禁止嵌套获取锁**：`withMysqlSessionLock` 每次新开一条连接，嵌套等于自己等自己
  直到超时。所以 `resetMetadataPolicy` 调用不加锁的 `updateSettingsUnlocked`。
- 合并基准是**锁内新读的 DB 行**，不是进程内 30 秒缓存：否则 A 刚把 `retentionDays`
  改成 45，30 秒内 B 的只改 keys 的 PUT 会把 45 写回旧值，而 TTL 索引仍是 45 天。
- Nest 侧同一把锁名（`apps/api/src/modules/system-settings/llm-request-log-settings.service.ts`），
  因此 Go 与 Nest 的并发部分写跨实现互斥。

task-logs、quota、safety、security 都是整体替换写，不加锁。

## 5. 平台门禁（SEC-05）

`system_security` / `assistant_quota` / `assistant_safety` / `llm_request_log_settings`
/ `task_log_settings` 都是**全局单例键**（无 org 维度）。本批给 4 个控制器的 8 个写
handler 补上 `await this.platformAccess.assertPlatformAdmin(user.id)`（与
`task-log-settings.controller.ts`、`vector-service-settings.controller.ts` 同构），
Go 侧对 9 条写路由执行同一判断。

机器令牌（`mtk_` 前缀）永远过不了平台门禁：`GlobalRoleAssignment.userId` 是
`User(id)` 的外键，`machine:<id>` 查不到行。Go 侧对机器身份直接 403，与 Nest
`assertPlatformAdmin("machine:<id>")` 的结果一致（`internal/platformgovernance/auth.go`）。

`updatedById` 与 `AuditLog.actorId` 统一走 `normalizeAuditActorId`（Nest）/ 内部
`nullableActorID`（Go），机器身份写 NULL，避免外键 1452 把设置写入变成 500——纵深防御。

## 6. 与 NestJS 的已知差异

1. **Nest 进程内 30 秒缓存（task-logs、llm-request-logs）**：这两个 Nest 服务只有
   进程内缓存（`SETTINGS_CACHE_TTL_MS = 30_000`），Go 侧没有。因此 Go 写入后，30 秒
   内直连 Nest 的 GET 可能返回旧值。这是既有行为，本批不动 Nest 的缓存策略；
   smoke 在需要比较这两个 GET 时先等 31 秒，或直接比较 DB。
   注意 `llm-request-logs` 的**写路径**已经不再依赖该缓存（CONC-01 修复）。
2. **metrics 嵌套数组顺序**：`$group` 不保证 `guardrails` / `codes` 数组顺序，两侧
   都按原样输出。smoke 用多重集比较这两个数组，其余字段逐字节比较。
3. **环境变量空串**：`os.Getenv` 无法区分「未设置」与「设为空串」。Nest zod 对
   `z.coerce.number()` 会把空串当成 `Number("") = 0`（在区间内即合法），Go 侧把空串
   当作未设置并使用默认值。仅在显式把数值型变量设为空串时存在差异。

## 7. 回滚

只把 `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE` 改回 `legacy`（或删除）。不需要
代码回滚、数据迁移或前端改动。`infra/docker/docker-compose.yml` 的 api-go 服务默认
即 `${API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE:-legacy}`。

## 8. 验证

1. `apps/api-go/internal/platformgovernance/*_test.go`：DTO 消息与顺序、`jsNumberish`
   全分支、`toFixed` 居中取大、base64 宽松解码、guardrails 推导、`coerceLimit`、
   token 列表 strict/lenient、required keys 合并顺序、TTL 对账纯函数决策、metrics
   日期补齐、401→403→400→平台 403 失败顺序。
2. `apps/api/src/modules/system-settings/*.controller.test.ts` 四个新 vitest：
   非平台管理员写 403 且 service 未被调用、平台管理员通过、GET 不调用
   `assertPlatformAdmin`。
3. `pnpm --filter @modular/api run contract:auth-matrix:check` 与 OpenAPI 快照漂移门禁
   需要重新生成基线（新增 8 行 `platformOnly: true` /
   `platformCheckSource: "handler-text-scan"`）。
4. `.github/workflows/api-go-platform-governance-settings-smoke.yml`（label
   `api-go-platform-governance-settings-smoke`）：真实栈四阶段，覆盖 legacy/空白对照、
   16 条与 Nest 逐字节对照、6 类 400 对照、平台门禁（两侧）、TTL NamespaceNotFound
   回归、过期缓存回滚回归、5 轮并发部分写、跨租户隔离、停 Nest 后接管与 502。

### smoke 各阶段关键断言（日志行前缀）

| 阶段 | 日志行 |
|---|---|
| 0 | `ok: phase 0: legacy mode proxies all sampled routes to NestJS` |
| 1 | `ok: phase 1: 16 routes byte-identical to NestJS`、`ok: phase 1: six 400 families byte-identical to NestJS` |
| 2 | `ok: defect 1: platform admin gate verified on both implementations`、`ok: defect 2: NamespaceNotFound PUT returns 200 and recreates the TTL index on both`、`ok: defect 3: Nest partial PUT merged over the fresh DB row (retentionDays stayed 45)`、`ok: defect 3: 5 concurrent Go/Nest partial writes kept both fields and wrote 10 audit rows`、`ok: cross-tenant: quota usage and metrics stay inside the caller's org` |
| 3 | `ok: phase 3: 16 routes still served by Go; unmigrated paths return 502` |
