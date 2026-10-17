# 管理端质量面板（Go 接管说明）

> 本批：`API_GO_QUALITY_OVERVIEW_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源（逐段翻译，未使用简化版）：`apps/api/src/modules/observability/news-source-quality.controller.ts` / `news-source-quality.service.ts`、`pipeline-quality.controller.ts` / `pipeline-quality.service.ts`、`quality-overview.controller.ts` / `quality-overview.service.ts`、`task-logs.controller.ts`、`admin-logs.service.ts` 的 `getQualityTaskLogsOverview` / `listTaskLogs` / `summarizeTaskLogs`、`observability-snapshot.service.ts` 的 `getOrCreate` / `buildLockKey`、`apps/api/src/modules/cache/cache.service.ts` 的 `withLock` / `wrap`、`packages/mongo/src/models/processed-item.ts` 与 `task-log.ts`。

## 1. 开关与回滚

- 变量：`API_GO_QUALITY_OVERVIEW_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_QUALITY_OVERVIEW_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（`processeditems` 与 `tasklogs` 在 Mongo；新闻源/流水线快照与 `MongoOutbox` 在 MySQL；快照锁与总览缓存在 Redis）。`MONGO_URI` 缺失时启动失败，错误文本是 `MONGO_URI is required when API_GO_QUALITY_OVERVIEW_MODE=go`；`DATABASE_URL` DSN 无效时启动失败。
- 回滚：**只把 `API_GO_QUALITY_OVERVIEW_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则、不额外打开 Mongo 连接。
- 不改任何已有 `API_GO_*` 的默认值；不改 Web 的 API 地址；不打开 canary。**未启用 shadow。**

## 2. 接管的路径（仅 `go` 时，且只匹配 `GET`）

| 路径 | 权限 | 数据源 | 响应 |
|---|---|---|---|
| `GET /api/admin/quality/news-sources` | `settings.manage` | MySQL `NewsSource` / `PipelineJob` + `ObservabilitySnapshot` | `{windowHours, totals, topFailingSources}` |
| `GET /api/admin/quality/pipeline` | `settings.manage` | Mongo `processeditems` / `tasklogs` + MySQL `MongoOutbox` + `ObservabilitySnapshot` | `{windowMinutes, totals, successRate, averageLatencyMs, ingestionLatencyMs, failureTypes, llmModels, outbox}` |
| `GET /api/admin/quality/overview` | `settings.manage` | 组合 pipeline + newsSources + taskLogs | `{generatedAt, pipeline, newsSources, taskLogs}` |
| `GET /api/admin/quality/task-logs` | `settings.manage` | Mongo `tasklogs` | `items` JSON 数组 |
| `GET /api/admin/quality/task-logs/summary` | `settings.manage` | Mongo `tasklogs` | `{totals, byStage, topErrors}` |

五条都是精确 path + 方法白名单（`GET` + 预检 `OPTIONS`，预检随后回落 legacy 代理）。其他方法（如 `POST /api/admin/quality/task-logs`）与更长路径继续回落 NestJS——Go 不返回自己的 404。因此：

- `/api/admin/quality/pipeline/runs`、`/api/admin/quality/pipeline/replay`、`/api/admin/quality/pipeline/rollback`（`pipeline-recovery.controller.ts`）**不会被 `/api/admin/quality/pipeline` 吃掉**；
- `/api/admin/quality/classification/*`（`classification-quality.controller.ts`）**不会被任何一条吃掉**；
- `/api/admin/quality/task-logs/extra`、`/api/admin/quality/`、`/api/admin/quality` 也回落 NestJS。

## 3. 快照复用（与 Nest 共享 60 秒快照）

新闻源质量与流水线质量沿用 Nest 的 `ObservabilitySnapshotService.getOrCreate` 语义：

- 先查 MySQL `ObservabilitySnapshot`：`orgId` + `scope` + `variantKey`，`expiresAt > now` 直接返回已存 `payload`。
- `scope` 是 `quality_news_sources` / `quality_pipeline`（Prisma 枚举 `ObservabilitySnapshotScope`）。
- `variantKey` 是 `windowHours:<normalized>` / `windowMinutes:<normalized>`；窗口先 `Math.floor` 再收口：新闻源 `[1, 24*14]`，流水线 `[5, 60*24*14]`；缺省 24 / 60。
- `expiresAt` 为 `now + 60 秒`（TTL 60s），写入用唯一键 `orgId+scope+variantKey` 做 upsert。
- 未命中时抢 Redis 锁：`lock:observability-snapshot:<orgId>:<scope>:<variantKey>`（与 `CacheService.withLock` 的 `lock:` 前缀一致，键就是 `buildLockKey` 的结果），锁 TTL 15s、抢不到每 100ms 轮询数据库最多 20s，仍无则无锁重建（与 Nest 的最终 fallback 一致）；锁内会再查一次快照。
- 质量总览的任务日志缓存沿用 Nest `getQualityTaskLogsOverview` 的键：`quality:task-logs:overview:<orgId>:60:10`，TTL 15s；锁 `lock:quality:task-logs:overview:<orgId>:60:10`，lockTtl 2000ms / retryDelay 50ms / maxWait 3000ms。

## 4. 参数全是宽松回退（不抛 400）

与 `/api/admin/logs/task` 不同，质量面板 5 条**不抛 400**：

- `news-sources` 的 `windowHours`：空串/缺失 → 24；`Number(windowHours)` 非有限数（`abc`、`NaN`、`Infinity`）→ 24；否则 `Math.max(1, Math.min(336, Math.floor(v)))`。
- `pipeline` 与 `overview` 的 `windowMinutes`：空串/缺失 → 60；非有限数 → 60；否则 `Math.max(5, Math.min(20160, Math.floor(v)))`。
- `task-logs` 的 `limit`：空串/非有限数 → 50；否则 `min(max(floor(v), 1), 200)`。空字符串以外、`Number` 后是 `0` 的输入（如 `" "`）收口到 1。
- `task-logs(+summary)` 的 `sinceMinutes`：空串/非有限数 → 忽略时间下界；只有 `floor(v) > 0` 才设 `start = now - v 分钟`，`<= 0` 一律忽略。
- `status`：trim 后不在 `pending`/`processing`/`completed`/`failed` 内一律当 `undefined`，不报错。`summary` 不接收 `jobId`。
- `task-logs` 直接返回 `items` JSON 数组，不是 `{page, pageSize, total, items}`。

## 5. 查询语义

- **新闻源质量**：`totals.total` 该 org 全部新闻源；`active` 是 `isActive`；`failing` 是 `consecutiveFailures > 0`；`circuitOpen` 是 `isActive` 且 `circuitOpenUntil > now`。`topFailingSources` 查 `PipelineJob`（`orgId`、`status='failed'`、`sourceId IS NOT NULL`、`createdAt >= since`），按 `sourceId` 分组 `COUNT(id)` 降序取前 10，再回查本组织 `NewsSource`；时间字段 ISO 或 `null`。
- **流水线质量**：
  - `totals`（`total`/`completed`/`failed`/`processing`/`pending`）来自 `processeditems`（`orgId`、`createdAt >= since`）的 `status` 分组；`successRate = completed / total`（`total = 0` 为 `null`）。
  - `averageLatencyMs` 是 `status='completed'` 且 `llm.latencyMs` 为数字的平均值 `Math.round`，无样本为 `null`。
  - `llmModels` 是 `status='completed'` 按 `ifNull(llm.model, "unknown")` 分组、`count` 降序前 10；`avgLatencyMs`/`avgTotalTokens` 用 `Math.round`，`avgCostUsd` 用 `Math.round(v*1000)/1000`。
  - `ingestionLatencyMs` 取最近 5000 条 `status='completed'` 且 `ingestedAt` 为日期的文档，`createdAt - ingestedAt`（`>= 0`）升序后算 `sampleSize`/`averageMs`/`p50Ms`/`p90Ms`/`p99Ms`/`maxMs`；分位数下标 `Math.floor(pct*(len-1))`；无样本 `sampleSize: 0`、其余 `null`。
  - `failureTypes` 查 `tasklogs`（`orgId`、`queue='itemPipeline'`、`status='failed'`、`createdAt >= since`），按 `{stage, errorName}` 分组 `count` 降序前 20。
  - `outbox` 查 MySQL `MongoOutbox`（`orgId`、`type='processed_item'`）：统计 `pending`/`processing`/`failed`/`dead`/`total`；`staleProcessing` 是 `processing` 且 `lockedAt < now-5 分钟`；最早未完成记录（`status IN (pending, failed, processing)` 按 `createdAt` 升序第一条）算 `oldestCreatedAt` 与 `oldestAgeMinutes`。
- **任务日志**：复用 `internal/adminlogs` 的同一聚合与深层脱敏（`message`/`data`/`error`/`topErrors.errorName`/`sampleMessage`）。
- **质量总览**：pipeline 用请求的 `windowMinutes`；newsSources 固定 `windowHours=24`；taskLogs 固定 `sinceMinutes=60`、`limit=10`（`items` 只取 `status='failed'` 前 10，`summary` 仍统计窗口内全部状态与 `topErrors`）。

## 6. 缺陷修复（Nest 与 Go 两侧同修）

**缺陷**：`PipelineQualityService.buildSummary` 在 `apps/api/src/modules/observability/pipeline-quality.service.ts` 第 337–341 行构造 `failureTypes` 时直接写 `errorName: String(entry._id?.errorName ?? "unknown")`，没有调用 `redactSensitiveFields`；而同一张 Mongo `tasklogs` 集合在 `AdminLogsService.runTaskLogAggregate` 第 488–490 行对 `errorName` 做了 `redactSensitiveFields`。失败任务的 `error.name` 若带 `Bearer xxx`、`token=xxx`、`api_key=xxx`，`/api/admin/quality/pipeline` 与 `/api/admin/quality/overview` 会把原文写进快照并返回前端。

修复：

- Nest：`pipeline-quality.service.ts` 导入 `redactSensitiveFields`（`@modular/utils`），映射 `failureTypes` 时对 `String(entry._id?.errorName ?? "unknown")` 调用它（第 337–343 行）。
- Go：`internal/qualityoverview/service.go` 的 `buildPipelineSummary` 用 `adminlogs.RedactSensitiveFields` 处理 `failureTypes.errorName`（与任务日志同一函数、同一套 9 条正则，不维护第二套）。

只改读取输出，不动库内已存文档；快照缓存被重建后也会写入脱敏结果。

## 7. 身份与鉴权（照 admin logs / llm logs 现有实现，不新写规则）

- 没有 `Authorization` 或不是 Bearer：401。
- token 以 `mtk_` 开头：`internal/adminlogs.Service.AuthenticateMachine`——SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到/已撤销/已过期/组织停用：401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON，`orgId` 只用令牌行。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；JWT 里的 permissions 不算。
- 缺少 `settings.manage`：403。query 里的 `orgId` 不参与查询条件。

## 8. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `/api/admin/quality/classification/*`（`classification-quality.controller.ts`）。
- `/api/admin/quality/pipeline/runs`、`/api/admin/quality/pipeline/replay`、`/api/admin/quality/pipeline/rollback`（`pipeline-recovery.controller.ts`）。
- 上述 5 条的非 `GET` 方法与更长路径；`/api/admin/quality/`、`/api/admin/quality`。
- `/api/observability/*`、`/api/metrics`、异常上报 POST（不属于本开关）。

## 9. 验收与未验证项（诚实登记）

- 普通 CI：`go test ./...`（编译 + 既有 Go 测试 + 本批新增的参数规则 / 快照键 / 分位数 / 四舍五入单测、adminlogs 导出面单测与 5 条路由规则测试：开关缺省与 `legacy` 时这 5 条不在 Go 规则里；开关 `go` 时在且都是 Exact + 仅 GET；`pipeline/runs`、`pipeline/replay`、`pipeline/rollback`、`classification/*`、更长路径与父路径都不在 Go 规则里）。`api-go-quality-overview-smoke.yml` **不进普通 CI**。
- 真实栈 smoke：`api-go-quality-overview-smoke.yml`（`workflow_dispatch` 或 PR 加 label `api-go-quality-overview-smoke`），只用隔离组织；向 MySQL 插入本组织与另一组织的 `NewsSource`/`PipelineJob`/`MongoOutbox`，向 Mongo 插入 `processeditems` 与 `tasklogs`（其中一条 `queue=itemPipeline`、`status=failed` 的 `error.name` 含 `Bearer secret.jwt.token`）。断言见 workflow。
- **未验证/未发生**：生产流量未切换；canary 保持关闭；不启用 shadow；未改前端；未改 Web 的 API 地址；SEC-01 的真实登录态不在本批验证；未处理 FE-TPL-02。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
