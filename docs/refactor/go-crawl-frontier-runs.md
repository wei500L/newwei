# 采集 Frontier 运行监控与取消（Go 接管说明）

> 本批：`API_GO_CRAWL_FRONTIER_RUNS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，
> canary 保持关闭，未启用 shadow，不改前端。回滚只把这一个变量改回 `legacy`。
> 基线：`origin/main@39ad5b55`。事实源：`apps/api/src/modules/crawl/crawl-frontier.controller.ts:117-219`、
> `crawl-frontier.service.ts` 的 `listRuns/getRun/getNode/getRunWorkflowRun/cancelRun/cancelRuns/cancelRunRecords`
> 与 summary/trace 构造、`crawl-strategy.controller.ts:127-154`、
> `crawl-strategy-runtime.service.ts:196-206`、`crawl-strategy-run-recorder.service.ts` 的
> `getRun/mapRun/mapStep/mapCandidate/mapEvent/appendEvent/markRunStatus`、
> `dto/crawl-frontier.dto.ts` 的两个 Run DTO、`packages/db/prisma/schema.prisma` 的列顺序。

## 1. 开关与回滚

- 变量：`API_GO_CRAWL_FRONTIER_RUNS_MODE`。只接受空串、`legacy`、`go`；空串与 `legacy`
  等价。**其他值启动失败**，错误文本一字不差：
  `API_GO_CRAWL_FRONTIER_RUNS_MODE must be one of legacy|go`。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`（`appendAuthRequirements`）。
  **不要求 `MONGO_URI`**，本批不读 Mongo，不启动采集 worker，不入队，不请求 crawl4ai。
- 回滚：只把 `API_GO_CRAWL_FRONTIER_RUNS_MODE` 改回 `legacy`——legacy 不注册 handler、
  不追加任何路由规则，纯配置变更。
- `infra/docker/docker-compose.yml` 的 api-go 服务用
  `${API_GO_CRAWL_FRONTIER_RUNS_MODE:-legacy}`，`infra/docker/.env.sample` 为
  `API_GO_CRAWL_FRONTIER_RUNS_MODE=legacy`。不改其他 `API_GO_*` 默认值。

## 2. 接管的 11 条路由（仅 `go` 时）

所有路径以 `/api/admin/crawl-frontier` 开头。路由规则只登记下表中的方法；同一路径的
其他方法、带尾斜杠与更长路径继续回落 `/api/` legacy（Go 不返回自己的 404）。
`GET /runs/cancel` 由 `runs/:id` 规则处理（`id="cancel"`），返回与 Nest `@Get("runs/:id")`
相同的 404。

| # | 方法 | 路径 | 权限 | 成功码 | Nest 实现 |
|---|---|---|---|---|---|
| 1 | GET | `/runs`（exact） | `crawl.read` | 200 | `CrawlFrontierService.listRuns` |
| 2 | GET | `/runs/:id` | `crawl.read` | 200 | `getRun` |
| 3 | GET | `/runs/:id/workflow-run` | `crawl.read` | 200 | `getRunWorkflowRun` |
| 4 | GET | `/runs/:id/workflow-candidates` | `crawl.read` | 200 | `listRunWorkflowCandidates` |
| 5 | GET | `/runs/:id/workflow-candidates/:candidateId` | `crawl.read` | 200 | `getRunWorkflowCandidateExplanation` |
| 6 | POST | `/runs/cancel`（exact） | `crawl.write` | **201** | `cancelRuns` |
| 7 | POST | `/runs/:id/cancel` | `crawl.write` | **201** | `cancelRun` |
| 8 | GET | `/nodes/:id` | `crawl.read` | 200 | `getNode` |
| 9 | GET | `/workflow-runs/:runId` | `crawl.read` | 200 | `CrawlStrategyRuntimeService.getRun` |
| 10 | GET | `/workflow-runs/:runId/candidates` | `crawl.read` | 200 | `listRunCandidates` |
| 11 | GET | `/workflow-runs/:runId/candidates/:candidateId/explanation` | `crawl.read` | 200 | `getCandidateExplanation` |

POST 成功码是 201，因为控制器没有 `@HttpCode`。

### 仍在 NestJS（路由层回落）

- `POST /runs`（createRun，会入队并调用 crawl4ai）
- `POST /nodes/retry`、`POST /nodes/:id/retry`（BullMQ 入队）
- `POST /workflow-runs/:runId/replay`、`POST /workflows/:id/trial-run`
- `/profiles/**`、`/workflows/**`、`/workflow-versions/**`、`/news-sources/**`
  （属于 `API_GO_CRAWL_PROFILES_MODE` / `API_GO_CRAWL_WORKFLOWS_MODE`，本开关不改变其归属）
- 上表路径的其他方法，以及带尾斜杠或多一段的路径

## 3. 身份与鉴权

- 人类身份由 Go 独立完成：HS256 验签、Redis 撤销名单（fail-closed）、MySQL membership
  重推导权限；不信任 JWT 里的 `permissions`。
- `mtk_` 机器令牌走 `MachineAccessToken` 的 SHA-256 查表，要求未撤销、未过期、
  `Org.isActive`，并更新 `lastUsedAt`；权限与 orgId 只来自令牌行。
- 失败顺序：401 → 403（`Forbidden resource` 形状照 `authhttp`）→ 400（DTO）→ service 错误。
  handler 先鉴权再解析/校验请求体，等价于 Nest 的 guard 先于 pipe。
- 跨租户一律 404：run、node、workflow run 都先按主键查、再比对 orgId，不存在与跨租户
  返回同一句 404。

## 4. DTO 与响应契约

- `GET /runs` 的 `ListCrawlFrontierRunDto` 全部 `@IsOptional @IsString`：
  `search` ≤200、`profileId` ≤191、`status ∈ {pending,queued,running,completed,failed,canceled}`、
  `executionMode ∈ {layered,native,hybrid}`、`runRole/failureKind/warningFlag` ≤64、
  `seedStrategy ∈ {auto,seed_first,frontier_first,frontier_only}`。
  未知 query 报 `property X should not exist`；重复参数在 Express 中是数组，按
  class-validator 生成 `… must be shorter than or equal to N characters; X must be a string`
  （MaxLength 先于 IsString，与 Nest 逐字节一致）；MaxLength 用 validator.js `isLength`
  的码点语义（UTF-16 长度 − 代理对 − 变体选择符对）。
- `POST /runs/cancel` 的 `BulkCrawlFrontierIdsDto` 消息顺序（装饰器自下而上）：
  `each value in ids must be shorter than or equal to 191 characters`、
  `each value in ids must be a string`、`ids must contain no more than 200 elements`、
  `ids should not be empty`、`ids must be an array`。
- 请求体校验通过后，每项 trim、去空、去重并保持首次出现顺序；结果为空时 400
  `ids must contain at least one run id`。
- 响应严格按 Prisma 列顺序输出；时间字段是 `Date.toISOString()` 等价格式（毫秒 UTC）
  或 `null`；`keywords` 原样透传（SQL NULL → `null`）；`metadata` 只有是 JSON 对象时
  原样透传，数组/标量/null 输出 `null`。
- `summary` 逐行移植 `buildRunAdminSummary`：`coverageByPageType` 空时回落
  `{home:0,category:0,list:0,article:0}`，`coverageByDepth/candidateStats/rejectionCounts`
  空时回落 `{}`；数值一律走 **JS `Number()` 语义**（空串 0、`true`/`false` 1/0、`null` 0、
  空数组 0、单元素数组 `Number(String(x))`、多元素/对象 NaN；接受 `0x/0o/0b` 与
  `Infinity` 字面量，拒绝 `inf`/`nan`/hex float/下划线），非有限数被丢弃；
  `warningFlags` 合并 `metadata.warningFlags`、两个 LLM judge 失败标志与 failureKind
  （`metadata.failureKind` 优先，否则 `classifyFrontierFailureKind(lastError)`），trim、
  去空、按首次出现去重。
- `repairSummary` 的两次查询都带调用者 `orgId`：先由节点收集 `crawlResultId` 并去重，
  再查 `CrawlResult`，再按 contentHash 查 `Article`；节点引用其他组织的 CrawlResult
  不会贡献统计。
- `trace` 的 6 个 step（seed、topology、frontier、native、llm_judge、shadow_learn）
  状态、detail、tags 逐字移植；tag 模板串使用**未 trim 的原始值**
  （例如 `strategy:${metadata.seedStrategy}`），随后整体 trim 去重。

### `undefined` 省略规则

Nest 用 `?? undefined` 表达的键在 JSON 中会被 `JSON.stringify` 丢掉；Go 用指针字段 +
`omitempty` 表达，并保证 `0`、`""`、`false` 保留：

- `stepResults[].metrics`：对象时输出，否则省略；`durationMs` 缺省写 0。
- `candidates[]`：`title/description/author/pageType/relevanceScore/score/freshnessScore/qualityScore`
  为 null 时省略；`metadata` 非对象输出 `{}`；`sourceNodeId` 缺省 `"unknown"`。
- `trace[]`：`accepted/scoreDelta/freshnessDelta` 为 null 时省略；`ruleHits` 非数组省略；
  `rejectedReason` 只在 `details.rejectedReason` 是字符串时输出；三个 snapshot/details
  非对象省略。
- `systemEvents[].details` 非对象省略。
- `llmLogFilters.repair` 只在文章有 `metadata.llmRepair` 对象时输出，否则整个键省略；
  `profileId` 为空时省略。

## 5. 取消协议与幂等语义（F1 修复后）

`cancelRunRecords(orgId, ids)` 两侧一致：

```sql
BEGIN;
SELECT id, workflowRunId FROM CrawlFrontierRun
WHERE orgId = ? AND id IN (?, …) AND status NOT IN ('completed', 'canceled')
ORDER BY id ASC
FOR UPDATE;                      -- 升序加锁，两个批量取消交叉不死锁
-- 无行 → COMMIT，返回空列表
UPDATE CrawlFrontierRun SET status='canceled', finishedAt=?, updatedAt=? WHERE orgId=? AND id IN (锁定 id);
UPDATE CrawlFrontierNode SET status='canceled', updatedAt=?
  WHERE orgId=? AND runId IN (锁定 id) AND status IN ('pending','queued','running');
COMMIT;
-- 提交后按 id 升序，对每个有 workflowRunId 的锁定行：
--   sequence = COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId=? + 1
--   插入 frontier_run_canceled 事件（details={"frontierRunId":"<id>"}，createdAt=finishedAt）
--   UPDATE CrawlStrategyWorkflowRun SET status='canceled', error=NULL, finishedAt=?, updatedAt=NOW(3)
```

- 终态运行（`completed`/`canceled`）永远不会被改写；取消它们是幂等无操作。
- `POST /runs/:id/cancel` 无论是否发生状态转换都返回 #2 的完整详情，成功码 201。
- `POST /runs/cancel` 返回 `{canceledIds, canceledCount}`，`canceledIds` 只含实际发生
  转换的 id，按 id 升序；不存在、跨租户、已终态的 id 不出现。
- `failed` 仍允许取消（与前端 `status !== "completed" && status !== "canceled"` 一致）。
- 已知并刻意的行为：`appendEvent` 仍用 `COUNT(*) + 1` 计算 sequence（与 worker 共用
  代码，见 bug-ledger 的 F1-FOLLOWUP-01）。

## 6. 与 Nest 的已知差异与刻意保留

- 列表与节点的相同排序键（相同 `createdAt`、相同 `discoveredAt`）由数据库返回顺序决定，
  Nest（Prisma）与 Go 都是同一条 SQL，但 MySQL 对等值行不保证稳定顺序；smoke 用互不
  相同的值规避。
- `repairSummary` 的计数对象键序来自文章遍历顺序；两侧都是同一条 org 范围查询，smoke
  用单篇文章保证确定性。
- `POST workflow-runs/:runId/replay` 只要求 `crawl.read` 的权限缺陷**未修**（不在本批
  迁移范围，且控制器不可改），见 bug-ledger 的 F1-FOLLOWUP-02。

## 7. 验收与未验证项（诚实登记）

- 普通 CI：Go 单测覆盖 DTO 消息与顺序、`jsNumberish` 全分支、`collectNodeWarningFlags`
  （三类 failureKind 关键词）、`matchesRunQueryFilters`、`toNumericRecord`（字符串数字、
  `null` 为 0、空对象回落）、trace 6 个 step 的状态分支与未 trim 的 tag、`undefined`
  省略（含 0 与空串保留）、`llmLogFilters` 的 repair 省略、`extractionSummary`、
  取消协议的纯决策部分（终态过滤与 id 去重排序）、失败顺序 401→403→400→404；
  `legacyproxy` 路由测试覆盖 11 条归属、回落清单、`GET /runs/cancel` 走 Go，以及三个
  crawl-frontier 开关任意组合互不抢占。
- 真实栈 smoke：`api-go-crawl-frontier-runs-smoke.yml`（PR 加 label
  `api-go-crawl-frontier-runs-smoke` 或 workflow_dispatch；`SCHEDULE_ENABLED=false`），
  阶段 0 seed、阶段 1 Go/Nest 逐条 JSON 深度比对、阶段 2 F1 回归（终态跳过、单次转换、
  批量升序、并发取消、反向顺序批量取消、DTO 文案）、阶段 3 停 Nest 后 11 条仍由 Go
  服务且写队列路径为 502。无 `continue-on-error`。
- **未迁**：`createRun`、`retry`、`replay`、`trial-run`；BullMQ、crawl4ai 与任何外网
  调用都不在本批路径内。
- **未验证**：生产流量未切换；canary 保持关闭；SEC-01 真实登录态不在本批验证；本机
  按任务约束未运行 `pnpm install`、`go test`、`go build`、`go vet`、`docker`，验证全部
  在 GitHub Actions。
