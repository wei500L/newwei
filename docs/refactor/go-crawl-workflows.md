# 采集策略工作流编辑接口（Go 接管说明）

> 本批：`API_GO_CRAWL_WORKFLOWS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源：`apps/api/src/modules/crawl/crawl-strategy.controller.ts` 与其服务/DTO/registry/policy/bridge（逐段翻译，未使用 crawl-strategy-runtime.service.ts——试跑与回放不在本批）。

## 1. 开关与回滚

- 变量：`API_GO_CRAWL_WORKFLOWS_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`（与其它已迁单元一致；`DATABASE_URL` DSN 无效时启动失败）。
- 回滚：**只把 `API_GO_CRAWL_WORKFLOWS_MODE` 改回 `legacy`** —— 纯配置变更；legacy 时不注册 handler、不追加路由规则。
- `infra/docker/.env.sample` 与 compose pilot 的默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值。

## 2. 接管的路径（仅 `go` 时）

路由注册顺序：先精确路径 `node-schemas` 与 `compare`，再 `:id` 的 `draft`、`publish`、`versions`，最后才是恰好一段的 `:id`——`compare` 不会被当成 id。

读，权限 `crawl.read`：

| 路径 | 说明 |
|---|---|
| `GET /api/admin/crawl-frontier/workflows/node-schemas` | 直接返回 `CRAWL_STRATEGY_NODE_SCHEMAS`（不按 org 过滤；处理函数本来就没有 user） |
| `GET /api/admin/crawl-frontier/workflows` | 只查本 org；`search` trim 后非空时 name/description contains（数据库默认排序规则，不做大小写敏感）；`updatedAt desc, createdAt desc`；每条带 `publishedVersion` 与最近 10 个版本（version desc）；响应是数组 |
| `POST /api/admin/crawl-frontier/workflows/compare` | `leftVersionId`/`rightVersionId` 各按 `getVersion` 规则取；diff 结构按 `buildSettingsDiff`/`buildNodeDiff`/`buildEdgeDiff` 翻译；`bindingImpact` 只统计本 org。成功码是 NestJS 的 POST 默认 201（控制器没有 `@HttpCode` 覆盖） |
| `GET /api/admin/crawl-frontier/workflows/:id` | id 恰好一段；先按主键查再看 orgId，两者不符都是 404 `Workflow not found` |
| `GET /api/admin/crawl-frontier/workflows/:id/versions` | 工作流属于本 org；返回全部版本（不是 10 条），`version desc, createdAt desc` |
| `GET /api/admin/crawl-frontier/workflow-versions/:versionId` | versionId 恰好一段；跨 org 或不存在：404 `Workflow version not found` |
| `GET /api/admin/crawl-frontier/profiles/:id/workflow-bridge` | query 可带 `seedUrl`（原始值，无 DTO 校验）；profile 不存在/跨 org：404 `Crawl site profile not found`；响应是 `buildWorkflowFromProfile` 的返回值 |
| `GET /api/admin/crawl-frontier/news-sources/:id/workflow-bridge` | news source 不存在/跨 org：404 `News source not found`；`crawlOptions` 只在 crawlTemplate 存在、`isActive` 为真且 `crawlOptions` 是对象时带上（模板查询不带 orgId——与 NestJS 现有 include 相同，本批不改） |

写，权限 `crawl.write`：

| 路径 | 成功码 | 说明 |
|---|---|---|
| `POST /api/admin/crawl-frontier/workflows` | 201 | `name` 服务端 trim，空字符串 400 `name is required`；`description` 按 `normalizeOptionalString`；`draftDefinition` 缺省用 `createEmptyWorkflowDefinition`，随后 normalize + `assertSupportedWorkflowDefinition`；`createdById`/`updatedById` 是当前用户（机器令牌用令牌行的 user id）；响应是 `mapWorkflow` |
| `PATCH /api/admin/crawl-frontier/workflows/:id/draft` | 200 | 工作流不存在 404 `Workflow not found`；`draftDefinition` 必填对象；`name` 省略不改、出现先 trim、trim 后空 400 `name is required`（缺陷 2 修复，原先可写入空名）；`description` 省略不改；WHERE 同时含 `id` 与 `orgId` |
| `POST /api/admin/crawl-frontier/workflows/:id/publish` | 201 | body 可为空对象；`versionName` trim 后为空用工作流当前 name；`description` 省略沿用当前值、出现按 `normalizeOptionalString`；校验失败不插入版本；响应是 `{workflow, version}`；版本号见 §4 |

## 3. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `POST /workflows/:id/trial-run`、`GET /workflow-runs/:runId`、`GET /workflow-runs/:runId/candidates`、`GET /workflow-runs/:runId/candidates/:candidateId/explanation`、`POST /workflow-runs/:runId/replay`
- `/profiles` 的列表、创建、预览（match/preview）、更新、版本、回滚
- `/runs` 与 `/nodes`
- 全部未列出的方法与更长路径（如 `PATCH /workflows/:id/draft/extra`）

本批不实现试跑/回放/候选/解释：不调用 crawl4ai、不写 `CrawlStrategyWorkflowRun`、不入 BullMQ、不启动 worker。**未启用 shadow。**

## 4. 缺陷修复

**缺陷 1：发布版本号竞态（`crawl-strategy-workflow.service.ts` 的 `publishWorkflow` 第 169-174 行原在事务外用 `ensureWorkflow` 的 versions 算 nextVersion，第 186 行才开始事务）**。两侧同修，同一条 SQL、同一把行锁（Nest 进程与 Go 进程会同时发布，不做应用层 mutex）：

```sql
BEGIN;
SELECT id FROM CrawlStrategyWorkflow WHERE id = ? AND orgId = ? FOR UPDATE; -- 无行 → 404 Workflow not found，回滚
SELECT COALESCE(MAX(version), 0) FROM CrawlStrategyWorkflowVersion WHERE workflowId = ? FOR UPDATE; -- 必须当前读
-- nextVersion = MAX + 1
INSERT INTO CrawlStrategyWorkflowVersion (...version, ...);
UPDATE CrawlStrategyWorkflow SET publishedVersionId = ?, description = ?, updatedById = ? WHERE id = ? AND orgId = ?;
COMMIT;
```

MySQL 默认可重复读时，锁等待之后的普通 SELECT 可能仍看见旧快照，所以 MAX 那条必须是 `FOR UPDATE`。唯一冲突（MySQL 1062 / Prisma P2002）没有在锁协议下消失时，**在同一事务内重取 MAX 再插一次**，不把 1062/P2002 返回成 500。不删除旧版本、不修改已有 version 数字；缺陷 1 不加新索引（表上已有 `@@unique([workflowId, version])`）。

**缺陷 2：空白名称（`updateDraft` 第 145 行原只做 `input.name.trim()` 就写入；DTO 的 `IsNotEmpty` 把 `"   "` 当成非空）**。两侧同修：`name` 出现时先 trim，trim 后为空返回 400 `name is required`，不执行 UPDATE；省略 name 保留原名。服务端 trim 后必须再判一次，不能只靠 DTO。

## 5. 身份与鉴权（照新闻源现有实现，不新写规则）

- `Authorization` 不是 Bearer 或没有 token：401（文案与 `authhttp.WriteUnauthorized` 一致）。
- token 以 `mtk_` 开头：不调用 `authhttp.Authenticate`（它会拒绝 `mtk_`）；用 SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到、已撤销、已过期、组织停用：401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON 里的字符串数组，`orgId` 只用令牌行的 `orgId`。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；JWT 里的 permissions 不算。
- 人类或机器令牌缺少方法要求的权限：403（`authhttp.WriteForbidden`，required 是 `crawl.read` 或 `crawl.write`）。
- body、query 里出现 `orgId`/`userId` 不参与查询条件；org 一律来自鉴权身份。

## 6. 请求体校验

对齐 `dto/crawl-strategy.dto.ts`，错误形状用 `GlobalExceptionFilter` 的现有 400（不新造 code/appCode）。对照 ValidationPipe：whitelist + forbidNonWhitelisted + transform——未知字段 400 `property X should not exist`；消息文本与顺序按 class-validator 的约束逐条生成（`MaxLength` 计数用 validator.js `isLength` 的码点语义）。时间字段输出为 NestJS 的 `Date.toISOString()` 等价格式（毫秒 UTC）。

## 7. 验收与未验证项（诚实登记）

- 普通 CI：编译 + 既有 Go 测试 + 本批路由测试（开关缺省时这些路径不在 Go 规则里；开关 `go` 时在，且方法正确；trial-run、workflow-runs、profiles 列表不在 Go 规则里；`workflows/compare` 与 `workflows/node-schemas` 不是 `workflows/:id`）。
- 真实栈 smoke：`api-go-crawl-workflows-smoke.yml`（workflow_dispatch 或 PR 加 label `api-go-crawl-workflows-smoke`，`SCHEDULE_ENABLED` 保持 false），只用新建的 smoke 用户与 smoke 组织；覆盖 legacy 代理创建对照、空白名 400、403、跨 org 404、跨进程并发发布（Go + Nest 同时发布，版本号连续、无 500、publishedVersionId 指向较大版本）、停止 Nest 后 Go 仍可创建/改草稿/发布、trial-run 回落为 502。
- **未迁**：试跑（trial-run）、回放（replay）、候选列表与解释；`CrawlStrategyWorkflowRun` 不受本批影响。
- **未验证**：crawl4ai、模型与外网（AkShare/Nominatim 等）不在本批调用路径；SEC-01 的真实登录态未在本批验证；生产流量未切换；canary 保持关闭。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
