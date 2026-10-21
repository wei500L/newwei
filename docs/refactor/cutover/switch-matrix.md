# API_GO_* 开关矩阵（切流准备）

本文件是「Go 切流准备」批次的开关矩阵交付物：为 `apps/api-go/internal/config/config.go` 中的**全部 134 个 `API_GO_*` 开关**逐行给出域、类别、Nest 是否同读、依赖、资源、切换顺序、回退方式、回退后已知问题、风险与阶段，并汇总 `config.go` 中全部跨开关硬校验。其中 4 个（C-1/C-5/C-7/C-9）由 `refactor/go-ops-entrypoints` 追加，见「ops-entrypoints」小节。

基线：`origin/main = dcbe563b917fde0927637121a91de2186d6177a4`（#136），分支 `docs/go-cutover-readiness`。所有 `path:line` 均来自该提交；PR 证据只写 PR 号与本文件核对到的正文条目。**本文件是静态阅读结论，不代表任何部署、流量或 CI 通过。**

## 阅读说明

### 统计口径

- **134 个开关**：用 `grep -o 'getenv("API_GO_[A-Z0-9_]*")' apps/api-go/internal/config/config.go | sort -u | wc -l` 复核；本文件在 130 个基线开关上追加本批 4 个（`API_GO_HEALTHZ_LIVE_MODE`、`API_GO_LEGACY_FALLBACK_MODE`、`API_GO_DOCS_MODE`、`API_GO_VECTOR_DIAGNOSTICS_MODE`）。`infra/docker/api-go-cutover.env.sample` 已同步为 134 行；清单以 `config.go` 源码为准。
- **注册/接线口径，不是部署启用口径**：本矩阵描述「开关设为 `go` 时 Go 做什么、Nest 是否让位」，**不表示任何环境已经启用**。仓库默认仍全部 `legacy`（两个历史单元例外：`API_GO_ONBOARDING_MODE` 默认 `shadow`、`API_GO_USER_SETTINGS_READ_MODE` 默认空串＝兼容），`api-go` 仍在 compose 的 `api-go-pilot` profile 内，`CANARY_PERCENT=0`，Web 默认指向 `api:4000`。
- **一个开关一行**：共 **134 行**，按迁移地图的 18 个产品域分组（`vector` 域没有 `API_GO_*` 开关，单独说明；本批 4 个跨域开关单列在 `ops-entrypoints` 小节）。同一开关若同时接管 HTTP 与 GraphQL，类别列写多值。
- **行数统计**：域表 130 行 + ops-entrypoints 4 行 + 跨开关校验 8 条 + 阶段总览 6 行 + Top 10 + 回退已知问题汇总 8 条。

### 如何回退

回退一律是**改环境变量 + 重启目标进程**，不需要回滚代码或数据库：

- 只被 `api-go` 读取的开关（HTTP/GraphQL 类，绝大多数）：改回 `legacy` 并重启 `api-go`，请求立即回落 `LEGACY_API_URL`（NestJS）。
- 被 `api` 与 `api-go` 双端读取的开关（worker/Cron/Outbox/实时桥，见「Nest 同读」列为「是」的 34 个）：**先 `api-go` 回 `legacy` 并排空在途任务，再 `api` 回 `legacy`**；切换时顺序相反（先 `api` 置 `go`，再 `api-go` 置 `go`）。
- 已写入的 MySQL/Mongo 数据、Redis 缓存与队列任务**不回滚**：所有已迁移单元的数据格式与 NestJS 同构，回退后 Nest 直接继续读写（逐条见「回退后已知问题」列与「回退后已知会重现的问题」一节）。
- 两个历史单元的合法值集合不同：`API_GO_ONBOARDING_MODE` 回退值是 `shadow`（空串也等于 shadow），`API_GO_USER_SETTINGS_READ_MODE` 回退值是空串或 `shadow`；二者都**不接受** `legacy`（非法值启动失败，`config.go:3393-3415`）。

### 列与前缀约定

- **类别**：HTTP / GraphQL Query / GraphQL Mutation / GraphQL Subscription / worker（BullMQ 消费）/ Cron（含 Interval）/ 启动任务 / Socket.IO。依据是 `cmd/api/main.go` 的规则 builder、GraphQL Registry 装配与 worker/Cron 启动分支，不是开关名字。
- **Nest 同读**：`是` = NestJS 也读取同一变量并改变行为（不建 Worker、Cron 返回、订阅者让位等），**必须与 api-go 同值**；`仅 schema 声明` = 只在 `apps/api/src/modules/config/env.schema.ts` 声明（zod 校验用），无行为分支；`否` = NestJS 完全不读。
- **所需资源**：`MySQL`=`DATABASE_URL`，`JWT`=`JWT_SECRET`（含 issuer/audience），`Redis`=`REDIS_HOST`，`Mongo`=`MONGO_URI`，`SMTP`=`SMTP_*` 四键，`crawl4ai`=`CRAWL4AI_BASE_URL`，`SSK`=`SYSTEM_SETTINGS_ENCRYPTION_KEY`。这些是 **`=go` 时 `config.Load` 的启动硬条件**（`config.go:5193-6314`），不是「跑起来就证明连通」。
- **切换顺序**：`仅 api-go` = Nest 不读该值，改完重启 `api-go` 即可；`先 api=go → 再 api-go=go` = 双端读取，必须按此顺序，回退反向；个别开关（Frontier/economic worker、Socket）有额外的停旧 owner/反代/重建 Web 步骤，写在单元格里。
- **阶段**：按 BRIEF 的阶段 0–6。归属规则：**只要该开关接管了写库或入队就落在阶段 2 或更高**；Cron/Interval/启动任务落阶段 3；BullMQ 消费者落阶段 4；实时传输落阶段 5；认证版健康检查落阶段 6。只读的 POST（导出、预览、地理编码、指标抓取）不写业务库、不入队，仍归阶段 1。阶段 0 不翻转任何开关（全部 legacy，只验证入口与透明代理），因此矩阵中没有阶段 0 的行。
- **证据**：`config.go` 的类型定义/`load` 解析/校验行 + `main.go`（或 `cmd/api/*.go`）接线行 + `legacyproxy` 规则文件行；Nest 同读的行为证据写 `apps/api/src/...:line`。**`legacyproxy/proxy.go` 的行号按 `dcbe563b` 计**：本批 T5.6 在同一 PR 给该文件增加了 legacy 回落计数（`metrics.RecordLegacyProxyRequest`），工作树比 `dcbe563b` 多一行 import，直接读工作树会偏移 1 行。

## 跨开关硬校验（config.go 全量）

`grep -c 'errs = append' config.go` 共 **348** 条，其中绝大多数是单开关「值域校验」（`must be one of legacy|go`）与单开关「资源校验」（`X is required when API_GO_...=go`）。**`API_GO_*` 之间**的硬校验共 **8 条**，全部在 `load` 内，命中即 `Load` 返回错误、进程不启动：

| # | 触发条件（全部满足） | 硬校验内容 | 代码位置 | 说明 |
|---|---|---|---|---|
| 1 | `API_GO_USER_SETTINGS_WRITE_MODE=go` | 必须 `API_GO_USER_SETTINGS_READ_MODE=go` | config.go:3428-3431 | 避免 PUT 成功但响应无法用 Go 读路径构建 |
| 2 | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE=go` | 必须 `GRAPHQL_SUBSCRIPTION_BUS=redis` | config.go:4213-4214 | 四订阅依赖既有 `gqlsub:*` Redis 通道；`local` 总线不可用 |
| 3 | `API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE=go` | 必须 `API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_GRAPHQL_NEWS_EVENTS_MODE=go` | config.go:4421-4422 | Brief 是新闻事件读单元的子 root，无执行器/父 root 时启动失败 |
| 4 | `API_GO_ANALYSIS_WORKER_MODE=go` | 必须 `GRAPHQL_SUBSCRIPTION_BUS=redis` | config.go:5519-5521 | worker 要把事件送到既有 Redis backplane |
| 5 | `API_GO_GRAPHQL_CRAWL_METADATA_MODE=go` | 必须 `API_GO_GRAPHQL_READ_MODE=go` | config.go:5747-5748 | 子开关，无 `/graphql` 执行器时启动失败而不是静默忽略 |
| 6 | `API_GO_GRAPHQL_ITEMS_LIST_MODE=go` | 必须 `API_GO_GRAPHQL_READ_MODE=go` **且** `API_GO_ITEMS_READING_MODE=go` | config.go:5821-5826 | items 连接根复用条目读服务与共享执行器 |
| 7 | `API_GO_REALTIME_SOCKET_MODE=go` | 必须 `WS_REDIS_ADAPTER_ENABLED=true` | config.go:6004-6008 | newsnow namespace 靠 adapter 广播频道转发；关掉会静默收不到事件 |
| 8 | `API_GO_SITUATION_REFRESH_MODE=go` | 必须 `API_GO_SITUATION_SIGNALS_WORKER_MODE=go` **且** `API_GO_NEWS_SOURCE_SCHEDULER_MODE=go` | config.go:6175-6180 | Telegram 会话只能被一个租约持有；刷新入口属于 Go 新闻源调度器 |

另有 **3 条「父开关隐含约束」不在 `config` 里、在 `main.go` 运行时强制执行**（命中即 `run` 返回错误、进程不监听）：`/graphql` Go 执行器要求 MySQL+JWT+Redis 同时可用（`main.go:2196-2198`）；`API_GO_GRAPHQL_READ_MODE=go` 且无可用 `MONGO_URI` 时报 `requires a valid MONGO_URI`（`main.go:2216-2220`）；`API_GO_GRAPHQL_RSS_TRANSLATION_MODE=go` 同理（`main.go:2436-2441`）。

## 阶段总览

| 阶段 | 定义（BRIEF） | 开关数 | 代表开关 | 前置资源 |
|---|---|---|---|---|
| 0 | Web 入口指向 api-go，全部开关仍 legacy | 0（不翻转开关） | — | 入口与透明代理可用 |
| 1 | 只读 HTTP 与 GraphQL 读（Query） | 37 | `API_GO_GRAPHQL_READ_MODE`、`API_GO_ITEMS_READING_MODE`、`API_GO_DASHBOARD_STATS_MODE`、`API_GO_VECTOR_DIAGNOSTICS_MODE` | MySQL+Redis+JWT，部分 +Mongo |
| 2 | 写入类 HTTP 与 GraphQL Mutation | 60 | `API_GO_ITEMS_INGEST_MODE`、`API_GO_GRAPHQL_SETTINGS_WRITE_MODE`、`API_GO_CRAWL_TASK_WRITE_MODE` | 同阶段 1，写开关普遍要 Mongo/SSK/SMTP |
| 3 | Cron / Interval / 启动任务 / 后台调度 | 18 | `API_GO_NEWS_SOURCE_SCHEDULER_MODE`、`API_GO_AUDIT_OUTBOX_MODE`、`API_GO_CRAWL_MAINTENANCE_MODE` | MySQL+Redis，多数 +Mongo |
| 4 | BullMQ 队列 worker | 12 | `API_GO_ITEM_PIPELINE_WORKER_MODE`、`API_GO_CRAWL_WORKER_MODE`、`API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | Redis + 队列依赖（crawl4ai/SMTP/SSK/模型） |
| 5 | 实时推送（Subscription、两个 Socket.IO 路径、重建 Web） | 3 | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE`、`API_GO_NOTIFICATIONS_SOCKET_MODE`、`API_GO_REALTIME_SOCKET_MODE` | Redis(+adapter)、WS 反代与 Web 重建 |
| 6 | 认证版健康检查与停 Nest 收尾（C-1/C-7/C-9） | 4 | `API_GO_HEALTHZ_MODE`、`API_GO_HEALTHZ_LIVE_MODE`、`API_GO_DOCS_MODE`、`API_GO_LEGACY_FALLBACK_MODE` | JWT+MySQL+Redis；停 Nest 步骤见 runbook 阶段 6 |

合计 **134** 个开关（覆盖全部 `API_GO_*`）。**阶段 0 不涉及任何开关翻转**：`/api/` 前缀仍整体 `legacy`，未接管路径全部回落 NestJS（`legacyproxy/proxy.go:115-173`）。

### 域 × 阶段分布

| 域 | 开关数 | 阶段 1 | 阶段 2 | 阶段 3 | 阶段 4 | 阶段 5 | 阶段 6 |
|---|---|---|---|---|---|---|---|
| identity（身份、组织与访问控制） | 8 | 1 | 7 | 0 | 0 | 0 | 0 |
| personal（个人设置、阅读工作台与公共门户） | 8 | 3 | 4 | 1 | 0 | 0 | 0 |
| workspace（通知、看板与告警交互） | 15 | 9 | 2 | 1 | 1 | 2 | 0 |
| items（条目检索、RSS 阅读与处理结果） | 8 | 2 | 3 | 2 | 1 | 0 | 0 |
| analysis（分析协作工作区与导出） | 6 | 1 | 4 | 0 | 1 | 0 | 0 |
| news（新闻事件、指标、聚类与内容流水线） | 17 | 3 | 7 | 6 | 1 | 0 | 0 |
| knowledge（知识图谱、实体情报与影响传播） | 4 | 2 | 1 | 1 | 0 | 0 | 0 |
| crawl（采集源、模板、画像、工作流与 Frontier） | 14 | 3 | 8 | 1 | 2 | 0 | 0 |
| situation（态势监控、地理与实时信号） | 10 | 2 | 5 | 2 | 1 | 0 | 0 |
| settings（设置中心与平台治理） | 12 | 3 | 9 | 0 | 0 | 0 | 0 |
| model-gateway（模型接入、密钥与 LLM 网关） | 3 | 0 | 3 | 0 | 0 | 0 | 0 |
| infrastructure-data（基础设施、采集凭据与数据运行） | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| observability（日志、异常、质量、遥测与运维） | 15 | 5 | 4 | 4 | 2 | 0 | 0 |
| assistant（Assistant 与模型任务） | 2 | 0 | 1 | 0 | 1 | 0 | 0 |
| economic（经济数据与 AkShare） | 2 | 0 | 1 | 0 | 1 | 0 | 0 |
| archive（归档阅读与准备任务） | 2 | 1 | 0 | 0 | 1 | 0 | 0 |
| async-runtime（队列、调度、Outbox 与实时传输） | 3 | 1 | 0 | 0 | 0 | 1 | 1 |
| ops-entrypoints（停 Nest 收尾，本批新增） | 4 | 1 | 0 | 0 | 0 | 0 | 3 |

类别分布（可多选）：HTTP **82**、GraphQL Query **13**、GraphQL Mutation **12**、GraphQL Subscription **1**、worker **12**、Cron **17**、启动任务 **2**、Socket.IO **2**。Nest 同读：**34** 个「是」、**11** 个「仅 schema 声明」、其余 **89** 个 Nest 完全不读。

## 按域矩阵

读法：每张表是同一套 12 列；「风险」是**切换风险**（回到 Nest 的难度、影响面、外部依赖与已知缺陷），不是代码质量评价。风险口径：`高` = 影响登录/写入主链、实时可达性或双消费/双跑风险，或带已知缺陷；`中` = 普通读写或调度，回退路径清晰；`低` = 只读/诊断/幂等清理类。


### identity · 身份、组织与访问控制（8 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ACCOUNT_SECURITY_MODE` | identity | HTTP（8 条 /api/auth*，GET/PATCH/POST/DELETE） | 否 | 无其它 API_GO_*；只依赖共享鉴权栈 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已写入的会话/机器令牌与审计不回滚（未核实：无 PR 描述证据）；回退后 8 条路由立即回 Nest | 中（账户资料、登出与机器令牌写路径） | 2 | config.go:963/4123/5924；main.go:811；legacyproxy/account_security_routes.go:38 |
| `API_GO_AUTH_FACTORS_MODE` | identity | HTTP（7 条 MFA 与组织 OIDC 配置，GET/POST/PUT） | 否 | 无其它 API_GO_* | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | MFA 因子与 OIDC 配置已写入不回滚；回退后由 Nest 继续管理（未核实具体 PR 说明） | 中（MFA/OIDC 管理，不访问 IdP） | 2 | config.go:2046/4115/5917；main.go:807；legacyproxy/auth_factors_routes.go:37 |
| `API_GO_AUTH_LOGIN_MODE` | identity | HTTP（11 条 POST：登录/刷新/验证码/MFA 挑战/找回/改邮箱） | 否 | 无其它 API_GO_*；SMTP_* 必填 | MySQL+JWT+Redis+SMTP | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已签发的会话、验证码与审计不回滚；SMTP 真实投递未在部署环境验证（未核实） | 高（全站登录与会话签发主链） | 2 | config.go:2097/4153/5946-5957；main.go:823；legacyproxy/auth_login_routes.go:43 |
| `API_GO_OIDC_LOGIN_MODE` | identity | HTTP（3 条 SSO：start/callback/handoff exchange） | 否 | 复用已迁 trusted-login 核心；依赖 Redis 状态/discovery/JWKS 缓存 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已签发 handoff/会话不回滚；未与真实 IdP 联调（PR #83 只做静态与契约测试） | 高（组织 SSO 唯一入口，失败即无法登录） | 2 | config.go:2128/4164/5964；main.go:831；legacyproxy/oidc_login_routes.go:25 |
| `API_GO_IDENTITY_ONBOARDING_MODE` | identity | HTTP（14 条 邀请/注册申请/审批，GET/POST） | 否 | 无其它 API_GO_*；SMTP_* 必填 | MySQL+JWT+Redis+SMTP | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已发出的邀请/审批结果与邮件不回滚（PR #79 未给回退章节，未核实） | 中（管理员入组与审批，含邮件副作用） | 2 | config.go:2174/4175/5971-5982；main.go:827；legacyproxy/identity_onboarding_routes.go:44 |
| `API_GO_RBAC_MODE` | identity | HTTP（6 条 /api/rbac*：permissions/roles/assign/members/audit-logs） | 否 | 无其它 API_GO_* | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已完成的角色分配与缓存失效不回滚；回退后 Nest 继续写（未核实） | 中（组织访问控制写路径） | 2 | config.go:231/3730/5540；main.go:661；legacyproxy/rbac_routes.go:22 |
| `API_GO_AVATAR_UPLOAD_MODE` | identity | HTTP（1 条 POST /api/auth/avatar/presigned-url） | 否 | 与 USER_DATA_EXPORT 共用 account_data builder；不要求 Mongo | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已签发的上传地址在 TTL 内仍有效，已写审计不回滚（PR #108） | 低（单条签名接口，本地签名不访问 S3） | 2 | config.go:984/4134/5930；main.go:815；legacyproxy/account_data_routes.go:25-27 |
| `API_GO_USER_DATA_EXPORT_MODE` | identity | HTTP（1 条 GET /api/auth/data-export） | 否 | 与 AVATAR_UPLOAD 共用 builder | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已导出文件不回滚；回退后由 Nest 重新生成（PR #108） | 中（个人数据全量导出，含限流与审计） | 1 | config.go:1000/4142/5935-5937；main.go:819；legacyproxy/account_data_routes.go:25-31 |

### personal · 个人设置、阅读工作台与公共门户（8 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ONBOARDING_MODE` | personal | HTTP（1 条 GET /api/user-settings/ui/onboarding） | 否 | 默认 shadow（不是 legacy）；接受 ""/shadow/go，无 legacy 值 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 shadow（或空）重启：Nest 响应 + Go 差分 | 回到 shadow 后 onboarding 由 Nest 响应，Go 只做差分（config.go:35-38）；不产生数据差异 | 低（单条只读 GET，首个 Go 全响应单元） | 1 | config.go:32/3393/5197；main.go:525/1493；legacyproxy/proxy.go:115-139 |
| `API_GO_USER_SETTINGS_READ_MODE` | personal | HTTP（6 条只读 GET /api/user-settings/ui/*） | 否 | 默认空（兼容：由 ONBOARDING 决定 onboarding，其余按历史去向）；接受 ""/shadow/go | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回空/ shadow 重启：六个 GET 由 Nest 响应（部分端点 Go 差分） | 回退到空后 rss-reader/spacetime-timeline 回到 shadow、其余回到 legacy（config.go:47-60）；六读行为分裂需注意 | 中（六个用户设置读的统一开关） | 1 | config.go:47/3407；main.go:533/1059/1189；legacyproxy/proxy.go:115 |
| `API_GO_USER_SETTINGS_WRITE_MODE` | personal | HTTP（6 条 PUT /api/user-settings/ui/*） | 否 | 硬校验：必须同时 READ=go（config.go:3428-3431） | MySQL+JWT+Redis（由 READ=go 带入） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启；六个 PUT 立即回 Nest | 已写入的 UserSetting 不回滚；回退后读仍可由 Go 响应（读写开关独立） | 中（六 PUT 与读模式强耦合） | 2 | config.go:62/3420/3430；main.go:541/1465；legacyproxy/proxy.go:115-173 |
| `API_GO_PUBLIC_PORTAL_MODE` | personal | HTTP（4 条公开 GET：home/channels/stories-id/stories-slug） | 否 | 匿名读；不要求 JWT/Redis | MySQL（仅 DATABASE_URL） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 故事 miss 会调模型 HTTP；回退后由 Nest 生成（模型未真实联调，未核实） | 中（公开匿名入口，模型依赖在请求期） | 1 | config.go:76/3433/5207；main.go:545/1498；legacyproxy/proxy.go:174-186 |
| `API_GO_USER_NEWS_BEHAVIOR_MODE` | personal | HTTP（3 条：行为记录/画像读/清空，GET/POST/DELETE） | 否 | 无其它 API_GO_*；订阅/摘要可独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 行为记录已写入不回滚；回退后 Nest 继续累计（未核实具体 PR 说明） | 低（个人行为读写，无外部服务） | 2 | config.go:1614/3523/5297；main.go:589；legacyproxy/proxy.go:387 |
| `API_GO_USER_DIGEST_MODE` | personal | HTTP（5 条：摘要偏好/每日摘要/投递设置，GET/PUT） | 仅 schema 声明（env.schema.ts:34 注释） | 与 USER_DIGEST_DELIVERY 独立（后者只管后台投递） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 摘要内容与投递记录不回滚；回退后 Nest 读同一 MySQL/Mongo（未核实具体 PR 说明） | 中（摘要读模型跨 Mongo） | 2 | config.go:1623/3531/5306-5308；main.go:593；legacyproxy/proxy.go:398 |
| `API_GO_USER_DIGEST_DELIVERY_MODE` | personal | Cron（每分钟扫描 + 到期 CAS 投递） | 是（Nest Cron 在 tick gate 前返回；通知订阅者接入 relay） | SCHEDULE_ENABLED；与 5 条摘要 HTTP 开关独立 | MySQL+Redis+Mongo+SMTP | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | 已投递邮件与状态不回滚；回退后 Nest Cron 恢复投递（digest 通知 relay 需两端一致，DEPENDENCIES.md:46） | 高（真实 SMTP 投递 + 状态写回） | 3 | config.go:1641/3539/5317-5335；cmd/api/digest_delivery.go:29；apps/api/src/modules/user-digest/user-digest-delivery-scheduler.service.ts:34-39 |
| `API_GO_CONTENT_SUBSCRIPTIONS_MODE` | personal | HTTP（7 条：订阅 CRUD/批量/catalog/推荐） | 否 | 无其它 API_GO_*；catalog 可调模型/vector | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 订阅与 catalog 缓存不回滚；回退后 Nest 读同一 MySQL/Mongo（未核实具体 PR 说明） | 低（个人内容订阅，模型依赖在请求期） | 2 | config.go:1605/3515/5300-5302；main.go:585；legacyproxy/proxy.go:372 |

### workspace · 通知、看板与告警交互（15 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_DASHBOARD_STATS_MODE` | workspace | HTTP（1 条 GET /api/dashboard/stats + OPTIONS） | 否 | 无其它 API_GO_* | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；回退后 Nest 计算（共享 Redis 缓存键相同，无数据回滚） | 中（首页主统计，跨 Mongo） | 1 | config.go:88/3442/5211-5220；main.go:549；legacyproxy/proxy.go:221 |
| `API_GO_DASHBOARD_CHARTS_MODE` | workspace | HTTP（3 条图表 GET + OPTIONS） | 否 | 与 stats/war-map 独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；回退后 Nest 计算（未核实具体 PR 说明） | 低（只读图表聚合） | 1 | config.go:100/3451/5225-5231；main.go:553；legacyproxy/proxy.go:237 |
| `API_GO_DASHBOARD_WAR_MAP_MODE` | workspace | HTTP（2 条 GET：events/news-markers） | 否 | 与 transport/layers 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；MySQL 新闻为空时回退 Mongo 的分支与 Nest 同构（config.go:118-120） | 中（War Map 主数据，跨库回退） | 1 | config.go:113/3459/5236-5245；main.go:557；legacyproxy/proxy.go:260 |
| `API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE` | workspace | HTTP（1 条 GET transport-detail） | 否 | 与 events/layers 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；运输明细可能触发外部 HTTP（未核实实网） | 低 | 1 | config.go:125/3467/5250-5259；main.go:561；legacyproxy/proxy.go:280 |
| `API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE` | workspace | HTTP（1 条 GET layers） | 否 | 与 events/transport 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；无数据回滚 | 低 | 1 | config.go:134/3475/5264-5273；main.go:565；legacyproxy/proxy.go:289 |
| `API_GO_DASHBOARD_SPACETIME_GEO_MODE` | workspace | HTTP（2 条 GET geo-heatmap/下钻） | 否 | 与 propagation 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 地理 miss 可能调 Nominatim（请求期外部依赖，未实网验证） | 中（地理聚合 + 外部地理编码） | 1 | config.go:143/3483/5277；main.go:569；legacyproxy/proxy.go:298 |
| `API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE` | workspace | HTTP（2 条 GET propagation/下钻） | 否 | 与 geo 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；参数越界夹取与 Nest 同构（PR #106） | 中（传播图聚合算法） | 1 | config.go:152/3491/5280；main.go:573；legacyproxy/proxy.go:308 |
| `API_GO_DASHBOARD_STREAM_MODE` | workspace | HTTP（SSE，1 条 GET /api/dashboard/stream） | 否 | 复用 charts/war-map/spacetime 内部服务，但不改写它们的路由 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | SSE 与行缓存均在进程内，进程退出即释放（PR #106:119）；无数据回滚 | 中（长连接 SSE，Nest 侧 prom-client 无关） | 1 | config.go:162/3499/5283；main.go:577；legacyproxy/proxy.go:318 |
| `API_GO_GRAPHQL_WORKSPACE_READ_MODE` | workspace | GraphQL Query（12 个 root：me/myOrganizations/users/userLoginRecords/roles/permissions/memberships/dashboards/queueStats/entitySentimentSeries/topicSentimentSeries/processedItemById） | 否 | 双 go 才登记：READ=go 且本开关=go（main.go:2209）；否则含这些 root 的文档整包回 Nest | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含这 12 个 root 的文档整包回 Nest（config.go:2459）；无数据回滚 | 中（组织/RBAC 读面） | 1 | config.go:4443/2459；main.go:2209/2260；graphqlread/workspace/register.go |
| `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` | workspace | GraphQL Mutation（8 个：通知/看板/告警交互写） | 否 | 与 READ 独立；不读 Mongo | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已写入的交互数据不回滚；回退后整包回 Nest（config.go:2546） | 中（工作台交互写） | 2 | config.go:4570/2546/6036；main.go:892/1213；graphqlread/workspacewrite/register.go |
| `API_GO_GRAPHQL_ALERT_RULES_MODE` | workspace | GraphQL Query+Mutation（alertRules root + upsert/delete/trigger 三个规则 Mutation） | 否 | 与 READ/workspace write 独立；只经 Redis 入队，不起 worker | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #100：回退后请求立即回 Nest，Go 无 worker 需要停止；已写规则/关联与删除效果不回滚；在途任务格式与 Nest 相同 | 中（告警规则写 + 入队） | 2 | config.go:4581/2560/6042；main.go:898/1217；graphqlread/alerts/register.go+alertqueue |
| `API_GO_ALERT_WORKER_MODE` | workspace | worker（alerts 队列：扫描/评估/站内通知/邮件与 webhook 投递） | 是（alerts.processor.ts:95 读取后不建 Worker；通知订阅者读取） | BULLMQ_WORKERS_ENABLED；SMTP_*；ALERT_* 参数 | MySQL+Redis+Mongo+SMTP | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #113：回退后队列中未处理任务格式相同，Nest 可直接续消费；已写通知/投递不回滚；Nest 没有 B2/B3 修复 | 高（邮件/Webhook 外发 + 双消费风险） | 4 | config.go:1782/3585/5426-5444；cmd/api/alert_worker.go:33；apps/api/src/modules/alerts/alerts.processor.ts:95 |
| `API_GO_NOTIFICATIONS_SOCKET_MODE` | workspace | Socket.IO（/socket.io-notifications 专用 Engine.IO 路径） | 是（notification-realtime.relay.ts:41、generic-notification.subscriber.ts:151） | 与全部 GraphQL/HTTP 开关独立；Web 需指向该路径 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go；Web 改回 /socket.io 并重建 | PR #124：切换需同时设 Go 开关与 Web 构建路径并重建 Web；回滚无数据迁移；回退后 Nest 自己推送，Go 侧无残留 | 高（实时通知可达性） | 5 | config.go:1983/4219/5999；main.go:861/1152；legacyproxy/proxy.go:191；apps/api/src/modules/notifications/notification-realtime.relay.ts:41 |
| `API_GO_REALTIME_SOCKET_MODE` | workspace | Socket.IO（/socket.io-realtime：newsnow/ops/quality/queue/situation-monitor 五个 namespace） | 是（situation-monitor-signals.dispatcher.ts:92 等） | 硬校验 WS_REDIS_ADAPTER_ENABLED=true（config.go:6004-6008） | MySQL+JWT+Redis | api 与 api-go 同值 go + 反代把 /socket.io-realtime 指向 api-go + 重建 Web（PR #131:107） | 反向：Web 改回 /socket.io 重建 → 摘反代 → 两侧改回 legacy | PR #131：回退 legacy 后 situation 实时事件恢复为 Nest 基线（该基线本身广播有缺陷，PR #131:60） | 高（五个 namespace 的实时链路） | 5 | config.go:2000/4230/6004-6008；main.go:867；legacyproxy/proxy.go:206；apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.dispatcher.ts:92 |
| `API_GO_CLASSIFICATION_QUALITY_ALERT_MODE` | workspace | Cron（每 5 分钟分类质检告警评估） | 是（classification-quality-alert-scheduler.service.ts:50 读取后 tick 直接返回） | 与 HTTP 开关独立；共享 tick gate 与组织锁 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | 评估结果写入 Mongo 不回滚；回退后 Nest @Interval 恢复（PR #131:109） | 中（告警评估，双跑由共享锁防护） | 3 | config.go:2013/4240/6017-6023；main.go:890；apps/api/src/modules/observability/classification-quality-alert-scheduler.service.ts:50 |

### items · 条目检索、RSS 阅读与处理结果（8 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ITEMS_READING_MODE` | items | HTTP（2 条 GET /api/items*）+ GraphQL Query（item/itemFacets/rssSources/rssTranslationStatus/searchSuggestions 5 root，需 READ=go） | 否 | GraphQL 部分需 READ=go；REST 部分由本开关单独控制 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；回退后 Nest 读同一 MySQL/Mongo。GAP-ITEMS-001（Go 水合窄快照）只影响 Go 路径，GAPS.md:36 记录于旧基线，本基线是否已修未核实 | 中（条目主读路径） | 1 | config.go:1250/4476/5777-5779；main.go:747；legacyproxy/items_reading_routes.go:20；graphqlread/itemsreading |
| `API_GO_ITEMS_INGEST_MODE` | items | HTTP（POST /api/items）+ GraphQL Mutation（5 个条目/采集写入） | 否 | 与全部读开关独立；请求内即时投递 raw_item | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启；写路径回 Nest，不再新增 Go 写入 | PR #96：已写条目/读模型/队列任务不回滚；Nest worker 继续消费同一队列；GAP-ITEMS-001 的水合差异只存在于 Go 路径（未核实是否已修） | 高（条目写入与入库主链） | 2 | config.go:1267/4489/5785-5787；main.go:751/895；legacyproxy/items_ingest_routes.go:14；graphqlread/itemsingest |
| `API_GO_RAW_ITEM_OUTBOX_MODE` | items | Cron（每分钟 raw_item 重放） | 是（raw-item-outbox.service.ts:477 读取后跳过定时批量） | SCHEDULE_ENABLED=false 可停定时重放（不影响请求内即时投递）；与 ITEMS_INGEST 独立 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #96：先停旧 Cron 再启 Go，回退反向；无需清表；未处理 outbox 行格式不变，Nest 可继续补偿 | 中（重放语义双跑风险由锁/条件领取控制） | 3 | config.go:1278/4498/5794-5800；cmd/api/items_ingest.go:51；apps/api/src/modules/items/raw-item-outbox.service.ts:154-162 |
| `API_GO_PROCESSED_ITEM_OUTBOX_MODE` | items | Cron（每 5 分钟 processed_item 补偿扫描） | 是（news-pipeline.service.ts:196 直接读 process.env） | SCHEDULE_ENABLED；吞吐参数只在 go 模式读取；同步在途投递仍留 Nest | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #116：回退反向；已写入结果保留、未处理 outbox 行格式不变，Nest 按原低吞吐继续补偿 | 中（补偿投递，短暂双跑安全） | 3 | config.go:1297/4508/5808-5814；cmd/api/processed_item_outbox.go:29；apps/api/src/modules/news-pipeline/news-pipeline.service.ts:196 |
| `API_GO_ITEM_PIPELINE_WORKER_MODE` | items | worker（itemPipeline 队列消费） | 是（queue.processor.ts:97 不建 Worker；news-source-notification.subscriber.ts:146 受影响） | BULLMQ_WORKERS_ENABLED；SYSTEM_SETTINGS_ENCRYPTION_KEY（解密网关/向量密钥） | MySQL+Redis+Mongo+SSK | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | config.go:687：任何阶段无法在 Go 跑都必须保持 legacy；回退无需数据变更（队列与数据格式相同）；Go 不自动回退 501 路径（DEPENDENCIES.md:9） | 高（流水线核心 worker，双消费即重复处理） | 4 | config.go:681/5154/6236-6245；cmd/api/item_pipeline_worker.go:75；apps/api/src/modules/queue/queue.processor.ts:97 |
| `API_GO_GRAPHQL_ITEMS_LIST_MODE` | items | GraphQL Query（items 连接根：分页/三排序/相关性重排/个性化） | 否 | 硬校验：READ=go 且 ITEMS_READING=go（config.go:5821-5826） | MySQL+JWT+Redis+Mongo（由父开关带入） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含 items 的文档整包回 Nest；个性化画像读取仍由 behavior 开关决定 | 中（条目列表主查询） | 1 | config.go:4548/2519/5823-5826；main.go:2303；graphqlread/itemsreading（RegisterList） |
| `API_GO_SEARCH_REINDEX_MODE` | items | HTTP（2 条：POST /api/admin/search/reindex、GET /:jobId） | 否 | 与读开关独立；ES 可选（未配置走禁用分支） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 重建为进程内 goroutine + Redis job 状态，重启不自动恢复（DEPENDENCIES.md:103）；回退后 Nest 重新提供入口 | 中（索引重建写 ES/读模型） | 2 | config.go:879/3984/5755-5757；main.go:739；legacyproxy/search_reindex_routes.go:21；internal/searchreindex |
| `API_GO_GRAPHQL_RSS_TRANSLATION_MODE` | items | GraphQL Mutation（translateRssItems） | 否 | 独立于所有读/写开关；请求内同步选源→缓存→模型 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | GAP-RSS-001（status 窄投影覆盖共享缓存）在 #90 已修（GAPS.md:11）；回退后整包回 Nest，已写缓存/指标/日志不回滚 | 中（模型调用 + 缓存写回） | 2 | config.go:4626/2618/6068-6070；cmd/api/rss_translation.go:37；main.go:894/1229 |

### analysis · 分析协作工作区与导出（6 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ANALYSIS_VIEWS_MODE` | analysis | HTTP（5 条保存视图 GET/POST/PATCH/DELETE） | 否 | 与 boards/threads 独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已保存视图不回滚；回退后 Nest 继续读写（未核实具体 PR 说明） | 低 | 2 | config.go:1839/3610/5448；main.go:597；legacyproxy/analysis_routes.go:18 |
| `API_GO_ANALYSIS_BOARDS_MODE` | analysis | HTTP（13 条看板/列/任务 GET/POST/PATCH/DELETE） | 否 | 与 views/threads 独立；不决定讨论服务读任务的能力 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 看板/列/任务写入不回滚（未核实具体 PR 说明） | 中（看板结构写路径） | 2 | config.go:1848/3618/5451；main.go:601；legacyproxy/analysis_routes.go:31 |
| `API_GO_ANALYSIS_THREADS_MODE` | analysis | HTTP（5 条笔记/评论 GET/POST/PATCH/DELETE/PUT） | 否 | 与 views/boards 独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 讨论内容写入不回滚（未核实具体 PR 说明） | 低 | 2 | config.go:1857/3626/5454；main.go:605；legacyproxy/analysis_routes.go:55 |
| `API_GO_ANALYSIS_EXPORT_MODE` | analysis | HTTP（2 条 CSV 导出 POST /api/analysis/exports/items／events，只读） | 否 | 独立于三个协作开关；search 导出仍留 Nest（由 archive 开关接管） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 导出文件不回滚；回退后 Nest 重新生成（PR #84 未给回退章节，未核实） | 中（大批量读取，Mongo 投影） | 1 | config.go:1880/3639/5461-5463；main.go:611；legacyproxy/analysis_export_routes.go:22 |
| `API_GO_ANALYSIS_RUNS_MODE` | analysis | GraphQL Mutation（3 个：correlation/anomaly/geo-transport 分析请求） | 否（仅有未使用的 getter：config.service.ts:1302-1310） | 与 READ/export/协作开关独立；worker 归属由 ANALYSIS_WORKER 单独决定 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go；worker 回退顺序见 ANALYSIS_WORKER | PR #98：两端代码先部署且默认 legacy；Mutation 回退只需改本开关，队列/分析记录不清理；GAP-ANALYSIS-001 的 running 恢复由本批窄修，Nest 同步了 finalizeStalledFailure，回退后该修复仍在 | 高（分析执行入口 + Mongo 状态） | 2 | config.go:1922/3656/5480-5482；cmd/api/analysis_runs.go:40；apps/api/src/modules/config/config.service.ts:1303 |
| `API_GO_ANALYSIS_WORKER_MODE` | analysis | worker（analysis 队列消费 + 模型流 + 订阅事件发布） | 是（analysis.processor.ts:53 读取后不建 Worker） | BULLMQ_WORKERS_ENABLED；硬校验 GRAPHQL_SUBSCRIPTION_BUS=redis（config.go:5519-5521） | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #98：先停并排空 Nest 消费者再启 Go；回退先停 Go 领取/drain 再启 Nest；不 flush 队列 | 高（模型执行 + 事件发布 + 双消费） | 4 | config.go:1938/3665/5510-5521；cmd/api/analysis_runs.go:76；apps/api/src/modules/analysis/analysis.processor.ts:53 |

### news · 新闻事件、指标、聚类与内容流水线（17 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_NEWS_SOURCES_MODE` | news | HTTP（15 条新闻源管理台 GET/POST/PATCH/DELETE） | 否 | 与 source-ops / scheduler 独立；不接管 preview | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 源配置与 OPML 导入结果不回滚（未核实具体 PR 说明） | 中（新闻源配置写） | 2 | config.go:180/3682/5528；main.go:638；legacyproxy/proxy.go:331 |
| `API_GO_NEWS_SOURCE_SCHEDULER_MODE` | news | Cron（30 秒新闻源调度） | 是（news-source.scheduler.service.ts:275 读取；通知订阅者 :141 受影响） | SITUATION_REFRESH=go 时必须同 go；共享 cron:news-source-scheduler 锁 | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #118：先 api 后 api-go，回退反向；两侧共用锁与派发去重键，短暂并存不会重复派发；数据不回滚；失败不自动在两端重放（派发可能已入队） | 高（调度 + 后续 worker 派发） | 3 | config.go:190/3690/5732-5735；cmd/api/news_source_scheduler.go:52；apps/api/src/modules/queue/news-source.scheduler.service.ts:275 |
| `API_GO_NEWS_SOURCE_OPS_MODE` | news | HTTP（4 条 POST：dispatch/cancel-queued/clear-inflight/retry-latest） | 是（news-source-notification.subscriber.ts:142 读取） | 与 scheduler 独立；同一通知 relay 订阅者受两侧开关共同影响 | MySQL+JWT+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | 操作产生的队列/在途状态已是 Redis 运行态，回退后保持（未核实具体 PR 说明） | 中（队列运维动作） | 2 | config.go:199/3698/5741；cmd/api/news_source_scheduler.go:53；apps/api/src/modules/notifications/news-source-notification.subscriber.ts:142 |
| `API_GO_NEWS_INDICATORS_MODE` | news | HTTP（3 条 GET/POST）+ GraphQL Query（2 个只读 root，需 READ=go） | 否 | GraphQL 部分需 READ=go；mutation refresh 由独立开关控制 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | refresh 写 MySQL 的结果不回滚；回退后 Nest 继续（PR #105 未给该开关回退章节，未核实） | 中（指标关联读 + refresh 写） | 2 | config.go:336/3771/5569；main.go:682/2247/2502；legacyproxy/news_indicator_routes.go:19 |
| `API_GO_NEWS_INDICATOR_ASSOCIATION_CRON_MODE` | news | Cron（每 6 小时指标关联刷新） | 是（news-indicator-association.ingestion.service.ts:41 读取后跳过） | 共享 tick gate + 组织租约；MySQL+Redis 足够，不需要 JWT/Mongo | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | 已刷新关联不回滚；回退后 Nest 恢复 cron（未核实具体 PR 说明） | 中（批量写 MySQL） | 3 | config.go:695/5170/6253-6256；cmd/api/news_backfill_jobs.go:101；apps/api/src/modules/news-indicator/news-indicator-association.ingestion.service.ts:41 |
| `API_GO_NEWS_EVENTS_INGESTION_MODE` | news | Cron（5 分钟新闻事件入库与逐篇分配） | 是（news-events-ingestion.service.ts:115 读取后跳过） | SETTLE_MS 参数；共享 tick gate/组织锁/游标 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #123：回退后 settleMs 上界失效，原风险恢复（`legacy` 回退后该上界失效，PR #123:72）；已写入事件与游标不回滚 | 高（事件入库 + 聚类分配写） | 3 | config.go:1761/3565/5372-5378；cmd/api/news_events_ingestion.go:60；apps/api/src/modules/news-events/news-events-ingestion.service.ts:115 |
| `API_GO_NEWS_EVENTS_TIMELINE_MODE` | news | Cron（10 分钟事件时间线重建） | 是（news-events-timeline.service.ts:252 读取后跳过） | 共享 tick gate + 组织锁；幂等重建 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #120：回退后 B1/B2 修复失效（唯一索引撞车导致整事务回滚、组织停在旧数据的问题重新出现，PR #120:91）；幂等重建下一轮会覆盖 | 中（幂等重建，写 MySQL+Mongo） | 3 | config.go:1680/4379/6265-6271；cmd/api/event_timeline_sentiment.go:49；apps/api/src/modules/news-events/news-events-timeline.service.ts:252 |
| `API_GO_NEWS_CLUSTERING_LLM_BACKFILL_MODE` | news | HTTP（1 条 POST 手动 LLM 补救入队） | 仅 schema 声明（env.schema.ts:120） | 只入队，不消费（消费由 NEWS_CLUSTERING_RECOVERY_WORKER 决定） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #105：已入队 job 由既有 worker 消费；回退后入口回 Nest，已写 Mongo 状态不回滚 | 中（跨 Mongo 状态 + 入队） | 2 | config.go:636/5130/6204-6206；cmd/api/news_backfill_jobs.go:99；legacyproxy/news_clustering_llm_backfill_routes.go:21 |
| `API_GO_NEWS_CLUSTERING_RECOVERY_WORKER_MODE` | news | worker（news_event_clustering_recovery 消费 + 5 分钟 pending 扫描 + R1 恢复） | 是（news-event-clustering-recovery.processor.ts:35、scheduler.service.ts:29） | BULLMQ_WORKERS_ENABLED；与 backfill 入队开关独立 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #105：worker 按相反顺序回退，未处理任务格式相同 Nest 可续消费；Mongo 状态不连真实 Mongo 验证（PR #105:139） | 中（双消费风险由 Nest 不建 Worker 防护） | 4 | config.go:650/5138/6211-6217；cmd/api/news_backfill_jobs.go:100；apps/api/src/modules/news-events/news-event-clustering-recovery.processor.ts:35 |
| `API_GO_GRAPHQL_NEWS_EVENTS_MODE` | news | GraphQL Query（6 个新闻事件 root） | 否 | 双 go 才登记：READ=go 且本开关=go；BRIEF 子开关额外依赖本开关 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含这 6 个 root 的文档整包回 Nest（config.go:2429）；无数据回滚 | 中（新闻事件读面） | 1 | config.go:4400/2429；main.go:2227/2493；graphqlread/newsevents/register.go |
| `API_GO_GRAPHQL_NEWS_EVENT_BRIEF_MODE` | news | GraphQL Query（单 root newsEventBrief：选源→模型→校验→写回 briefV1） | 否 | 硬校验：READ=go 且 NEWS_EVENTS=go（config.go:4421-4422） | MySQL+JWT+Redis+Mongo+模型上游/SSK（请求期） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退 legacy 后 brief 由 Nest 生成；旧 briefV1 缓存保持兼容（config.go:2436 字段注释）；GAP-NEWS-001 在 GAPS.md:78 记为开放（旧基线），本基线已装配 BriefCompleter（main.go:2236-2246），是否已修复未核实 | 中（模型调用 + metadata 写回） | 1 | config.go:4411/2436/4422；main.go:2234/2494；graphqlread/newsevents/brief.go:69 |
| `API_GO_GRAPHQL_NEWS_INDICATOR_REFRESH_MODE` | news | GraphQL Mutation（refreshNewsIndicatorAssociations） | 仅 schema 声明（env.schema.ts:144） | 与 NEWS_INDICATORS 读开关独立；只复用 MySQL 会话锁 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已刷新关联不回滚；回退后整包回 Nest（config.go:3224） | 中（跨组织刷新写） | 2 | config.go:5162/3224/6249；main.go:2406；graphqlread/newsindicatorwrite |
| `API_GO_SENTIMENT_SNAPSHOT_MODE` | news | Cron（每小时情绪快照重建） | 是（sentiment-snapshot.ingestion.service.ts:127 读取后跳过） | 与 TIMELINE 独立；共享 tick gate/组织锁 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #120：回退反向，两侧锁键相同；幂等重建，回退后 Nest 下一轮覆盖 | 中 | 3 | config.go:1694/4389/6276-6282；cmd/api/event_timeline_sentiment.go:50；apps/api/src/modules/sentiment/sentiment-snapshot.ingestion.service.ts:127 |
| `API_GO_NEWSNOW_BACKGROUND_MODE` | news | Cron（hot 分析每 10 分钟 + source-warm 每分钟） | 是（newsnow-hottest-analysis.scheduler.service.ts:40、newsnow-source-warm.scheduler.service.ts:33） | 与 hottest/sources HTTP 开关独立 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #115：回退反向；两边靠数据库条件领取互斥，短暂同时运行不会重复投递；已写入结果保留 | 中（含模型与投影写） | 3 | config.go:618/3884/5645-5651；cmd/api/newsnow_hottest.go:62；apps/api/src/modules/news-aggregator/newsnow-hottest-analysis.scheduler.service.ts:40 |
| `API_GO_NEWSNOW_CLUSTERING_OPS_MODE` | news | HTTP（9 条 NewsNow 本地计算 + 聚类失败排查，GET/POST） | 否 | 与 hottest/sources/background 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 聚类失败处理写 Mongo，回退后不回滚（未核实） | 中 | 2 | config.go:554/3868/5631-5633；main.go:694；legacyproxy/newsnow_clustering_ops_routes.go:35 |
| `API_GO_NEWSNOW_HOTTEST_MODE` | news | HTTP（2 条 GET：hottest-analysis/recommended，含 items.write 时自动导入副作用） | 仅 schema 声明（env.schema.ts:185） | 模型网关配置；与 background 调度开关独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已生成快照/投影/自动导入条目不回滚；回退后 Nest 重算（PR #115:54） | 中（读接口带写副作用：自动导入条目） | 2 | config.go:599/3876/5639；main.go:707；legacyproxy/newsnow_hottest_routes.go:21 |
| `API_GO_NEWSNOW_SOURCES_MODE` | news | HTTP（2 条：GET source、POST sources/batch，公开） | 是（config.service.ts:535 与通知 relay 判定） | 不发队列/不启调度；与 background/hottest 独立 | MySQL+Redis（仅 DATABASE_URL/REDIS_HOST） | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #94：回退后兼容缓存保留、Nest 预热照常；在途 HTTP/relay 需 drain；不发队列 | 中（64 个来源的真实上游抓取 + 凭据） | 1 | config.go:577/3892/5660-5663；cmd/api/newsnow_sources.go:47；apps/api/src/modules/config/config.service.ts:535 |

### knowledge · 知识图谱、实体情报与影响传播（4 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_GRAPHQL_KNOWLEDGE_GRAPH_MODE` | knowledge | GraphQL Query（6 个知识图谱/实体情报 root） | 否 | 双 go 才登记：READ=go 且本开关=go | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含这 6 个 root 的文档整包回 Nest（config.go:2450） | 中 | 1 | config.go:4432/2450；main.go:2255/2512；graphqlread/knowledgegraph/register.go |
| `API_GO_GRAPHQL_KG_IMPACT_MODE` | knowledge | GraphQL Query（4 个冲击传导/共现相关图 root） | 否 | 双 go 才登记：READ=go 且本开关=go | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含这 4 个 root 的文档整包回 Nest（config.go:2445） | 中 | 1 | config.go:4424/2445；main.go:2251/2507；graphqlread/kgimpact/register.go |
| `API_GO_GRAPHQL_KNOWLEDGE_REVIEW_MODE` | knowledge | GraphQL Mutation（证据人工复核写，1 个） | 否 | 与知识图谱读开关独立；不读 Mongo、不起 worker | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | GAP-KG-001 的队列遮挡修复在 #86 交付（GAPS.md:45-51）；回退后整包回 Nest，已写复核状态不回滚 | 中（人工复核写 + 审计） | 2 | config.go:4614/2604/6060；main.go:894/1225；graphqlread/knowledgereview |
| `API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE` | knowledge | Cron（5 分钟图谱自动构建：模型校验/消歧 + 事务写图） | 是（knowledge-graph.ingestion.service.ts:135 读取后跳过） | 共享 tick gate/组织锁/游标；模型上游在请求期 | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #104：回退后 Nest 从当前游标继续，Go 写入的实体/边/证据/游标保留不回滚；K2 权重修复不被撤销 | 高（模型调用 + 图事务写） | 3 | config.go:1739/3557/5358-5361；cmd/api/kg_ingestion.go:63；apps/api/src/modules/knowledge-graph/knowledge-graph.ingestion.service.ts:135 |

### crawl · 采集源、模板、画像、工作流与 Frontier（14 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_CRAWL_WORKFLOWS_MODE` | crawl | HTTP（工作流编辑/发布/版本/节点 schema/bridge，GET/PATCH/POST） | 否 | 与 profiles/templates/frontier-runs 独立；不启动采集、不入队 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | trial-run/replay/workflow-runs 仍由各自开关或 Nest 提供；回退后编辑接口回 Nest，已发布版本不回滚 | 中 | 2 | config.go:210/3706/5531；main.go:649；legacyproxy/crawl_workflows_routes.go:27 |
| `API_GO_CRAWL_PROFILES_MODE` | crawl | HTTP（8 条画像：列表/匹配/预览/创建/详情/更新/版本/回滚） | 否 | 与 workflows/templates 独立；不起采集 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 画像版本与回滚结果不回滚（未核实具体 PR 说明） | 中（版本链写） | 2 | config.go:221/3714/5534；main.go:653；legacyproxy/crawl_profiles_routes.go:24 |
| `API_GO_CRAWL_TEMPLATES_MODE` | crawl | HTTP（4 条模板 CRUD） | 否 | 与 workflows/profiles 独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 模板写入不回滚；回退后 Nest 继续（未核实） | 低 | 2 | config.go:242/3738/5543；main.go:665；legacyproxy/crawl_templates_routes.go:19 |
| `API_GO_CRAWL_FRONTIER_RUNS_MODE` | crawl | HTTP（11 条 Frontier 运行监控与取消，GET/POST） | 否 | 与 workflow-trial 独立；Frontier create/retry 仍 Nest | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 取消动作改变 Frontier 运行态（Redis/MySQL），回退后保持；已写运行记录与 Nest 同构（PR #111:136） | 中 | 2 | config.go:275/3722/5537；main.go:657；legacyproxy/crawl_frontier_runs_routes.go:40 |
| `API_GO_CRAWL_METADATA_MODE` | crawl | HTTP（1 条 POST /api/crawl-tasks/metadata，只读预览但做真实抓取） | 否 | GraphQL crawlMetadata root 另有子开关（GRAPHQL_CRAWL_METADATA_MODE，硬校验 READ=go） | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | robots/sitemap 真实网络抓取；回退后 Nest 提供同一入口（未实网验证） | 中（外部网络抓取，SSRF 面） | 1 | config.go:820/3910/5679；main.go:719；legacyproxy/crawl_metadata_routes.go:18 |
| `API_GO_CRAWL_QUEUE_OPS_MODE` | crawl | HTTP（4 条 crawl4ai 队列管理：GET queue/pause/resume/concurrency） | 否 | 与 task-write、read-telemetry 独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 队列暂停/并发是 Redis 运行态，回退后保持原样（PR #101:70） | 中（运行时队列参数） | 2 | config.go:756/3926/5691；main.go:727；legacyproxy/crawl_queue_ops_routes.go:24 |
| `API_GO_CRAWL_TASK_WRITE_MODE` | crawl | HTTP（3 条任务生命周期 POST/DELETE）+ GraphQL Mutation（create/delete/retry） | 否 | 只写 BullMQ 协议，执行仍归 CrawlQueueProcessor；不起 worker | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #101：数据/状态不回滚（已建任务、审计、清理记录保留）；回退后 Nest 接手执行 | 高（任务与队列写入） | 2 | config.go:738/3918/5685；main.go:723/899；legacyproxy/crawl_task_write_routes.go:24 |
| `API_GO_CRAWL_READ_TELEMETRY_MODE` | crawl | HTTP（7 条：任务/媒体/质量读 + POST /api/search-telemetry 遥测写） | 否 | 与 crawl worker/task-write 独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | GAP-CRAWL-001（S3 媒体下发）在 GAPS.md:90 记开放（旧基线）；本基线已有 objectstorage 注入（service_media.go:19、main.go:2273-2279），是否已修复未核实；回退后 Nest 提供同一读面 | 中（含媒体签名与遥测写） | 2 | config.go:719/3900/5669-5671；main.go:715；legacyproxy/crawl_read_telemetry_routes.go:30 |
| `API_GO_CRAWL_WORKFLOW_TRIAL_MODE` | crawl | HTTP（2 条 POST：trial-run/replay） | 否 | 与 workflows 编辑开关独立；crawl4ai 可选 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 试运行产生的运行记录与 Nest 同构（PR #111:136）；回退后两端读取都能展示 | 中（试运行会触发真实发现链） | 2 | config.go:856/3974/5725；cmd/api/crawl_discovery.go:44；legacyproxy/crawl_discovery_routes.go:38 |
| `API_GO_CRAWL_MAINTENANCE_MODE` | crawl | Cron（4 个维护任务：janitor/outbox 重放/自适应并发/质量快照） | 是（crawl-adaptive-concurrency.service.ts:92、crawl-cleanup-outbox.service.ts:51、crawl-quality-task-snapshot.service.ts:96） | SCHEDULE_ENABLED；共享锁/租约 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #119：先 api 后 api-go，回退反向；已写入数据不回滚，状态格式相同 | 中（清理/重放类定时任务，幂等） | 3 | config.go:779/3937/5697-5703；cmd/api/crawl_maintenance.go:99；apps/api/src/modules/crawl/crawl-cleanup-outbox.service.ts:51 |
| `API_GO_CRAWL_WORKER_MODE` | crawl | worker（crawl4ai / crawl4ai-hot / crawl4ai-normal 三队列） | 是（config.service.ts:1338 getter；crawl.processor.ts:520 不建 Worker） | BULLMQ_WORKERS_ENABLED；CRAWL4AI_BASE_URL；SYSTEM_SETTINGS_ENCRYPTION_KEY；C2 并发广播 | MySQL+Redis+Mongo+crawl4ai+SSK | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #135：回退后 B1/B2/B3 修复失效（重复扣减、失败计数丢失、legacy socket 无实时推送会重新出现）；回退反向即可，队列数据格式不变 | 高（三条采集队列 + 外部 crawl4ai） | 4 | config.go:1829/3601/5409-5421；cmd/api/crawl_worker.go:116；apps/api/src/modules/config/config.service.ts:1338 |
| `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE` | crawl | worker（frontier-llm-judge / frontier-llm-learn 两队列） | 是（config.service.ts:1325 getter） | BULLMQ_WORKERS_ENABLED；与 CRAWL_WORKER 独立；SYSTEM_SETTINGS_ENCRYPTION_KEY | MySQL+Redis+SSK | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #125：回退反向；队列名/任务数据/limiter 键不变，切换期共用同一限速键；回退后 B1 修复失效 | 高（模型判定 worker + 限速键共享） | 4 | config.go:1803/3593/5391-5397；cmd/api/crawl_frontier_llm.go:34；apps/api/src/modules/config/config.service.ts:1325 |
| `API_GO_GRAPHQL_CRAWL_METADATA_MODE` | crawl | GraphQL Query（crawlMetadata 单 root） | 否 | 硬校验：READ=go（config.go:5747-5748）；与 HTTP metadata 开关共用 service | MySQL+JWT+Redis+Mongo（由 READ=go 带入） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含 crawlMetadata 的文档整包回 Nest（config.go:2479）；无数据回滚 | 低 | 1 | config.go:4465/2479/5748；main.go:1266/2290；graphqlread/crawlmetadata/register.go |
| `API_GO_NEWS_SOURCE_PREVIEW_MODE` | crawl | HTTP（1 条 GET /api/admin/news-sources/:id/preview） | 否 | crawl4ai 可选（未配置时深度发现返回 SEED_DEEP_CRAWL4AI_UNAVAILABLE） | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读入口，无行写入、不入队（config.go:838 类型注释）；回退后 Nest 提供同一预览 | 中（真实抓取 + SSRF 面） | 1 | config.go:838/3964/5720；cmd/api/crawl_discovery.go:43；legacyproxy/crawl_discovery_routes.go:21 |

### situation · 态势监控、地理与实时信号（10 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_SITUATION_MONITORS_MODE` | situation | HTTP（5 条自定义监控 CRUD） | 否 | 与 signals/insights/refresh/telegram 独立；模型与 Nominatim 不是启动条件 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 监控配置不回滚；回退后 Nest 继续（未核实具体 PR 说明） | 低 | 2 | config.go:1391/3674/5525；main.go:620；legacyproxy/proxy.go:358 |
| `API_GO_SITUATION_MONITOR_SIGNALS_MODE` | situation | HTTP（7 条信号读与反馈：catalog/feedback/telegram-feed/oref-alerts/oref-history/live-hls/refresh-runs） | 否 | 与 signals worker 开关独立：本开关不刷新缓存 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | Go 只读缓存，不刷新；回退后 Nest 继续读同一 Redis 缓存（DEPENDENCIES.md:73） | 中（外部信号状态读） | 1 | config.go:1402/4293/6102-6104；main.go:624；legacyproxy/situation_signals_routes.go:38 |
| `API_GO_SITUATION_INSIGHTS_MODE` | situation | HTTP（1 条 GET /api/situation-monitor/insights，含完整读取与分析链） | 否 | 与 refresh/settings 独立；不重建缓存 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #103：回退只改开关；Redis 缓存格式与 Nest 相同（core 45s/external 300s/同名 lock），Nest 可直接读；无数据回滚 | 中（读缓存；跨租户清缓存的既有副作用见 PR #134:73） | 1 | config.go:1425/4301/6134-6136；main.go:634；legacyproxy/situation_insights_routes.go:20 |
| `API_GO_SITUATION_SETTINGS_MODE` | situation | HTTP（4 条 GET/PUT/DELETE 设置与 Telegram 登录注销） | 否（按 #117 设计不写入 Nest schema） | 与 refresh/telegram-auth 独立；SYSTEM_SETTINGS_ENCRYPTION_KEY 必填 | MySQL+JWT+Redis+Mongo+SSK | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #117：回滚只改变量；存储与加密格式相同，Nest 可直接读 Go 写入的设置；两个定时任务的 Redis 格式相同 | 中（含加密设置写） | 2 | config.go:1449/4309/6146-6151；main.go:759；legacyproxy/situation_settings_routes.go:24 |
| `API_GO_SITUATION_REFRESH_MODE` | situation | HTTP（1 条 POST /api/situation-monitor/refresh） | 仅 schema 声明（env.schema.ts:976） | 硬校验：SITUATION_SIGNALS_WORKER=go 且 NEWS_SOURCE_SCHEDULER=go（config.go:6175-6180） | MySQL+JWT+Redis | 仅 api-go；但两个前置开关必须先按「先 api 后 api-go」切完 | 改回 legacy 重启 api-go（前置开关保持 go 可继续运行） | PR #134：回退后接口回 Nest，刷新记录格式两端相同；B2 只影响 Go worker（Nest 持有 Telegram 会话时 Go worker 不执行） | 高（Telegram 会话唯一租约 + 前置强耦合） | 2 | config.go:1508/4328/6175-6180；cmd/api/situation_refresh.go:53；legacyproxy/situation_refresh_routes.go:27 |
| `API_GO_SITUATION_SIGNALS_WORKER_MODE` | situation | worker（situationMonitorSignals 队列：Telegram 轮询 + OREF 警报轮询 + repeat 注册） | 是（situation-monitor-signals.processor.ts:59 不建 Worker；events subscriber :141） | BULLMQ_WORKERS_ENABLED；SITUATION_REFRESH 的前置；Telegram 单实例租约 | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #129：回退按相反顺序；会话字符串、Redis 状态与队列/重复任务协议两端相同，回退不需要重新登录；真实 Telegram/OREF 未联调（PR #129:69） | 高（Telegram 会话唯一性 + 外部轮询） | 4 | config.go:1477/4317/6160-6163；cmd/api/situation_signals_worker.go:46；apps/api/src/modules/situation-monitor/signals/situation-monitor-signals.processor.ts:59 |
| `API_GO_SITUATION_TELEGRAM_AUTH_MODE` | situation | HTTP（2 条 POST：telegram-auth start/complete） | 仅 schema 声明（env.schema.ts:983） | 与 settings/worker 独立；SYSTEM_SETTINGS_ENCRYPTION_KEY 必填 | MySQL+JWT+Redis+Mongo+SSK | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已写入的会话与待处理请求不回滚；回退后 Nest 提供同一入口（未实网验证 Telegram 登录） | 中（Telegram 登录 + 会话加密写） | 2 | config.go:1533/4336/6188-6193；main.go:919；legacyproxy/situation_telegram_auth_routes.go:20 |
| `API_GO_GDELT_SNAPSHOT_MODE` | situation | Cron（15 分钟 GDELT 外部快照重建） | 是（situation-monitor-external-snapshot.service.ts:137 读取后直接返回） | 与 refresh 开关独立；共享 Redis 重建租约 lock:cron:situation-monitor:external-snapshot:gdelt | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #110：回退分「流量回退」与「定时回退」两步，定时回退按相反顺序；历史快照与两层 Redis 缓存保留，格式与 Nest 相同 | 中（外部 GDELT 抓取 + 租约） | 3 | config.go:1548/4347/6289-6292；cmd/api/gdelt_snapshot.go:38；apps/api/src/modules/situation-monitor/situation-monitor-external-snapshot.service.ts:137 |
| `API_GO_GDELT_SNAPSHOT_REFRESH_MODE` | situation | HTTP（1 条 POST external-snapshot/refresh） | 否（只有 Go 读该变量，Nest 继续提供控制器） | 与 GDELT_SNAPSHOT 独立；共享同一重建租约 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #110：流量回退只改本开关，POST 回 Nest，不需重启定时任务所有权；已写快照不回滚 | 中（强刷会触发真实外部抓取） | 2 | config.go:1567/4368/6312；cmd/api/gdelt_snapshot.go:69；legacyproxy/gdelt_snapshot_routes.go:25 |
| `API_GO_REALTIME_SIGNALS_MODE` | situation | Cron（每分钟实时信号采集：8 个来源 → 一个洞察快照） | 是（realtime-signals.service.ts:120 读取后返回） | 全有或全无：不能把来源集拆到两个进程；共享 tick gate 与组织租约 | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #121：回退到 legacy 后按组织预扣的问题重新出现（每轮共享预扣失效，PR #121:39/60）；额度/令牌/状态在共享 Redis/MySQL，Nest 可直接沿用 | 高（外部 API 额度账本 + 8 来源） | 3 | config.go:1589/4358/6300-6306；cmd/api/realtime_signals.go:34；apps/api/src/modules/realtime-signals/realtime-signals.service.ts:120 |

### settings · 设置中心与平台治理（12 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_RUNTIME_SETTINGS_MODE` | settings | HTTP（18 条 /api/system-settings 运行与治理设置，GET/POST/PUT/DELETE） | 否 | 与 platform-governance/infrastructure 等独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 设置与缓存写入不回滚；回退后 Nest 读同一 SystemSetting/Redis（PR 未见专门回退章节，未核实） | 中（全局运行参数写） | 2 | config.go:1014/3992/5763；main.go:743；legacyproxy/runtime_settings_routes.go:46 |
| `API_GO_DATA_RUNTIME_SETTINGS_MODE` | settings | HTTP（9 条数据运行设置与归档状态，GET/PUT/DELETE） | 否 | 与 archive 读/worker 开关独立；不要求 Mongo | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | OBS-DATA-001：main.go 会吞掉 wireDataRuntimeSettings 的错误（GAPS.md:142），当前是否可达未证实；回退后设置回 Nest 读写 | 中（设置写 + 归档状态） | 2 | config.go:1045/4000/5874；main.go:791；legacyproxy/data_runtime_settings_routes.go:40 |
| `API_GO_INFRASTRUCTURE_SETTINGS_MODE` | settings | HTTP（7 条：vector 3 + storage 2 + 新闻源运行时密钥 2） | 否 | 与 STORAGE_DIAGNOSTICS 独立；不要求 Mongo/S3 实网 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 密钥写入不回滚；回退后 Nest 读同一加密设置（未核实具体 PR 说明） | 中（含凭据加密写） | 2 | config.go:905/4091/5859；main.go:781；legacyproxy/infrastructure_settings_routes.go:34 |
| `API_GO_PLATFORM_GOVERNANCE_SETTINGS_MODE` | settings | HTTP（16 条平台治理设置，含配额/安全/日志策略） | 否 | governance 默认值解析错误只在本开关 go 时升级为启动失败（config.go:4047-4049） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 治理设置写入不回滚；回退后 Nest 读同一 SystemSetting | 中（配额/安全策略写） | 2 | config.go:1193/4034/5576-5578；main.go:755；legacyproxy/platform_governance_settings_routes.go:50 |
| `API_GO_MODEL_ACCESS_SETTINGS_MODE` | settings | HTTP（10 条模型服务配置与 OpenAI key 下发/内部接口） | 否 | 与 LLM_GATEWAY_PROFILES/OPS、PROXY_LOAD_BALANCING 独立；不访问真实 LiteLLM | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 密钥指纹与下发记录不回滚；回退后 Nest 继续管理（未核实具体 PR 说明） | 中（模型密钥下发） | 2 | config.go:1233/4053/5772；main.go:763；legacyproxy/model_access_settings_routes.go:42 |
| `API_GO_EMAIL_SETTINGS_MODE` | settings | HTTP（3 条：GET 设置、PUT auth-code、POST test） | 否 | SMTP_* 必填（状态接口做真实 SMTP verify、测试接口发真实邮件） | MySQL+JWT+Redis+SMTP | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #102：回滚只改开关并重启；已写入的验证码设置与已发邮件保留，缓存格式与 Nest 相同 | 中（真实 SMTP 外发） | 2 | config.go:1069/4008/5880-5891；cmd/api/settings_diagnostics.go:31；legacyproxy/email_settings_routes.go:22 |
| `API_GO_GEOCODING_MODE` | settings | HTTP（2 条 POST，只读 + 缓存：geocode 与 nominatim test） | 否 | 不要求 Mongo；Nominatim 只在请求期调用 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #102：共享 geo:geocode:v1 缓存与 geocode:nominatim 限流；回退后 Nest 直接读同一缓存 | 低（请求期外部地理编码） | 1 | config.go:1090/4016/5898；cmd/api/settings_diagnostics.go:79；legacyproxy/geocoding_routes.go:19 |
| `API_GO_RUNTIME_DIAGNOSTICS_MODE` | settings | HTTP（2 条只读诊断：assistant-safety/diagnostics、realtime-signals/runtime） | 否 | assistant 安全探测会调 LiteLLM（请求期） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读，无写入回滚；回退后由 Nest 执行同一探测（PR #102） | 低 | 1 | config.go:1110/4024/5905-5907；cmd/api/settings_diagnostics.go:129；legacyproxy/runtime_diagnostics_routes.go:22 |
| `API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE` | settings | GraphQL Query（20 个 root：设置中心 20 项、来源策略与同步状态、KG 证据复核队列、crawlTask(s)） | 否 | 双 go 才登记：READ=go 且本开关=go；同时决定设置写/任务写是否复用已注册模型 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后含这些 root 的文档整包回 Nest（config.go:2469）；无数据回滚 | 中（设置中心读面，root 最多） | 1 | config.go:4454/2469；main.go:2210/2273；graphqlread/settingscrawl/register.go |
| `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | settings | GraphQL Mutation（13 个设置写） | 否 | 与 READ 独立；不读 Mongo、不起 worker | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | GAP-GQL-001（旧基线接线漏项）在 #82 后仍按文档跟踪（GAPS.md:63-74）；回退后整包回 Nest，已写设置与审计 outbox 不回滚 | 高（全站设置写） | 2 | config.go:4592/2576/6048；main.go:893/2192；graphqlread/settingswrite/register.go |
| `API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE` | settings | GraphQL Mutation（4 个来源策略写，含版本链） | 否 | 与设置写/读独立；不读 Mongo | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退只改开关；已存 v2 状态、legacy 文档与预设保留（config.go:2591 字段注释）；整包回 Nest | 高（策略版本链写） | 2 | config.go:4603/2591/6054；main.go:893/1221；graphqlread/settingswrite（RegisterSourcePolicy） |
| `API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE` | settings | GraphQL Mutation（8 个组织/角色/成员写） | 否 | 与 READ 独立；只读 MySQL+Redis，不要 Mongo | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后整包回 Nest（config.go:2531）；已写成员/角色与缓存失效不回滚 | 高（组织权限写） | 2 | config.go:4559/2531/6030；main.go:892/1209；graphqlread/orgaccesswrite/register.go |

### model-gateway · 模型接入、密钥与 LLM 网关（3 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_LLM_GATEWAY_PROFILES_MODE` | model-gateway | HTTP（7 条 LLM 网关 profile 配置/激活） | 否 | 与 model-access/proxy-LB 独立；不要求真实模型上游 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | profile 与激活状态写入不回滚；回退后 Nest 读同一设置（未核实具体 PR 说明） | 中（影响全站模型路由） | 2 | config.go:1310/4061/5831；main.go:767；legacyproxy/llm_gateway_profiles_routes.go:40 |
| `API_GO_LLM_GATEWAY_OPS_MODE` | model-gateway | HTTP（12 条治理与真实探测：proxy-governance/models-config/test-config/各类探测） | 否 | 每次真实探测写 Mongo（Mongo 必填） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 探测记录写 Mongo 不回滚；回退后由 Nest 提供探测（PR #81 未给回退章节，未核实） | 中（真实上游探测 + 密钥轮换） | 2 | config.go:1346/4072/5839-5841；main.go:773；legacyproxy/llm_gateway_ops_routes.go:38 |
| `API_GO_PROXY_LOAD_BALANCING_MODE` | model-gateway | HTTP（4 条：proxy-load-balancing GET/PUT/DELETE + 内部 GET） | 否 | 与 MODEL_ACCESS_SETTINGS 独立（复用其 key 读取但不互相启用） | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | LB 配置与下发结果不回滚；回退后 Nest 重新下发（未核实） | 中（模型负载均衡配置） | 2 | config.go:1373/4083/5851；main.go:777；legacyproxy/proxy_load_balancing_routes.go:30 |

### infrastructure-data · 基础设施、采集凭据与数据运行（1 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_STORAGE_DIAGNOSTICS_MODE` | infrastructure-data | HTTP（1 条 POST /api/admin/settings/storage/test） | 否 | 与 INFRASTRUCTURE_SETTINGS、CRAWL_READ_TELEMETRY 独立；不要求 Mongo | MySQL+JWT+Redis（S3/MinIO 仅请求期） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 诊断会写/删自己的唯一测试对象，回退后无残留（DEPENDENCIES.md:82）；实桶未验证（GAPS.md:143 VERIFY-EXT-001） | 中（真实存储读写探测） | 2 | config.go:937/4103/5867；main.go:787；legacyproxy/storage_diagnostics_routes.go:25；internal/objectstorage |

### observability · 日志、异常、质量、遥测与运维（15 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_LLM_LOGS_MODE` | observability | HTTP（3 条只读 GET：llm-logs、export、summary） | 否 | 不接管 api/system-settings/llm-request-logs（会改 Mongo TTL 索引，仍留 Nest） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；回退后 Nest 读同一 Mongo（未核实具体 PR 说明） | 低 | 1 | config.go:287/3746/5546-5548；main.go:669；legacyproxy/llm_logs_routes.go:22 |
| `API_GO_ADMIN_LOGS_MODE` | observability | HTTP（7 条 GET：任务日志/异常/审计日志及其汇总） | 否 | 与 EXCEPTION_INGEST 独立（后者管异常上报 POST） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；/api/admin/quality/、/api/observability/ 与 /api/metrics 仍回 Nest（config.go:298-305） | 低 | 1 | config.go:298/3755/5553-5555；main.go:674；legacyproxy/admin_logs_routes.go:25 |
| `API_GO_EXCEPTION_INGEST_MODE` | observability | HTTP（2 条 POST：客户端异常上报 + LiteLLM 内部异常上报） | 否 | 内部 token 在请求期校验（缺 token 是 403，不是启动失败） | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 已写入的异常事件不回滚；回退后上报回 Nest（未核实） | 中（写 Mongo + 内部鉴权） | 2 | config.go:317/3763/5563-5565；main.go:678；legacyproxy/exception_ingest_routes.go:24 |
| `API_GO_QUALITY_OVERVIEW_MODE` | observability | HTTP（5 条 GET：质量面板 news-sources/pipeline/overview/task-logs） | 否 | 与 CLASSIFICATION_REPORTS/RSS_OPS 独立；共享 60 秒快照与 Redis 锁 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；api/admin/quality/classification/* 与 pipeline runs/replay 仍回 Nest | 低 | 1 | config.go:351/3779/5582-5584；main.go:686；legacyproxy/quality_overview_routes.go:25 |
| `API_GO_CLASSIFICATION_REPORTS_MODE` | observability | HTTP（1 条 POST 创建分类报告 + 入队 classification_quality） | 仅 schema 声明（env.schema.ts:58） | 只入队，不消费（消费归 CLASSIFICATION_QUALITY_WORKER）；GET reports/:jobId 归 RSS_OPS 开关 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #107：回滚分三件事（流量/worker/数据）；已写入报告、评审与克隆的 RawItem/ProcessedItem 都保留；队列任务格式两侧相同 | 中（Mongo 文档 + 入队） | 2 | config.go:404/3796/5597-5599；cmd/api/quality_ops.go:60；legacyproxy/classification_reports_routes.go:25 |
| `API_GO_CLASSIFICATION_RSS_OPS_MODE` | observability | HTTP（13 条：分类质量工作台 7 + RSS 诊断 4 + RSS 翻译日指标 1） | 否 | 与 CLASSIFICATION_REPORTS/QUALITY_WORKER 独立，可任意顺序组合 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #107：回滚只改开关；已写入的分类评审与指标不回滚 | 中（含评审决策写） | 2 | config.go:383/3787/5588-5590；cmd/api/classification_rss_ops.go:37；legacyproxy/classification_rss_ops_routes.go:37 |
| `API_GO_CLASSIFICATION_QUALITY_WORKER_MODE` | observability | worker（classification_quality 队列消费） | 是（classification-quality.processor.ts:36 不建 Worker） | BULLMQ_WORKERS_ENABLED；不要求 JWT | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #107：回滚按相反顺序（先停 Go worker，再由 Nest 消费）；数据不回滚 | 中（双消费风险由 Nest 不建 Worker 防护） | 4 | config.go:428/3804/5607-5613；cmd/api/quality_ops.go:61；apps/api/src/modules/observability/classification-quality.processor.ts:36 |
| `API_GO_PIPELINE_RECOVERY_MODE` | observability | HTTP（1 条 GET /api/admin/quality/pipeline/runs） | 仅 schema 声明（env.schema.ts:72） | 与 PIPELINE_RECOVERY_WRITE 独立（读写可分开切） | MySQL+JWT+Mongo（不需要 Redis） | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 只读；回退后 Nest 提供 runs 读（replay/rollback 仍由写开关决定） | 低 | 1 | config.go:446/3812/5620-5626；cmd/api/quality_ops.go:62；legacyproxy/pipeline_recovery_routes.go:26 |
| `API_GO_PIPELINE_RECOVERY_WRITE_MODE` | observability | HTTP（2 条 POST：pipeline replay/rollback） | 仅 schema 声明（env.schema.ts:96） | 与 PIPELINE_RECOVERY 读开关独立 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 重放/回滚会改 ItemMeta/ProcessedItem 状态，回退后不回滚（PR #127:113-114） | 高（批量重放/回滚，具破坏性） | 2 | config.go:493/3836/5495-5497；cmd/api/nest_residual_duties.go:194；legacyproxy/pipeline_recovery_routes.go:42 |
| `API_GO_METRICS_MODE` | observability | HTTP（1 条 GET /api/metrics） | 仅 schema 声明（env.schema.ts:103） | 需要 metrics.read + 平台管理员；不使用 client_golang（自研注册表） | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #127：接口类只切 api-go，回退改回 legacy，Nest 控制器未改；无数据回滚 | 中（监控采集中断即告警盲区） | 1 | config.go:508/3844/5501；cmd/api/nest_residual_duties.go:237；legacyproxy/metrics_routes.go:15 |
| `API_GO_AUDIT_LOG_RETENTION_MODE` | observability | Cron（每日 01:00 审计日志清理） | 是（audit-log-retention.service.ts:26 读取后返回） | 共享留存缓存键；不需要 JWT/Mongo | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #119：已删除数据不可恢复（清理类任务天然不可回滚）；回退后 Nest @Cron 恢复 | 中（删除类任务，不可逆） | 3 | config.go:795/3945/5710-5713；cmd/api/crawl_maintenance.go:100；apps/api/src/modules/rbac/audit-log-retention.service.ts:26 |
| `API_GO_BULLMQ_CLEANUP_MODE` | observability | Cron/启动任务（保留 job 清理：启动即跑一次 + 每小时） | 是（bullmq-queue-cleanup.service.ts:96 直接读 process.env） | 清理幂等，切换期短暂重叠无害；租约 lock:cron:bullmq-retained-cleanup | Redis（仅 REDIS_HOST） | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #127：清理幂等，短暂双跑安全；回退后 Nest 恢复各进程 timer | 低（幂等清理） | 3 | config.go:461/3820/5489；cmd/api/nest_residual_duties.go:108；apps/api/src/common/bullmq-queue-cleanup.service.ts:96 |
| `API_GO_STARTUP_RECONCILE_MODE` | observability | 启动任务（TaskLog/LLM 日志 TTL 索引 + 可选 ES items 索引对齐） | 是（llm-request-log-settings.service.ts:170、items-elasticsearch.service.ts:225） | 启动租约 startup:reconcile；Mongo/MySQL/ES 失败只告警不阻塞 | Redis（+Mongo/ES 可选） | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #127：启动对齐有租约，短暂双跑安全；回退后 Nest onModuleInit 恢复 | 低（启动对齐，失败仅告警） | 3 | config.go:524/3852/5504；cmd/api/nest_residual_duties.go:268；apps/api/src/modules/system-settings/llm-request-log-settings.service.ts:170 |
| `API_GO_AUDIT_OUTBOX_MODE` | observability | Cron（每分钟 AuditLogOutbox 重放） | 是（audit-log-outbox.service.ts:401 读取后返回） | SCHEDULE_ENABLED；只需 MySQL+Redis，不需要 JWT/Mongo/SMTP | MySQL+Redis | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #92：回滚停 Go 并 drain → 恢复 Nest；旧版本不识别 gate 时须先升级或停止；共享锁不替代执行所有权切换 | 中（重放去重，双跑由租约限制） | 3 | config.go:1661/3549/5344-5347；cmd/api/audit_outbox.go:22；apps/api/src/modules/audit/audit-log-outbox.service.ts:401 |
| `API_GO_CLASSIFICATION_REVIEW_SEED_MODE` | observability | worker 事件（消费 itemPipeline 队列事件 → 入队分类复核样本） | 是（classification-quality-seed-trigger.service.ts:31 读取后不监听） | 依附 itemPipeline 事件读者；jobId 稳定幂等；只需 Redis | Redis（仅 REDIS_HOST） | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #127：复核样本 jobId 幂等，短暂双跑安全；回退后 Nest 监听恢复 | 低（幂等入队，不消费业务队列） | 4 | config.go:478/3828/5492；cmd/api/nest_residual_duties.go:160；apps/api/src/modules/observability/classification-quality-seed-trigger.service.ts:31 |

### assistant · Assistant 与模型任务（2 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ASSISTANT_WORKER_MODE` | assistant | worker（assistant 队列消费） | 是（assistant.processor.ts:37 读取后只保留 Queue/QueueEvents） | BULLMQ_WORKERS_ENABLED；与 ASSISTANT_WRITE 独立；不需要 JWT | MySQL+Redis+Mongo | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #109：worker 回退按相反顺序，Mutation 回退改写开关；已写运行记录与请求日志保留，不回滚 | 高（模型执行 worker，双消费即重复跑） | 4 | config.go:4682/2637/6088-6094；cmd/api/assistant_runs.go:105；apps/api/src/modules/assistant/assistant.processor.ts:37 |
| `API_GO_GRAPHQL_ASSISTANT_WRITE_MODE` | assistant | GraphQL Mutation（4 个：提交/执行/删除等） | 否 | 与 assistant worker 独立；只入队不消费 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #109：Mutation 改回 legacy 即可；已写入运行记录与日志保留 | 中（助手写入 + 入队） | 2 | config.go:4671/2629/6079-6081；main.go:901/1233；graphqlread/assistantwrite/register.go |

### economic · 经济数据与 AkShare（2 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ECONOMIC_DATA_MODE` | economic | HTTP（3 条 AkShare 网关管理 GET/POST）+ GraphQL Mutation（3 个经济数据请求） | 仅 schema 声明（env.schema.ts:160） | 与 ECONOMIC_DATA_WORKER 独立；Mongo 不是启动条件 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #99：回退请求开关只把新 Mutation/升级请求交回 Nest；已入队 job、已写数据点与已发升级不撤销 | 中（AkShare 真实上游 + 队列） | 2 | config.go:1706/4634/6110-6116；cmd/api/economic_data.go:88；legacyproxy/economic_data_routes.go:18 |
| `API_GO_ECONOMIC_DATA_WORKER_MODE` | economic | worker（akshare-data 消费 + 目录/repeat 同步） | 是（akshare.processor.ts:39、akshare.service.ts:158） | BULLMQ_WORKERS_ENABLED；不需要 JWT | MySQL+Redis+Mongo | 先停全部 Nest akshare worker 并等在途 job → 再 api=go → api-go=go（PR #99:33） | 回退 worker 先停 Go 并等在途抓取 → 恢复 Nest；Nest 启动会重新对齐目录与 repeat | PR #99：不 drain、不删除已有 repeat job；已入队 job 与已抓取数据点不撤销 | 高（外部 AkShare + repeat 任务所有权） | 4 | config.go:1718/4642/6121-6127；cmd/api/economic_data.go:89；apps/api/src/modules/akshare/akshare.processor.ts:39 |

### archive · 归档阅读与准备任务（2 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_ARCHIVE_READING_MODE` | archive | GraphQL Query（3 个：archiveDigest/archiveCalendar/archiveDetail）+ HTTP（1 条 POST search 导出） | 否 | 独立于 READ 与 ANALYSIS_EXPORT；单开即装配 GraphQL handler 与 search 导出 | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | PR #97：回滚改回 legacy 并重启；已入队 job 继续由 NestJS 消费，不清缓存/队列 | 中（归档读 + search 导出） | 1 | config.go:1902/3648/5471-5473；main.go:615/618；legacyproxy/archive_reading_routes.go:12；graphqlread/archivereading |
| `API_GO_ARCHIVE_PREPARATION_WORKER_MODE` | archive | worker（archivePreparation 队列消费） | 是（archive-preparation.processor.ts:42 不建 Worker） | BULLMQ_WORKERS_ENABLED；SYSTEM_SETTINGS_ENCRYPTION_KEY（解密网关密钥） | MySQL+Redis+Mongo+SSK | 先 api=go 重启 → 再 api-go=go 重启；回退反向 | 先 api-go 回 legacy → 再 api 回 legacy；数据/队列格式两端相同 | PR #126：回退反向；队列任务格式不变，回退后 Nest 可续消费，但 B1 问题会重新出现（PR #126:68） | 高（准备链写状态 + 分类写入幂等） | 4 | config.go:664/5146/6222-6231；cmd/api/archive_preparation_worker.go:62；apps/api/src/modules/archive/archive-preparation.processor.ts:42 |

### async-runtime · 队列、调度、Outbox 与实时传输（3 个开关）

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_GRAPHQL_READ_MODE` | async-runtime | GraphQL Query（总读开关：注册 alerts 4 + history 6 + economic 6 = 16 个 root，并装配 /graphql executor） | 否 | 子开关（NEWS_EVENTS/KG_IMPACT/KNOWLEDGE_GRAPH/WORKSPACE_READ/SETTINGS_CRAWL_READ/ITEMS_LIST/CRAWL_METADATA/BRIEF）都要求本开关=go | MySQL+JWT+Redis+Mongo | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后 /graphql 整份回 Nest（mutation、subscription、未迁 query 本来就走 Nest）；无数据回滚 | 高（全站 GraphQL 读入口，错误即整站读失败） | 1 | config.go:4183/2394/5986-5988；main.go:892/2199-2220；legacyproxy/proxy.go:432 |
| `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | async-runtime | GraphQL Subscription（4 个：alertEvents/analysisEvents/assistantEvents/queueEvents，graphql-transport-ws upgrade） | 否（Nest 仍是 producer/backplane 且保留自己的订阅执行，但不读该变量） | 硬校验 GRAPHQL_SUBSCRIPTION_BUS=redis（config.go:4213-4214）；与全部读写开关独立 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启/排空 Go WebSocket；客户端重连后整条 upgrade 回 Nest | PR #95：回退后 Nest producer/worker/WS 与既有 Redis 数据无需清理；同连接非本批 operation 始终整份转 Nest | 高（实时订阅传输 + WS 生命周期） | 5 | config.go:1970/4194/4214/5994；main.go:887/2651；apps/api/src/modules/graphql-subscriptions |
| `API_GO_HEALTHZ_MODE` | async-runtime | HTTP（1 条认证版 GET /api/healthz） | 否 | 不改变公开探针 GET /api/healthz/live（始终 shadow，Nest 响应；proxy.go:135） | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 legacy 重启 api-go | 回退后认证探针回 Nest；/api/healthz/live 仍是 shadow，没有对应开关（阶段 6 的「/live 改 go」当前无开关可改，见未核实项） | 中（探针语义错误会影响编排与告警） | 6 | config.go:171/3507/5287-5293；main.go:581；legacyproxy/proxy.go:411（live 见 :135） |

### vector · 独立 Go 服务与 vector 上游切换（0 个开关）

`vector` 域没有 `API_GO_*` 开关：vector 是独立进程 `apps/vector-go`（三 HTTP + 内部 token + orgId 过滤），与 api-go 的开关矩阵无交集；上游切换属独立部署决策（`DEPENDENCIES.md:104`）。


### ops-entrypoints · 停 Nest 收尾（refactor/go-ops-entrypoints 新增 4 个开关）

本小节由 `refactor/go-ops-entrypoints` 追加，对应审计 C-1/C-5/C-7/C-9。四个开关都不属于迁移地图的 18 个产品域，因此单列；它们同样由 `api-go` 独占读取，NestJS 不读，切换只需要重启 `api-go`。

| 开关 | 域 | 类别 | Nest 同读 | 依赖（开关/配置） | 所需资源 | 切换顺序 | 回退方式 | 回退后已知问题 | 风险 | 阶段 | 证据 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `API_GO_HEALTHZ_LIVE_MODE` | ops-entrypoints | HTTP（1 条公开 GET /api/healthz/live，仅 exact GET） | 否 | 无其它开关；POST/HEAD/相似路径继续回落 /api/ legacy | 无（handler 不读数据库、缓存或密钥） | 仅 api-go（Nest 不读该值） | 改回 `shadow` 重启 api-go（**默认值就是 shadow，不是 legacy**） | 回退后 live 恢复「Nest 应答 + Go 差分」；compose api healthcheck 与 Web 启动等待重新依赖 Nest 进程 | 低（纯 handler，默认 shadow 已是现网行为） | 6 | config.go:187/2342/3580/5395-5401；legacyproxy/healthz_live_routes.go；cmd/api/main.go 的规则与 handler 注册 |
| `API_GO_LEGACY_FALLBACK_MODE` | ops-entrypoints | 网关回落策略（不新增路由） | 否 | `reject` 要求其余全部 `*Mode` 字段为 `go`，由反射校验保证（豁免表只有本开关自身，config.go:6865-6911） | `reject` 无；`proxy` 使用 `LEGACY_API_URL` | 仅 api-go（且必须在阶段 6b、所有开关为 go 之后） | 改回 `proxy` 重启 api-go；**前提是 Nest 仍在运行** | reject 期间被拒绝的请求不会补发/drain，`api_go_legacy_rejected_requests_total{route_prefix}` 保留分布；回退后未迁移路径恢复代理 | 高（在所有开关 go 之前误开会把未迁移入口变成 404，而非代理） | 6 | config.go:201/2346/3590/5406-5410；legacyproxy/proxy.go 的 `proxyLegacy`；metrics/families.go |
| `API_GO_DOCS_MODE` | ops-entrypoints | HTTP（`/docs`、`/docs/`、`/docs/json` 与 Swagger UI 静态资源） | 否 | 是否实际提供文档由 `SWAGGER_ENABLED` 决定（未设置时 NODE_ENV=production 为 false，否则 true）；false 时返回与 C-9 相同的 404 | 无 | 仅 api-go（Nest 不读该值） | 改回 `legacy` 重启 api-go | 回退后 `/docs` 重新代理 Nest；Go 侧只读嵌入快照，无写入、无缓存数据需要清理。`/docs-yaml` 未实现，见「未核实项」 | 低（公开只读文档） | 6 | config.go:212/2349/3598/5398-5402；internal/apidocs；legacyproxy/docs_routes.go |
| `API_GO_VECTOR_DIAGNOSTICS_MODE` | settings | HTTP（1 条 GET /api/system-settings/vector-service/diagnostics） | 否 | 与 `API_GO_INFRASTRUCTURE_SETTINGS_MODE` 独立；复用同一 settings 读取与鉴权栈；报告本进程共享的 vector 健康状态 | MySQL+JWT+Redis | 仅 api-go（Nest 不读该值） | 改回 `legacy` 重启 api-go | 回退后诊断回到 Nest 进程内计数器；api-go worker 的共享不可用窗口（B1 修复）不受本开关影响，继续生效 | 低（只读诊断） | 1 | config.go:223/2352/3606/5403；internal/vectorclient/health.go；internal/infrastructuresettings/vector_diagnostics.go；legacyproxy/vector_diagnostics_routes.go |


## 高风险开关 Top 10

排序按「切错的影响面 × 回退代价」，全部为矩阵中 `高` 风险行：

| # | 开关 | 为什么高风险 | 关键约束/证据 |
|---|---|---|---|
| 1 | `API_GO_GRAPHQL_READ_MODE` | 全站 `/graphql` 执行器的总开关，16 个 root + 8 个子开关的父级；执行器装配失败即整站读不可用 | main.go:2199-2220、config.go:5986-5988 |
| 2 | `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` | WebSocket upgrade 与四条实时订阅；必须 `GRAPHQL_SUBSCRIPTION_BUS=redis`，本地总线直接启动失败 | config.go:4213-4214、main.go:2651 |
| 3 | `API_GO_REALTIME_SOCKET_MODE` | 五个 namespace + 反代 + Web 重建三件事；硬依赖 `WS_REDIS_ADAPTER_ENABLED=true`；Nest 基线 situation 广播本身有缺陷 | config.go:6004-6008、PR #131:107、#131:60 |
| 4 | `API_GO_ITEM_PIPELINE_WORKER_MODE` | 条目流水线核心消费者，双消费即重复处理；要求 MySQL/Mongo/Redis/SSK 全套 | config.go:681、apps/api/src/modules/queue/queue.processor.ts:97 |
| 5 | `API_GO_CRAWL_WORKER_MODE` | 三条 crawl4ai 队列 + 外部 crawl4ai + 队列级限速/C2 广播；回退后 B1/B2/B3 修复失效 | config.go:5409-5421、PR #135:87 |
| 6 | `API_GO_NEWS_SOURCE_SCHEDULER_MODE` | 30 秒调度是下游采集 worker 的派发源；也是 `SITUATION_REFRESH` 的硬前置；失败时不自动重放 | config.go:5732-5735、PR #118:41-42 |
| 7 | `API_GO_AUTH_LOGIN_MODE` | 11 条登录/会话/验证码/找回接口，失败即全站无法登录；还要求 SMTP 四键 | config.go:5946-5957 |
| 8 | `API_GO_SITUATION_SIGNALS_WORKER_MODE` | Telegram 会话只能有一个 owner（第二个连接 AUTH_KEY_DUPLICATED），且是 `SITUATION_REFRESH` 前置 | config.go:6160-6163、#129:65 |
| 9 | `API_GO_GRAPHQL_SETTINGS_WRITE_MODE` | 13 个全站设置写；GAP-GQL-001 记录过「路由/资源 OR 漏接」的历史缺陷 | config.go:6048、GAPS.md:63-74 |
| 10 | `API_GO_ANALYSIS_WORKER_MODE` | 模型流执行 + 订阅事件发布，且强制 `GRAPHQL_SUBSCRIPTION_BUS=redis`；双消费会重复消耗模型额度 | config.go:5510-5521、PR #98:40 |

次高风险（同为 `高`，建议同批关注）：`API_GO_ITEMS_INGEST_MODE`、`API_GO_ALERT_WORKER_MODE`、`API_GO_NOTIFICATIONS_SOCKET_MODE`、`API_GO_GRAPHQL_ORG_ACCESS_WRITE_MODE`/`_SETTINGS_WRITE_MODE`/`_SOURCE_POLICY_WRITE_MODE` 三个 GraphQL 写开关、`API_GO_PIPELINE_RECOVERY_WRITE_MODE`、`API_GO_ASSISTANT_WORKER_MODE`、`API_GO_ECONOMIC_DATA_WORKER_MODE`、`API_GO_ARCHIVE_PREPARATION_WORKER_MODE`、`API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE`、`API_GO_CRAWL_TASK_WRITE_MODE`、`API_GO_USER_DIGEST_DELIVERY_MODE`、`API_GO_OIDC_LOGIN_MODE`、`API_GO_NEWS_EVENTS_INGESTION_MODE`、`API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE`、`API_GO_REALTIME_SIGNALS_MODE`、`API_GO_SITUATION_REFRESH_MODE`。

## 回退后已知会重现的问题（汇总）

只列**有 PR 正文/源码证据**的项。回退到 `legacy` 后，Go 侧修复不再生效，Nest 基线的问题重新出现；数据本身不回滚。

| # | 开关/域 | 回退后会重新出现的问题 | 证据 |
|---|---|---|---|
| 1 | `API_GO_NEWS_EVENTS_TIMELINE_MODE`（news） | B1/B2：唯一索引撞车导致整事务回滚、组织时间线停在旧数据 | PR #120:91 |
| 2 | `API_GO_REALTIME_SIGNALS_MODE`（situation） | 额度账本改为按组织预扣（共享预扣失效），外部 API 额度消耗上升 | PR #121:39/60 |
| 3 | `API_GO_NEWS_EVENTS_INGESTION_MODE`（news） | `settleMs` 等待上界失效，新文章进入事件的时间抖动恢复 | PR #123:72 |
| 4 | `API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE`（crawl） | B1 修复失效（判定/学习链的既有缺陷） | PR #125:21 |
| 5 | `API_GO_ARCHIVE_PREPARATION_WORKER_MODE`（archive） | B1 修复失效（游标延续等准备链缺陷） | PR #126:68 |
| 6 | `API_GO_CRAWL_WORKER_MODE`（crawl） | B1/B2/B3：重复扣减、失败计数丢失、legacy socket 无实时推送 | PR #135:87 |
| 7 | `API_GO_REALTIME_SOCKET_MODE`（workspace） | Nest 基线 situation 实时事件实际不推送（`Namespace.sockets` 误用），回退即恢复该现状 | PR #131:60 |
| 8 | `API_GO_USER_SETTINGS_READ_MODE`（personal） | 回退到空串后六读行为分裂：rss-reader/spacetime-timeline 回 shadow、其余回 legacy | config.go:47-60 |

补充（非「重现缺陷」，但回退时必须知道）：

- **子开关整包回退**：所有 GraphQL 子开关（`NEWS_EVENTS`/`NEWS_EVENT_BRIEF`/`KG_IMPACT`/`KNOWLEDGE_GRAPH`/`WORKSPACE_READ`/`SETTINGS_CRAWL_READ`/`ITEMS_LIST`/`CRAWL_METADATA`/`ORG_ACCESS_WRITE`/`SETTINGS_WRITE`/`SOURCE_POLICY_WRITE`/`KNOWLEDGE_REVIEW`/`RSS_TRANSLATION`/`ASSISTANT_WRITE`/`NEWS_INDICATOR_REFRESH`）回退后，**含该 root 的文档整份回 NestJS**，不是字段级降级（config.go:2429-2629 各 GraphQL 子开关字段注释）。
- **写入不回滚**：`PR #96`（条目写）、`#100`（告警规则）、`#101`（采集任务/队列运行态）、`#108`（头像签名与审计）、`#109`（助手运行记录）、`#110`（GDELT 快照与两层缓存）、`#117`（态势设置与加密存储）、`#119`（维护类状态）、`#127`（清理/复核样本）均明确「已写入数据不回滚，格式与 Nest 同构」。
- **删除类不可逆**：`API_GO_AUDIT_LOG_RETENTION_MODE` 的清理、`API_GO_BULLMQ_CLEANUP_MODE` 的保留 job 清理，回退不会恢复已删除数据（幂等，但不可逆）。
- **实时/反代额外步骤**：两个 Socket 开关回退除改变量外，还要把 Web 改回 `/socket.io` 并重建、摘掉 `/socket.io-realtime` 反代（PR #124:25、#131:107）。

## 未核实项

以下内容本矩阵**没有**证据，不做结论：

1. **`/api/healthz/live` 没有开关（已由 `refactor/go-ops-entrypoints` 关闭）**：本批新增 `API_GO_HEALTHZ_LIVE_MODE`（默认 `shadow`，可 `legacy`/`go`），规则由 `WithHealthzLive` 决定；见 `ops-entrypoints` 小节与 runbook 阶段 6。
2. **GAPS.md 的开放状态基于旧基线**（`3cedce9a`/`90765633`），与本基线可能不一致：`GAP-NEWS-001`（brief 冷生成/写回）在当前代码已装配 `BriefCompleter`（`main.go:2236-2246`、`graphqlread/newsevents/brief.go:69` 的 `generateBrief` 与 `JSON_SET metadata`）；`GAP-CRAWL-001`（S3 媒体下发）当前已有 `internal/objectstorage` 并在 `crawlreadtelemetry` 注入（`service_media.go:19`、`main.go:2273`）。**是否已修复未核实**，本矩阵不据此关闭任何 GAP。
3. **部署侧真实取值未核实**：本矩阵只读仓库代码与默认值；compose 是否显式注入某个开关、宿主 `.env` 的实际值、是否已切流均未核实（`VERIFY-DEPLOY-001`）。
4. **真实外部服务未验证**：SMTP、模型/LiteLLM、crawl4ai、Telegram/OREF、AkShare、Nominatim/OpenSky、S3/MinIO、Elasticsearch 均未实网调用（`VERIFY-EXT-001`）。所有「资源」列只表示启动硬条件。
5. **无 PR 回退/已知问题描述的开关**：矩阵中该列写「未核实」的行（如 `API_GO_ACCOUNT_SECURITY_MODE`、`API_GO_AUTH_FACTORS_MODE`、`API_GO_PUBLIC_PORTAL_MODE` 等），只能确认「改回 legacy 后请求回 Nest」的通用语义，具体副作用未在 PR 正文中说明。
6. **`OBS-DATA-001`**：`main.go` 吞掉 `wireDataRuntimeSettings` 错误（GAPS.md:142），当前是否可达未证明；本矩阵不把它写成「九路必然不可用」。
7. **阶段划分是规划归并**：BRIEF 定义阶段 0–6，本矩阵按「接线的最重动作」把 134 个开关归入 1–6；同一阶段内没有严格先后顺序，阶段内顺序建议见 runbook（T5）。
8. **GraphQL root 的字段级权限/租户隔离未逐条复验**：属 T1.2 审计范围；本矩阵只到「root 是否登记/整包回退」粒度。
9. **`API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` 的历史记录**：`DEPENDENCIES.md:30` 写「main 没有该开关」，那是旧基线快照；当前 `config.go:4570` 与 `main.go:2364` 已存在，本矩阵以代码为准。
10. **`/docs-yaml` 未实现**：Nest 的 `SwaggerModule.setup("docs", …)` 默认还提供 `/docs-yaml`（YAML 序列化）。本批只提供 `/docs/json`；`API_GO_DOCS_MODE=go` 且 fallback 为 `reject` 时 `/docs-yaml` 返回 404。该差异记录在 runbook 阶段 6 与 PR 描述。
