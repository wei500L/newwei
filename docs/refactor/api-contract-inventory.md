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
- `GET/PUT /api/user-settings/ui/onboarding`（`modules/user-settings/user-ui-settings.controller.ts:110,116`）
- `GET /api/auth/admin/registration-applications`（`auth.controller.ts:393`）、`POST .../approve-org`（:454）、`POST .../reject-org`（:471）——handler 内部另有鉴权，但全局 Guard 先拦

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
**其余**：crawl-tasks 6 个（`crawl.controller.ts:26-77`，含 metadata 端点）· crawl-templates 4 个（`crawl-template.controller.ts`）· crawl4ai quality 2 + queue 4（`crawl4ai-*.controller.ts`）· crawl-media-assets 1 个 **@Public**（签名 URL，`crawl-media-asset.controller.ts:29`）· news-source dispatch 1 + ops 3（`modules/queue/news-source-*.controller.ts`）

### 1.6 news-events 聚类管理（6 个，`news-event-clustering-admin.controller.ts`）

GET .../clustering/readiness · overview · failures；POST failures/:groupId/vector-backfill · llm-backfill · ignore（均 settings.manage :20-75）

### 1.7 user-settings（12 个，`user-ui-settings.controller.ts`）

situation-monitor/war-map/spacetime-timeline/newsnow/rss-reader 各 GET+PUT（items.read :22-101）；**onboarding GET+PUT 无权限元数据（死路由）**（:110/116）

### 1.8 public-portal（4 个，全部 @Public + Cache-Control）

GET /api/public-portal/home(:16) · channels/:topic(:23) · stories/id/:id(:34) · stories/slug/:slug(:45)

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
| news-events | sourcePolicySyncStatus/newsEvents/newsEvent/Brief/ReferencedArticles | — | — | items.read |
| news-indicator | associations/:id | refresh | — | dashboards.read / settings.manage |
| notification | notifications/unreadCount | markRead/markAllRead | — | @AllowAuthenticated |
| org | myOrganizations | createOrg/updateOrg/setOrgActive | — | myOrganizations @AllowAuthenticated；其余 org.write |
| processed-item(-event/-duplicate) | processedItemById | — | — | items.read（后两者仅 @ResolveField） |
| rbac | roles/permissions/memberships | createRole/assignRole/updateRole | — | roles/users 读写 |
| sentiment | entitySentimentSeries/topicSentimentSeries | — | — | dashboards.read |
| settings | 16 个设置读取 | 16 个对应 update | — | 绝大多数 settings.manage；entityImpactGraph/knowledgeGraph/newsEvent/newsIndicator 的 GET 为 dashboards.read |
| topics | topicGroups/eventGroups | — | — | items.read |
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
| CORS | credentials:true，origin 白名单来自 CORS_ORIGIN |

## 7. 保护网快照与差分测试（已落地；验证状态标注于各项）

1. **REST 路由/鉴权契约快照**：✅ 远端 CI 已验证。`apps/api/tests/contract/openapi.snapshot.json`（OpenAPI 3.0 形，静态装饰器扫描生成——不启动 Nest 不连 DB；370 端点/294 路径；确定性输出）。**能力边界（info.completeness 如实登记）**：覆盖路由/方法/路径参数/鉴权元数据/默认状态码语义（POST=201 + 显式 @HttpCode 提取，`x-http-code-explicit`）；请求体只有 DTO `$ref` 名称（`x-unresolved-schema` 标注，无 components.schemas 字段模型）；响应与错误字段模型**未提取**（`x-response-schema: "unresolved"`，错误形状由本清单 §5 文字锚定）；@All 多方法 handler 跳过并计数。**它是 REST route/auth contract snapshot，不是完整 OpenAPI 契约**。CI 漂移门禁：`git diff --exit-code`。
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
6. `GET /api/metrics` 全局未按 org 过滤（SEC-03，bug-ledger 登记）
