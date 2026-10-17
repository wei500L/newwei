# 管理端日志与异常读取（Go 接管说明）

> 本批：`API_GO_ADMIN_LOGS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源（全文逐段翻译，未使用简化版）：`apps/api/src/modules/observability/admin-logs.controller.ts`、`admin-errors.controller.ts`、`admin-logs.service.ts` 的 `listTaskLogs` / `summarizeTaskLogs` / `listErrors` / `summarizeErrors` / `listAuditLogs` / `redactDeep` / `isSensitiveKey`、`exception-events.service.ts` 的 `buildFilter` / `list` / `stats`、`packages/utils/src/error-sanitizer.ts` 的 `SENSITIVE_PATTERNS` / `redactSensitiveFields`、`packages/mongo/src/models/task-log.ts` 与 `exception-event.ts`。

## 1. 开关与回滚

- 变量：`API_GO_ADMIN_LOGS_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_ADMIN_LOGS_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（任务日志与异常事件在 Mongo；`MONGO_URI` 缺失时启动失败，错误文本是 `MONGO_URI is required when API_GO_ADMIN_LOGS_MODE=go`；`DATABASE_URL` DSN 无效时启动失败）。
- 回滚：**只把 `API_GO_ADMIN_LOGS_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则、不额外打开 Mongo 连接。
- `infra/docker/.env.sample` 与 `infra/docker/docker-compose.yml` 的 pilot 默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值；不改 Web 的 API 地址；不打开 canary。
- **未启用 shadow。**

## 2. 接管的路径（仅 `go` 时，且只匹配 `GET`）

| 路径 | 权限 | 数据源 | 响应 |
|---|---|---|---|
| `GET /api/admin/logs/task` | `settings.manage` | Mongo `tasklogs` | `{page, pageSize, total, items, summary}` |
| `GET /api/admin/logs/task/summary` | `settings.manage` | Mongo `tasklogs` | `summary` |
| `GET /api/admin/logs/errors` | `settings.manage` | Mongo `exceptionevents` | `{page, pageSize, total, items}` |
| `GET /api/admin/logs/errors/summary` | `settings.manage` | Mongo `exceptionevents` | `{total, byKind, byDay}` |
| `GET /api/admin/logs/audit` | `settings.manage` | MySQL `AuditLog` | `{page, pageSize, total, items}` |
| `GET /api/admin/errors` | `settings.manage` | Mongo `exceptionevents` | `{total, items}` |
| `GET /api/admin/errors/stats` | `settings.manage` | Mongo `exceptionevents` | `{total, byKind, byDay}` |

七条都是精确 path + 方法白名单（`GET` + 预检 `OPTIONS`，预检随后回落 legacy 代理）。其他方法（如 `POST /api/admin/logs/task`）与更长路径（`/api/admin/logs/task/extra`、`/api/admin/errors/extra`、`/api/admin/logs/`）继续回落 NestJS——Go 不返回自己的 404。集合名是 Mongoose 8 默认值：`TaskLog → tasklogs`、`ExceptionEvent → exceptionevents`（两个 schema 都没有显式 `collection`）。

## 3. 两个控制器的参数规则不同——本批不统一

`/api/admin/logs/*` 的五条会**主动抛 400**：

- `start` / `end` 非空但不是合法日期 → `<name> must be a valid date`；
- `start > end` → `start must be earlier than or equal to end`；
- `page` / `pageSize` 非空但不是正有限数 → `<name> must be a positive number`（正小数用 `Math.trunc`；`page` 缺省 1；`pageSize` 缺省 20，服务层再收口到最大 100）；
- `task` 的 `status` 非空且不在 `pending`/`processing`/`completed`/`failed` → `status must be one of pending, processing, completed, failed`；
- `errors` 的 `kind` 非空且不在 `http`/`graphql`/`unknown` → `kind must be one of http, graphql, unknown`。

`/api/admin/errors` 与 `/api/admin/errors/stats` **不抛这些 400**：

- `kind` 不在三个枚举内当 `undefined`（也不 trim），不报错；
- `start` / `end` 非法日期时 `parseDate` 返回 `undefined`，忽略该条件，不报错；
- `start > end` 也不抛 400，照常查询并返回 0 条；
- `limit` 缺省 50，收口到 1 到 200；`offset` 缺省 0，最小 0；非有限数走缺省。

`admin/errors` 的 `limit` / `offset` 走 `limit ? Number(limit) : undefined` 再经 `Number.isFinite` 判定，因此空串与 `abc` 都当缺省；校验顺序也照抄控制器（日期 → page → pageSize → status/kind）。

## 4. 查询语义

- `task` 与 `task/summary`：按 `orgId`，可选精确匹配 `queue`、`jobId`、`stage`、`status`，`createdAt` 落在 `[start, end]`；`summary.totals` 固定有 `total`、`pending`、`processing`、`completed`、`failed` 五个键；`byStage` 按 count 降序、最多 50 条；`topErrors` 只在没有传 `status`，或 `status` 为 `failed` 时聚合（`completed`、`pending`、`processing` 时是空数组），按 count 降序、最多 25 条。每条日志的 `message`、`data`、`error` 与 `topErrors.errorName`、`sampleMessage` 都过 `redactDeep` / `redactSensitiveFields`（深度超过 10 层原样返回；敏感键按 `isSensitiveKey`）。分页 `$skip = (page-1)*pageSize`、`$limit = pageSize`，排序 `createdAt desc`；响应里的 `page` / `pageSize` 是收口后的值。
- `logs/errors` 与 `admin/errors`：同一张 `exceptionevents`，必须带 `filter.orgId = 当前 orgId`；`operationName` trim 后精确匹配；`messageContains` trim 后先 `escapeRegex`（JS 的 14 个元字符），再做不区分大小写的正则匹配；`timestamp` 落在 `[start, end]`；排序 `timestamp desc`。前者返回 `{page, pageSize, total, items}`，后者返回 `{total, items}`。
- `logs/errors/summary` 与 `admin/errors/stats`：都是 `ExceptionEventsService.stats` 的等价实现，返回 `{total, byKind, byDay}`；`byKind` 按 count 降序；`byDay` 按 UTC 的 `%Y-%m-%d` 分组、日期降序、最多 30 条。
- `logs/audit`：查 MySQL `AuditLog`，`where` 恒含 `orgId`；`resource`、`action` 是 contains；`search` 是 `resource`、`action`、`actorId`、`ipAddress` 四个字段的 OR contains；`createdAt` 落在 `[start, end]`；按 `createdAt desc` 加 `skip`/`take`；返回 `{page, pageSize, total, items}`，`createdAt` 是 ISO 字符串，`metadata` 原样输出数据库里的 JSON（SQL NULL 输出 `null`）。
- items 的键序与 `undefined` 省略语义按 JS 对象字面量对齐：字段缺失整键省略（`message`、`data`、`error`、`statusCode`、`path`、`method`、`operation`、`operationName`、`errorName`、`stack`），值为 `null` 时输出 `null`；`message` 缺省输出 `"Unknown error"`，`traceId` 缺省输出 `""`，`kind` 缺省输出 `"unknown"`，`status` 缺省输出 `"pending"`；时间按 `Date.toISOString()` 等价格式（毫秒 UTC）。

## 5. 缺陷修复（Nest 与 Go 两侧同修）

**缺陷**：`ExceptionEventsService.list` 在 `exception-events.service.ts` 第 147 到 159 行直接返回 Mongo 里的 `message` 与 `stack`，没有调用 `redactSensitiveFields`；而任务日志在 `admin-logs.service.ts` 第 233 到 258 行对 `message`、`data`、`error` 都做了脱敏。异常消息或堆栈里若带有 `Bearer xxx`、`password=xxx`、`api_key=xxx`，读取 `/api/admin/logs/errors` 或 `/api/admin/errors` 会把原文返回给前端。

修复：在 `list` 映射 items 时，`message` 先过 `redactSensitiveFields`（缺省值 `"Unknown error"` 一并过），`stack` 非空时也过 `redactSensitiveFields`。**不修改数据库里已存的文档**，只在读取输出时脱敏。

- Nest：`apps/api/src/modules/observability/exception-events.service.ts`——导入 `redactSensitiveFields`（第 2 行），items 映射的 `message`（第 152 行由 `item.message ?? "Unknown error"` 改为 `redactSensitiveFields(item.message ?? "Unknown error")`）与 `stack`（第 158 行由 `item.stack ?? undefined` 改为 `item.stack ? redactSensitiveFields(item.stack) : undefined`）。
- Go：`apps/api-go/internal/adminlogs/mongo.go` 的 `exceptionEventJSON`——`message` 过 `redactSensitiveFields`，`stack` 非空时过 `redactSensitiveFields`；`apps/api-go/internal/adminlogs/redact.go` 是 `packages/utils/src/error-sanitizer.ts` 的 9 条正则与替换规则的逐条翻译（`password`、`token`、`apiKey`、`api_key`、`secret`、`credential`、`auth` 保留键名与分隔符后替换成 `[REDACTED]`；`Bearer` 变 `Bearer [REDACTED]`；`Basic` 变 `Basic [REDACTED]`）。

## 6. 身份与鉴权（照新闻源/模板/画像现有实现，不新写规则）

- 没有 `Authorization` 或不是 Bearer：401（`authhttp.WriteUnauthorized`）。
- token 以 `mtk_` 开头：不调用 `authhttp.Authenticate`（它会拒绝 `mtk_`）；用 SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到、已撤销、已过期、组织停用：401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON 里的字符串数组，`orgId` 只用令牌行的。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；JWT 里的 permissions 不算。
- 缺少 `settings.manage`：403（`authhttp.WriteForbidden`，required 是 `settings.manage`）。
- query 里出现 `orgId` 不参与查询条件；org 一律来自鉴权身份。

## 7. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `GET /api/admin/quality/task-logs`（`getQualityTaskLogsOverview` 不迁移）与 `/api/admin/quality/*`。
- `/api/observability/*`、`/api/metrics`。
- 上述 7 条路径的非 `GET` 方法与更长路径。
- 异常上报 `POST /api/observability/exception-events/client` 与 `POST /api/internal/observability/exception-events` 由独立开关 `API_GO_EXCEPTION_INGEST_MODE` 接管（见 `docs/refactor/go-exception-ingest.md`），与本开关互不影响。

## 8. 查询算法优化（本批，Nest 与 Go 两侧同步）

只改既有 7 条读取 GET 的查询算法，接管路径、权限、响应字段、过滤条件、分页上限与两组接口的参数校验差异均不变。

1. **异常统计一次聚合**：`stats`（`logs/errors/summary` 与 `admin/errors/stats`）原先对同一过滤条件分别执行 `CountDocuments`、按 `kind` 的聚合、按 UTC 日期的聚合（三个查询）。现在改为一次聚合：最前面 `$match` 保持 `orgId`、`kind`、`operationName`、字面量 `messageContains`、`timestamp` 区间的现有条件；先按「UTC 日期（`$dateToString`，`timezone: "UTC"`，`%Y-%m-%d`）+ 原 `kind`」`$group` 出每天各类的数量；再在压缩后的分组结果上汇总 `total`（所有计数之和）、`byKind`（按 `kind` 合并）、`byDay`（按 UTC 日期合并）。响应结构仍是 `{total, byKind, byDay}`；`byKind` 排序 `count DESC, kind ASC`；`byDay` 排序 `date DESC`，最多 30 个有数据的日期。`total` 与 `byKind` 覆盖全部匹配记录，`byDay` 的 30 条上限不截断它们；未传 `start`/`end` 时不自行添加「最近 30 天」过滤；不把原始文档全部读进内存再统计。无数据时 `total=0`、两个列表均为 `[]`。
2. **确定性的列表排序**：异常列表 `timestamp DESC, _id DESC`；任务日志列表 `createdAt DESC, _id DESC`；MySQL 审计列表 `createdAt DESC, id DESC`。分页仍是数据库 `skip`/`limit`（或 `LIMIT`/`OFFSET`），保持现有 page/offset 协议、`total` 与结果数量；不改为新游标 API，不增加分页 token，也不是并发写入期间的冻结分页快照。
3. **Top Errors 展示最近样本**：分组键仍是 `queue + stage + errorName`；只统计 `failed`；`count` 覆盖该组全部匹配记录；最多 25 组。`sampleMessage` 从无排序的 `$first` 改为该组 `createdAt DESC, _id DESC` 的最近一条失败记录了；消息仍优先 `error.message`，否则 `message`；空值与脱敏规则不变。Mongo 7.0 使用有序分组聚合 `$top`（分组前 `$project` 保留 `createdAt` 与 `_id`），不把每组完整文档累计进数组再在应用层排序。错误组最终排序 `count DESC`，再按 `queue`、`stage`、`errorName` ASC；`byStage` 最多 50 组，`count DESC`，并列 `stage ASC`。质量面板复用同一任务日志聚合，自然获得相同优化，未另写一套质量面板专用算法。

算法改动位置：

- Nest：`apps/api/src/modules/observability/exception-events.service.ts`（`list` 排序、`stats` 单聚合）、`admin-logs.service.ts`（任务日志 items 排序、`byStage` 并列排序、`topErrors` 的 `$top` 与最终排序、审计 `orderBy`）。
- Go：`apps/api-go/internal/adminlogs/mongo.go`（`queryExceptionEvents` 排序、items `$sort`、`stageAgg` 排序、`errorAgg` 的 `$top` 与最终排序、`exceptionStats` 单聚合）、`service.go`（审计 `ORDER BY createdAt DESC, id DESC`）。

## 9. 验收与未验证项（诚实登记）

- 普通 CI：`go test ./...`（编译 + 既有 Go 测试 + 本批新增的脱敏/敏感键/参数规则/items 映射单测与 7 条路由规则测试：开关缺省与 `legacy` 时这 7 条不在 Go 规则里；开关 `go` 时在且都是 Exact + 仅 GET；`/api/admin/logs/task/extra`、`/api/admin/logs/`、`/api/admin/logs`、`/api/admin/errors/extra`、`quality`、`observability`、`metrics`、异常上报 POST 与父路径都不在 Go 规则里）。`api-go-admin-logs-smoke.yml` **不进普通 CI**。
- 真实栈 smoke：`api-go-admin-logs-smoke.yml`（`workflow_dispatch` 或 PR 加 label `api-go-admin-logs-smoke`，`SCHEDULE_ENABLED` 保持 false），只用隔离的 smoke 用户与 smoke 组织；向 Mongo 的 `tasklogs`、`exceptionevents` 与 MySQL 的 `AuditLog` 插入本组织与另一组织的测试数据（其中一条任务日志与一条异常事件的 `message`、`stack` 含 `Bearer secret.jwt.token` 与 `password=plain123`）。断言见下节与 workflow。
- **未迁**：`admin/quality/*`（含 `quality/task-logs`）、`observability/*`、`metrics`。异常上报 POST 由独立开关 `API_GO_EXCEPTION_INGEST_MODE` 接管（见 `docs/refactor/go-exception-ingest.md`）。
- **未验证/未发生**：生产流量未切换；canary 保持关闭；不启用 shadow；未改前端；未改 Web 的 API 地址；SEC-01 的真实登录态不在本批验证。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
