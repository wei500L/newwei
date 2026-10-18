# API 契约清单（Contract Inventory · 冻结基线）

> 生成时间：2026-09-03 · 基线 commit `95759f59`
> 用途：Go 迁移的契约保护网基线。**Strangler Fig 迁移期间，本清单中的路径、方法、状态码、错误结构、鉴权语义、事件名不得单方面变更**；确需变更走版本化演进并在本文件登记。
> 快照物：REST/OpenAPI 与 GraphQL SDL 的机器可读快照见 §7（第一阶段交付物）。
> 行号基于基线 commit；`apps/api/src/` 前缀省略。

---

## 0. 全局骨架（影响所有契约）

| 项 | 值 | 证据 |
|---|---|---|
| REST 全局前缀 | `api`（即 `/api/...`），排除 `admin/queues*`（Bull Board） | `main.ts:62-67` |
| 全局 Guard（REST） | `JwtAuthGuard` + `PermissionsGuard`（APP_GUARD） | `app.module.ts:118-126` |
| 全局过滤器 | `GlobalExceptionFilter`（APP_FILTER） | `app.module.ts:127-130` |
| 全局管道 | `ValidationPipe{whitelist, forbidUnknownValues, forbidNonWhitelisted, transform}` | `main.ts:68-75` |
| TraceId | 所有路由读 `x-trace-id`/`x-request-id`/`traceparent`，回写 `x-trace-id`+`traceparent` | `common/middleware/trace-id.middleware.ts:8-18`、`app.module.ts:135-139` |
| 其他中间件 | helmet、cookie-parser、json 10MB（保留 rawBody）、CORS credentials=true | `main.ts:107-117,146-150` |
| Swagger | `/docs`（env `swaggerEnabled`），Bearer JWT | `main.ts:154-166` |
| GraphQL 端点 | **`/graphql`（无 /api 前缀）**；Playground 同路径 | `apps/web/lib/env.ts:72-95`、README |
| Socket.IO | path `/socket.io`，namespace 挂根；可选 Redis adapter（`WS_REDIS_ADAPTER_ENABLED`） | `common/websocket/redis-io.adapter.ts:46-57` |

**Guard 语义**（`common/guards/`）：
- `@Public()` → 跳过 JWT + 权限
- `@AllowAuthenticated()` → 仅 JWT
- `@Permissions("a","b")` 任一满足 / `@PermissionsAll("a","b")` 全部满足 → JWT + 权限
- **无任何元数据 → 403 `PERMISSION_METADATA_MISSING`**（fail-closed，`permissions.guard.ts:38-46`）
- 权限不足 → 403 + `code:"INSUFFICIENT_PERMISSIONS"` + `requiredPermissions` 等（`permissions.guard.ts:72-79`）
- JWT Guard 对 graphql 上下文直接放行（GraphQL 侧 GqlAuthGuard 接管，`jwt-auth.guard.ts:19-21`）

**契约风险点（迁移前需决策）**——全库仅 5 个端点处于「无权限元数据 → 必 403」的死路由状态：
- `GET/PUT /api/user-settings/ui/onboarding`（`modules/user-settings/user-ui-settings.controller.ts:110,116`）——已修复（API-01，`edf0c8cf` 补 `@Permissions("items.read")`）
- `GET /api/auth/admin/registration-applications`（`auth.controller.ts:393`）、`POST .../approve-org`（:454）、`POST .../reject-org`（:471）——handler 内部另有鉴权，但全局 Guard 先拦

**Go 迁移状态（api-go 四态路由表，`apps/api-go/internal/legacyproxy/proxy.go`）**：
- user-settings 只读 GET ×6 —— **ModeGo（Go-批3B 统一接管：onboarding/rss-reader/spacetime-timeline/war-map/newsnow/situation-monitor；pilot 内 `API_GO_USER_SETTINGS_READ_MODE=go` 显式启用，优先级高于批3A 的 `API_GO_ONBOARDING_MODE`；默认未设置=兼容旧行为）**：六个 GET 全部由统一 Go handler（`internal/usersettingsread`）独立鉴权并全响应——Go 独立验签 HS256 access token（iss/aud/exp 按 jsonwebtoken 语义、jti 缺失按 NestJS 语义放行、拒绝 alg 混淆与 mtk_）、独立查询真实 Redis blacklist（`access-token:blacklist:<jti>` 同 key，fail-closed）、独立从 MySQL 重推导 User/Org/Membership 与 MembershipRole/RolePermission/Permission 权限（与 getUserProfile 同序同文案 401，多角色优先/primary 回退）、独立判定 `items.read`（JWT permissions claim 一律不参与）、独立查 UserSetting（五个单 key 端点各查一个编译期固定常量 key；situation-monitor 一次聚合查询三个固定 key，对齐 NestJS findMany）并经 normalization（War Map 完整移植 war-map-contract.ts；Situation Monitor 三段聚合；NewsNow 有序对象/上限/真值语义）写出契约等价响应（错误形状对齐 GlobalExceptionFilter）。路由为 exact+GET：六个 PUT 同路径与相似路径（onboarding-x/war-map-x/newsnow 子路径等）回落 legacy。已完成远端真实栈接管验证（Phase A-D：8 个固定 key 落库、shadow 零差异、go 契约全等、NestJS 停止后六端点仍 200 且代表性 PUT/未迁移 GET 502）。`API_GO_USER_SETTINGS_READ_MODE=shadow` 时六端点全部回 shadow 差分。
- user-settings 全部 PUT ×6（onboarding/rss-reader/spacetime-timeline/war-map/newsnow/situation-monitor）—— **`API_GO_USER_SETTINGS_WRITE_MODE`（Go-批3C）**：默认 `legacy`，精确路径 PUT 仍代理 NestJS；`go` 时由 `internal/usersettingswrite` 经同一鉴权链写入现有 `UserSetting`（八个固定 key 的 upsert，写后重读）。要求读模式同为 `go`。相似路径与其他方法仍回落 legacy。Situation Monitor 三段不是事务。
- 登录/refresh/MFA/OIDC/邮箱验证码/密码找回/邀请/注册审核/头像上传签名/个人数据导出 —— **仍由 NestJS 承载**；账户资料、会话退出与机器令牌管理 8 条精确路由可在 `API_GO_ACCOUNT_SECURITY_MODE=go` 时由 Go 承载（默认 legacy，见 §1.8s）。
- 搜索索引重建 ×2（`POST /api/admin/search/reindex`、`GET /api/admin/search/reindex/:jobId`，`settings.manage`）—— **`API_GO_SEARCH_REINDEX_MODE`（Go-批11）**：默认 `legacy`，只接受空串/`legacy`/`go`，非法值启动失败；`go` 时由 `internal/searchreindex` 共用既有 Redis job/list/orgs/lock 结构（`lock:search:reindex:org:<orgId>` 为物理键）、按 `itemMetaId` 游标分批读 Mongo `itemreadmodels` 并 bulk 写入 Elasticsearch（`refresh=false`，最后一次显式 refresh 才 completed）。两个遥测端点（`POST /api/search-telemetry`、`GET /api/admin/search-telemetry/summary`）的开关仍是 `API_GO_CRAWL_READ_TELEMETRY_MODE`；本批只优化其 Redis 往返（写入单次 Lua、汇总单次 Pipeline），不改存储与口径。`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`；Elasticsearch 不是启动条件。回滚只改 `API_GO_SEARCH_REINDEX_MODE`（细节见 §1.8t）。
- 入口链（Go-批2C）：api-go 具备生产容器（`infra/docker/api-go.Dockerfile`，distroless nonroot + `healthcheck` 子命令）与 Compose 独立 `api-go-pilot` profile 服务；`API_BASE_URL` 可切 `http://api-go:4020` 使入口变为 `Web → api-go → NestJS`（其余请求全部纯代理，契约不变），默认部署仍直连 NestJS。已通过远端真实栈运行验证（`api-go-entry-smoke`：真实登录 JWT + 六个 PUT 持久化 + Shadow GET 零差异零丢弃 + Go-批3A 鉴权链 + Go-批3B 四阶段接管验证）；生产/预发布真实流量验证未完成。trace header（`x-trace-id`/`traceparent`）在 api-go 入口链保持原语义（§0 TraceId 行为镜像）。

## 1. REST 契约（71 controller · 369 endpoint）

### 1.1 auth（45 个，前缀 `auth`，`modules/auth/auth.controller.ts`）

| Method | 路径 | 守卫/权限 | 行 |
|---|---|---|---|
| POST | /api/auth/login | @Public | 95 |
| POST | /api/auth/refresh | @Public（轮换式） | 108 |
| POST | /api/auth/send-verification | AllowAuthenticated | 119 |
| POST | /api/auth/verify-email | AllowAuthenticated | 135 |
| POST | /api/auth/send-login-code | @Public | 147 |
| POST | /api/auth/login-with-code | @Public | 156 |
| POST/GET | /api/auth/machine-tokens[...]（3 个 + :tokenId DELETE + rotate） | settings.manage | 168/184/190/199 |
| POST | /api/auth/password/forgot · reset | @Public | 209/228 |
| GET | /api/auth/mfa | AllowAuthenticated | 238 |
| POST | /api/auth/mfa/enroll · verify-enroll · disable · recovery/rotate | AllowAuthenticated | 244-268 |
| POST | /api/auth/mfa/verify-login · enrollment/start · enrollment/complete | @Public | 278/293/306 |
| GET/PUT | /api/auth/admin/oidc-config | settings.manage | 321/327 |
| GET/POST | /api/auth/admin/invites[.../:id/resend · revoke] | users.write | 347-384 |
| GET | /api/auth/admin/registration-applications | **无元数据（死路由）** | 393 |
| POST | .../registration-applications/:id/approve-join · reject-join | users.write | 418/439 |
| POST | .../registration-applications/:id/approve-org · reject-org | **无元数据（死路由）** | 454/471 |
| POST | /api/auth/register/applications · join-applications | @Public | 485/492 |
| GET | /api/auth/invitations/:token | @Public | 499 |
| POST | /api/auth/invitations/:token/accept · accept-authenticated | @Public / AllowAuthenticated | 505/518 |
| GET | /api/auth/sso/oidc/start · /api/auth/oidc/callback · /api/auth/sso/handoff/exchange | @Public | 531/538/579 |
| POST | /api/auth/logout | AllowAuthenticated | 591 |
| POST | /api/auth/avatar/presigned-url | AllowAuthenticated | 608 |
| PATCH | /api/auth/profile | AllowAuthenticated | 622 |
| POST | /api/auth/change-password | AllowAuthenticated | 631 |
| GET | /api/auth/me | AllowAuthenticated | 647 |
| GET | /api/auth/data-export | AllowAuthenticated（Cache-Control: no-store） | 653 |

### 1.2 无 REST controller 的模块

org、alerts、vector（org/alerts 为 GraphQL-only；vector 的 REST 面在独立 `apps/vector`：`POST /v1/upsert`、`POST /v1/search`（**成功状态码 201**——NestJS @Post 默认，2026-09-03 远端差分实测确认并同步进 vector-go）、`GET /healthz`，`InternalAuthGuard` 校验 `x-internal-token`，`apps/vector/src/modules/vector/vector.controller.ts:28-48`；api 侧另有 system-settings/vector-service 管理面——PUT/DELETE 自本轮起仅平台管理员，SEC-01）

### 1.3 rbac（6 个，`modules/rbac/rbac.controller.ts`）

GET /api/rbac/permissions（permissions.read :19）· roles（roles.read :25）· POST roles（roles.write :32）· POST assign（roles.write :38）· GET members（users.read :44）· GET audit-logs（settings.manage :50）

### 1.4 geo / items / search-admin（9 个）

POST /api/geo/geocode（items.read，`geo.controller.ts:16`）
GET/POST /api/items、GET /api/items/:id（items.read/write，`items.controller.ts:19-34`）
POST /api/admin/search/reindex、GET .../reindex/:jobId（settings.manage，`search-admin.controller.ts:14-22`）

### 1.5 crawl（69 个，8 个 controller）

**crawl-frontier**（前缀 `admin/crawl-frontier`，19 个，`crawl-frontier.controller.ts`）：profiles CRUD+versions+rollback（crawl.read/write :38-102）· runs CRUD+workflow-run+workflow-candidates+cancel（:117-212）· nodes/:id+retry（:194-212）
**crawl-strategy**（同前缀，16 个，`crawl-strategy.controller.ts`）：workflows CRUD+draft/publish/versions/compare/trial-run（crawl.read/write :37-117）· workflow-runs/:runId+candidates+explanation+replay（:127-155）· profiles/news-sources 的 workflow-bridge（:165-175）
**news-source**（前缀 `admin/news-sources`，16 个，`news-source.controller.ts`）：CRUD+options+batch(frequency/group/active)+opml(presets/preview/import)+groups+run+schedule+preview（crawl.read/write :43-181）
**其余**：crawl-tasks 6 个（`crawl.controller.ts:26-77`，含 metadata 端点）· crawl-templates 4 个（`crawl-template.controller.ts`；Go-批9：见 §1.8k）· crawl4ai quality 2 + queue 4（`crawl4ai-*.controller.ts`）· crawl-media-assets 1 个 **@Public**（签名 URL，`crawl-media-asset.controller.ts:29`）· news-source dispatch 1 + ops 3（`modules/queue/news-source-*.controller.ts`）

### 1.6 news-events 聚类管理（6 个，`news-event-clustering-admin.controller.ts`）

GET .../clustering/readiness · overview · failures；POST failures/:groupId/vector-backfill · llm-backfill · ignore（均 settings.manage :20-75）

### 1.7 user-settings（12 个，`user-ui-settings.controller.ts`）

situation-monitor/war-map/spacetime-timeline/newsnow/rss-reader 各 GET+PUT（items.read :22-101）；onboarding GET+PUT（items.read :110/116，API-01 已补权限元数据）。Go-批3B 起六个 GET 在 pilot 可读模式 `go` 下由 Go 响应；Go-批3C 起六个 PUT 在 `API_GO_USER_SETTINGS_WRITE_MODE=go` 时由 Go 写入同一 `UserSetting` 表（默认 `legacy` 仍代理 NestJS）。见 §0。

### 1.8 public-portal（4 个，全部 @Public + Cache-Control）

GET /api/public-portal/home(:16) · channels/:topic(:23) · stories/id/:id(:34) · stories/slug/:slug(:45)

Go-批4A/4B：`API_GO_PUBLIC_PORTAL_MODE=go` 时，`GET /api/public-portal/home`（exact）、`GET /api/public-portal/channels/:topic`、`GET /api/public-portal/stories/id/:id` 与 `GET /api/public-portal/stories/slug/:slug`（后三个恰好一个路径段，且仅 GET）由 Go 查 MySQL 并完整响应。默认 `legacy`，生产入口未切换。公开组织只来自 `SystemSetting.public_portal_org_slug`。故事详情的 brief 冷路径使用 `llm_gateway_profiles`，不把请求转回 NestJS。缓存命中详情已在真实栈验证；缓存缺失时的真实模型调用与新 brief 写回尚未真实验证。启用 `go` 前应确认模型网关配置可用。回滚：`API_GO_PUBLIC_PORTAL_MODE=legacy`。

### 1.8a dashboard stats（Go-批5A，仅 1 个 GET）

`GET /api/dashboard/stats` 权限是 `items.read`（不是表内其余图表的 `dashboards.read`）。`API_GO_DASHBOARD_STATS_MODE=go` 时该精确 GET 由 Go 按服务端 orgId 读 MySQL `ItemMeta`、Mongo `processeditems`/`tasklogs` 和 Redis `queue:itemPipeline:org:<orgId>:counts`。默认 `legacy`。`dashboard/stream` 与图表 GET 不在这个开关里。回滚：`API_GO_DASHBOARD_STATS_MODE=legacy`。

### 1.8b dashboard 三个图表（Go-批5B）

`API_GO_DASHBOARD_CHARTS_MODE=go` 时，下面三个精确 GET 由 Go 验签并重推导 `dashboards.read` 后响应。默认 `legacy`。与 stats 开关无关。

| 路径 | 数据 | 备注 |
|---|---|---|
| `GET /api/dashboard/sector-heatmap` | MySQL `EconomicDataItem`（`economic-short`、启用、最多 8 条）和 `EconomicDataPoint` | `metadata.dataViz.heatmap.preferredSourceFields` 与 parser label；未命中则 `SOURCE_FIELD_FALLBACK` |
| `GET /api/dashboard/financial-candlestick` | MySQL slug `sp500_index` 与其数据点 | OHLC 别名来自 `metadata.dataViz.candlestick.ohlc`，否则用内置别名。范围内有数据但没有 OHLC 字段时 500 `DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH` |
| `GET /api/dashboard/war-map/geojson` | 构建时嵌入的 `world.geo.json` | 仍先做日期校验。成功响应 `Cache-Control: no-store`。不是匿名接口 |

三条都接受可选 `start`/`end`（ISO 8601，缺省 30 天，对齐 UTC 日边界）。错误体的 `path` 与其他 Go 路由一样不含 query。`layers`、`transport-detail`、spacetime 和 `/api/dashboard/stream` 仍由 NestJS 处理。`events` 与 `news-markers` 见批5C。回滚：`API_GO_DASHBOARD_CHARTS_MODE=legacy`。

### 1.8c War Map 事件与新闻标记（Go-批5C）

`API_GO_DASHBOARD_WAR_MAP_MODE=go` 时，下面两个精确 GET 由 Go 验签并重推导 `dashboards.read` 后响应。默认 `legacy`。orgId 只来自 membership 重推导。`start`/`end` 不按 UTC 整日对齐。

| 路径 | 数据 |
|---|---|
| `GET /api/dashboard/war-map/events` | MySQL `AlertEvent`（经 `AlertRule.orgId`，最多 1000）与有位置的 `ProcessedArticle`（最多 2500）。MySQL 新闻为空才读 Mongo `processeditems` |
| `GET /api/dashboard/war-map/news-markers` | MySQL `ProcessedArticle` 联 `Article`（最多 500）。为空才读 Mongo `processeditems` / `rawitems`。地理缓存、最多 3 次 Nominatim、国家中心点回退 |

`translate=zh-CN` 使用既有翻译配置；未配置或调用失败时省略中文字段。回滚：`API_GO_DASHBOARD_WAR_MAP_MODE=legacy`。启用 `go` 需要 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。

### 1.8d War Map transport-detail 与 layers（Go-批5D）

两个开关默认 `legacy`，互不影响，也不改变批5C。

| 开关 | 路径 | 数据 |
|---|---|---|
| `API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go` | `GET /api/dashboard/war-map/transport-detail` | Mongo `MapTransportObjectState` / `MapTransportTrackPoint`。范围内轨迹优先，否则回退最近轨迹 |
| `API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go` | `GET /api/dashboard/war-map/layers` | 静态图层 + 批5C events/news 动态图层 + Redis ADS-B/AIS。`flightMode=all` 使用 OpenSky viewport 和日预算 |

回滚：把对应变量改回 `legacy`。`/api/dashboard/stream` 仍由 NestJS 处理。spacetime 见 §1.8e。

### 1.8e Dashboard Spacetime 热力图与传播图（Go-批6A）

两个开关默认 `legacy`，互不影响，也不改变 stats、图表、War Map 或 `/api/dashboard/stream`。

| 开关 | 路径 | 数据 |
|---|---|---|
| `API_GO_DASHBOARD_SPACETIME_GEO_MODE=go` | `GET /api/dashboard/spacetime/geo-heatmap` 与 `.../articles` | MySQL 该组织、UTC 整日范围内已完成且有地点的 `ProcessedArticle`（最多 2000）。Mongo `processeditems` 只补充情感，查询失败则情感为 unknown 或省略。地点走已有地理缓存、最多 6 次外部解析和国家中心点。Redis snapshot 键含 orgId，TTL 1 小时，内容与 NestJS `JSON.stringify` 后的 SHA-256 对齐 |
| `API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE=go` | `GET /api/dashboard/spacetime/propagation` 与 `.../articles` | MySQL `NewsEventItem` 联 `ProcessedArticle` / `Article`。节点与 duplicate/time 边都返回。Mongo `duplicateOf` 失败时退回时间边 |

四条都要求重推导后的 `dashboards.read`。orgId 只来自 membership。日期按 UTC 整日对齐。MySQL 失败返回 500，不返回空数组。回滚：`API_GO_DASHBOARD_SPACETIME_GEO_MODE=legacy` 只交回热力图两条；`API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE=legacy` 只交回传播图两条。外部地理解析的实网调用不在本批验收范围内。

### 1.8f Dashboard SSE 与认证版 healthz（Go-批6B）

两个开关默认 `legacy`，互不影响。公开 `GET /api/healthz/live` 仍是 shadow。

| 开关 | 路径 | 数据 |
|---|---|---|
| `API_GO_DASHBOARD_STREAM_MODE=go` | 精确 `GET /api/dashboard/stream`，以及合格 CORS 预检 | 连接时重推导 `dashboards.read` 和 orgId。War Map 事件、新闻、图层共用一次查询；K 线读 `EconomicDataItem`/`EconomicDataPoint`；热力图复用批6A 服务。首轮全量，之后按指纹只发变化 |
| `API_GO_HEALTHZ_MODE=go` | 精确 `GET /api/healthz` | `@AllowAuthenticated()`：人类 access token，或有效 `mtk_` 机器令牌。请求时执行 MySQL、Redis、Mongo、crawl4ai、SSRF crawl、LLM 配置和磁盘七项探针。整份响应缓存 5 秒。失败为 HTTP 503，并保留 terminus 的 status/info/error/details 以及 version、now |

机器令牌不因此获得 `dashboards.read` 或 user-settings。SEC-03 对 `/api/metrics` 的平台级限制不变。回滚：`API_GO_DASHBOARD_STREAM_MODE=legacy` 只交回 SSE；`API_GO_HEALTHZ_MODE=legacy` 只交回认证版健康检查。生产入口未切换。远端没有配置的 crawl4ai、SSRF proxy 或 LLM 应表现为失败，而不是七项全绿。

### 1.8g 态势监控自定义监控

`API_GO_SITUATION_MONITORS_MODE` 默认 `legacy`，只接受 `legacy` 或 `go`。`go` 时只接管五条：`GET/POST /api/situation-monitor/monitors`、精确 `POST /api/situation-monitor/monitors/preview`、恰好一段的 `PATCH/DELETE /api/situation-monitor/monitors/:id`。权限是重推导后的 `items.read`。`POST` 成功是 201。删除缺失仍是 `{ok:true}`。insights、catalog、feedback、refresh、refresh-runs、telegram-feed、oref-alerts、oref-history、live-hls-proxy-config 仍回 NestJS。已迁的 `/api/user-settings/ui/situation-monitor` 不在这个开关里。回滚：`API_GO_SITUATION_MONITORS_MODE=legacy`。不打开 canary，不改生产入口。模型与 Nominatim 未做实网验收。

### 1.8h 新闻源管理台

`API_GO_NEWS_SOURCES_MODE` 默认 `legacy`，只接受 `legacy` 或 `go`。`go` 时接管十五条：`GET/POST /api/admin/news-sources`，`GET /options`、`/groups`、`/opml-presets`，`POST /batch/frequency`、`/opml/preview`、`/opml/import`，`PATCH /batch/group`、`/batch/active`，`DELETE /batch`，以及恰好一段的 `PATCH/DELETE /:id` 和 `POST /:id/run`、`POST /:id/schedule`。读要 `crawl.read`，写要 `crawl.write`。人类身份来自验签、Redis 撤销名单和 membership 重推导。有效机器令牌使用令牌行里的 permissions 和 orgId。`POST` 成功是 201。删除成功是 `{ok:true}`。更新、删除、run、schedule 的写入条件同时包含 `id` 和 `orgId`。run 与 schedule 只改 `NewsSource` 行，不入队。`GET /api/admin/news-sources/:id/preview` 仍回 NestJS；该预览按模板 id 读取 `crawlOptions` 时仍没有带 `orgId`，这批不改。回滚：`API_GO_NEWS_SOURCES_MODE=legacy`。不打开 canary，不改生产入口。不把 RSS、crawl4ai、模型、AkShare 或 Nominatim 记为已通过。SEC-01 的真实登录态未在本批验证。

### 1.8i 采集策略工作流编辑

`API_GO_CRAWL_WORKFLOWS_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时接管十一条：`GET /workflows/node-schemas`、`GET/POST /workflows`、`POST /workflows/compare`、恰好一段的 `GET /workflows/:id`、`PATCH /workflows/:id/draft`、`POST /workflows/:id/publish`、`GET /workflows/:id/versions`、恰好一段的 `GET /workflow-versions/:versionId`、恰好一段的 `GET /profiles/:id/workflow-bridge`（query 可带 `seedUrl`）与 `GET /news-sources/:id/workflow-bridge`。读要 `crawl.read`，写要 `crawl.write`。`POST /workflows`、`POST /workflows/compare` 与 `POST /workflows/:id/publish` 成功都是 201（NestJS POST 默认；后者返回 `{workflow, version}`），`PATCH` 草稿是 200。列表 `search` trim 后做 name/description contains（数据库默认排序规则），排序 `updatedAt desc, createdAt desc`，每条带 `publishedVersion` 与最近 10 个版本；详情带同样 include，跨 org 与不存在都是 404 `Workflow not found`；版本列表返回全部版本（`version desc, createdAt desc`）。`compare` 按 `buildSettingsDiff`/`buildNodeDiff`/`buildEdgeDiff` 的字段与计数输出，`bindingImpact` 只统计本组织。机器令牌（`mtk_`）走 `MachineAccessToken` 行（含 `Org.isActive`），人类令牌走验签 + Redis 撤销名单 + membership 重推导。空白 name 在创建与草稿更新都返回 400 `name is required`。发布版本号在事务内持 `CrawlStrategyWorkflow` 行锁（`FOR UPDATE`）并按 `FOR UPDATE` 的当前读取 `MAX(version)`，`NestJS 与 Go 共用同一把行锁`。`trial-run`、`workflow-runs/:runId(+candidates/explanation/replay)`、`profiles` 列表/创建/预览/回滚、`runs`、`nodes` 仍回 NestJS。回滚：`API_GO_CRAWL_WORKFLOWS_MODE=legacy`。不打开 canary，不改生产入口，不改 Web 的 API 地址。试跑与回放未迁移；crawl4ai、模型与外网未验证。SEC-01 的真实登录态未在本批验证。

### 1.8j 采集站点画像编辑

`API_GO_CRAWL_PROFILES_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时接管八条：精确的 `GET/POST /profiles`、`GET /profiles/match`（query 必填 `url`）、`POST /profiles/preview`，恰好一段的 `GET/PATCH /profiles/:id`，恰好一段加 `/versions` 的 `GET /profiles/:id/versions`，以及 `:id/rollback/:version`（version 段按 `Number.parseInt(version, 10)`；`"abc"` → NaN 按 404 `Crawl site profile version not found`）。读要 `crawl.read`，写要 `crawl.write`。`POST /profiles` 与 `POST /profiles/preview`、`POST /profiles/:id/rollback/:version` 成功是 201（NestJS POST 默认），`PATCH` 是 200。列表 `search` trim 后做 name/matchHost contains，排序 `updatedAt desc, createdAt desc`，响应是数组；详情跨 org 与不存在都是 404 `Crawl site profile not found`；版本列表返回全部版本行（Prisma 字段原样、config 为入库原文，`version desc, createdAt desc`）。match 只取本组织 `isActive` 画像并按 `matchHostPattern` 过滤，响应 `{url, host, match, candidates}`。preview 不写库（draft 的 id/createdById 是 `draft`、version 0、createdAt/updatedAt 是 Unix 纪元）。创建要求 name/matchHost 非空（服务端 trim），`executionMode` 只允许 layered/native/hybrid，`workflowBindingMode` 只允许 published/pinned；version 用数据库默认 1 并写第一条版本快照。更新/回滚单事务 + 画像行锁（第一条 `SELECT id ... FOR UPDATE`，没有行 404；UPDATE WHERE 同时含 `id` 与 `orgId`），创建与第一条快照同事务，Nest 与 Go 共用同一把行锁；`@@unique([profileId, version])` 冲突与 Nest 现有失败一致（500）。缺陷 1：跨组织工作流绑定在创建与更新都返回 400 `Invalid workflowId` / `Invalid workflowVersionId`（清空 null 允许）。机器令牌（`mtk_`）走 `MachineAccessToken` 行（含 `Org.isActive`），人类令牌走验签 + Redis 撤销名单 + membership 重推导。`runs`、`nodes`、`workflows`、`trial-run`、`workflow-runs` 与 `GET /profiles/:id/workflow-bridge` 仍回 NestJS（Go 不返回自己的 404）。回滚：`API_GO_CRAWL_PROFILES_MODE=legacy`。不打开 canary，不改生产入口，不改 Web 的 API 地址，不启用 shadow。不入队，不启动采集 worker。crawl4ai、模型与外网未验证。SEC-01 的真实登录态未在本批验证。

### 1.8k 采集模板编辑

`API_GO_CRAWL_TEMPLATES_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时只接管四条：精确的 `GET/POST /api/admin/crawl-templates` 与恰好一段的 `PATCH/DELETE /api/admin/crawl-templates/:id`。读要 `crawl.read`，写要 `crawl.write`。`POST` 成功是 201，`PATCH` 是 200，`DELETE` 成功是 `{ok:true}`。列表只查本组织，`search` trim 后**只对 `name` 做 contains（不搜 description）**，排序 `updatedAt desc, createdAt desc`，响应是数组；`GET /:id` 详情未迁移。创建要求 `name` 非空（服务端 trim），`isActive` 缺省 true，`crawlOptions` 为 null 或缺省写数据库 NULL（不写 `{}`），响应中数据库 NULL 映射为 `null`。更新/删除的 WHERE 同时含 `id` 与 `orgId`，不存在或跨组织 404 `Crawl template not found`；同一组织同名撞 `@@unique([orgId, name])` 与 Nest 现有失败一致（500，不收成 409）。`crawlOptions` 为对象时先过 `assertNoUnsupportedProxy` 再 `assertNoCrawl4aiLlmOptions`（两句错误原文不变；守卫递归扫对象/数组、环检测、最多列前 5 个键）。机器令牌（`mtk_`）走 `MachineAccessToken` 行（含 `Org.isActive`），人类令牌走验签 + Redis 撤销名单 + membership 重推导。`GET /:id` 详情、`crawl-tasks`（含 metadata）、`crawl4ai` quality/queue、`crawl-media-assets`、news-source dispatch/ops 仍回 NestJS（Go 不返回自己的 404）。回滚：`API_GO_CRAWL_TEMPLATES_MODE=legacy`。不打开 canary，不改生产入口，不改 Web 的 API 地址，不启用 shadow。不入队，不启动采集 worker。crawl4ai、模型与外网未验证。SEC-01 的真实登录态未在本批验证。

### 1.8l 组织访问控制（RBAC）

`API_GO_RBAC_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时接管六条精确路径：`GET /api/rbac/permissions`（`permissions.read`）、`GET /api/rbac/roles`（`roles.read`）、`POST /api/rbac/roles`（`roles.write`）、`POST /api/rbac/assign`（`roles.write`）、`GET /api/rbac/members`（`users.read`）、`GET /api/rbac/audit-logs`（`settings.manage`）。其他方法（如 `DELETE /api/rbac/roles`）与更长路径（如 `/api/rbac/roles/:id`）仍回 NestJS（Go 不返回自己的 404），也不新增 `updateRole` 的 HTTP。`GET /permissions` 是全局目录按 `name asc`；`GET /roles` 只查本组织，`includeSystem` 是字面量规则（参数缺省 → true；正好字符串 `true` → true；其他值 → false），响应带 `permissions` 与每条 `rolePermission.permission`；`GET /members` 带 `user`/`role`/`roles` 权限链；`GET /audit-logs` 的 `limit` 用 `Number` + `min(trunc, 200)`（否则 20），且必须 `settings.manage`。`POST /roles` 与 `POST /assign` 仍是组织管理员 + 权限范围 + 写限流（`rbac:write:<orgId>:<actorId>`，`rbacWrite` 桶，超限 429）；创建角色唯一冲突 409 `Role name already exists`，名字空白 400 `Role name is required`，名字保留 400 `System administrator role name is reserved`，权限缺失 404 `One or more permissions not found`；分配保护自身与系统管理员 403，跨组织角色 404 `Role not found`；审计 `roles/create` 与 `users/assign_role` 均 best-effort。`assignRole` 的单事务先 `SELECT id FROM Membership WHERE userId=? AND orgId=? FOR UPDATE`（没有行时 upsert 创建后再次 `FOR UPDATE`），Nest 与 Go 共用同一把成员行锁，消除并发分配留下空角色的缺陷；非成员目标仍被 upsert 创建进组织。机器令牌（`mtk_`）走 `MachineAccessToken` 行（含 `Org.isActive`），人类令牌走验签 + Redis 撤销名单 + membership 重推导。回滚：`API_GO_RBAC_MODE=legacy`。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不改 Web 的 API 地址。细节见 `docs/refactor/go-rbac.md`。SEC-01 的真实登录态未在本批验证。
### 1.8m 管理端日志与异常读取

`API_GO_ADMIN_LOGS_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时接管 7 条精确路径，且只匹配 `GET`；7 条统一要求 `settings.manage`（人类身份来自验签、Redis 撤销名单与 membership 重推导，机器令牌走 `MachineAccessToken` 行含 `Org.isActive`）：`GET /api/admin/logs/task`、`GET /api/admin/logs/task/summary`、`GET /api/admin/logs/errors`、`GET /api/admin/logs/errors/summary`、`GET /api/admin/logs/audit`、`GET /api/admin/errors`、`GET /api/admin/errors/stats`。任务日志与异常事件读 Mongo（集合 `tasklogs` 与 `exceptionevents`），审计日志读 MySQL `AuditLog`；三者都按服务端推导的当前 orgId 过滤（query 里的 `orgId` 不参与）。其他方法与更长路径继续回落 NestJS（Go 不返回自己的 404）。

两个控制器对非法参数的处理**本来就不同，本批不统一**：`admin/logs/*` 的五条会主动抛 400——`start`/`end` 非空但非法是 `<name> must be a valid date`，`start > end` 是 `start must be earlier than or equal to end`，`page`/`pageSize` 非空但不是正有限数是 `<name> must be a positive number`（正小数 `Math.trunc`；pageSize 在服务层再收口到 100，缺省 20，page 缺省 1），`task` 的 `status` 不在四个枚举内是 `status must be one of pending, processing, completed, failed`，`errors` 的 `kind` 不在三个枚举内是 `kind must be one of http, graphql, unknown`。`admin/errors` 与 `admin/errors/stats` 不抛这些 400——非法 `kind` 当 undefined，非法 `start`/`end` 忽略该条件，`start > end` 照样查出 0 条，`limit` 缺省 50 并收口到 1–200，`offset` 缺省 0 且最小 0，非有限数走缺省。

查询语义：`task` 与 `task/summary` 按 orgId，可选精确匹配 `queue`/`jobId`/`stage`/`status`，`createdAt` 落在 `[start, end]`；`summary.totals` 固定含 `total`/`pending`/`processing`/`completed`/`failed` 五个键，`byStage` 最多 50 条，`topErrors` 只在没有传 `status` 或 `status=failed` 时聚合（`completed`/`pending`/`processing` 时是空数组）；每条日志的 `message`、`data`、`error` 与 `topErrors.errorName`、`sampleMessage` 都过脱敏（深度超过 10 层原样返回，敏感键按 `isSensitiveKey`）。`logs/errors` 与 `admin/errors` 是同一张 `exceptionevents`：必须带 `orgId`，`operationName` trim 后精确，`messageContains` trim 后先 `escapeRegex` 再做不区分大小写正则，`timestamp` 落在 `[start, end]`；前者返回 `{page, pageSize, total, items}`，后者返回 `{total, items}`。`logs/errors/summary` 与 `admin/errors/stats` 都是 `stats`，返回 `{total, byKind, byDay}`，`byDay` 按 UTC `%Y-%m-%d` 分组、日期降序、最多 30 条。`logs/audit` 查 MySQL `AuditLog`（where 含 `orgId`；`resource`/`action` 是 contains；`search` 是 `resource`/`action`/`actorId`/`ipAddress` 四字段 OR contains；`createdAt` 落在 `[start, end]`；`createdAt desc`），返回 `{page, pageSize, total, items}`，`createdAt` 是 ISO 字符串。

缺陷修复（两侧同修）：`ExceptionEventsService.list` 原先直接返回 Mongo 里的 `message` 与 `stack`，没有脱敏，异常消息或堆栈里带 `Bearer xxx`、`password=xxx`、`api_key=xxx` 时会原样返回前端。现在 Nest 与 Go 都在读取输出时对 `message` 与 `stack` 调用 `redactSensitiveFields`（9 条正则按 `packages/utils/src/error-sanitizer.ts` 原样翻译到 Go；`password`/`token`/`apiKey`/`api_key`/`secret`/`credential`/`auth` 保留键名与分隔符后替换成 `[REDACTED]`，`Bearer` 变 `Bearer [REDACTED]`，`Basic` 变 `Basic [REDACTED]`），库内已存文档不动。

仍回 NestJS：`/api/admin/quality/task-logs`（`getQualityTaskLogsOverview` 不迁移）、`/api/admin/quality/*`、`/api/observability/*` 的其余路由、`/api/metrics`（以及 `admin/logs/*` 与 `admin/errors(+stats)` 的非 GET 方法）。两个异常上报 POST 后来由独立开关 `API_GO_EXCEPTION_INGEST_MODE` 接管（见 §1.8s），与 `API_GO_ADMIN_LOGS_MODE` 互不影响。`/api/admin/quality/*` 后来由独立开关 `API_GO_QUALITY_OVERVIEW_MODE` 接管（见 §1.8o），与 `API_GO_ADMIN_LOGS_MODE` 互不影响。回滚：`API_GO_ADMIN_LOGS_MODE=legacy`。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不改 Web 的 API 地址，不启用 shadow，不改前端。SEC-01 的真实登录态未在本批验证。

查询算法优化（本批，Nest 与 Go 两侧同步，只改这 7 条读取 GET）：

- **异常统计一次聚合**：`stats`（`logs/errors/summary` 与 `admin/errors/stats`）原先对同一过滤条件分别执行 `countDocuments`、按 `kind` 的聚合、按 UTC 日期的聚合，共三个查询；现在改为一次聚合——`$match` 保持 `orgId`/`kind`/`operationName`/字面量 `messageContains`/`timestamp` 区间的现有条件，先按「UTC 日期（`$dateToString`，`timezone: "UTC"`，`%Y-%m-%d`）+ 原 `kind`」`$group` 出每天各类的数量，再在压缩后的分组结果上汇总 `total`（所有计数之和）、`byKind`（按 `kind` 合并）、`byDay`（按 UTC 日期合并）。响应结构仍为 `{total, byKind, byDay}`；`byKind` 排序 `count DESC, kind ASC`，`byDay` 排序 `date DESC` 并最多保留 30 个有数据的日期。`total` 与 `byKind` 覆盖全部匹配记录，`byDay` 的 30 条上限不截断它们；未传 `start`/`end` 时不自行添加「最近 30 天」过滤；不把原始文档读进内存统计。无数据时 `total=0`、两个列表均为 `[]`。
- **确定性列表排序**：异常列表 `timestamp DESC, _id DESC`；任务日志列表 `createdAt DESC, _id DESC`；MySQL 审计列表 `createdAt DESC, id DESC`。分页仍是数据库 `skip`/`limit`（或 `LIMIT`/`OFFSET`），不改游标协议，也不是并发写入期间的冻结快照。
- **Top Errors 最近样本**：分组键仍是 `queue + stage + errorName`，只统计 `failed`，`count` 覆盖该组全部匹配记录，最多 25 组；`sampleMessage` 从无排序的 `$first` 改为该组 `createdAt DESC, _id DESC` 的最近一条失败记录的 `error.message`（否则 `message`）（Mongo 7.0 的 `$top` 有序分组聚合，分组前 `$project` 保留 `createdAt`/`_id`），空值与脱敏规则不变。错误组最终排序 `count DESC`，再按 `queue`、`stage`、`errorName` ASC；`byStage` 最多 50 组，`count DESC`，并列 `stage ASC`。质量面板复用同一任务日志聚合，自然获得相同优化。

### 1.8s 异常上报（Go）

`API_GO_EXCEPTION_INGEST_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名；`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`）。只接管 2 个精确路径，且只匹配 `POST`（预检 `OPTIONS` 由 Go 回答，非预检 `OPTIONS` 回落 legacy 代理）：

- `POST /api/observability/exception-events/client`：沿用 `@AllowAuthenticated` 语义（任一已认证用户，不要求 `settings.manage`）；`orgId`/`userId` 只来自服务端认证结果，body 里的 `orgId`/`userId`/`stack` 被忽略，client 的 `stack` 不落库。输入字段 `kind`、`traceId`、`timestamp`、`statusCode`、`message`、`path`、`method`、`operation`、`operationName`、`errorName` 按现有 normalizer 处理：字符串 `trim` 后空当缺省，超长 400 `<fieldName> is too long (max <N> characters)`（`message` 1000、`traceId` 与 `x-trace-id` 128、`timestamp` 64、`path` 512、`method` 16、`operation` 120、`operationName` 160、`errorName` 120，长度按 UTF-16 码元）；`message` 处理后为空 400 `message is required`；`kind` 只认 `http`/`graphql`/`unknown`，其他归 `unknown`；`method` 有效字符串转大写；`statusCode` 沿用 JavaScript `Number` 转换与向下取整，只保留 100–599，否则省略；`traceId` 优先级为有效 `x-trace-id` → 有效 `body.traceId` → 空字符串；`timestamp` 有效按 UTC 保存，省略或无效用当前时间。**先完成输入处理再消费限流**，无效请求不耗额度：先查 `observability:client-exception:user:<orgId>:<userId>`，有有效请求 IP 时再查 `observability:client-exception:ip:<orgId>:<ip>`（复用 Nest `RateLimiterService` 的滑动窗口 Lua 与 fail-closed 策略，Go 侧同样加 `rate:` 前缀以共享同一桶；限额来自 `OBSERVABILITY_CLIENT_EXCEPTION_USER_RATE_LIMIT`（默认 30）、`OBSERVABILITY_CLIENT_EXCEPTION_IP_RATE_LIMIT`（默认 120）、`OBSERVABILITY_CLIENT_EXCEPTION_RATE_LIMIT_WINDOW_SECONDS`（默认 60），IP 解析沿用 `TRUST_PROXY`）；429 文案分别是 `Too many client exception events from this user. Please retry later.` 与 `Too many client exception events from this IP. Please retry later.`。成功 `201 {"ok":true}`。
- `POST /api/internal/observability/exception-events`：只使用 `LITELLM_CONFIG_INTERNAL_TOKEN`，不要求用户 JWT；沿用现有 Bearer 提取与恒定时间比较语义，未配置 403 `LITELLM_CONFIG_INTERNAL_TOKEN is not configured`，缺 Bearer 401 `Missing bearer token`，不匹配 401 `Invalid bearer token`。输入字段与现有内部 controller 一致（含 `stack`、`orgId`、`userId`），保持内部入口自己的字符串规则（无客户端长度限制，`stack` 按 `record` 规则最多保留 8000 字符），`traceId` 优先级为有效 `body.traceId` → 有效 `x-trace-id` → 空字符串，`message` 处理后为空 400 `message is required`。成功 `201 {"ok":true}`。

两个入口都做**一次 best-effort `InsertOne`**：在请求内完成这一次写入尝试后返回既有响应，写入失败只记服务日志并保持 201；不重试、不排队、不递归上报。写入既有 `exceptionevents` 集合（Mongoose 默认集合名，不另建集合），文档字段为 `id`（UUID 字符串）、`orgId`、`userId`、`kind`、`traceId`、`timestamp`、`statusCode`、`message`、`path`、`method`、`operation`、`operationName`、`errorName`、`stack`、`createdAt`、`updatedAt`，其中 `timestamp`/`createdAt`/`updatedAt` 是 BSON Date，现有管理端读取接口可直接查询。相似路径（如 `/api/observability/exception-events/clients`）与其他方法继续回落 NestJS。回滚：`API_GO_EXCEPTION_INGEST_MODE=legacy`。不打开 canary，不改生产入口，不改 Web 的 API 地址，不启用 shadow，不改前端；7 条读取 GET 仍由 `API_GO_ADMIN_LOGS_MODE` 决定。

### 1.8n LLM 请求日志列表 / CSV 导出 / 用量汇总

`API_GO_LLM_LOGS_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时只接管三条精确 GET：`GET /api/llm-logs`（`application/json`：`{page, pageSize, total, items, metadataPolicy}`，按 `createdAt` 降序分页）、`GET /api/llm-logs/export`（`text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="llm-logs-export.csv"`）、`GET /api/llm-logs/summary`（`{totals, statusBreakdown, governanceBreakdown, latency, topErrors, byModel, byDay}`）。三条都要求 `settings.manage`，`orgId` 由 membership 重推导或机器令牌行推导，全部查询按该 `orgId` 过滤；其他方法（如 `POST /api/llm-logs`）与更长路径（如 `/api/llm-logs/export/extra`）仍回 NestJS（Go 不返回自己的 404）。`summary` 的参数只有 `feature`、`profileId`、`runId`、`nodeId`、`start`、`end`（控制器不接收 `model`/`requestType`/`status`）。列表 `items` 字段与 `toListItem` 一致，并附 `metadataPolicy`（`source` 为 `default`/`db`、`allowedTopLevelKeys`、`allowedTopLevelPrefixes`、`keyCount`、`prefixCount`；从 MySQL `SystemSetting` 的 `llm_request_log_settings` 读出，没有行或解析失败时落默认列表，`REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS` 始终合并）。参数校验与控制器逐字一致：非法日期 400 `<name> must be a valid date`、`start > end` 400 `start must be earlier than or equal to end`、非正数分页 400 `<name> must be a positive number`（正小数 `Math.trunc`，`pageSize` 收口 1..100）、`requestType`/`status` 枚举 400、`feature` 非小写 token 400 `feature must be a lowercase token with [a-z0-9_:. -], max 64 chars`、超长 `profileId`/`runId`/`nodeId` 400 `<name> must be 128 characters or fewer`。`buildWhere` 与 Nest 一致（`orgId` 为空落 `_unknown_`；`feature`/`profileId`/`runId`/`nodeId` 各是 `$or` 条件收进 `$and`；`start`/`end` 是 `createdAt` 的 `$gte`/`$lte`）。导出保留 90 天窗口（400 `export date range cannot exceed 90 days`）、50000 行上限（400 `export row count exceeds 50000; narrow filters or date range`）、固定表头 `timestamp,model,requestType,status,durationMs,inputTokens,outputTokens,totalTokens,error`、`createdAt` 降序、公式注入防护（字符串去前导空白后以 `=`/`+`/`-`/`@` 开头且非纯数字才加前导单引号）与 MySQL `AuditLog`（`resource=llm_request_logs`、`action=export_csv`，成功失败都写，机器令牌 `actorId` 为 `null`，审计失败不阻断响应）。**缺陷修复**：`normalizeFilterForExport` 此前漏掉 `runId` 与 `nodeId`（控制器第 279-288 行已解析并传入），导致导出 CSV 丢掉这两个条件而导出全组织数据；Nest（`llm-request-log.service.ts` 第 508-509 行）与 Go（`internal/llmlogs/where.go`）两侧同修后，导出与列表共用同一套条件。机器令牌（`mtk_`）走 `MachineAccessToken` 行（含 `Org.isActive`），人类令牌走验签 + Redis 撤销名单 + membership 重推导。`/api/system-settings/llm-request-logs`（含 `metadata-policy`、`reset`）整组不迁移——它会修改 Mongo TTL 索引，留在 NestJS。回滚：`API_GO_LLM_LOGS_MODE=legacy`。`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。不打开 canary，不改生产入口，不改 Web 的 API 地址，不启用 shadow，不调用模型服务，不启动 worker。细节见 `docs/refactor/go-llm-logs.md`。SEC-01 的真实登录态未在本批验证。

### 1.8p 新闻指标关联分析

`API_GO_NEWS_INDICATORS_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时只接管三条：精确的 `GET /api/news-indicator/associations`（`limit` 缺省/非有限数 50，否则 `clamp(trunc(Number(limit)),1,200)`；`scopeType`/`featureMetric` trim+小写后合法才过滤，**非法串当未设置不报 400**；`scopeKey`/`indicatorSlug` trim 后非空才过滤；`lastEvaluatedAt desc, correlation desc`；响应含完整 `indicatorItem` 与 1 条最新 `backtests`）、恰好一段的 `GET /api/news-indicator/associations/:id`（`backtestsLimit` 缺省/非有限数 10，否则 `clamp(trunc,0,100)`；`0` 时不返回 `backtests` 字段；找不到或跨组织按 Nest `findFirst` 返回 200 空响应，不改 404）、精确的 `POST /api/news-indicator/refresh`（成功 201，响应 `{indicators,associationsUpserted,backtestsCreated}`）。读要 `dashboards.read`，refresh 要 `settings.manage`。`refreshOrg` 在按组织的 MySQL 会话锁（`ni:<orgId>`，超 64 字符走 `sha256(orgId)` 前 60 位十六进制）内执行，每个 chunk 的 upsert、过期回测 `deleteMany`（`where` 补 `orgId`）与新回测 `createMany` 在同一个事务里；Nest 与 Go 两侧同修。皮尔逊相关、滞后搜索、Z-score 回测逐段对齐 `news-indicator-math.ts`，`holdoutDays=0` 时回测 `failed` 且 `metrics.skipped=holdout_days_zero`。GraphQL `newsIndicatorAssociations`/`newsIndicatorAssociation` 只在 `API_GO_GRAPHQL_READ_MODE=go` 且本开关为 `go` 时由读执行器登记（权限 `dashboards.read`，机器令牌在 GraphQL 入口不开放），映射 `NewsIndicatorAssociationModel` 并复用 `economic.EconomicDataItemModel`。未列出的方法与更长路径、GraphQL mutation `refreshNewsIndicatorAssociations` 与设置读写都仍回 NestJS（Go 不返回自己的 404）。回滚：`API_GO_NEWS_INDICATORS_MODE=legacy`。不打开 canary，不改生产入口，不调用 AkShare，不启动调度 worker。
### 1.8o 管理端质量面板（新闻源 / 流水线 / 总览 / 任务日志）

`API_GO_QUALITY_OVERVIEW_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名；`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`）。`go` 时只接管 5 条精确 `GET`，全部要求 `settings.manage`（人类身份来自验签、Redis 撤销名单与 membership 重推导；机器令牌走 `MachineAccessToken` 行含 `Org.isActive`，SHA-256 查 `tokenHash`、更新 `lastUsedAt`，权限与 `orgId` 来自令牌行）：

- `GET /api/admin/quality/news-sources` → `{windowHours, totals, topFailingSources}`；`windowHours` 空串/非有限数缺省 24，否则 `Math.max(1, Math.min(336, Math.floor(v)))`。`totals` 是 `total`/`active`（`isActive`）/`failing`（`consecutiveFailures > 0`）/`circuitOpen`（`isActive` 且 `circuitOpenUntil > now`）；`topFailingSources` 查 `PipelineJob`（`status='failed'`、`sourceId IS NOT NULL`、`createdAt >= since`）按 `sourceId` 分组 `COUNT(id)` 降序前 10，再回查本组织 `NewsSource`。
- `GET /api/admin/quality/pipeline` → `{windowMinutes, totals, successRate, averageLatencyMs, ingestionLatencyMs, failureTypes, llmModels, outbox}`；`windowMinutes` 空串/非有限数缺省 60，否则 `Math.max(5, Math.min(20160, Math.floor(v)))`。数据来自 Mongo `processeditems`（state 分组、`completed` 的 `llm.latencyMs` 平均、`llm.model` 分组前 10、最近 5000 条 `ingestedAt` 分位数）、Mongo `tasklogs`（`queue='itemPipeline'`、`status='failed'` 按 `{stage, errorName}` 前 20）与 MySQL `MongoOutbox`（`type='processed_item'` 的状态计数、`staleProcessing`、最早未完成 `oldestCreatedAt`/`oldestAgeMinutes`）。
- `GET /api/admin/quality/overview` → `{generatedAt, pipeline, newsSources, taskLogs}`；pipeline 用请求的 `windowMinutes`，newsSources 固定 `windowHours=24`，taskLogs 固定 `sinceMinutes=60`、`limit=10`（`getQualityTaskLogsOverview`：Mongo `tasklogs` 窗口内全部状态进 `summary`/`topErrors`，`items` 只取 `status='failed'` 前 10）。
- `GET /api/admin/quality/task-logs` → `items` JSON 数组（不是 `{page, pageSize, total, items}`）；`limit` 空串/非有限数缺省 50，否则 `min(max(floor(v),1),200)`。
- `GET /api/admin/quality/task-logs/summary` → `{totals, byStage, topErrors}`；不接收 `jobId`。

5 条**全部宽松回退、不抛 400**（与 `/api/admin/logs/task` 不同）：非法 `windowHours`/`windowMinutes` 走缺省，`status` 不在四枚举当 `undefined`，`limit`/`sinceMinutes` 非有限数走缺省，`sinceMinutes <= 0` 忽略时间下界。

快照复用：`news-sources` 与 `pipeline` 沿用 `ObservabilitySnapshotService.getOrCreate`——MySQL `ObservabilitySnapshot`（`scope` 为 `quality_news_sources`/`quality_pipeline`，`variantKey` 为 `windowHours:<n>`/`windowMinutes:<n>`，`expiresAt > now` 直接返回；否则抢 Redis 锁 `lock:observability-snapshot:<orgId>:<scope>:<variantKey>`（TTL 15s，抢不到每 100ms 轮询数据库最多 20s，仍无则无锁重建），重建后按唯一键 `orgId+scope+variantKey` upsert、TTL 60s），与 Nest 共享 60 秒快照与同一把锁。质量总览任务日志走 Redis 缓存 `quality:task-logs:overview:<orgId>:60:10`（TTL 15s，锁 `lock:` 前缀，lockTtl 2000ms / retryDelay 50ms / maxWait 3000ms）。

**缺陷修复（两侧同修）**：`PipelineQualityService.buildSummary`（`pipeline-quality.service.ts` 第 337–341 行）此前直接输出 `error.name` 原文，而同一 `tasklogs` 集合在 `AdminLogsService` 已做 `redactSensitiveFields`；失败任务的 `error.name` 含 `Bearer xxx`/`token=xxx`/`api_key=xxx` 时 `/api/admin/quality/pipeline` 与 `/api/admin/quality/overview` 会泄漏原文。两侧映射 `failureTypes.errorName` 时都调用 `redactSensitiveFields`（Go 复用 `internal/adminlogs` 的同一函数），只改读取输出，不动库内文档。

任务日志的列表/汇总/窗口聚合与深层脱敏直接调用 `internal/adminlogs`（同一实现，不维护第二套正则）。仍回 NestJS：`/api/admin/quality/classification/*`（`classification-quality.controller.ts`）与 `/api/admin/quality/pipeline/runs|replay|rollback`（`pipeline-recovery.controller.ts`），以及这 5 条的非 `GET` 方法与更长路径（Go 精确匹配，不返回自己的 404）。回滚：`API_GO_QUALITY_OVERVIEW_MODE=legacy`。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不改 Web 的 API 地址，不启用 shadow，不改前端。细节见 `docs/refactor/go-quality-overview.md`。SEC-01 的真实登录态未在本批验证。

### 1.8r 采集只读、媒体下发与检索遥测

`API_GO_CRAWL_READ_TELEMETRY_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名；`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`）。`go` 时只接管 7 条精确路由（规则见 `apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go`）：

- `GET /api/crawl-tasks`（`crawl.read`）：`page` ≥1（缺省 1）、`pageSize` 1..50（缺省 10）、`status` 六枚举、`search` 对 `targetUrl`/`displayName` contains；`createdAt desc` 分页，返回 `{tasks, total, page, pageSize}`，`resultCount` 取 `_count.results`，`config` 原样输出。
- `GET /api/crawl-tasks/:id`（`crawl.read`，恰好一段）：`resultLimit` 1..100（缺省 20，`clampResultLimit(limit, fallback=20)`）、`resultSearch` 对 `sourceUrl` contains；任务不存在或跨组织 404 `crawl task not found`。结果关联 Mongo `crawlresultcontents` 的 `markdown`/`markdownWithCitations`/`referencesMarkdown`/`fitMarkdown`/`linkAnalysis`/`media`/`tables`，MySQL `CrawlMediaAsset` 生成 HMAC 签名的 `previewUrl`（仅 inline 安全类型）/`downloadUrl`，`ItemMeta` 按 `externalId = CONCAT('crawlResult:', r.id)` 填 `itemId`/`itemStatus`，Mongo `tasklogs`（`queue='crawl4ai'`、`stage='complete'`）产出 `memoryStats`/`lastRunSummary`。
- `GET /api/crawl-media-assets/:assetId/:mode`（`@Public` + HMAC，恰好两段）：`:mode` 只允许 `preview`/`download`；验签顺序与文案为 `Missing signature` / `Missing access scope` / `Invalid expires timestamp` / `Signature expired` / `Signature window too large` / `Invalid signature`；签名 payload `<assetId>:<mode>:<expiresAtMs>:<orgId>:<userId>`、密钥 `JWT_SECRET`、`base64url`。Content-Type 别名净化后只放行 `image/*`/`video/*`/`audio/*`，其余降级 `application/octet-stream`；仅 `preview` 且属 inline 白名单（SVG 不在内）时 `inline` 并加 `default-src 'none'; sandbox`，否则 `attachment`。
- `GET /api/admin/crawl4ai/quality` 与 `/quality/sources/:sourceId`（`crawl.read`）：`lookbackHours` 缺省 24、收口 1..336；复用 `ObservabilitySnapshot`（`scope=crawl_quality_metrics`、`variantKey=lookbackHours:<n>`、TTL 60s、同一 Redis 锁键），滚动聚合 MySQL `CrawlQualityTaskSnapshot` 与 Mongo `tasklogs`/`crawlresultcontents`，阈值来自 `AlertRule`（0.15/0.05/0.3）。
- `POST /api/search-telemetry`（`items.read`，201 `{"recorded":true}`）：Redis 日桶 `search-telemetry:<orgId>:<YYYY-MM-DD>`（UTC）`HINCRBY` + `EXPIRE 2592000`；`queryLength` 分桶 `len_00_01`/`len_02_03`/`len_04_07`/`len_08_15`/`len_16_31`/`len_32_plus`；Redis 失败被吞掉。
- `GET /api/admin/search-telemetry/summary`（`settings.manage`）：`surface` 传入即 400 `surface filtering is not supported by the stored telemetry counters`；`from`/`to` 必须 `YYYY-MM-DD`，非法日历日 400 `invalid date`，`from > to` 与跨度 >31 天各有固定文案；逐日 `HGETALL` 汇总为 `{from, to, surface:"all", totals, daily}`。

**同批缺陷修复（两侧同修）**：① `crawl-media-asset.service.ts` 第 264–268 行资产查询补 `orgId`（否则会为跨租户资产签发当前组织的 HMAC）；② `crawl-result.service.ts` 第 754 行 Mongo 内容查询在存在 `accessScope.orgId` 时补 `$or: [{orgId}, {orgId: {$exists:false}}]`；③ `crawl-quality-task-snapshot.service.ts` 的 `aggregateMarkdownRows` 增加 `orgId` 参数并补同样的 `$or`（此前只有 `taskId`）。

仍回 NestJS：`POST /api/crawl-tasks`、`DELETE /api/crawl-tasks/:id`、`POST /api/crawl-tasks/:id/retry`、`POST /api/crawl-tasks/metadata`、`/api/admin/crawl4ai/queue*`、上述 7 条的非注册方法、更长路径与父路径（Go 不返回自己的 404）。回滚：`API_GO_CRAWL_READ_TELEMETRY_MODE=legacy`。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不改 Web 的 API 地址，不启用 shadow，不改前端。已知偏差与细节见 `docs/refactor/go-crawl-read-telemetry.md`。SEC-01 的真实登录态未在本批验证。

### 1.8t 搜索索引重建（2 个，Go）与检索遥测批处理优化

`API_GO_SEARCH_REINDEX_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本是 `API_GO_SEARCH_REINDEX_MODE must be one of legacy|go`；`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，Elasticsearch 不是启动条件）。`go` 时只接管 2 条精确规则（规则见 `apps/api-go/internal/legacyproxy/search_reindex_routes.go`）：

- `POST /api/admin/search/reindex`（`settings.manage`，201）：取组织锁（物理键 `lock:search:reindex:org:<orgId>`，`SET NX PX` 5 分钟 + 随机 owner token，续租间隔 TTL/3）→ 落 `queued` 任务（活跃 TTL 12 小时）→ 返回 `{id, orgId, status:"queued", indexed:0, createdAt, updatedAt}`。同组织已有锁时 409 `SEARCH_REINDEX_IN_PROGRESS`（`error:"Conflict"`，无 `detail`）；不新增请求 DTO、不新增输入参数。
- `GET /api/admin/search/reindex/:jobId`（`settings.manage`，200）：只返回本组织任务，状态仅 `queued|running|completed|failed`，`error` 仅在失败时出现。不存在、已过期或跨组织一律 `null`（200），不新增 UUID 校验、不改 404。

任务状态用 Redis 既有结构 `search:reindex:job:<jobId>` / `search:reindex:org:<orgId>` / `search:reindex:orgs`，与 Nest 存储逐字段兼容（job JSON 的键序与 `error` 位置一致）。后台执行使用服务生命周期 context（HTTP 返回后不因请求取消而终止），顺序为 running → 分批重建 → completed/failed → 停止续租、释放自身锁、只清理本组织历史。清理改为当前组织范围：一次 `LRANGE` + 一次 `MGET` 单遍分类过期/缺失/超额，超额预算基于过滤后的有效列表且只裁终态任务（queued/running 永不被历史清理删除），批量 `DEL` + `LREM`，不用整段覆盖列表。本批不实现进程重启后的自动续跑，也不新增全局清理 scheduler、重试系统或第二套锁。

索引重建：Mongo 只读 `itemreadmodels` 的固定字段投影（不含 `raw.payload`/`processed.result`），始终带 `orgId`、按 `itemMetaId` 升序、`itemMetaId > 上批最后值` 的游标、每批最多 500；ES 文档 ID 为 `<orgId>:<itemMetaId>`。`ensureIndex` 保持现有行为（索引不存在时按当前 mappings 创建，alias 不存在时挂到当前索引，不重建共享索引、不删其他组织文档、不切整库 alias）。Bulk 每批 `refresh=false`、NDJSON 动作行与文档行交替且末尾换行；逐项读取响应，只把成功写入计入 `indexed`，一批存在逐项失败时保存该批成功数并立即 failed（不自动重试，不把后续批次当成功），错误文本含 `itemMetaId`、错误类型与截短原因，不含认证信息或完整文档；最后一次显式 refresh 成功后才 completed。未启用 ES 时沿用禁用分支（`indexed=0`），不算真实重建验收。

本批同时优化两个已迁移遥测入口（开关仍是 `API_GO_CRAWL_READ_TELEMETRY_MODE`，不改存储键、字段名与计数口径）：`POST /api/search-telemetry` 的写入由"N 次 `HINCRBY` + 1 次 `EXPIRE`"合并为一次 Lua（Nest 与 Go 同步），仍是 best-effort；`GET /api/admin/search-telemetry/summary` 的逐日 `HGETALL` 改为一次 Pipeline（Go）与一次批处理读取（Nest），日期顺序与零值日期输出不变。

细节、回滚与未验证项见 `docs/refactor/go-search-reindex.md`。

### 1.8q 运行时与治理设置（rate-limit / auth-cache / audit-log / scheduler / newsnow）

`API_GO_RUNTIME_SETTINGS_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本是 `API_GO_RUNTIME_SETTINGS_MODE must be one of legacy|go`；`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 `MONGO_URI`）。`go` 时只接管 18 条精确规则，统一要求 `settings.manage`（人类身份来自验签、Redis 撤销名单与 membership 重推导；机器令牌走 `MachineAccessToken` 行含 `Org.isActive`，权限与 `orgId` 来自令牌行），其中 `PUT /api/system-settings/audit-log` 另外要求平台管理员（否则 403 `Platform admin access required`；机器令牌永不满足）：

- 限流策略（201 仅创建）：`GET /api/system-settings/rate-limit-policies`（200，按 `feature asc`，空结果是 `[]`）、`POST /api/system-settings/rate-limit-policies`（201）、`GET /api/system-settings/rate-limit-policies/:feature`（200，恰好一段）、`PUT /api/system-settings/rate-limit-policies/:feature`（200）、`DELETE /api/system-settings/rate-limit-policies/:feature`（200 `{ok:true}`）。
- 全局限流桶：`GET /api/system-settings/rate-limits`（200）、`PUT /api/system-settings/rate-limits`（200，三桶同事务 upsert）。
- 鉴权缓存：`GET /api/system-settings/auth-cache`（200）、`PUT /api/system-settings/auth-cache`（200）。
- 审计保留：`GET /api/system-settings/audit-log`（200 `{retentionDays}`，30 秒进程内缓存）、`PUT /api/system-settings/audit-log`（200，`retentionDays` 收口 [1,3650]）。
- 多租户调度：`GET/PUT /api/system-settings/multi-tenant-schedulers`（200，`source` + 11 个并发值；PUT 是整条替换）。
- 新闻源调度：`GET/PUT /api/system-settings/news-source-scheduler`（200，`source` + 15 个值，30 秒进程内缓存）。
- NewsNow 个性化：`GET/PUT /api/system-settings/newsnow-personalization`（200）、`GET /api/system-settings/newsnow-personalization/metrics`（200；`days` 缺省 7、收口 [1,90]；每 UTC 日一个 Redis hash，单日读失败输出全零行）。

`feature` 归一化为 `trim().toLowerCase()` 且须匹配 `^[a-z][a-z0-9_.]*$`（否则 400 `Invalid rate limit feature name`）。Redis 键与 TTL：`rate_limit_policy:<feature>` 固定 60 秒；`rate_limit:settings` 取 `RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS`（缺省/≤0 时 60 秒）；`auth_cache:settings` 固定 60 秒；`newsnow:personalization:metrics:v1:<YYYY-MM-DD>` 由聚合器写入、Go 只读。新闻源调度写成功后 best-effort 删 `news-source:sitemap:` / `news-source:rss:` / `news-source:list:` / `news-source:deep:` 四个前缀。SystemSetting 主键：`rate_limit_login`、`rate_limit_crawl_create`、`rate_limit_rbac_write`、`auth_profile_cache_settings`、`audit_log_retention_days`、`multi_tenant_scheduler_runtime_settings`、`news_source_scheduler_settings`、`newsnow_personalization_settings`。

错误契约：新闻源调度三条交叉规则返回 400 `rssAdaptiveWarmHitRatePercent must be less than or equal to rssAdaptiveHotHitRatePercent` / `rssAdaptiveColdMaxIntervalSeconds must be greater than or equal to rssAdaptiveWarmMinIntervalSeconds` / `rssAdaptiveWarmDiscoveryCacheTtlCapSeconds must be greater than or equal to rssAdaptiveHotDiscoveryCacheTtlCapSeconds`；三处存储值非法返回 409 且带 code——`MULTI_TENANT_SCHEDULER_SETTINGS_INVALID`（`Stored multi-tenant scheduler runtime settings are invalid.`，detail `Multi-tenant scheduler concurrency settings must be integers between 1 and 16.`）、`NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID`（`Stored news source scheduler settings are invalid.`）、`NEWSNOW_PERSONALIZATION_SETTINGS_INVALID`（`Stored NewsNow personalization settings are invalid.`）；重复创建策略 409 `Rate limit policy already exists for <feature>`；update/delete 行不存在 404 `Rate limit policy not found for <feature>`；DTO 校验复刻 class-validator 措辞并用 `"; "` 拼接，未知字段 400 `property <name> should not exist`。**缺陷修复（Nest 与 Go 两侧同修）**：`SystemSetting.updatedById`、`RateLimitPolicy.updatedById` 与 `AuditLog.actorId` 是指向 `User(id)` 的外键，机器令牌 `machine:<id>` 必须写 SQL NULL（否则 MySQL 1452 → 500）；`description` 改为三态（键缺失=保留，`""`/空白/`null`=清成 NULL）；并发创建 1062（P2002）→ 409、并发删除 P2025 → 404。`GET /api/system-settings/security` 与其余全部 `/api/system-settings/*` 仍回 NestJS（Go 不返回自己的 404）。回滚：`API_GO_RUNTIME_SETTINGS_MODE=legacy`。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不改 Web 的 API 地址，不启用 shadow，不改前端。细节见 `docs/refactor/go-runtime-settings.md`。SEC-01 的真实登录态未在本批验证。

### 1.8r NewsNow 本地计算与新闻事件聚类失败管理（Go）

`API_GO_NEWSNOW_CLUSTERING_OPS_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名；`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`）。`go` 时只接管 9 条精确路由，规则在 `apps/api-go/internal/legacyproxy/newsnow_clustering_ops_routes.go`：

- `GET /api/news-aggregator/metadata`（`@Public()`）→ `{sources, columns}`，由 `genSources()`/`genMetadata()` 的确定性结果内嵌生成，JSON 键顺序与 NestJS 一致。
- `GET /api/news-aggregator/resolve?url=`（`@Public()`）→ `{matched, itemId?, eventId?, confidence?, matchedUrl?}`。`url` 缺失/空白 → 400 `url query is required`；非绝对 URL → 400 `url must be a valid absolute URL`；协议非 http/https → 400 `url protocol must be http or https`。5 级优先级查 Mongo `rawitems`，置信度 `1` / `1` / `1` / `0.93` / `0.86`；Redis 命中 300s、未命中 30s。
- `POST /api/news-aggregator/sources/order`（`items.read`，201）→ `{columnKey, sortMode, sourceIds, sourceScores, sourceScoreDetails, scoreWeights, computedAt}`。请求校验与控制器一致（`column is required`、`invalid column format`、`sources must be an array of source ids`、`settings must be an object`）；超限且无 stale 缓存 → 429 `NewsNow personalized ordering is rate limited. Please retry shortly.`；存储策略非法 → 409 `NEWSNOW_PERSONALIZATION_SETTINGS_INVALID`。
- `GET /api/news-aggregator/domestic-opinion-index?hours=`（`items.read`）→ `hours` 非空时必须是 `1..168` 整数字符串，否则 400 `hours must be an integer between 1 and 168`，缺省 24。返回 `{generatedAt, dataState, emptyReason, diagnostics, latest, trend, topKeywords, topCandidates, breakdown}`，`0.75`（`NewsnowDomesticOpinionIndexSnapshot`）/`0.25`（`ProcessedArticle`）加权融合。
- `GET /api/system-settings/news-events/clustering/readiness`（`settings.manage`）→ `{modelService, llmBackfill, recoveryAutomation}`；读 MySQL `SystemSetting` 的 `model_service`（**不是** `model_service_settings`）与 `llm_gateway_profiles`。
- `GET /api/system-settings/news-events/clustering/overview`（`settings.manage`）→ `{pendingCount, processingCount, resolvedCount, ignoredCount, latestFailureAt}`。
- `GET /api/system-settings/news-events/clustering/failures?status=&limit=`（`settings.manage`）→ `NewsEventClusteringFailureSummary[]`；`status` 只在这四个枚举值时过滤，`limit` 缺省 20 且 clamp `1..200`。
- `POST /api/system-settings/news-events/clustering/failures/:groupId/vector-backfill`（`settings.manage`，201）→ `{groupId, assignedCount, skippedCount, resolvedEventIds, resolvedAt}`；入口 `{orgId, groupId, status: "pending"}` 原子抢占。
- `POST /api/system-settings/news-events/clustering/failures/:groupId/ignore`（`settings.manage`，201）→ `NewsEventClusteringFailureSummary`，`status === "ignored"`。

后 7 条同时接受人类 JWT（验签 + Redis 撤销名单 + MySQL membership 权限重推导）与 `mtk_` 机器令牌（`MachineAccessToken` SHA-256 + `Org.isActive`，权限与 `orgId` 只取令牌行）。聚类失败组一律按 `{orgId, groupId}` 过滤：跨组织访问返回 404，不返回 403 之外的任何本组织信息。

仍回 NestJS：`GET /api/news-aggregator/source`、`POST /api/news-aggregator/sources/batch`、`GET /api/news-aggregator/hottest-analysis`、`GET /api/news-aggregator/recommended`（抓外网源）与 `POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill`（BullMQ + LLM 网关），以及这 9 条的非白名单方法与更长路径。回滚：`API_GO_NEWSNOW_CLUSTERING_OPS_MODE=legacy`。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不启用 shadow，不改前端。细节见 `docs/refactor/go-newsnow-clustering-ops.md`。SEC-01 的真实登录态未在本批验证。
### 1.9 system-settings（98 个，26 个 controller）

内部端点（服务间 token，非用户 JWT）：
- `openai-keys-internal.controller.ts`（前缀 `internal/litellm`，类级 `LitellmInternalTokenGuard`+`@Public`）：GET openai-keys(:33) · POST openai-keys/applied(:43) · GET proxy-load-balancing(:54)
- `observability/internal-exception-events.controller.ts`：POST /api/internal/observability/exception-events(:39)

其余均为 settings.manage 的设置型端点（GET+PUT+可选 DELETE），前缀 `system-settings/*`：
archive-preparation · assistant-quota · assistant-safety(+diagnostics/metrics) · audit-log · auth-cache · email(+auth-code/test) · geo/nominatim(+test) · **llm-gateways（22 个：CRUD+active+embedding-active+rerank-active+proxy-governance 全套+proxy-load-balancing 全套+test-config+models+proxy-health+proxy-model-info+proxy-lb-test+models-config）** · llm-request-logs(+metadata-policy/reset) · model-service · multi-tenant-schedulers · news-source-runtime-secrets · news-source-scheduler · newsnow-personalization(+metrics) · openai-keys · rate-limit-policies(:feature CRUD) · rate-limits · realtime-signals · rss-diagnostics(overview/chain/sources/backfill) · rss-translation/metrics · situation-monitor（7 个，含 telegram-auth 三步 + external-snapshot/refresh） · security · task-logs · vector-service(+diagnostics)

### 1.10 其余模块压缩清单

| 模块 | 数量 | 路径与权限（省略 /api/） |
|---|---|---|
| akshare | 3 | admin/akshare/version·status·upgrade（settings.manage） |
| analysis-workspace | 26 | analysis 下 views/boards/columns/tasks/threads/comments/exports CRUD（analysis.read/write） |
| archive | 1 | admin/archive-preparation/status（settings.manage） |
| dashboard | 13 | dashboard/stats + war-map(geojson/layers/events/news-markers/transport-detail) + spacetime(geo-heatmap[+articles]/propagation[+articles]) + sector-heatmap + financial-candlestick（dashboards.read） |
| health | 2 | healthz（AllowAuthenticated）· healthz/live（@Public） |
| news-aggregator | 8 | source·sources/batch·sources/order·metadata·resolve（Public/mixed）·hottest-analysis·domestic-opinion-index·recommended（items.read） |
| news-indicator | 3 | associations·:id（dashboards.read）·refresh（settings.manage） |
| llm-logs | 3 | llm-_logs·export·summary（settings.manage） |
| observability | 27 | admin/errors(+stats) · admin/task-logs(+summary/errors/audit) · admin/quality/classification 全套 · observability/exception-events/client(AllowAuthenticated) · internal/observability/exception-events · **metrics（metrics.read）** · admin/quality/news-sources·pipeline·overview · pipeline-recovery(runs/replay/rollback) |
| realtime-signals | 1 | system-settings/realtime-signals/runtime（settings.manage） |
| search-telemetry | 2 | POST search-telemetry（items.read）· GET admin/search-telemetry/summary（settings.manage） |
| situation-monitor | 14 | insights·monitors CRUD·preview·catalog·feedback(items.write)·refresh·refresh-runs/:id·telegram-feed·oref-alerts·oref-history·live-hls-proxy-config（items.read） |
| storage | 3 | admin/settings/storage GET/PATCH/test（settings.manage） |
| user-content-subscriptions | 7 | CRUD+catalog+recommendations+lookup+related-topics（items.read） |
| user-digest | 5 | preference GET/PUT · delivery GET/PUT · GET /api/user-digest（items.read） |
| user-news-behavior | 3 | POST · GET profile · DELETE profile（items.read） |
| Bull Board | 1 | /admin/queues（无 /api 前缀，Bearer JWT + queue.manage，纯文本错误非 JSON，`bull-board-auth.middleware.ts:27-57`） |

### 1.8s 账户资料、会话退出与机器令牌（Go）

`API_GO_ACCOUNT_SECURITY_MODE` 默认 `legacy`，只接受空字符串、`legacy` 或 `go`
（空串与 `legacy` 等价；其他值启动失败，错误文本含变量名）。`go` 时接管 8 条
精确路由：`GET /api/auth/me`（AllowAuthenticated）、`PATCH /api/auth/profile`
（AllowAuthenticated）、`POST /api/auth/change-password`（AllowAuthenticated，200）、
`POST /api/auth/logout`（AllowAuthenticated，成功 **201**）、
`GET/POST /api/auth/machine-tokens`（`settings.manage`，POST 201）、
`DELETE /api/auth/machine-tokens/:tokenId`（`settings.manage`，200）、
`POST /api/auth/machine-tokens/:tokenId/rotate`（`settings.manage`，201）。
`:tokenId` 只能是恰好一个非空路径段，`/rotate` 只能是最后一段；其他方法（如
`GET /api/auth/machine-tokens/:tokenId`）、尾斜杠、更长路径与相似前缀（如
`/api/auth/mefoo`、`/api/auth/machine-tokensx`）仍回 NestJS（Go 不返回自己的
404）。人类走 JWT 验签 + Redis access 黑名单 + MySQL membership 权限重推导
（JWT permissions claim 不参与）；机器令牌按 `mtk_` 全量 SHA-256 查
`MachineAccessToken`，权限取自存储行且**不按新建白名单裁剪**（历史
`settings.manage` 令牌仍可管理机器令牌）。`GET /me` 返回基础 profile +
`accessTokenId`/`accessTokenExpiresAt`（`exp*1000` 毫秒）；`PATCH /profile`
有意不返回这两个字段。profile 缓存 `profile:<userId>:<orgId|default>`
（`auth_cache:settings` 60s），资料更新与改密后按该 user 全部 membership 失效。
登录、refresh、邮箱验证码、密码找回、MFA、OIDC、邀请、注册审核、
`avatar/presigned-url`、`data-export` 仍回 NestJS。回滚：把
`API_GO_ACCOUNT_SECURITY_MODE` 改回 `legacy`。不打开 canary，不改生产入口
（生产 Web 仍指向 NestJS）。细节见 `docs/refactor/go-account-security.md`。

## 2. GraphQL 契约

- 端点：`POST /graphql`；订阅 `graphql-ws` 协议（默认启用）
- Guard 链：`GraphqlRateLimitGuard` → `GqlAuthGuard` → `GqlPermissionsGuard`（`graphql.module.ts:494-513`）；限流 `graphql:{ip}` 桶，limit = max(login×30, 120)
- 防护：深度 8 / 复杂度 2000 / APQ 开启 / 响应缓存（Redis，按 `orgId:userId` 会话隔离，仅缓存白名单 query）
- SDL 快照：`apps/api/schema.gql`（code-first sortSchema 生成，2925 行）：**77 Query / 57 Mutation / 4 Subscription**；150 type / 85 input / 53 enum
- WS 订阅鉴权：connectionParams 合成 headers，键须小写 `authorization`（`graphql.types.ts:47-55`、`gql-auth.guard.ts:35-47`）
- **PubSub 为进程内**（非 Redis）：alerts/queue/analysis/assistant 四处（`*.pubsub.ts`）——多实例不跨进程

### Resolver 清单（25 个，`src/graphql/resolvers/`）

统一 `@UseGuards(GqlAuthGuard, GqlPermissionsGuard)`；字段级 `@HasPermission("x")`。

| Resolver | Query | Mutation | Subscription | 权限要点 |
|---|---|---|---|---|
| alerts | alertChannels/alertRules/alertEvents/alertEventReplay/alertRuleTuningSuggestion | upsert/deleteAlertRule · create/update/deleteAlertChannel · triggerAlertRule · updateAlertEventStatus | alertEvents | alerts.read / alerts.manage |
| analysis | analysisResults | requestCorrelation/Anomaly/GeoTransportAnalysis | analysisEvents | analysis.read / analysis.run |
| archive | archiveDigest/Calendar/Detail | — | — | items.read |
| assistant | assistantRuns/EconomicSeriesSuggestions/RuntimeCapabilities | requestQuery/Report/Forecast · deleteRun | assistantEvents | assistant.read / assistant.run |
| crawl | crawlTasks/crawlTask/crawlMetadata | create/retry/updateIngest/ingestResults(**@PermissionsAll("crawl.read","items.write")**)/delete | — | crawl.read/write |
| dashboard | dashboards/queueStats | upsert/deleteDashboard | queueEvents | dashboards.read/write；queueStats+queueEvents 为 queue.manage |
| economic-data | getEconomicData(WithInsights/Insights/Paginated) · fetchConfigs · refreshPresetStatus | updateFetchConfig · triggerDataFetch · triggerRefreshPreset | — | economicdata.read/manage |
| entity-impact-graph | getEntityImpactGraph | — | — | dashboards.read |
| entity-intelligence | entityIntelligenceCard/Evidence · knowledgeEntityByName | — | — | dashboards.read |
| items | items/itemFacets/rssSources/rssTranslationStatus/searchSuggestions/item | createItem · createItemFromCrawlResult(**PermissionsAll**) · updateItem · translateRssItems | — | items.read/write；6 个 @ResolveField（meta/publishedAt/raw/processed 等，DataLoader） |
| knowledge-graph | getSubgraph · articleEntityLinks · edgeEvidence | — | — | dashboards.read / items.read |
| knowledge-graph-impact | getExecutiveChange/CommodityMove/PolicyEventImpact | — | — | dashboards.read |
| knowledge-graph-review | evidenceReviewQueue | reviewEvidence | — | settings.manage **或** knowledgegraph.review |
| news-events | sourcePolicySyncStatus/newsEvents/newsEvent/Brief/ReferencedArticles。Go-批8：两个开关都是 `go` 时后四项由 Go 读；sourcePolicySyncStatus 仍在 NestJS。简报只迁缓存命中，未命中不调用模型 | — | — | items.read |
| news-indicator | associations/:id。Go：`API_GO_GRAPHQL_READ_MODE` 与 `API_GO_NEWS_INDICATORS_MODE` 都是 `go` 时 `newsIndicatorAssociations`/`newsIndicatorAssociation` 两个只读 query 由 Go 读；`newsIndicatorSettings` 仍在 NestJS | refresh。Go 不迁这个 mutation | — | dashboards.read / settings.manage |
| notification | notifications/unreadCount | markRead/markAllRead | — | @AllowAuthenticated |
| org | myOrganizations | createOrg/updateOrg/setOrgActive | — | myOrganizations @AllowAuthenticated；其余 org.write |
| processed-item(-event/-duplicate) | processedItemById | — | — | items.read（后两者仅 @ResolveField） |
| rbac | roles/permissions/memberships | createRole/assignRole/updateRole | — | roles/users 读写 |
| sentiment | entitySentimentSeries/topicSentimentSeries | — | — | dashboards.read |
| settings | 16 个设置读取 | 16 个对应 update | — | 绝大多数 settings.manage；entityImpactGraph/knowledgeGraph/newsEvent/newsIndicator 的 GET 为 dashboards.read |
| topics | topicGroups/eventGroups。Go-批8：两个开关都是 `go` 时这两个 root 由 Go 读 Mongo `processeditems` | — | — | items.read |
| user | me(@AllowAuthenticated)/users/userLoginRecords | updateMembershipRoles/setUserActive | — | users.read/write |

## 3. WebSocket 契约（6 个 Socket.IO gateway）

通用：JWT 三处取（header `Authorization: Bearer` > `auth.token` > `query.token`）· IP+用户桶连接限流（退避 1s→60s）· **30s token 周期复验** · 房间 `org:{orgId}` / `user:{userId}` · **全库无 @SubscribeMessage**（唯一 client→server 事件见 newsnow 行）。

| Gateway | namespace | client→server | server→client | 权限 |
|---|---|---|---|---|
| notifications | `notifications` | — | notification:connected · notification（user/org 定向） · notification:error | 仅 JWT |
| queue | `queue` | — | queue:connected · queue:event（org 房间） · queue:error | queue.manage |
| newsnow | `newsnow` | newsnow:set-active-sources | newsnow:connected · newsnow:update（org 定向） · newsnow:error | items.read |
| ops | `ops` | — | ops:connected · ops:event（org，source: pipeline/crawl/analysis/assistant/alerts） · ops:error | crawl.read 或 crawl.write |
| quality | `quality` | — | quality:connected · quality:event · quality:error | settings.manage |
| situation-monitor | `situation-monitor` | — | situation:connected · situation:telegram.update · situation:oref.update（user 定向） · situation:error | items.read |

## 4. 队列契约（BullMQ，14 队列 / 10 processor）

全部 processor 为 `OnModuleInit` 手写 `new Worker(...)`；共享 Redis 连接（maxRetriesPerRequest:null）+ 每 QueueEvents 专用连接；失败任务保留 7 天/1 万条，DLQ 30 天/2 万条。

| 队列 | job name | 关键语义 | 并发 |
|---|---|---|---|
| itemPipeline | process-item | attempts 5 · 指数退避 · removeOnComplete{age 1h,count 1000} | env，默认 3 |
| itemPipelineDlq | dlq | **入队发生在 worker failed 事件**（jobId `dlq-itemPipeline-{jobId}-{attemptsMade}`）；永久错误 UnrecoverableError 或重试耗尽 | — |
| crawl4ai(legacy)/-hot/-normal | crawl-task · crawl-frontier-node | 双轨并存（shouldStartLegacyWorker 决定 legacy worker）；内存压力 requeue 预算 | 全局限流器+本地并发 |
| frontier-llm-judge/-learn | crawl-frontier-llm-judge/learn | attempts 1 | 专用 worker |
| analysis | correlation/anomaly/geo_transport | 最终失败通知 | env |
| assistant | query/report/forecast | 同上 | env |
| alerts | scan-active-rules（repeat）· evaluate-rule:{id} · deliver-notification:{id} | 投递自定义 backoff | env |
| news_event_clustering_recovery | llm_backfill | — | max(1,min(2,c)) |
| classification_quality | report:{jobId} · review_seed_item | attempts 3 | min(4,c‖2) |
| archivePreparation | = 队列名 | attempts 5 · 退避 15s | **1** |
| situationMonitorSignals | telegram-poll(+bootstrap) · oref-poll(+bootstrap) | repeat + bootstrap 首跑 | **1** |
| akshare-data | fetch:{itemId}(repeat) · manual-fetch | — | env |

## 5. 错误响应结构（GlobalExceptionFilter）

### REST（`handleHttpException` :68-117）

```json
{
  "statusCode": 503,            // Prisma 初始化/RustPanic/P2021/P2022 → 503；其余非 HttpException → 500
  "message": "Internal server error",  // >=500 固定此值；<500 为异常 message（数组以 "; " 连接）
  "error": "Service Unavailable",
  "code": "SAFE_CODE",          // 白名单 ^[A-Z0-9_]+$（如 INSUFFICIENT_PERMISSIONS）
  "detail": "...",              // 可选
  "requiredPermissions": [],    // 等扩展字段（按异常类型透传）
  "traceId": "...",             // 响应头同时有 x-trace-id
  "path": "/api/...",
  "timestamp": "ISO8601"
}
```

### GraphQL（`handleGraphqlException` :119-192）

Apollo errors 数组；与 REST 的差异：`extensions.code` 为 **HttpStatus 枚举名**（BAD_REQUEST 等），业务码在 `extensions.appCode`；traceId 在 extensions 内；`originalError`（含 stack）仅非生产环境；无顶层 path/timestamp。

## 6. 鉴权相关 HTTP 语义

| 项 | 语义 |
|---|---|
| JWT 读取位置 | **仅 `Authorization: Bearer`**；无 cookie 下发（refreshToken 在 login/refresh 响应体） |
| TTL | access 15m / refresh 7d；refresh 轮换（旧 token 黑名单 + 原子 claimed 更新） |
| 机器令牌 | `mtk_` 前缀，同一 Bearer 通道，JwtAuthGuard 分流，权限白名单 |
| LiteLLM 内部端点 | Bearer 与 `LITELLM_CONFIG_INTERNAL_TOKEN` **时序安全比较**（`common/internal-token.ts`） |
| vector/model-service | `x-internal-token` 头；vector 侧为**普通相等比较**（SEC-04） |
| Bull Board | Bearer JWT + queue.manage；错误为纯文本非 JSON |
| CORS | credentials:true，origin 白名单来自 CORS_ORIGIN。api-go 在 user-settings 读写模式均为 go 时，对六个精确 GET/PUT 使用同一白名单；不反射未列出的 Origin，携带凭据时不返回 `*` |

## 7. 保护网快照与差分测试（已落地；验证状态标注于各项）

1. **REST 路由/鉴权契约快照**：✅ 远端 CI 已验证。`apps/api/tests/contract/openapi.snapshot.json`（OpenAPI 3.0 形，静态装饰器扫描生成——不启动 Nest 不连 DB；370 端点/294 路径；确定性输出）。**能力边界（info.completeness 如实登记）**：覆盖路由/方法/路径参数/鉴权元数据/默认状态码语义（POST=201 + 显式 @HttpCode 提取，`x-http-code-explicit`）；请求体只有 DTO `$ref` 名称（`x-unresolved-schema` 标注，无 components.schemas 字段模型）；响应与错误字段模型**未提取**（`x-response-schema: "unresolved"`，错误形状由本清单 §5 文字锚定）；@All 多方法 handler 跳过并计数。**它是 REST route/auth contract snapshot，不是完整 OpenAPI 契约**。CI 漂移门禁：同一生成命令在两个互相独立的冷 Node 进程各生成一次（`--output` 导向临时文件），SHA-256 必须一致，再与已提交快照逐字节比对（CI-01 修复后加固，PR #12；无 retry）。
2. **GraphQL SDL**：✅ CI 门禁已接入（verify job「GraphQL SDL drift check」：`pnpm --filter @modular/api run generate:schema` + `git diff --exit-code apps/api/schema.gql`）。`schema.gql`（2925 行）为冻结快照。
3. **鉴权矩阵（四态语义）**：✅ 远端 CI 已验证。`apps/api/tests/contract/auth-matrix.{json,md}`（`tools/generate-auth-matrix.ts` 静态生成）。列语义：`anonymous` / `authenticatedWithoutPermission`（@Permissions 端点必 denied——Guard 语义的静态镜像）/ `authenticatedWithPermission`（allowed）/ `wrongOrg`（**一律 runtime-required**——org 上下文由每请求 DB membership 重推导，静态不编造）/ `ordinaryOrgAdmin` / `platformAdmin` / `platformCheckSource`（handler-text-scan 启发式来源）/ `runtimeVerificationRequired` / `confidence`（static vs static+heuristic）。**handler 平台校验是启发式标注**：提示运行时行为，不是静态保障——运行时强制力由 handler 内 assertPlatformAdmin 提供并以控制器单测锚定。生成时 fail-closed（缺权限元数据 → exit 1）；CI 重新生成逐字节比对。
4. **差分测试**：✅ 基础设施远端 CI 已验证（直通+有界旁录捕获：客户端流式语义保留、请求体/响应捕获独立预算、SSE/升级跳过、六类分类丢弃统计、差分正文默认只记 sha256 hash）。首个迁移单元 `GET /api/healthz/live` 在 shadow 态（NestJS 仍是响应方）。**真实流量差分数据：无**（网关未接入入口代理）。
5. **契约基线再生成**：生成器不在开发机执行——有意变更契约语义时给 PR 打 `contract-regen` label，CI `contract-baseline-regen` job 远端运行三个生成器并提交回分支（见 ci.yml；再生成完成后移除 label 恢复漂移门禁）。
6. **WS 事件**：6 namespace 的 connected/event/error 事件名与 payload 形状入 `tests/contract/ws-events.json` —— ⬜ 未做（M5+）

## 8. 迁移风险登记（勘察结论）

1. GraphQL 与 Socket.IO 挂根路径，代理层必须三套路径规则（/api、/graphql、/socket.io）
2. 5 个死路由（§0）——契约冻结时决定补元数据还是删除（删除即契约变更，需版本化）
3. GraphQL Subscription 进程内 PubSub vs Socket.IO 可选 Redis adapter——水平扩容语义不一致
4. crawl4ai legacy 与 hot/normal 双轨队列并存
5. itemPipeline DLQ 的非标准入队时机（worker failed 事件）
6. `GET /api/metrics` 是平台级全量指标（SEC-03 已收紧）：人类须为平台管理员；机器令牌还须其 `createdById` 当前持有 `platform_admin`。普通组织的 `metrics.read` 或旧机器令牌不再够用。输出不过滤成组织子集。

## 9. Go-批9 知识图谱与实体 360 情报 GraphQL 读（增量）

- 开关：`API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE`（`legacy`|`go`，默认 `legacy`）。只有 `API_GO_GRAPHQL_READ_MODE=go` 且本开关 `=go` 时，六个 root 才登记进 Go 执行器。
- 迁入 root：`getKnowledgeGraphSubgraph`、`articleEntityLinks`、`knowledgeGraphEdgeEvidence`、`entityIntelligenceCard`、`entityIntelligenceEvidence`、`knowledgeEntityByName`。orgId 与权限仍是服务端 membership 重推导；`entityIntelligenceEvidence` 顶层 `dashboards.read`，无 `items.read` 时返回 `restricted: true` 空列表。
- 未迁：`knowledgeGraphEvidenceReviewQueue`、`reviewKnowledgeGraphEvidence`、`knowledgeGraphSettings` / `updateKnowledgeGraphSettings`；`getExecutiveChangeImpact` / `getCommodityMoveImpact` / `getPolicyEventImpact` / `getEntityImpactGraph` 由第 10 节另一个开关迁入。选中任一未迁 root 时整文档回落 NestJS。
- 缺陷 1：`getSubgraph` 邻居实体查询两侧同补 `orgId`（`apps/api/src/modules/knowledge-graph/knowledge-graph.service.ts:499-501`、`apps/api-go/internal/graphqlread/knowledgegraph/subgraph.go`），防止脏边跨租户带出实体。
- 缺陷 2：全局 `ValidationPipe{forbidUnknownValues:true}` 会 400 掉无 class-validator 元数据的 InputType；给 `KnowledgeGraphSubgraphInput`、`EntityIntelligenceCardInput`、`EntityIntelligenceEvidenceInput` 的字段加 `@Allow()`（不加约束、不改 SDL）。
- 说明见 `docs/refactor/go-knowledge-graph-read.md`。

## 10. 知识图谱冲击传导与实体共现/相关图 GraphQL 读（Go）

新增开关 `API_GO_GRAPHQL_KG_IMPACT_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败）。只有 `API_GO_GRAPHQL_READ_MODE=go` 且本开关 `go` 时，才在既有精确 `/graphql` 执行器登记 4 个只读 root：`getExecutiveChangeImpact`、`getCommodityMoveImpact`、`getPolicyEventImpact`、`getEntityImpactGraph`。与第 2 节表格中 `entity-impact-graph` / `knowledge-graph-impact` 两行是同一个权限（重推导的 `dashboards.read`），`mtk_` 机器令牌按读执行器规则拒绝。

- 三个冲击传导 root 读组织级知识图谱设置（Redis `knowledgeGraph:settings:<orgId>` -> MySQL `SystemSetting` `knowledge_graph_settings:<orgId>`），按 Nest 的评分公式、候选合并、链条顺序与 Redis 缓存键（`knowledgeGraph:impact:<orgId>:...`）输出。`includeLprSnapshot` 不发实网 AkShare。
- `getEntityImpactGraph` 读 Mongo `processeditems` 共现/提及序列与 MySQL `EconomicDataPoint` 金融序列，皮尔逊相关、节点裁剪与 ECharts 符号大小对齐 Nest，缓存键 `entityImpactGraph:data:<orgId>:...`。
- 同批修掉三处缺陷：`knowledge-graph-impact.service.ts` 第 158/275/386/545/575 行 5 处 `knowledgeEntity.findMany` 补 `orgId`；`entity-impact-graph.service.ts` 第 564 行 `$dateToString` 补 `timezone: "UTC"`；`knowledge-graph-impact.model.ts` 三个冲击传导输入补 `@Allow()`（与第 9 节同一误杀，否则全局 `ValidationPipe` 的 `forbidUnknownValues` 直接 400，查询到不了 resolver）。两侧同修。
- 回滚只把 `API_GO_GRAPHQL_KG_IMPACT_MODE` 改回 `legacy`；不改表、不改 SDL、不改 Web 入口、不改其他开关默认值。

## 11. 身份/组织/RBAC/仪表盘/队列/情感/已处理条目 GraphQL 读（Go）

新增开关 `API_GO_GRAPHQL_WORKSPACE_READ_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败）。只有 `API_GO_GRAPHQL_READ_MODE=go` 且本开关 `go` 时，才在既有精确 `/graphql` 执行器登记 12 个只读 root：

- `me`（`AllowAuthenticated`；`UserModel` 的 `primaryRoleId`/`isActive`/`emailVerified`/`lastLoginAt`/`roleIds` 为字段级 `users.read`）
- `myOrganizations`（`AllowAuthenticated`；按 `createdAt asc` 去重，`isActive = org.isActive && (membership.isActive ?? true)`）
- `users(first, after, search)`、`userLoginRecords(userId, limit)`（`users.read` + 系统 `admin` 角色门禁）
- `roles(includeSystem)`（`roles.read`，`name asc`）、`permissions`（`permissions.read`，`name asc`）
- `memberships`（`users.read`；`RoleModel.permissions` 为字段级 `roles.read`）
- `dashboards`（`dashboards.read`；`createdAt asc`，widgets `sortOrder asc`）
- `queueStats`（`queue.manage`；MySQL `ItemMeta` + Mongo `processeditems` + Redis `queue:itemPipeline:org:<orgId>:counts` + 最近 10 条 `tasklogs`，`message` 经 `adminlogs.RedactSensitiveFields`）
- `entitySentimentSeries` / `topicSentimentSeries`（`dashboards.read`；`days` 默认 30、clamp 1..365，名称 trim）
- `processedItemById(id)`（`items.read`；非法 ObjectId 400，`duplicateOf` -> 目标 `ItemMeta.id`，`eventId` 两步回退）

未迁：`upsertDashboard`/`deleteDashboard` Mutation 与 `queueEvents` Subscription。同批修 4 个缺陷：非法/跨组织游标返回空页（Nest + Go）、删除 `(doc.llm as any)` 并强类型归一化 `llm`（Nest + Go）、`entityName`/`topic` trim（Nest + Go）、`recentLogs.message` 脱敏（Nest + Go）。回滚只把 `API_GO_GRAPHQL_WORKSPACE_READ_MODE` 改回 `legacy`；不改表、不改 SDL、不改 Web 入口、不改其他开关默认值。

### 11.1 组织、角色与成员管理 GraphQL 写（Go）

新增开关 `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败，错误文本含变量名）。与 `API_GO_GRAPHQL_READ_MODE` 完全解耦，四种读/写组合分别决定 Query 与 Mutation 的归属。`go` 只要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，**不要求 `MONGO_URI`**，不初始化只读域 Mongo service。

`go` 时在既有精确 `/graphql` 执行器登记 8 个 Mutation（其余 Mutation 仍回 NestJS）：

- `createOrg(input)` / `updateOrg(input)` / `setOrgActive(input)`：`org.write`；组织写在一个事务内创建 `Org`、`DEFAULT_ROLES` 三个系统角色及其 `RolePermission`、创建者的 `Membership`/`MembershipRole` 与 `AuditLog`（`org/create`，metadata `{slug,name}`，缺失权限记 `bootstrapWarnings`），admin 关联数据库全部 `Permission`；`updateOrg`/`setOrgActive` 的目标组织权限从 actor 在目标 org 的 `Membership` + 角色重新推导；禁用组织后逐成员删 `profile:<userId>:<orgId>`。
- `createRole(input)` / `updateRole(input)`：`roles.write`；复用 `internal/rbacapi`（限流、事务、权限存在性与范围、系统角色限制、缓存失效、审计）。
- `assignRole(input)`：`roles.write`；复用 `internal/rbacapi`，事务内 `SELECT id FROM Membership ... FOR UPDATE` 后替换 `MembershipRole`。
- `updateMembershipRoles(input)` / `setUserActive(input)`：`users.write`；`roleIds` trim + 去空 + 去重且 `primaryRoleId` 必须属于该集合；`setUserActive` 只改 `Membership.isActive`。

本批同时为执行器补齐最小必要的 Mutation 能力：Query/Mutation 分别登记与选根（planner、选择集、复杂度、`__typename`、字段定义查找按 operation 选根）、整包接管判断、顶层字段按文档顺序串行执行（非空失败 `data:null` 并停止后续字段）、GET 拒绝（405 + `Allow: POST`，鉴权前发生）、Mutation `Cache-Control: no-store`（`ResponseCacheable` 先限定 operation 为 Query）。

回滚只把 `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` 改回 `legacy`；不改表、不改 SDL、不改 Web 入口、不改其他开关默认值。说明见 `docs/refactor/go-graphql-org-access-write.md`。

## 12. 分类质量工作台与 RSS 诊断/翻译指标（Go）

新增开关 `API_GO_CLASSIFICATION_RSS_OPS_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败，错误文本含变量名）。`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。`go` 时只接管 13 条精确路由规则（10 条静态 + 3 条“恰好一段”动态路径，另加同路径 `OPTIONS` 预检），全部要求 `settings.manage`（人类身份来自 JWT 验签、Redis 撤销名单与 membership 重推导，忽略 JWT claims 里的 `permissions`；`mtk_` 机器令牌走 `MachineAccessToken` 的 SHA-256 查 `tokenHash`、校验 `Org.isActive`/未撤销/未过期、更新 `lastUsedAt`，身份为 `machine:<tokenId>`）：

| 方法 | 精确路径 | 成功码 |
| --- | --- | --- |
| GET | `/api/admin/quality/classification/summary` | 200 |
| GET | `/api/admin/quality/classification/sources/:sourceId/items` | 200 |
| GET | `/api/admin/quality/classification/reviews/queue` | 200 |
| POST | `/api/admin/quality/classification/reviews/:reviewId/decision` | 201 |
| POST | `/api/admin/quality/classification/reviews/batch` | 201 |
| POST | `/api/admin/quality/classification/sampling/query` | 201 |
| POST | `/api/admin/quality/classification/sampling/annotations` | 201 |
| GET | `/api/admin/quality/classification/reports/:jobId` | 200 |
| GET | `/api/system-settings/rss-diagnostics/overview` | 200 |
| GET | `/api/system-settings/rss-diagnostics/chain` | 200 |
| GET | `/api/system-settings/rss-diagnostics/sources` | 200 |
| POST | `/api/system-settings/rss-diagnostics/backfill-source-id` | 201 |
| GET | `/api/system-settings/rss-translation/metrics` | 200 |

- **不迁移**：`POST /api/admin/quality/classification/reports` 会向 BullMQ `CLASSIFICATION_QUALITY_QUEUE` 投递异步任务，遵守队列红线整条留在 NestJS；其余未列出的方法与更长路径（如 `reports/:jobId/results`、`reviews/queue/detail`）也继续回落 NestJS，Go 不返回自己的 404。
- **分类质量**：`summary` 先读 Redis `classificationQuality:settings:<orgId>`，未命中读 MySQL `SystemSetting` 的 `classification_quality_settings:<orgId>`，再回退默认值（`lowConfidenceThreshold` 0.4 等 9 项）；`window` 只接受 `1h`/`24h`/`7d`（默认 `24h`，非法 400 `window must be one of the following values: 1h, 24h, 7d`），桶宽 5/60/360 分钟；响应含 10 桶 `confidenceHistogram`、按桶对齐的 `confidenceTrend`、前 10 `lowConfidenceSources`、`tasklogs`（`queue=news_pipeline&stage=classify&status=completed` 最多 20000 条）的 P50/P95/P99、`news_events/category_gate` 的 reject/penalized/accepted 与比率、前 30 `sourceCategoryBreakdown`（组织级 `news_event_source_policy:<orgId>` 判定 `authoritative`/`blog`/`unknown`）与阈值告警；告警以 Redis NX 键 `quality:classification:alert:notify:<orgId>:<window>:<signature>`（TTL 900 秒）节流，向本组织持有 `settings.manage` 的活跃成员写 `Notification`。`sampling/query` 按 `confidenceBand|method` 分层（`<0.4` low、`<0.75` medium、其余 high）随机取样并落库 `classificationsamples`（180 天 `expiresAt`）；`sampling/annotations` 只对样本内条目 upsert `classificationannotations`（365 天）并实时返回混淆矩阵与 `problemPathPairs`；`reports/:jobId` 不存在或 `jobId` 非法一律 200 `null`。
- **RSS 链路诊断**：`windowDays` 收口 1..30（默认 7）、`lookbackHours` 收口 1..720（默认 24）；`ObservabilitySnapshot` 的 `scope=rss_diagnostics`、`variantKey=windowDays:<n>:lookbackHours:<n>`、TTL 60 秒、共享锁键 `observability-snapshot:<orgId>:rss_diagnostics:<variantKey>`；筛选 `config.seed.mode === "rss"` 的 `NewsSource`，结合 Mongo `processeditems` 与 MySQL `Article`/`PipelineJob`/`CrawlTask`(`displayName LIKE 'NewsSource:%'`)/`CrawlResult` 计算可见性、缺失率、问题标签与 `recommendations`。`backfill-source-id` 的 `dryRun` 默认 `true`（仅显式 `false` 写库）、`limit` 收口 1..5000（默认 500），按 `PipelineJob.sourceId` → `RawItem.payload.metadata.sourceId` → `...pipelineJobId` → `...crawlResultId` → `ItemMeta.externalId`（`crawlResult:`/`crawl:` 前缀反查 `CrawlTask.config`）多跳解析，只回填属于本组织 `NewsSource` 的值，写库后失效 `rss_diagnostics` 快照。
- **RSS 翻译指标**：`provider` 非空时只允许 `deeplx`/`llm`（否则 400 `provider must be one of: deeplx, llm`）；`from`/`to` 为 `YYYY-MM-DD`（非法 400 `Invalid date '<raw>', expected YYYY-MM-DD`，`from > to` 400 `'from' must be earlier than or equal to 'to'`，跨度 > 180 天 400 `Date range exceeds 180 days`），默认最近 14 天，返回 `{ from, to, rows, summary }`。
- **同批修复的 4 个缺陷（Nest 与 Go 两侧一致）**：① 非 24 位十六进制 ObjectId 直接进 Mongoose `_id` 查询触发 CastError（500）——`submitReviewDecision` 返回 404 `Review item not found`、`batchReviewDecision` 过滤无效 id、`submitAnnotations` 返回 404 `Sample not found`、`getReportJob` 返回 `null`；② `status=corrected` 传 `"///"` 经 `normalizePath` 归一化为空后落库成 `correctedCategoryPath: null`——改为 400 `correctedCategoryPath is required when status=corrected`；③ `getAlertRecipientUserIds` 的 `membership.findMany` 漏判 `Membership.isActive`，已停用成员仍收到阈值告警——补 `isActive: true`；④ `mtk_` 机器令牌执行复核裁决时把 `"machine:<id>"` 写入 `AuditLog.actorId`（User 外键）——写审计时归一化为 `null`，Mongo `reviewerId` 仍保留原 `actorId`。
- **强类型与注释**：Go 侧 `apps/api-go/internal/classificationrssops` 全部请求 DTO、响应模型、8 个 Mongo 集合文档、MySQL 行扫描、快照载荷与审计/通知载荷均为具名 `struct`（精确 `bson`/`json` tag），枚举为具名字符串类型（`QualityWindow`、`ReviewDecisionStatus`、`ConfidenceBand`、`ClassifiedSourceType`、`RssSourceVisibility`）；`any`/`interface{}`/`map[string]any`/`[]any` 为零（MySQL 语句固定 arity，id 列表用 `JSON_CONTAINS` 匹配）；新增与修改的 `.go`/`.ts` 注释全部为英文。
- 回滚只把 `API_GO_CLASSIFICATION_RSS_OPS_MODE` 改回 `legacy`：legacy 不注册 handler、不追加任何路由规则、不额外打开 Mongo 连接。不打开 canary，不改生产入口（生产 Web 仍指向 NestJS），不启用 shadow，不改前端，不改其他 `API_GO_*` 默认值。细节与验收清单见 `docs/refactor/go-classification-rss-ops.md`。SEC-01 的真实登录态未在本批验证。

## 13. 设置中心与来源策略 / 证据复核队列 / 采集任务 GraphQL 读（Go）

新增开关 `API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE`（空串/`legacy`/`go`，默认
`legacy`，非法值启动失败）。只有 `API_GO_GRAPHQL_READ_MODE=go` 且本开关 `go`
时才登记下列 20 个只读 root（Go 包 `internal/graphqlread/settingscrawl`）：

- 设置与来源策略 16 个：`rateLimitSettings`（`settings.manage` + 系统管理员；
  `rate_limit_login`/`rate_limit_crawl_create`/`rate_limit_rbac_write`）、
  `entityImpactGraphSettings`（`dashboards.read`）、`knowledgeGraphSettings`
  （`dashboards.read`；缺记录时 upsert `enabled: true, ingestionEnabled: true`
  引导值）、`newsEventSettings`（`dashboards.read`）、`newsEventSourcePolicy`
  （`settings.manage` + 系统管理员；有效名单 + `categoryAuthority` +
  `activeRevision` + `overrides` + 冲突 `warnings` + 最新 30 条 `revisions`）、
  `newsEventSourcePolicyPresets`（`settings.manage` + 系统管理员）、
  `newsEventSourcePolicyRevisionDiff(baseRevision, targetRevision)`
  （`settings.manage` + 系统管理员；找不到 revision 抛 400
  `Revision <N> not found`，无 `appCode`）、`newsClassificationSettings`、
  `classificationQualitySettings`、`newsDedupeSettings`、
  `newsIndicatorSettings`（`dashboards.read`）、`authCacheSettings`、
  `crawlClientSettings`（`requestTimeoutMs` 镜像 `requestTimeoutNormalMs`）、
  `auditLogRetention`、`newsExtractionSettings`、`newsPromptConfig`
  （缺省用 `DEFAULT_NEWS_PROMPT_CONFIG`）。
- 来源策略同步状态：`newsEventSourcePolicySyncStatus`（`items.read`；比较 DB 与
  Redis 的 `updatedAt`，返回 `degraded` / `policyCacheStale` / `presetCacheStale` /
  `warningCodes`（字典序）/ `forceAuthoritativeMode` / `forceMinAuthoritativeSources`）。
- 知识图谱证据复核队列：`knowledgeGraphEvidenceReviewQueue(limit, maxConfidence,
  onlyUnreviewed)`（`settings.manage` **或** `knowledgegraph.review`，`any` 模式；
  设置 `enabled = false` 返回 `[]`；`take = min(500, max(50, clamp(limit,1,200)*4))`；
  内存过滤并在 `limit` 处 break）。
- 采集任务：`crawlTasks(first, after, search, status)`（`crawl.read`；
  `take = min(first,50)`，`createdAt desc, id desc` 游标分页）与
  `crawlTask(id, resultLimit, resultSearch)`（`crawl.read`；找不到抛 404
  `crawl task not found`）。复用 `internal/crawlreadtelemetry` 的结果组装、Mongo
  内容关联、媒体签名 URL 与运行摘要读取逻辑。

未迁：`crawlMetadata`（抓外网）、`alertRules`（可能投递 BullMQ 任务）与全部
GraphQL mutation。同批修 3 个缺陷（Nest 与 Go 两侧）：`assertAdmin` 补
`orgId` 与 `isSystem`；`crawlTasks` 失效/跨组织 `after` 游标返回空页而不是
Prisma `P2025` 500；证据复核队列的 `edge`/`fromEntity`/`toEntity`/`article`
关联补 `orgId` 约束。回滚只把 `API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` 改回
`legacy`；不改表、不改 SDL、不改 Web 入口、不改其他开关默认值。

## 14. 采集 Frontier 运行监控与取消（Go）

新增开关 `API_GO_CRAWL_FRONTIER_RUNS_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败，错误文本含变量名）。`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`（`appendAuthRequirements`），**不要求 `MONGO_URI`**，不启用 shadow，不启动采集 worker，不入队，不请求 crawl4ai。`go` 时只接管 11 条精确方法规则：

| 方法 | 路径 | 权限 | 成功码 |
| --- | --- | --- | --- |
| GET | `/api/admin/crawl-frontier/runs` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/runs/:id` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/runs/:id/workflow-run` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/runs/:id/workflow-candidates` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/runs/:id/workflow-candidates/:candidateId` | `crawl.read` | 200 |
| POST | `/api/admin/crawl-frontier/runs/cancel` | `crawl.write` | 201 |
| POST | `/api/admin/crawl-frontier/runs/:id/cancel` | `crawl.write` | 201 |
| GET | `/api/admin/crawl-frontier/nodes/:id` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/workflow-runs/:runId` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/workflow-runs/:runId/candidates` | `crawl.read` | 200 |
| GET | `/api/admin/crawl-frontier/workflow-runs/:runId/candidates/:candidateId/explanation` | `crawl.read` | 200 |

- **不迁移**：`POST /runs`（createRun 入队并调用 crawl4ai）、`POST /nodes/retry`、`POST /nodes/:id/retry`（BullMQ）、`POST /workflow-runs/:runId/replay`、`POST /workflows/:id/trial-run`，以及 `/profiles/**`、`/workflows/**`、`/workflow-versions/**`、`/news-sources/**`（属于各自的开关）；上表路径的其他方法、带尾斜杠与更长路径也回落 NestJS，Go 不返回自己的 404。`GET /runs/cancel` 按 `runs/:id` 处理（`id="cancel"`）返回与 Nest 相同的 404。
- **契约**：人类身份走 JWT 验签 + Redis 撤销名单 + membership 重推导；`mtk_` 机器令牌走 `MachineAccessToken` SHA-256 查表并更新 `lastUsedAt`。失败顺序 401 → 403 → 400 → service。响应按 Prisma 列顺序输出，时间字段为毫秒 UTC ISO 或 `null`；`metadata` 只在是 JSON 对象时透传；`summary`/`repairSummary`/`trace` 逐行移植，数值走 JS `Number()` 语义，计数对象保持键的首次出现顺序；`undefined` 键（`metrics`、候选可空字段、trace 可空字段、`llmLogFilters.repair`）省略而 `0`/`""`/`false` 保留。
- **同批修复的缺陷 F1（Nest 与 Go 两侧一致）**：原 `cancelRunRecords` 无条件把终态运行改写为 `canceled` 并覆盖 `finishedAt`，两条 `updateMany` 并行无事务无行锁，并发取消会重复追加 `frontier_run_canceled`，批量取消还会把已完成运行计入 `canceledIds`。修复后：单事务第一条语句 `SELECT … WHERE orgId=? AND id IN (…) AND status NOT IN ('completed','canceled') ORDER BY id ASC FOR UPDATE`，随后更新 run 与 pending/queued/running 节点，提交后按 id 升序追加事件并 `markRunStatus`；终态取消是幂等无操作，`POST /runs/:id/cancel` 无论是否转换都返回完整详情 201，`POST /runs/cancel` 只返回实际转换的 id（升序）。`failed` 仍可取消。
- **强类型与注释**：`apps/api-go/internal/crawlfrontierruns` 的请求 DTO、响应模型、MySQL 行扫描、事件 details 均为具名 `struct`（精确 `json` tag），无 schema 的 JSON 列用本包具名 `RawJSON` 透传并提供 `IsObject()/IsArray()`；`any`/`interface{}`/`map[string]any`/`map[string]interface{}`/`[]any` 为零（id 集合用 `JSON_CONTAINS` 保持固定 arity）；新增与修改的 `.go`/`.ts` 注释全部为英文。`crawlprofile` 只新增 `export.go`（`NormalizeConfigJSON`），画像配置规范化仍是唯一实现。
- 回滚只把 `API_GO_CRAWL_FRONTIER_RUNS_MODE` 改回 `legacy`。细节与验收清单见 `docs/refactor/go-crawl-frontier-runs.md`；F1 与两条只登记项见 `docs/refactor/bug-ledger.md`。

## 15. 基础设施连接与采集运行凭据（Go）

新增开关 `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（空串/`legacy`/`go`，默认
`legacy`，非法值启动失败）。`go` 时只接管 7 条精确 METHOD+path（Go 包
`internal/infrastructuresettings`，路由键
`/api/system-settings#infrastructure`）：

- 向量服务配置：`GET`/`PUT`/`DELETE /api/system-settings/vector-service`
  （`settings.manage`；PUT/DELETE 另需平台管理员）。读写全局 `SystemSetting`
  key `vector_service`（`isPublic=false`）与 Redis `vector_service:settings`
  （30 秒 `{exists,value}` 信封）。`source=env|db`、`tokenSource=stored|env|none`；
  不返回 token/密文/指纹。token 四态：absent 保留锁内 DB 现值、`null`/空串/空白
  存 null 并允许 env 回退、非空 trim 后加密。baseUrl 按 Node WHATWG URL 规范化
  （http/https，端口 [0,65535]，最后删一个尾部 `/`）。
- 存储配置：`GET`/`PATCH /api/admin/settings/storage`（`settings.manage`；PATCH
  另需平台管理员）。九个全局 key `crawl_image_storage`（isPublic=true）、
  `storage_s3_access_key_id`（false）、`storage_s3_secret_access_key`（false）、
  `storage_s3_region`/`storage_s3_bucket`/`storage_s3_endpoint`/
  `storage_s3_public_base_url`/`storage_s3_force_path_style`/
  `storage_s3_presigned_url_ttl_seconds`（均 true）；Redis `storage:settings`
  （60 秒直接对象，缺失键省略、JSON null 保留）。同一 PATCH 全部有效字段同事务；
  `endpoint`/`forcePathStyle`/`presignedUrlTtlSeconds` 的清空写 JSON 字面量 null
  （`JSON_TYPE(value)="NULL"` 且 `value IS NULL` 为 false）。GET 的 `accessKeyId`
  保持完整展示，`hasSecretAccessKey`/`secretDecryptionFailed` 两个标志按既有语义。
- 新闻源运行凭据：`GET`/`PUT /api/system-settings/news-source-runtime-secrets`
  （`settings.manage`；PUT 另需平台管理员）。全局 key
  `news_source_runtime_secrets`（`isPublic=false`），无 Redis 配置缓存。
  条目指纹是 SHA-256(UTF-8) hex 前 16 位；strict 解析保留 409
  `NEWS_SOURCE_RUNTIME_SECRETS_INVALID` 与分支 detail，损坏 sourceId/key 仍走
  业务 400。

未迁：`GET /api/system-settings/vector-service/diagnostics`（Nest 进程内向量
计数）与 `POST /api/admin/settings/storage/test`（真实 S3 调用），以及全部向量
检索/回填、S3 对象操作、新闻源实际抓取消费链路。机器令牌三条 GET 可读、四条写
403。两把全局锁名 `infra-settings:vector-service:v1`、
`infra-settings:news-source-runtime-secrets:v1`。回滚只把本变量改回 `legacy`。

## 16. 模型接入设置与 OpenAI 密钥分发（Go · 10 条）

开关 `API_GO_MODEL_ACCESS_SETTINGS_MODE`（空串/`legacy`/`go`，默认 `legacy`，
非法值启动失败）。`go` 时由 `internal/modelaccesssettings` 独立验签并接管 10 条
**精确路径**：

| 方法 | 路径 | 认证 | 权限 | 平台门禁 | 成功码 |
|---|---|---|---|---|---|
| GET | `/api/system-settings/model-service` | JWT/`mtk_` | `settings.manage` | 否 | 200 |
| PUT | `/api/system-settings/model-service` | JWT/`mtk_` | `settings.manage` | 是 | 200 |
| DELETE | `/api/system-settings/model-service` | JWT/`mtk_` | `settings.manage` | 是 | 200 |
| GET | `/api/system-settings/openai-keys` | JWT/`mtk_` | `settings.manage` | 否 | 200 |
| PUT | `/api/system-settings/openai-keys` | JWT/`mtk_` | `settings.manage` | 是 | 200 |
| POST | `/api/system-settings/openai-keys` | JWT/`mtk_` | `settings.manage` | 是 | 201 |
| DELETE | `/api/system-settings/openai-keys/key/:fingerprint` | JWT/`mtk_` | `settings.manage` | 是 | 200 |
| DELETE | `/api/system-settings/openai-keys` | JWT/`mtk_` | `settings.manage` | 是 | 200 |
| GET | `/api/internal/litellm/openai-keys` | `LITELLM_CONFIG_INTERNAL_TOKEN` | 不用 JWT/RBAC | 否 | 200 |
| POST | `/api/internal/litellm/openai-keys/applied` | `LITELLM_CONFIG_INTERNAL_TOKEN` | 不用 JWT/RBAC | 否 | 201 |

契约要点：

- 失败顺序：认证 → `settings.manage` → DTO（有 body 时）→ 平台门禁（service 内，
  仅六条管理写）→ 业务校验/写库。平台管理员仍必须有 `settings.manage`。
- 权限载荷复用既有安全形状：`code=INSUFFICIENT_PERMISSIONS`、
  `detail="Requires any permission: settings.manage"`、`permissionsMode="any"`、
  不带 `missingPermissions`；平台门禁为 403 `Platform admin access required`。
- 内部端点失败顺序：未配置 403 `LITELLM_CONFIG_INTERNAL_TOKEN is not configured`
  → 无可提取 bearer 401 `Missing bearer token` → 不匹配 401 `Invalid bearer token`
  （常量时间比较；header 解析严格对齐 `extractBearerToken`）。内部 token 缺失
  不阻止启动。
- 公共响应字段全集：模型 `source/enabled/baseUrl/timeoutMs/maxRetries/hasToken/
  tokenSource`；密钥 `source/keysCount/hasKeys/keyFingerprints/
  internalTokenConfigured/appliedAt/appliedSource/appliedKeyFingerprints/
  restartRequired`；`keyFingerprints` 与 `appliedKeyFingerprints` 空值序列化为
  `[]`，`appliedAt`/`appliedSource` 空值序列化为 `null`。
- 不返回任何完整/部分明文 key、加密包或 token 指纹（模型）。
- SystemSetting key：`model_service`、`openai_keys`、`litellm_openai_keys_applied`
  （+ 只读 `system_security`）；Redis：`model_service:settings`、
  `openai_keys:settings`、`openai_keys:applied_status`（30 秒）与只读
  `system_security:settings`（60 秒）。
- 两把全局 MySQL 会话锁：`model-access:model-service:v1`、
  `model-access:openai-keys:v1`（Nest 与 Go 同名字面量）；锁内重读权威行，
  锁失败 503（`message=Internal server error`、`error=Service Unavailable`）。
- 同批修 3 个缺陷（Nest 与 Go 两侧）：全局模型/密钥写缺平台管理员门禁（MA1）、
  密钥追加与按指纹删除的缓存读改写与缺互斥（MA2）、模型 PUT 省略 token 时写回
  旧缓存 token（MA3）。

未迁：`/api/internal/litellm/proxy-load-balancing`、
`/api/system-settings/llm-gateways`、`/api/system-settings/*` 其余全部路径，以及
模型预测/异常检测/embedding/rerank/moderation 等实际推理。回滚只把
`API_GO_MODEL_ACCESS_SETTINGS_MODE` 改回 `legacy`；不改表、不改 controller/DTO、
不改 Web 入口与其他开关默认值。

## 17. 平台治理设置 16 条 HTTP（Go）

新增开关 `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE`（空串/`legacy`/`go`，默认
`legacy`，非法值启动失败，错误文本 `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE must be
one of legacy|go`）。`go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、
`MONGO_URI`，并注册 16 条精确路由（handler 键
`/api/system-settings#platform-governance`，与运行时的 `/api/system-settings` 不同键）：

- `GET|PUT /api/system-settings/security`
- `GET|PUT|DELETE /api/system-settings/assistant-quota`
- `GET|PUT|DELETE /api/system-settings/assistant-safety`
- `GET /api/system-settings/assistant-safety/metrics`
- `GET|PUT|DELETE /api/system-settings/task-logs`
- `GET|PUT|DELETE /api/system-settings/llm-request-logs`
- `POST /api/system-settings/llm-request-logs/metadata-policy/reset`（201）

全部要求重推导的 `settings.manage`；其中 9 条写路由另外要求 handler 内平台管理员
（机器令牌永不满足）。orgId 一律取自令牌/会话，`assistant-quota` 的用量聚合与
`assistant-safety/metrics` 的 `$match` 都带 `orgId`，防止跨租户读出。

**仍留在 NestJS 的路径**（两条开关都为 `go` 时也回落 `/api/` 代理）：

- `GET /api/system-settings/assistant-safety/diagnostics`（实际请求 LiteLLM）
- `GET /api/system-settings/email`
- `GET /api/system-settings/archive-preparation`
- `GET /api/system-settings/realtime-signals`
- `GET /api/system-settings/situation-monitor`
- `GET /api/system-settings/vector-service`
- 上述 16 条路径的未列出方法（如 `POST /api/system-settings/security`）
- 带尾斜杠或多一段的路径（如 `/api/system-settings/task-logs/x`）

回滚只把 `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE` 改回 `legacy`。说明与 smoke 证据
见 `docs/refactor/go-platform-governance-settings.md`。

## 18. 数据运行设置与归档状态（Go）

新增开关 `API_GO_DATA_RUNTIME_SETTINGS_MODE`（空串/`legacy`/`go`，默认 `legacy`，
非法值启动失败，错误原句
`API_GO_DATA_RUNTIME_SETTINGS_MODE must be one of legacy|go`）。`go` 时只接管 9 条
精确 METHOD+path（Go 包 `internal/dataruntimesettings`，路由键
`/api/system-settings#data-runtime`）：

- 实时信号设置：`GET`/`PUT`/`DELETE /api/system-settings/realtime-signals`
  （`settings.manage`；PUT/DELETE 另需平台管理员，本批补齐 DS1）。读写全局
  `SystemSetting` key `realtime_signals_settings`（description
  `Realtime signals settings (source toggles, thresholds, and API credentials).`，
  不写 isPublic/updatedById）与派生 key `realtime_signals_acled_auth_state`；Redis
  `realtime-signals:settings`（30 秒 `{exists,value}` 信封，值缺失时省略 value）与
  `realtime-signals:acled-auth-state`（30 秒信封，仅失效/删除）。PUT 是部分合并：
  保留 `openskyEnabled ?? adsbEnabled`、`openskyIntervalSec ?? adsbIntervalSec`、
  `openskyBaseUrl ?? adsbBaseUrl`、`aisRelayBaseUrl ?? relayBaseUrl`、
  `aisRelaySharedSecret ?? relaySharedSecret` 的 nullish 语义；数值 `null` 变
  `Number(null)=0` 再 clamp 到下限；missing 的密钥保持原密文原字节；URL 按 WHATWG
  等价规范化（http/https，含默认端口剥离与结尾斜杠删除）并以
  `<field> must be a valid http(s) URL` 拒绝非法值。写出的 JSON 为 46 键：别名
  `relayBaseUrl`/`relaySharedSecret` 按 `JSON.stringify(undefined)` 省略，
  `acledAccessToken` 恒为 `null`。响应保留全部规范字段与 has/source；四个跨字段约束
  原句与顺序不变。ACLED 固定关闭：`acledApiEnabled=false`、
  `acledApiDisabledReason=Open myACLED does not include API access.`、
  `hasAcledAccessToken=false`、`acledAccessTokenSource=none`、
  `acledAccessTokenStatus=missing`，不可达状态字段省略（历史 token 不报告 ready）。
  审计 `resource=system_settings`、`action=realtime_signals_update`，metadata
  `{ok:true,updatedFields,secretsUpdated}`，其中 `updatedFields` 是 DTO 的 47 项
  声明序常量数组（ES2022 class fields 使 `Object.keys(input)` 与请求体无关），
  `secretsUpdated` 按 `!== undefined` 判断且不含任何 secret；重置为
  `realtime_signals_reset` + `{ok:true}`。
- 归档准备设置：`GET`/`PUT`/`DELETE /api/system-settings/archive-preparation`
  （`settings.manage`；PUT/DELETE 另需平台管理员，本批补齐 DS1）。全局 key
  `archive_preparation_settings`（description
  `Archive background preparation settings (batch sizes and embedding/rerank concurrency).`，
  `isPublic=false`，`updatedById` 为平台管理员真实 User.id）；Redis
  `archive_preparation:settings`（30 秒，**原始设置或 JSON null，无信封**）。四字段
  `jobBatchSize`/`embeddingBatchSize`（1..100，默认 20）、
  `embeddingMaxConcurrency`/`rerankMaxConcurrency`（1..8，默认 1）；PUT 是完整四字段
  替换（本批不加锁），DTO 带 `@Type(() => Number)`；响应
  `{source:"default"|"db",...}`，`source` 按存储值的 JavaScript truthiness 判断。
  审计 `archive_preparation_update`（metadata 为四字段）与
  `archive_preparation_reset`（`{ok:true}`）。
- 归档准备状态：`GET /api/admin/archive-preparation/status`（`settings.manage`，无平台
  门禁，无 query/body DTO）。Redis zset `archive:preparation:status:index`，成员
  `archive:preparation:status:<scope>:<orgId>:<scopeValue>`（scope=digest|calendar），
  单记录 TTL 3600 秒，writer 索引上限 200 条。读取 ZCARD → ZRANGE 0..total-1 →
  MGET → 跳过过期 null → orgId 缺失按旧 key 第 5 段回退 → 只保留当前 orgId →
  reverse；reader 不写入/不裁剪/不续租/不删除。响应
  `{updatedAt,pending,counts:{waiting,active,completed,failed,delayed},recentStatuses}`，
  counts 覆盖整份快照、recentStatuses 最多 10 条且不含 orgId/Redis key/traceId；
  计数 `QUEUED`→waiting、`PROCESSING|PARTIAL`→active、`READY`→completed、
  `FAILED`→failed、`IDLE`/未知不加计数、`delayed` 恒 0；`errorMessage` 仅公开读取
  输出脱敏（`adminlogs.RedactSensitiveFields`），Redis 原文不变。
- Nominatim 身份设置：`GET`/`PUT /api/system-settings/geo/nominatim`
  （`settings.manage`；PUT 另需平台管理员，本批补齐 DS1）。全局 key
  `geo_nominatim_identity`（create 写 description
  `Nominatim geocoding identity settings (User-Agent / email)`，update 保留既有
  description/isPublic）；无 Redis 配置缓存，保留 NestJS 每进程 30,000ms 缓存
  （Go 侧为线程安全实现）。DTO `userAgent`（`@MinLength(1)`）与 `email`
  （`@IsEmail`）均可选可空，`null` 清 override、missing 保留；响应
  `{userAgent,email,effectiveUserAgent,effectiveEmail}`，env 缺省
  `GEO_NOMINATIM_USER_AGENT=modular-api`、`GEO_NOMINATIM_EMAIL` 可选。审计
  `geo_nominatim_settings_update`（metadata 为 overrides，非 effective），保持
  fire-and-forget 且失败不改变 200。

未迁：`POST /api/system-settings/geo/nominatim/test`、`POST /api/geo/geocode`
（真实地理编码）与 `GEO_NOMINATIM_BASE_URL`，实时信号采集器与 ACLED OAuth 刷新，
归档分类/embedding/rerank 与 BullMQ producer/worker，`archiveDigest` /
`archiveCalendar` / `archiveDetail`，以及全部 GraphQL。机器令牌四条 GET 可读、五条写
403。两把全局锁名 `data-runtime-settings:realtime:v1`、
`data-runtime-settings:nominatim:v1`（锁未取得 409，连接类故障 503）。回滚只把本变量
改回 `legacy`。细节见 `docs/refactor/go-data-runtime-settings.md`。

## 19. 态势监控信号读取与反馈 7 条 HTTP（Go）

新增开关 `API_GO_SITUATION_MONITOR_SIGNALS_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败，错误文本含变量名）。`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（feedback 写 Mongo，refresh-runs 读 MySQL，信号状态读 Redis，settings 读 SystemSetting + Redis 信封）。`go` 时只接管 7 条路由规则（6 条精确 + 1 条「恰好一段」动态路径，另加同路径 `OPTIONS`），处理器注册键 `SituationSignalsKey = "/api/situation-monitor#signals"`，与自定义监控的 `SituationMonitorsKey` 不同：

| 方法 | 精确路径 | 权限 | 成功码 |
| --- | --- | --- | --- |
| GET | `/api/situation-monitor/catalog` | `items.read` | 200 |
| POST | `/api/situation-monitor/feedback` | `items.write` | 201 |
| GET | `/api/situation-monitor/refresh-runs/:refreshId` | `items.read` | 200 / 404 |
| GET | `/api/situation-monitor/telegram-feed` | `items.read` | 200 |
| GET | `/api/situation-monitor/oref-alerts` | `items.read` | 200 |
| GET | `/api/situation-monitor/oref-history` | `items.read` | 200 |
| GET | `/api/situation-monitor/live-hls-proxy-config` | `items.read` | 200 |

- **不迁移**：`GET /api/situation-monitor/insights`（重分析域）、`POST /api/situation-monitor/refresh`（触发实网抓取与队列）、`GET/POST/PATCH/DELETE /api/situation-monitor/monitors**`（属于 `API_GO_SITUATION_MONITORS_MODE`）、`GET /api/system-settings/realtime-signals/runtime`；上表路径的其他方法、带尾斜杠与更长路径也继续回落 NestJS（Go 不返回自己的 404）。
- **身份与权限**：人类身份 = HS256 验签 + Redis 撤销名单（fail-closed）+ MySQL membership/权限重推导，JWT `permissions` claim 不参与；`mtk_` 机器令牌走 `MachineAccessToken.tokenHash` 的 SHA-256 查表（未撤销、未过期、`Org.isActive`，更新 `lastUsedAt`），权限与 orgId 来自令牌行。失败顺序 401 → 403 → 400（仅 feedback 的 DTO / 空白 `signalId`）→ 404。
- **响应契约**：`catalog` 返回 `narratives`（16 条，`name = formatIdTitle(id)`）、`correlations`（20 条）、`refreshReadiness`（`activeSourceCount` = 本组织 `isActive` 的 `NewsSource` 计数，`backendRefreshTargets` 四布尔来自 `situation_monitor_settings` + env 回退）。`telegram-feed` 返回缓存态（`source/scope/earlySignal/configured/enabled/channelSet/count/updatedAt/items`，有错误时追加 `error`）并追加 `monitorMatches`；`oref-alerts` / `oref-history` 分别以 `alerts` / `history` 为键，`timestamp` 取缓存 `lastPollAt`（无缓存时为当前时间，非确定），计数器来自 history 缓存。`live-hls-proxy-config` 三分支：无/非法 channel 与合法但未配置 → `{channel, configured:false, upstreamUrl:null, referer:null, allowedHosts:[]}`；合法且配置 → 回显 `upstreamUrl`/`referer`，`allowedHosts` = 配置主机（去重、保序）+ 上游主机名。`refresh-runs/:refreshId` 返回 `{refreshId, requestedAt, taskWindowStart, status, crawl, progress:{crawlTasks:{pending,queued,running,completed,failed,paused}, analysisTasks:{pending,queued,running,completed,failed,delayed}}, signals, cache, warnings, terminal}`，`signals`/`cache` 缺失时省略键。
- **缓存键**：`situation-monitor:signals:telegram:state:v1`（24h，失配时 Go 回写清空态）、`situation-monitor:signals:oref:alerts:v1`、`situation-monitor:signals:oref:history:v1`（Go 只读）、`situation-monitor:refresh-run:<refreshId>`（900s，Go 只回写 `terminal` 一位，键与 TTL 不变）、`situation-monitor:insights:learning-rev:v1:<orgId>`（90 天，INCR 仅首次设 TTL）、`situation_monitor:settings`（30s，信封 `{exists, value?}`）。Mongo 集合 `situationsignalfeedbacks` 与 `situationsignallearningstates`。
- **监控匹配**：`monitorMatches` 的候选来自 telegram 缓存项与 OREF alerts/history 条目；监控行按 `orgId AND userId` 读取（先跑 legacy 迁移，只保留 `enabled`）。无监控带 `queryEmbeddingVector` 时不发模型调用；`Embed`/`Rerank` 失败一律回退词法规则并按 `0.68/0.55/0.82` 阈值与 `finalScore = clamp01(base + semantic*0.15 + rerank*0.2)` 计算。`link`/`title` 恒存在（falsy → `""`），其余条件键在 falsy 时省略；排序为 `timestamp` 降序 → `score` 降序 → `monitorName` 升序（English collator）。
- **同批修复的 2 个缺陷（Nest 与 Go 两侧一致）**：① 空白 `signalId` 的 `POST /feedback` 原本抛裸 `Error` → 500，现为 400 `signalId is required`（DTO 不改，控制器不改）；② refresh-run 缓存记录缺 `activeSourceIds`/`warnings`/`crawl` 或 `taskWindowStart` 非法时读取 500，现为数组归一化 → `[]`、`crawl` → 六字段零值对象、非法时间 → 404，正常记录行为不变。`activeSourceIds` 为空时 12 个计数直接为 0（不做无过滤全量计数）。
- **强类型与注释**：`apps/api-go/internal/situationsignals` 的请求 DTO、响应模型、Redis 缓存文档、Mongo 文档、匹配结果与候选均为具名 `struct`（`json`/`bson` tag），无 schema 的透传 JSON 用具名 `rawJSON`（`IsObject`/`IsArray`），宽松字段用具名 `jsNumberish`/`trimmedString`/`jsStringList`，枚举为具名字符串类型；`any`/`interface{}`/`map[string]any`/`[]any` 为零（MySQL 不构造变长参数列表）。新增/修改的 `.go`/`.ts` 注释全部为英文。
- 回滚只把 `API_GO_SITUATION_MONITOR_SIGNALS_MODE` 改回 `legacy`。生产入口仍是 Web → NestJS；canary 保持关闭；不启用 shadow，不改前端，不改控制器，不改其他 `API_GO_*` 默认值。语义 / rerank 命中路径在 CI 未验证（无 LiteLLM，两侧同环境降级）。细节与验收清单见 `docs/refactor/go-situation-monitor-signals.md`。


## 20. 条目阅读与 RSS 检索辅助（Go）

新增开关 `API_GO_ITEMS_READING_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值启动失败，错误文本含变量名：
`API_GO_ITEMS_READING_MODE must be one of legacy|go`）。`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`
与 `MONGO_URI`，不启用 shadow，不启动采集/摄取/队列 worker，不重建索引。`go` 时接管 2 条精确 REST 路由
与 5 个只读 GraphQL root：

| # | 入口 | 权限 | 成功 | 缺失语义 |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/items`（精确） | `items.read` | 200 `{items,total,page,pageSize}` | 空列表 `items=[]`、`total=0` |
| 2 | `GET /api/items/:id`（恰好一段） | `items.read` | 200 `{itemMeta,rawItem,processed}` | 404 `Item not found` |
| 3 | GraphQL `item(id: String!)` | `items.read` | nullable `ItemModel` | `data.item = null`（不抛错） |
| 4 | GraphQL `itemFacets(search, filters)` | `items.read` | 四组非空列表 | 四组 `[]` |
| 5 | GraphQL `rssSources(windowDays, onlyWithItems)` | `items.read` | 列表 | `[]` |
| 6 | GraphQL `rssTranslationStatus(targetLanguage)` | `items.read` | 固定顺序 `deeplx`、`llm` | `available=false` + 固定 message |
| 7 | GraphQL `searchSuggestions(prefix, limit: Float)` | `items.read` | `{type,value,origin}` | 空前缀 `[]` |

- **五个 GraphQL root 只在 `API_GO_GRAPHQL_READ_MODE=go` 且本开关 `go` 时才在既有精确 `/graphql`
  执行器登记**；`API_GO_GRAPHQL_READ_MODE=legacy` 时即使本开关为 `go`，含这五个 root 的文档整包回 NestJS。
  两条 REST 路由只由本开关控制。
- **未迁**：GraphQL `items` root、`createItem`/`createItemFromCrawlResult`/`updateItem`/`translateRssItems`
  mutation、`POST /api/items`、CSV 导出、archive、索引重建、摄取与队列 worker。未列出的方法与更长路径
  回落 NestJS（Go 不返回自己的 405）。
- **同批修 3 个缺陷（Nest 与 Go 两侧一致）**：IR1 Mongo 关联读取与回填补租户绑定（REST processed 补
  `orgId`；REST raw 要求 `_id = mongoRef` 且 `itemMetaId` 配对；新增 request-scoped
  `scoped-items-reading.loader.ts`；回填聚合补 `orgId`；`ProcessedArticle.cleanedMarkdownRef` 反查补
  `orgId`）；IR2 分页偏移补安全边界（offset 必须是非负安全整数且 `<= 2147483647`，越界 400
  `Pagination offset is too large`，在搜索/缓存/分页调用前失败）；IR3 来源 fallback 不再绕过其他筛选
  （fallback 候选还要满足 regions/topics/sentiments/contentTypes/excludeDuplicates，内容筛选用同组织
  最新 completed 快照）。
- **读模型**：`ITEMS_READ_MODEL_ENABLED` 默认 false，与迁移开关解耦；开启时详情读取可能触发
  `itemreadmodels` 回填（现有派生数据写入，不扩展到摄取/排队/重建索引）；快照缺失仍 `$unset` 而不是写显式 null。
- **限流/APQ/深度/复杂度/响应缓存/字段权限沿用既有机制**；身份与 orgId 一律取自服务端认证与 MySQL 权限。
- 回滚只把 `API_GO_ITEMS_READING_MODE` 改回 `legacy`。细节与验收清单见
  `docs/refactor/go-items-reading.md`。
