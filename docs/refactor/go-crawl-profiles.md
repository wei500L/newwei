# 采集站点画像编辑接口（Go 接管说明）

> 本批：`API_GO_CRAWL_PROFILES_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源：`apps/api/src/modules/crawl/crawl-frontier.controller.ts` 第 38-115 行、`crawl-site-profile.service.ts`、`dto/crawl-frontier.dto.ts` 的画像 DTO、`crawl-frontier.utils.ts` 的 `normalizeCrawlSiteProfileConfig`/`matchHostPattern`（逐段翻译，未使用 `crawl-frontier.service.ts`——runs 与 nodes 不在本批）。

## 1. 开关与回滚

- 变量：`API_GO_CRAWL_PROFILES_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本包含变量名。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`（与新闻源、工作流开关一致；`DATABASE_URL` DSN 无效时启动失败）。
- 回滚：**只把 `API_GO_CRAWL_PROFILES_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则。
- `infra/docker/.env.sample` 与 compose pilot 的默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值；同一前缀上的 `API_GO_CRAWL_WORKFLOWS_MODE` 规则不受本批影响。
- **未启用 shadow。**

## 2. 接管的路径（仅 `go` 时）

路由注册顺序：先精确路径 `profiles`、`profiles/match`、`profiles/preview`，再 `:id` 的 `rollback`、`versions`，最后才是恰好一段的 `:id`——`match`/`preview` 不会被当成 id。回滚是 `:id` 之后固定接 `rollback` 和恰好一段 version（`Rule.TailSegment`）。

读，权限 `crawl.read`：

| 路径 | 说明 |
|---|---|
| `GET /api/admin/crawl-frontier/profiles` | 只查本 org；`search` trim 后非空时 name/matchHost contains（数据库默认排序规则）；`updatedAt desc, createdAt desc`；响应是 JSON 数组（不包 items） |
| `GET /api/admin/crawl-frontier/profiles/match?url=` | url 必须是绝对 URL（`new URL` 规则）；只取本组织 `isActive` 的画像，按 `matchHostPattern` 过滤；响应 `{url, host, match, candidates}`，`url` 用请求原始字符串 |
| `GET /api/admin/crawl-frontier/profiles/:id` | id 恰好一段；先按主键查再看 orgId，两者不符都是 404 `Crawl site profile not found` |
| `GET /api/admin/crawl-frontier/profiles/:id/versions` | 画像属于本 org；返回全部版本行（Prisma 模型字段原样，config 为入库原文，不是 mapProfile），`version desc, createdAt desc` |

写，权限 `crawl.write`：

| 路径 | 成功码 | 说明 |
|---|---|---|
| `POST /api/admin/crawl-frontier/profiles/preview` | 201 | 不写数据库；draft 的 `id`/`createdById` 是 `draft`、`version` 0、`updatedById`/`publishedAt` 为 null、`createdAt`/`updatedAt` 是 Unix 纪元；name 缺省 `Draft profile`；`draftMatchReason` 两句英文原样拼接 |
| `POST /api/admin/crawl-frontier/profiles` | 201 | `name`/`matchHost` 服务端 trim，空 → 400 `name is required` / `matchHost is required`；`matchHost` toLowerCase；`executionMode` 只允许 layered/native/hybrid（缺省 layered）；`workflowBindingMode` 只允许 published/pinned（缺省 published）；config 走 `normalizeCrawlSiteProfileConfig`；version 用数据库默认 1 并写第一条版本快照；响应是 mapProfile |
| `PATCH /api/admin/crawl-frontier/profiles/:id` | 200 | 只更新 body 里出现的字段；不存在/跨组织 404 `Crawl site profile not found`；`name` trim 后空 400 `name is required`；`version` 加 1；版本快照与更新同事务 |
| `POST /api/admin/crawl-frontier/profiles/:id/rollback/:version` | 201 | version 按 `Number.parseInt(version, 10)`（`"10abc"` → 10；`"abc"` → NaN，找不到版本）；快照 where 是 orgId+profileId+version；写回快照字段后 version 加 1 并插新快照 |

## 3. 仍留在 NestJS（路由层回落，Go 不返回自己的 404）

- `GET/POST /runs` 及 runs 子路径、`POST /runs/cancel`、`POST /runs/:id/cancel`
- `GET /nodes/:id`、`POST /nodes/retry`、`POST /nodes/:id/retry`
- 已迁的 workflows 路径（由 `API_GO_CRAWL_WORKFLOWS_MODE` 决定）与 `GET /profiles/:id/workflow-bridge`（工作流开关的路由）
- trial-run、workflow-runs、replay 等未迁移路径；全部未列出的方法与更长路径（如 `DELETE /profiles/:id`、`GET /profiles/a/b`、`POST /profiles/:id/rollback`）

本批不实现 runs/nodes：不写 `CrawlFrontierRun`/`CrawlFrontierNode`、不入队、不启动 worker、不请求 crawl4ai。

## 4. 缺陷修复

**缺陷 1：跨组织工作流绑定**。修复前：`createProfile` 把 `workflowId`/`workflowVersionId` 直接写入（`crawl-site-profile.service.ts` 原 247-249 行），`updateProfile` 用 `connect: { id }` 只按工作流主键连接（原 306-314 行），不看工作流的 orgId；组织 A 可把自己的画像指到组织 B 的工作流或版本。

修复（两侧同修）：创建和更新时，`workflowId` 非空必须存在且 `CrawlStrategyWorkflow.orgId` 等于当前 orgId；`workflowVersionId` 非空必须存在且 `CrawlStrategyWorkflowVersion.orgId` 等于当前 orgId；否则 400，message 分别为 `Invalid workflowId` / `Invalid workflowVersionId`（与 `news-source.service.ts` 的 `assertWorkflowInOrg`/`assertWorkflowVersionInOrg` 文案一致）。清空（null）仍允许。不改工作流表。

- Nest：`crawl-site-profile.service.ts` 创建断言第 239-246 行、更新断言第 329-343 行、断言方法第 616-636 行。
- Go：`crawlprofile/store.go` 创建断言第 139-150 行、更新断言第 268-285 行、断言方法第 580-602 行。

**缺陷 2：更新/回滚只按主键写、版本快照不在同一事务**。修复前：`updateProfile` 先按 id 查出再比较 orgId（原 277-281 行）、UPDATE 的 where 只有 id（原 328-330 行）；`rollbackProfile` 的 where 也只有 id（原 379-380 行）；`createVersion` 在 update 成功之后单独插入（原 333-347 行）——中间失败会留下已加 version、但没有快照的画像。

修复（两侧同修，同一条 SQL、同一把行锁）：

```sql
BEGIN;
SELECT id FROM CrawlSiteProfile WHERE id = ? AND orgId = ? FOR UPDATE; -- 无行 → 404 Crawl site profile not found，回滚
-- 更新或回滚的 UPDATE WHERE 同时包含 id 与 orgId
-- 同一事务插入 CrawlSiteProfileVersion（version 用更新之后的数字）
COMMIT;
```

创建也把画像插入与第一条版本快照放进同一事务。不删除历史版本；`@@unique([profileId, version])` 冲突不变成新的业务文案（Nest 侧 Prisma P2002 与 Go 侧 MySQL 1062 都是 500 Internal server error）。有了行锁之后，同一画像的并发更新各自得到不同 version。

- Nest：`crawl-site-profile.service.ts` `updateProfile` 第 280-386 行、`createProfile` 第 247-278 行、`rollbackProfile` 第 395-460 行、`createVersion`（接收事务客户端）第 570-604 行。
- Go：`crawlprofile/store.go` `CreateProfile` 第 113-190 行、`UpdateProfile` 第 197-336 行、`RollbackProfile` 第 377-434 行。

**回滚 version 的解析**：两侧按 `Number.parseInt(version, 10)`；`"10abc"` 得到 10；`"abc"` 得到 NaN。Nest 侧增加 `Number.isInteger` 判定后按 404 `Crawl site profile version not found` 处理（原实现会把 NaN 交给 Prisma 抛校验错误）；Go 侧同一语义。

## 5. 身份与鉴权（照新闻源现有实现，不新写规则）

- `Authorization` 不是 Bearer 或没有 token：401（文案与 `authhttp.WriteUnauthorized` 一致）。
- token 以 `mtk_` 开头：不调用 `authhttp.Authenticate`（它会拒绝 `mtk_`）；用 SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到、已撤销、已过期、组织停用：401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON 里的字符串数组，`orgId` 只用令牌行的 `orgId`。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；JWT 里的 permissions 不算。
- 人类或机器令牌缺少方法要求的权限：403（`authhttp.WriteForbidden`，required 是 `crawl.read` 或 `crawl.write`）。
- body、query 里出现 `orgId`/`userId` 不参与查询条件；org 一律来自鉴权身份。

## 6. 请求体校验

对齐 `dto/crawl-frontier.dto.ts` 的 List/Create/Update/Match/Preview 五个画像 DTO（Run/Bulk 不在本批），错误形状用 `GlobalExceptionFilter` 的现有 400。对照 ValidationPipe：whitelist + forbidNonWhitelisted + transform——未知字段 400 `property X should not exist`；消息文本与顺序按 class-validator 的约束逐条生成（`MaxLength` 计数用 validator.js `isLength` 的码点语义；`@Type(() => Boolean)` 用 `Boolean(value)` 语义）。时间字段输出为 NestJS 的 `Date.toISOString()` 等价格式（毫秒 UTC）。

URL 字段两层校验都翻译了：DTO 层复刻 validator.js 13.15.23 的 `isURL`（`{ require_tld: false, require_protocol: true }` + 库默认协议名单 http/https/ftp），失败消息 `url must be a URL address`；服务层 `parseUrl`（`new URL` 规则）失败消息 `url must be a valid absolute URL`。已知不逐位复刻的边角（HTTP 路径上先被 DTO 拦截）：IDN 主机名的 punycode 转换、孤立百分号校验、端口数字与范围校验（isURL 已覆盖）。

两个 500 镜像（与 NestJS 生产行为一致，不带 error 字段）：更新时 `name`/`matchHost` 为 null 的 `null.trim()` TypeError；Prisma 拒绝为不可空字段（isActive/executionMode/workflowBindingMode）写 null。

## 7. 验收与未验证项（诚实登记）

- 普通 CI：编译 + 既有 Go 测试 + 本批路由测试（开关缺省时这 8 条不在 Go 规则里；开关 `go` 时在且方法正确；`profiles/match`、`profiles/preview` 不是 `:id`；runs、nodes、workflows、workflow-bridge 不在 Go 规则里；rollback 的 `:id/rollback/:version` 形状与 `:id/versions`/`:id` 各自独立；与工作流开关互不影响）。
- 真实栈 smoke：`api-go-crawl-profiles-smoke.yml`（workflow_dispatch 或 PR 加 label `api-go-crawl-profiles-smoke`，`SCHEDULE_ENABLED` 保持 false），只用新建的 smoke 用户与 smoke 组织；覆盖 legacy 代理创建对照、空白 name 400、403、跨 org 404、跨组织工作流绑定 400（Nest 与 Go 都验证）、match、preview 不落库、开关 go 后并发 PATCH 各自得到连续 version、rollback、停止 Nest 后创建与列表仍成功且 `POST /runs` 为 502。
- **未迁**：runs、nodes、cancel、retry；`CrawlFrontierRun`/`CrawlFrontierNode` 不受本批影响。
- **未验证**：crawl4ai、模型与外网（AkShare/Nominatim 等）不在本批调用路径；采集 worker 未启动、未入队；SEC-01 的真实登录态未在本批验证；生产流量未切换；canary 保持关闭；未实现 publishShadowProfile（该函数不在本批 8 条 HTTP 内）。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
