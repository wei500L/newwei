# LLM 请求日志列表 / CSV 导出 / 用量汇总（Go 接管说明）

> 本批：`API_GO_LLM_LOGS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源：`apps/api/src/modules/news-pipeline/llm-request-log.controller.ts`（全文）、`llm-request-log.service.ts` 的 `queryLogs`、`exportLogsCsvStream`、`normalizeFilterForExport`、`validateExportDateWindow`、`resolveExportRowCount`、`writeExportAuditLog`、`getUsageSummary`、`resolveP95Latency`、`toExportCsvLine`、`escapeCsvValue`、`buildWhere`、`resolveMetadataPolicySummary`、`apps/api/src/modules/system-settings/llm-request-log-settings.service.ts` 的常量与 `mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys`、`packages/mongo/src/models/llm-request-log.ts`（Mongo 集合名 `llmrequestlogs`）。

## 1. 开关与回滚

- 变量：`API_GO_LLM_LOGS_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_LLM_LOGS_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST` 与 `MONGO_URI`（`DATABASE_URL` DSN 无效时启动失败；`appendAuthRequirements` + `MONGO_URI` 检查）。
- 回滚：**只把 `API_GO_LLM_LOGS_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则。
- `infra/docker/.env.sample` 与 `infra/docker/docker-compose.yml` 的 pilot 默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值；生产 Web 仍指向 NestJS（`API_BASE_URL` 未改），`CANARY_PERCENT` 保持 0。
- **未启用 shadow。**

## 2. 接管的路径（仅 `go` 时）

控制器前缀 `llm-logs`，全局前缀 `api`。三条都是精确 GET，权限都是 `settings.manage`：

| 路径 | 方法 | 响应类型 | 成功码 | 说明 |
|---|---|---|---|---|
| `/api/llm-logs` | GET | `application/json` | 200 | `{page, pageSize, total, items, metadataPolicy}`；只查当前 orgId；按 `createdAt` 降序分页 |
| `/api/llm-logs/export` | GET | `text/csv; charset=utf-8` | 200 | `Content-Disposition: attachment; filename="llm-logs-export.csv"`；固定表头；90 天窗口 + 50000 行上限 + 公式注入防护 + 导出审计 |
| `/api/llm-logs/summary` | GET | `application/json` | 200 | `{totals, statusBreakdown, governanceBreakdown, latency, topErrors, byModel, byDay}` |

`items` 的字段名与 `toListItem` 一致：`id`、`orgId`、`requestType`、`model`、`status`、`promptTokens`、`completionTokens`、`totalTokens`、`costUsd`、`feature`、`gatewayProfileId`、`governanceApplied`、`authMode`、`governanceTargetProfileId`、`latencyMs`、`error`、`metadata`、`apiSurface`、`createdAt`、`updatedAt`。`metadataPolicy` 含 `source`（`default` 或 `db`）、`allowedTopLevelKeys`、`allowedTopLevelPrefixes`、`keyCount`、`prefixCount`。

`summary` 的参数只有 `feature`、`profileId`、`runId`、`nodeId`、`start`、`end`——控制器这里不接收 `model`、`requestType`、`status`，保持现状（传了也不生效）。

注册顺序：三条精确路径互不为前缀，任意顺序都不会误命中；更长路径（`/api/llm-logs/export/extra`、`/api/llm-logs/`、`/api/llm-logs/a/b`）与未列出的方法（`POST`/`PUT`/`DELETE`）回 `/api/` 的 legacy 规则由 NestJS 处理。预检 `OPTIONS` 由 Go 路由回答，随后回落 legacy。

## 3. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- **`/api/system-settings/llm-request-logs`（含 `metadata-policy`、`reset`）整组不迁移**：这组设置会修改 Mongo TTL 索引（`llm_request_log_created_at_ttl`），留在 Nest。
- Go 只从 MySQL `SystemSetting` 读 `llm_request_log_settings` 来算出列表响应里的 `metadataPolicy`（不写库、不动索引）。
- `/api/llm-logs` 的其他方法与更长路径。

## 4. 缺陷修复（Nest 与 Go 两侧同修）

**缺陷：导出 CSV 丢掉了 runId 与 nodeId 过滤条件。**

- `LlmRequestLogController.export` 在 `llm-request-log.controller.ts` 第 279-288 行已经解析出 `runId` 与 `nodeId` 并传给 `exportLogsCsvStream`。
- 但 `LlmRequestLogService.normalizeFilterForExport`（`llm-request-log.service.ts` 第 497 行起）此前只拷贝 `orgId`、`model`、`feature`、`profileId`、`requestType`、`status`、`start`、`end`，漏掉 `runId` 与 `nodeId`。结果是列表和汇总都能按 `runId`、`nodeId` 过滤，唯独导出 CSV 把这两个条件丢掉，导出全组织的数据。

修复：`normalizeFilterForExport` 的返回对象补上

```ts
runId: this.normalizeProfileId(filter.runId) ?? undefined,
nodeId: this.normalizeProfileId(filter.nodeId) ?? undefined,
```

（现在是该文件第 508-509 行）导出因此与列表共用同一套 `runId`/`nodeId` 条件。Go 侧 `internal/llmlogs/where.go` 的 `normalizeFilterForExport` 同样保留两个字段，由 `internal/llmlogs/where_test.go` 断言「导出 where 与列表 where 完全一致」。导出审计 metadata 保持现有字段，未改表结构。

## 5. 身份与鉴权（照新闻源/画像/模板/工作流现有实现，不新写规则）

- 没有 `Authorization` 或不是 Bearer：401（`authhttp.WriteUnauthorized`）。
- token 以 `mtk_` 开头：不调用 `authhttp.Authenticate`（它会拒绝 `mtk_`）；用 SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到、已撤销、已过期、组织停用：401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON 里的字符串数组，`orgId` 只用令牌行的。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；JWT 里的 permissions 不算。
- 缺少 `settings.manage`：403（`authhttp.WriteForbidden`）。
- query 里出现 `orgId` 不参与查询条件；org 一律来自鉴权身份。所有查询（列表、导出、汇总、metadataPolicy 之外的 Mongo 读）都带服务端推导的 `orgId`。
- 机器令牌导出时审计 `actorId` 传 `null`（人类令牌用用户 id），避免 `AuditLog.actorId` 外键失败。

## 6. 参数校验（与控制器逐字一致）

- `start`、`end` 非空但不是合法日期：400 `<name> must be a valid date`。
- `start > end`：400 `start must be earlier than or equal to end`。
- `page`、`pageSize` 非空但不是正有限数：400 `<name> must be a positive number`；正小数用 `Math.trunc`。缺省 `page=1`、`pageSize=20`，服务层再收口到 1..100。
- `requestType` 非空且不在 `completion|embedding|rerank|stream|responses`：400 `requestType must be one of completion, embedding, rerank, stream, responses`。
- `status` 非空且不在 `success|error`：400 `status must be one of success, error`。
- `feature` trim 并转小写后，长度 > 64 或不匹配 `^[a-z0-9_:\-.]+$`：400 `feature must be a lowercase token with [a-z0-9_:. -], max 64 chars`。
- `profileId` trim 后长度 > 128：400 `profileId must be 128 characters or fewer`。
- `runId`、`nodeId` trim 后长度 > 128：400 `<name> must be 128 characters or fewer`。

`buildWhere` 的过滤规则（Go `internal/llmlogs/where.go` 与 Nest 一一对应）：`orgId` 必填且 trim 后为空落到 `_unknown_`；`model` trim 后精确匹配；`requestType`、`status` 精确匹配；`feature` 匹配 `$or: [{feature}, {"metadata.feature"}]`；`profileId` 匹配 `$or: [{gatewayProfileId}, {"metadata.profileid"}, {"metadata.crawlsiteprofileid"}]`；`runId` 匹配 `$or: [{"metadata.runid"}, {"metadata.frontierrunid"}]`；`nodeId` 匹配 `$or: [{"metadata.nodeid"}, {"metadata.frontiernodeid"}]`；`start`、`end` 落在 `createdAt` 的 `$gte`、`$lte`。所有 `$or` 收进 `$and`。

## 7. 导出细节（保留项，未放宽）

- `Content-Type: text/csv; charset=utf-8`；`Content-Disposition: attachment; filename="llm-logs-export.csv"`。
- 同时传了 `start` 与 `end` 且 `end - start > 90 天`：400 `export date range cannot exceed 90 days`。
- 先探测匹配行数（最多取 50001 条 `_id`）；超过 50000 条：400 `export row count exceeds 50000; narrow filters or date range`。
- 表头固定 `timestamp,model,requestType,status,durationMs,inputTokens,outputTokens,totalTokens,error`；每行按 `createdAt` 降序；`model` 为空写 `unknown`；`durationMs` 是 `Math.max(0, Number(latencyMs ?? 0))`。
- **公式注入防护照 `escapeCsvValue` 原样翻译**：字符串去掉前导空白后，若以 `=`、`+`、`-`、`@` 开头且不是纯数字（`^-?\d+(\.\d+)?$`），先在原字符串前加单引号 `'`，再做双引号与逗号转义。因此 `=SUM(1,2)` → `"'=SUM(1,2)"`（前导单引号 + 逗号引发的双引号包裹），`=cmd|' /C calc'!A0` → `'=cmd|' /C calc'!A0`，而 `-12.5` 不加单引号、`-cmd` 加单引号。`internal/llmlogs/csv_test.go` 表驱动覆盖这些用例。
- 成功与失败都写 MySQL `AuditLog`：`resource=llm_request_logs`、`action=export_csv`，metadata 含 `outcome`、`rowCount`、`durationMs`、`model`、`feature`、`requestType`、`status`、`start`、`end`、`errorMessage`；审计失败不阻断响应（先写 `AuditLog`，失败回落 `AuditLogOutbox`，与 `audit-log.writer.ts` 同形）。

## 8. 汇总细节

- `p95` 用 `resolveP95Latency` 的算法：`rank = Math.max(0, Math.ceil(count * 0.95) - 1)`，按 `latencyMs` 升序 `skip(rank)` 取 1 条；没有样本（或取不到行）时 `p95Ms` 为 `null`。
- `topErrors` 只统计 `status: "error"` 且 `error` 为非空字符串的文档，按 `count` 降序、`message` 升序，最多 5 条。
- `byModel` 按 `requestCount` 降序、`model` 升序（`model` 为空/非字符串时写 `unknown`）；`byDay` 按 UTC `%Y-%m-%d` 升序。
- 比率与均值沿用服务现有精度（`successRate`/`errorRate` 是直接相除，`avgLatencyMs` 是 `totalLatencyMs / requestCount`，`requestCount > 0` 才相除），未更换精度。

## 9. metadataPolicy 的来源

Go 读 MySQL `SystemSetting.value WHERE key = 'llm_request_log_settings'`：

- 没有行、`value` 解析失败、或字段类型不对：用默认列表且 `source` 为 `default`；
- 有行且 `value` 是合法 JSON：`source` 为 `db`，两个列表按 `normalizeMetadataTokenList` 的 lenient 规则归一化（小写、trim、按 `^[a-z0-9_:\-.]+$` 过滤、去重保序），非法时落回默认列表；
- **`REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS` 始终合并进 `allowedTopLevelKeys`**（`runid`、`nodeid`、`profileid`、`frontierrunid`、`frontiernodeid`、`crawlsiteprofileid`）。

读库失败不阻断列表（NestJS 侧用的是后台刷新缓存，不会因为一次读失败而让列表变 503）。

## 10. 验收与未验证项（诚实登记）

- 普通 CI：编译 + 既有 Go 测试 + 本批路由测试（开关缺省时这 3 条不在 Go 规则里；开关 `go` 时为三条精确 GET，其他方法与更长路径、以及 `/api/system-settings/llm-request-logs` 都仍回 NestJS）+ 参数校验与 CSV 公式防护的表驱动测试 + `buildWhere`/`normalizeFilterForExport`/`validateExportDateWindow`/metadataPolicy 的单测（无需数据库）。
- 真实栈 smoke：`.github/workflows/api-go-llm-logs-smoke.yml`（`workflow_dispatch` 或 PR 加 label `api-go-llm-logs-smoke`，`SCHEDULE_ENABLED` 保持 false），只用隔离的 smoke 用户与 smoke 组织，往 Mongo `llmrequestlogs` 插入本组织两条（不同 `runid`，其中一条 `error` 为 `=cmd|' /C calc'!A0`）与另一组织一条记录。
- **未迁**：`/api/system-settings/llm-request-logs`（含 `metadata-policy`、`reset`）整组；Go 从不修改 Mongo TTL 索引。
- **未验证/未发生**：本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。不调用真实模型服务；不打开 canary；不改其他开关默认值；生产流量未切换；不启用 shadow。FE-TPL-02 未处理；SEC-01 的真实登录态未在本批验证（只在报告里点名）。
