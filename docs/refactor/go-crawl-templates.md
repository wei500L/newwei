# 采集模板编辑接口（Go 接管说明）

> 本批：`API_GO_CRAWL_TEMPLATES_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源：`apps/api/src/modules/crawl/crawl-template.controller.ts`（全文，只有 4 个方法）、`crawl-template.service.ts`（全文）、`dto/crawl-template.dto.ts`（全文）、`crawl-config-policy.ts` 的 `assertNoUnsupportedProxy`（及其 `findUnsupportedProxyIssues`/`formatIssues`）、`crawl4ai-llm.guard.ts`（全文，逐段翻译，未使用简化版）。

## 1. 开关与回滚

- 变量：`API_GO_CRAWL_TEMPLATES_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名（`API_GO_CRAWL_TEMPLATES_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`（与新闻源、工作流、画像开关一致；`DATABASE_URL` DSN 无效时启动失败）。
- 回滚：**只把 `API_GO_CRAWL_TEMPLATES_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则。
- `infra/docker/.env.sample` 与 `infra/docker/docker-compose.yml` 的 pilot 默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值；`API_GO_CRAWL_PROFILES_MODE`、`API_GO_CRAWL_WORKFLOWS_MODE` 不受本批影响。
- **未启用 shadow。**

## 2. 接管的路径（仅 `go` 时）

控制器前缀 `admin/crawl-templates`，全局前缀 `api`。只接管这 4 条：

| 路径 | 方法 | 权限 | 成功码 | 说明 |
|---|---|---|---|---|
| `/api/admin/crawl-templates` | GET | `crawl.read` | 200 | 只查本 org；`search` 先 trim，非空时**只对 name** 做 contains（不搜 description）；`updatedAt desc, createdAt desc`；响应是 JSON 数组（不包 items） |
| `/api/admin/crawl-templates` | POST | `crawl.write` | 201 | `name` 服务端 trim，空 → 400 `name is required`；`description` 按 `normalizeOptionalNullableString`；`isActive` 缺省 true；`crawlOptions` 见 §6 |
| `/api/admin/crawl-templates/:id` | PATCH | `crawl.write` | 200 | id 恰好一段；先确认本组织存在；只更新 body 里出现的字段 |
| `/api/admin/crawl-templates/:id` | DELETE | `crawl.write` | 200 | id 恰好一段；响应体 `{ok:true}` |

响应字段就是表列：`id`、`orgId`、`name`、`description`、`isActive`、`crawlOptions`、`createdAt`、`updatedAt`。`crawlOptions` 为数据库 NULL 时 JSON 里是 `null`，不会变成 `{}`。时间按 NestJS `Date.toISOString()` 等价格式（毫秒 UTC）输出。

注册顺序：先精确路径的列表/创建，再恰好一段的 `:id`（只匹配 PATCH/DELETE）。预检 `OPTIONS` 由 Go 路由回答，随后回落 legacy。

## 3. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `GET /api/admin/crawl-templates/:id`（详情未迁移）。
- 未列出的方法（`PUT` 等）与更长路径（`/:id/extra`）、空段/多段路径。
- `crawl-tasks`（`crawl.controller.ts`，含 `POST /metadata`）、`crawl4ai` quality/queue、`crawl-media-assets`、news-source dispatch/ops。
- 本批不实现采集任务：不入队、不调用 crawl4ai、不启动 worker。

## 4. 缺陷修复（Nest 与 Go 两侧同修）

**缺陷：更新与删除核对组织之后只按主键写。** 修复前：`updateTemplate` 第 49-51 行按 id 查出再比较 orgId、第 76 行 `update` 的 where 只有 `{ id }`；`deleteTemplate` 第 80-82 行同样先查、第 84 行 `delete` 的 where 只有 `{ id }`。核对和写入不是同一条语句。

修复：UPDATE 与 DELETE 的 WHERE 同时包含 `id` 与 `orgId`；没有行就 404 `Crawl template not found`。本组织的成功结果不变。

- Nest：`apps/api/src/modules/crawl/crawl-template.service.ts` 第 76 行（update）、第 84 行（delete）——保留第 49-51 / 80-82 行的存在性核对，写入条件补上 `orgId`（与画像修复同一模式，Prisma extendedWhereUnique）。
- Go：`internal/crawltemplate/store.go` `UpdateTemplate`/`DeleteTemplate`——同样先 `SELECT id ... WHERE id = ? AND orgId = ?`（无行 404），UPDATE/DELETE 的 WHERE 同时含 `id` 与 `orgId`。

列表与创建的查询条件不动（它们已经带 `orgId`）。被新闻源引用时按数据库现有外键行为（`NewsSource_crawlTemplateId_fkey` 是 `ON DELETE SET NULL`）处理：Go 与 Nest 都只执行 `DELETE`，不预先清引用。

## 5. 身份与鉴权（照新闻源/画像现有实现，不新写规则）

- 没有 `Authorization` 或不是 Bearer：401（`authhttp.WriteUnauthorized`）。
- token 以 `mtk_` 开头：不调用 `authhttp.Authenticate`（它会拒绝 `mtk_`）；用 SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到、已撤销、已过期、组织停用：401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON 里的字符串数组，`orgId` 只用令牌行的。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；JWT 里的 permissions 不算。
- 缺少方法要求的权限：403（`authhttp.WriteForbidden`，required 是 `crawl.read` 或 `crawl.write`）。
- body、query 里出现 `orgId` 不参与查询条件；org 一律来自鉴权身份。

## 6. 请求体校验与两个守卫

对齐 `dto/crawl-template.dto.ts` 三个 DTO，错误形状用 `GlobalExceptionFilter` 的现有 400（whitelist + forbidNonWhitelisted + transform；未知字段 400 `property X should not exist`）。`isActive` 用 `Boolean(value)` 语义（`@Type(() => Boolean)`）。

`crawlOptions` 归一化（对齐 `normalizeOptionalNullableString`/`normalizeOptionalObject`）：

- 缺省或归一化结果为 null：写入数据库 `NULL`，不写 `{}`。
- 非对象（含数组）：400 `crawlOptions must be an object`。
- 对象：先 `assertNoUnsupportedProxy(value, "crawlOptions")`，再 `assertNoCrawl4aiLlmOptions(value, "crawlOptions")`；两句错误原文不变。

两个守卫逐段翻译进 `internal/crawltemplate/policy.go`，**仍然生效，未放宽**：

- `assertNoUnsupportedProxy` → `Unsupported crawl config: crawlOptions.proxyUrl: custom upstream proxies are not supported`（proxyUrl / proxyConfig，按此顺序、`; ` 连接）。
- `assertNoCrawl4aiLlmOptions` → 递归扫描对象与数组、环检测、最多列前 5 个键、其余 ` (+N more)`；英文句子 `crawlOptions contains crawl4ai LLM extraction settings (...). The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead.` 原样保留。命中键按字典序输出（NestJS `Object.entries` 按插入序；单一命中时两者一致，与 `crawlprofile/config.go`、`crawlworkflow/bridge.go` 的既有翻译一致）；表驱动测试覆盖代理字段拒绝、`extractionStrategy`/`llmConfig` 拒绝、`type` 带 `llm` 且路径含 `strategy`/`extraction` 拒绝、普通 markdown 选项通过、超过 5 个命中键截断、自引用对象/数组环检测终止。

更新时 `name` 为 `null`（IsOptional 放行）与 `isActive` 为 `null` 的 Prisma 写 null 分支，Go 镜像为 500 `Internal server error`（与 NestJS 生产行为一致，不带 error 字段）。同一组织同名撞 `@@unique([orgId, name])`：NestJS 现在没有收成 409（Prisma P2002 → 500 `Internal server error`），Go 保持同一响应，**不新造 Conflict 文案**。

## 7. 验收与未验证项（诚实登记）

- 普通 CI：编译 + 既有 Go 测试 + 本批路由测试（开关缺省时这 4 条不在 Go 规则里；开关 `go` 时在，且 `:id` 恰好一段；`GET /:id` 详情、`crawl-tasks`、`crawl4ai` 队列与更长路径不在 Go 规则里）+ 两个守卫的表驱动测试（无需数据库）。
- 真实栈 smoke：`api-go-crawl-templates-smoke.yml`（workflow_dispatch 或 PR 加 label `api-go-crawl-templates-smoke`，`SCHEDULE_ENABLED` 保持 false），只用隔离的 smoke 用户与 smoke 组织；覆盖 legacy 代理创建对照（直接打 Nest 读列表比对 name/description/isActive/crawlOptions）、空白 name 的 POST/PATCH 400 `name is required`（PATCH 不改原名）、`proxyUrl` 400 `Unsupported crawl config:` 前缀且不落库、`llmConfig` 400 含 `crawl4ai LLM extraction settings` 且不落库、只有 `crawl.read` 的用户 POST 403、跨组织 PATCH/DELETE 404 `Crawl template not found`、DELETE 成功 200 `{ok:true}` 后再列表不含、停止 Nest 后创建与列表仍成功且 `POST /api/crawl-tasks` 为 502。
- **未迁**：`crawl-tasks`（含 metadata）、`crawl4ai` quality/queue、`crawl-media-assets`、news-source dispatch/ops；`CrawlTemplate` 行的读写仅限本批 4 条。
- **未验证/未发生**：crawl4ai、模型与外网（AkShare/Nominatim 等）不在本批调用路径；采集 worker 未启动、未入队；SEC-01 的真实登录态未在本批验证；生产流量未切换；canary 保持关闭；不启用 shadow。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
