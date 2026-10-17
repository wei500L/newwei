# 异常上报（Go 接管说明）

> 本批：`API_GO_EXCEPTION_INGEST_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源：`apps/api/src/modules/observability/client-exception-events.controller.ts`、`internal-exception-events.controller.ts`、`exception-events.service.ts` 的 `record`、`apps/api/src/common/guards/litellm-internal-token.guard.ts`、`apps/api/src/common/internal-token.ts`、`apps/api/src/common/request-ip.ts`、`apps/api/src/modules/cache/rate-limiter.service.ts`、`packages/mongo/src/models/exception-event.ts`。

## 1. 开关与回滚

- 变量：`API_GO_EXCEPTION_INGEST_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_EXCEPTION_INGEST_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（client 入口要验签、查 membership、消费 Redis 限流；两条都写 Mongo `exceptionevents`）。`MONGO_URI` 缺失时启动失败，错误文本是 `MONGO_URI is required when API_GO_EXCEPTION_INGEST_MODE=go`。
- `LITELLM_CONFIG_INTERNAL_TOKEN` **不是启动条件**：未配置时 internal 入口按既有契约返回接口级 403，不影响无关服务启动。
- 回滚：**只把 `API_GO_EXCEPTION_INGEST_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则、不额外打开 Mongo 连接。
- 该开关**只控制新增的两个上报入口**。7 条读取 GET 继续使用 `API_GO_ADMIN_LOGS_MODE`，两个开关互不影响。
- `infra/docker/.env.sample` 与 `infra/docker/docker-compose.yml` 的 pilot 默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值；不改 Web 的 API 地址；不打开 canary。
- **未启用 shadow。**

## 2. 接管的路径（仅 `go` 时，且只匹配 `POST`）

| 路径 | 身份 | 数据源 | 成功响应 |
|---|---|---|---|
| `POST /api/observability/exception-events/client` | 现有 `AllowAuthenticated`（任一已认证用户，无额外权限） | Mongo `exceptionevents` | `201 {"ok":true}` |
| `POST /api/internal/observability/exception-events` | 仅 `LITELLM_CONFIG_INTERNAL_TOKEN` | Mongo `exceptionevents` | `201 {"ok":true}` |

两条都是精确 path + 方法白名单（`POST` + 预检 `OPTIONS`；非预检 `OPTIONS` 回落 legacy 代理）。相似路径（`/api/observability/exception-events/clients` 等）、其他方法与更长路径继续回落 NestJS——Go 不返回自己的 404。集合名是 Mongoose 8 默认值 `ExceptionEvent → exceptionevents`。

## 3. client 入口的输入语义（逐项对齐 `ClientExceptionEventsController`）

- 身份：`orgId`、`userId` 来自服务端认证结果；body 里的 `orgId`、`userId`、`stack` 被忽略；client 的 `stack` 不落库。
- 字段：`kind`、`traceId`、`timestamp`、`statusCode`、`message`、`path`、`method`、`operation`、`operationName`、`errorName`。
- 字符串：`trim` 后空当缺省；超长 400 `<fieldName> is too long (max <N> characters)`，长度按 UTF-16 码元（与 JS `String.length` 一致）。上限：`message` 1000、`traceId`/`x-trace-id` 128、`timestamp` 64、`path` 512、`method` 16、`operation` 120、`operationName` 160、`errorName` 120。
- `message` 处理后为空：400 `message is required`。
- `kind`：`http`、`graphql`、`unknown`；其他值（含需要 trim 的串）归 `unknown`。
- `method`：有效字符串转大写。
- `statusCode`：沿用 JS `Number(value)` 转换与 `Math.floor`，只保存 100–599，否则省略（非有限数、`null`、数组/对象都省略）。
- `traceId` 优先级：有效 `x-trace-id` → 有效 `body.traceId` → 空字符串。
- `timestamp`：有效时间按 UTC 保存；省略或无效用当前时间。

## 4. 限流（client 入口，复用现有协议）

先完成输入处理，再消费限流；无效请求不消耗额度。

1. `observability:client-exception:user:<orgId>:<userId>`
2. 有有效请求 IP 时再检查 `observability:client-exception:ip:<orgId>:<ip>`

Go 侧复用 Nest `RateLimiterService` 的滑动窗口 Lua 脚本与 fail-closed 失败策略（Redis 异常也当不足额 → 429），并同样加 `rate:` 前缀，因此与 Nest 共享同一 Redis 桶。限额来自 `OBSERVABILITY_CLIENT_EXCEPTION_USER_RATE_LIMIT`（默认 30）、`OBSERVABILITY_CLIENT_EXCEPTION_IP_RATE_LIMIT`（默认 120）、`OBSERVABILITY_CLIENT_EXCEPTION_RATE_LIMIT_WINDOW_SECONDS`（默认 60）。IP 解析沿用 `TRUST_PROXY` 与既有 Go 地址解析方式（未配置时用 socket 地址，配置跳数时用 `X-Forwarded-For`）。

429 文案分别保持：

- `Too many client exception events from this user. Please retry later.`
- `Too many client exception events from this IP. Please retry later.`

## 5. internal 入口的输入与鉴权（逐项对齐 `InternalExceptionEventsController`）

- 只使用 `LITELLM_CONFIG_INTERNAL_TOKEN`：未配置 403 `LITELLM_CONFIG_INTERNAL_TOKEN is not configured`；缺少 Bearer 401 `Missing bearer token`；token 不匹配 401 `Invalid bearer token`。Bearer 提取与恒定时间比较语义与 `internal-token.ts` / `LitellmInternalTokenGuard` 一致。
- 输入字段与现有 controller 一致，包含 `stack`、`orgId`、`userId`；保持内部入口自己的字符串规则（`trim`、空当缺省，无客户端长度限制），`stack` 按 `record` 规则最多保留 8000 个字符。
- `traceId` 优先级：有效 `body.traceId` → 有效 `x-trace-id` → 空字符串。
- `message` 处理后为空：400 `message is required`。
- `kind`、`method`、`statusCode`、`timestamp` 沿用当前实现。

## 6. Mongo 写入

- 写入既有 `exceptionevents` 集合，不另建集合，也不是 `MongoOutbox`、不经过 BullMQ。
- 文档字段：`id`（UUID 字符串，等价 `crypto.randomUUID()`）、`orgId`、`userId`、`kind`、`traceId`、`timestamp`、`statusCode`、`message`、`path`、`method`、`operation`、`operationName`、`errorName`、`stack`、`createdAt`、`updatedAt`。
- `timestamp`、`createdAt`、`updatedAt` 保存为 BSON Date，不是仅供展示的字符串。缺省的可选字段整键省略（与 Mongoose 的 `undefined` 不落库一致）。
- 写入结果能被现有管理端读取接口直接查询到。
- 保留现有 best-effort 响应约定：请求内**执行一次** `InsertOne`，然后返回既有 `201 {"ok":true}`；写入失败记录服务日志并保持响应不变。不重试、不增加后台任务系统或内存持久化队列；不把日志上报失败递归上报给自身；**不将 best-effort 接收描述为保证持久化**。

## 7. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- 上述两条路径的非 `POST` 方法与相似/更长路径。
- `/api/observability/*` 的其余路由、`/api/metrics`。
- 7 条管理端读取 GET 由 `API_GO_ADMIN_LOGS_MODE` 决定，不在本开关里。

## 8. 验收与未验证项（诚实登记）

- 普通 CI：`go test ./...` 编译既有与本批新增的 Go 代码；本批新增了路由规则测试（开关缺省/`legacy` 时两条 POST 不在 Go 规则里；`go` 时两条都是 Exact + 仅 POST + 预检 OPTIONS；相似路径与其他方法仍回落 NestJS）。`TypeScript` 侧由 `pnpm typecheck` 检查。
- **未做**：本机未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；未做性能测量，因此不声称延迟、吞吐或内存收益。真实登录态与真实 Mongo 端到端写入未在本批验证。
- 生产流量未切换；canary 保持关闭；不启用 shadow；未改前端；未改 Web 的 API 地址。
