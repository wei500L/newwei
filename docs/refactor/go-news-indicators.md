# 新闻指标关联分析（Go 接管说明）

> 本批：`API_GO_NEWS_INDICATORS_MODE`，默认 `legacy`。生产入口保持 Web → NestJS，canary 保持关闭。
> 事实源：`apps/api/src/modules/news-indicator/news-indicator.controller.ts`（全文）、`news-indicator-association.service.ts`（全文）、`news-indicator-math.ts`（全文）、`news-indicator-settings.service.ts` 的 `getSettings/loadSettings/getFallbackSettings/normalizeSettings`、`apps/api/src/graphql/resolvers/news-indicator.resolver.ts`（全文）、`apps/api/src/graphql/models/news-indicator.model.ts`（全文）、`packages/db/prisma/schema.prisma` 的 `NewsIndicatorAssociation`、`NewsIndicatorAssociationBacktestRun`、`EntitySentimentSnapshot`、`TopicSentimentSnapshot`、`EconomicDataItem`、`EconomicDataPoint`。

## 1. 开关与回滚

- 变量：`API_GO_NEWS_INDICATORS_MODE`。只接受空字符串、`legacy`、`go`；空串与 `legacy` 等价。**其他值让进程启动失败**，错误文本含变量名（`API_GO_NEWS_INDICATORS_MODE must be one of legacy|go`）。
- `go` 时要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`；**不要求 `MONGO_URI`**（本批不读 Mongo）。
- 回滚：**只把 `API_GO_NEWS_INDICATORS_MODE` 改回 `legacy`**——纯配置变更；legacy 时不注册 handler、不追加路由规则、不登记 GraphQL 只读 query。
- `infra/docker/.env.sample` 与 `infra/docker/docker-compose.yml` 的 pilot 默认值都是 `legacy`。不改任何已有 `API_GO_*` 的默认值；`API_GO_GRAPHQL_READ_MODE`、`API_GO_GRAPHQL_NEWS_EVENTS_MODE` 不受本批影响。
- **未启用 shadow。** 不打开 canary，不改生产 Web 的 API 地址。

## 2. 接管的 HTTP 路径（仅 `go` 时）

控制器前缀 `news-indicator`，全局前缀 `api`。路由规则在 `apps/api-go/internal/legacyproxy/news_indicator_routes.go`（`WithNewsIndicators`，:19）。只接管这 3 条：

| 路径 | 方法 | 权限 | 成功码 | 说明 |
|---|---|---|---|---|
| `/api/news-indicator/associations` | GET | `dashboards.read` | 200 | `limit` 缺省/非有限数 → 50，否则 `clamp(trunc(Number(limit)), 1, 200)`；`scopeType`/`featureMetric` trim+小写后合法才过滤，非法串当未设置（**不报 400**）；`scopeKey`/`indicatorSlug` trim 后非空才过滤（`indicatorSlug` 过滤关联的 `EconomicDataItem.slug`）；`lastEvaluatedAt desc, correlation desc` |
| `/api/news-indicator/associations/:id` | GET | `dashboards.read` | 200 | `backtestsLimit` 缺省/非有限数 → 10，否则 `clamp(trunc(Number(x)), 0, 100)`；`0` 时**不查询、响应不含 `backtests` 字段**；`>0` 时 `createdAt desc` 取最多 N 条；找不到或跨组织按 Nest `findFirst` 返回 `null`（200 空响应，**不改 404**） |
| `/api/news-indicator/refresh` | POST | `settings.manage` | 201 | 无 `@HttpCode`，成功码 201；响应 `{indicators, associationsUpserted, backtestsCreated}` |

响应结构复刻 Prisma 原始行：列表/详情包含完整 `indicatorItem` 对象；列表恒含 `backtests` 数组（取 1 条）；详情 `backtestsLimit=0` 时该键整段缺失。时间按 `Date.toISOString()` 等价格式（毫秒 UTC）。注册顺序：先精确的 `associations` 与 `refresh`，再恰好一段的 `associations/:id`（只匹配 GET）。预检 `OPTIONS` 由 Go 路由回答后回落 legacy。

## 3. 只读 GraphQL query（仅两个开关都是 `go` 时）

`API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_NEWS_INDICATORS_MODE=go` 时，读执行器登记两个 root（`internal/graphqlread/newsindicators/register.go`）：`newsIndicatorAssociations(...)` 与 `newsIndicatorAssociation(id, backtestsLimit)`，权限都是重推导的 `dashboards.read`。机器令牌在 GraphQL 入口不开放（与读执行器既有规则一致）。嵌套 `indicator` 复用 `economic.EconomicDataItemModel`（不重复 `RegisterType`）。

GraphQL 返回结构与 HTTP 不同，不混用：映射到 `NewsIndicatorAssociationModel`，`indicator` 的 `displayName` 为空时回退 `slug`；`latestBacktest` 取 `backtests[0] ?? null`；列表项不含 `backtests` 数组；详情 `backtestsLimit>0` 时含 `backtests` 数组。

## 4. 数学翻译（逐段对齐 `news-indicator-math.ts`）

`apps/api-go/internal/newsindicator/math.go`：`toUtcDayStartMs`、`normalCDF`、`approximatePValue`、`pearsonCorrelation`、`buildDailyEconomicValues`、`buildDailyReturns`、`computeBestLagCorrelation`、`runBacktest`。数值单测在 `math_test.go`。`refreshOrg` 侧：`analyzedEndAt` 是当天 UTC 00:00:00.000；`analyzedStartAt = analyzedEndAt - windowDays*86400000`；`holdoutDays = min(max(backtestHoldoutDays,0), max(0, windowDays - max(minSampleSize, backtestBaselineDays)))`；每个指标按 `|correlation|` 降序取前 `maxAssociationsPerIndicator` 条；`holdoutDays===0` 时回测状态 `failed`、`metrics` 为 `{triggers:0, evaluatedSignals:0, hits:0, hitRate:0, skipped:"holdout_days_zero"}`。设置读取：Redis `newsIndicator:settings:<orgId>` → MySQL `SystemSetting` 键 `news_indicator_association_settings:<orgId>` → `normalizeSettings` 归一化（默认值见 `settings.go`）。**不调用 AkShare，不在 refresh 里外网拉经济数据**，只读已有 `EconomicDataItem`/`EconomicDataPoint`。

## 5. 缺陷修复：回测事务与按组织会话锁（Nest 与 Go 两侧同修）

**缺陷（原 `news-indicator-association.service.ts` 第 349-376 行）**：

1. `$transaction` 只包了 `newsIndicatorAssociation.upsert`；旧回测 `deleteMany` 与新回测 `createMany` 在事务外裸跑；且 `deleteMany` 的 `where` 只有 `associationId`/`createdAt`，**没有 `orgId`**。
2. 整个 `refreshOrg` 没有按组织加锁：同一组织的两个并发刷新（或 HTTP 刷新与后台定时任务同时跑）会针对同一批 `(orgId, scopeType, scopeKey, scopeKeyType, featureMetric, indicatorItemId)` 各自 `createMany`，给同一次评估重复插入双份回测。

**修复**：

- 使用 MySQL 会话锁 `SELECT GET_LOCK(?, 10)`，锁名 `ni:<orgId>`（超 64 字符时 `ni:` + `sha256(orgId)` 前 60 位十六进制）。在专用连接上持有，整个 `refreshOrg` 完成后 `RELEASE_LOCK`；**不放 Prisma 事务**，与 situation-monitor 的用户锁模式一致，复用 `withMysqlSessionLock`。
- 每个 chunk 的 `upsert`、过期回测 `deleteMany`（`where` 补上 `orgId`）与新回测插入放在**同一个数据库事务**里。

| 侧 | 文件 | 关键位置 |
|---|---|---|
| Nest | `apps/api/src/modules/news-indicator/news-indicator-association.service.ts` | `refreshOrg` 会话锁包装 :131；`refreshOrgInner` :134；单事务块 :359；`deleteMany`（含 `orgId`）:373-378；`createMany` :380 |
| Nest | `apps/api/src/modules/news-indicator/news-indicator-org-lock.ts` | `newsIndicatorOrgLockName` :8；`withNewsIndicatorOrgLock` :19 |
| Nest | `apps/api/src/modules/situation-monitor/situation-monitor-user-lock.ts` | 抽出通用 `withMysqlSessionLock` :66（`withSituationMonitorUserLock` :60 改为调用它） |
| Go | `apps/api-go/internal/newsindicator/store.go` | `RefreshOrg` 会话锁 :280；`withOrgLock` :295；`orgLockName` :322；单事务 `writeChunk` :659；`DELETE ... WHERE orgId = ?` :691；`upsertAssociation` :720 |

## 6. 身份与鉴权

- 没有 `Authorization` 或不是 Bearer：401（`authhttp.WriteUnauthorized`）。
- token 以 `mtk_` 开头：SHA-256 十六进制查 `MachineAccessToken.tokenHash`，连 `Org.isActive`；查不到、已撤销、已过期、组织停用 → 401 `Invalid machine token`；查到更新 `lastUsedAt`。权限只解析令牌行 `permissions` JSON 里的字符串数组，`orgId` 只用令牌行的。
- 其他 token：`authhttp.Authenticate`（验签 + Redis 撤销名单 + membership 重推导）；**JWT 里的 permissions 不算**。
- 缺少方法要求的权限：403。HTTP 与 GraphQL 的 orgId 一律取自鉴权身份，body/query 里的 `orgId` 不参与查询条件。

## 7. 仍留在 NestJS

- GraphQL mutation `refreshNewsIndicatorAssociations`。
- 设置读写 `newsIndicatorSettings` / `updateNewsIndicatorSettings`（`newsIndicatorSettings` 是未迁移 root，含它的 GraphQL 文档整包回 NestJS）。
- 未列出的方法（PUT/DELETE 等）与更长路径（Go 不返回自己的 404）。

## 8. 验收与未验证项（诚实登记）

- 普通 CI：Go 编译 + 既有测试 + 本批路由测试（开关缺省时 3 条不在 Go 规则里；`go` 时在且 `:id` 恰好一段）、数学数值单测、新闻指标 GraphQL 注册/转发测试、Nest lint/typecheck。
- 真实栈 smoke：`.github/workflows/api-go-news-indicators-smoke.yml`（`workflow_dispatch` 或 PR 加 label `api-go-news-indicators-smoke`，`SCHEDULE_ENABLED` 保持 false）。只用隔离组织：legacy 下 201 与 3 条 HTTP + 2 个 GraphQL 经 Go 代理与 Nest 直连逐字段一致；`backtestsLimit=0/1`；非法 `scopeType`/`featureMetric` 返回 200 不报 400；切 `go`+`API_GO_GRAPHQL_READ_MODE=go` 后并发两个 refresh 都 201 且无 500；跨组织不可见；仅 `dashboards.read` 用户不能 refresh（403）；停 Nest 后 3 条 HTTP 与 2 个 query 仍成功、mutation 为 502。
- **未发生**：不调用 AkShare、不调用模型、不外网拉数；不打开 canary；不改前端/prisma schema/GraphQL SDL；不启动调度 worker；生产流量未切换。
- **未验证**：SEC-01 的真实登录态未在本批验证。
- 本机按任务约束未运行 `pnpm install`、`go test`、`go build`、`npm`、`docker`，未启动 API；验证全部在 GitHub Actions。
