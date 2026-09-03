# 系统全景图（System Map）

> 生成时间：2026-09-03 · 基线 commit `95759f59`（修复后复验于 `c02eaf07`）
> 用途：Go 迁移与前端重构的公共事实底座。所有条目均可通过 `文件:行号` 回溯验证。
> 姊妹文档：`baseline.md`（质量门禁基线）、`api-contract-inventory.md`（契约全量清单）、`bug-ledger.md`（缺陷台账）。

---

## 1. 系统定位

多租户「全球态势感知与新闻情报分析平台」：采集新闻/RSS/AIS/经济数据 → LLM 抽取与清洗 → 事件聚类 → 向量检索/知识图谱 → 多终端可视化（态势地图、时间线、监控面板、公共门户）。租户（org）是数据与权限的一级隔离边界。

## 2. 仓库物理结构

```
newwei/                        pnpm 9 + Turborepo（Node >=20；CI 用 Node 20）
├── apps/
│   ├── api/        NestJS 11 主后端：REST /api + GraphQL /graphql + Socket.IO + Bull Board
│   │               src 770 文件；71 controller / 25 resolver / 6 gateway / 10 processor / 222 service
│   ├── web/        Next.js 15 App Router + React 19 + AntD 5 + Tailwind 3；72 路由
│   ├── vector/     NestJS Qdrant 适配器（独立部署，内部 token 鉴权）
│   └── ais-relay/  Node AIS WebSocket 聚合器（AISSTREAM_API_KEY，fail-closed）
├── packages/
│   ├── db/             Prisma + MySQL（schema 2478 行，93 model / 53 enum）
│   ├── mongo/          Mongoose 模型与索引
│   ├── config/         ESLint/tsconfig 预设（api/web/vector 共用）
│   ├── utils/          Zod env 加载器、logger、tracing、socket 错误码
│   └── vector-client/  api → vector 的 HTTP 客户端（x-internal-token）
├── infra/docker/       docker-compose 全栈（见 §3）+ runtime.Dockerfile
└── docs/refactor/      本系列文档
```

## 3. 运行时拓扑（infra/docker/docker-compose.yml）

| 服务 | 镜像 | 宿主端口（默认 127.0.0.1） | 说明 |
|---|---|---|---|
| mysql | mysql:8.4 | 3306 | 主业务库（Prisma） |
| mongo | mongo:7.0 | 27017 | 原始/处理后条目、outbox |
| redis | redis | 6379 | BullMQ + 缓存 + WS adapter（db0） |
| qdrant | qdrant v1.10.1 | 6333 | 向量库 |
| elasticsearch | 8.15.3 | 9200 | 全文检索 |
| minio(+mc) | digest 固定 | 9000 / 9001 | S3 对象存储 |
| litellm | 自建 | 4001→4000 | LLM 网关（master key 必须） |
| litellm-postgres | postgres:16 | 5432 | litellm 自身库 |
| akshare | 自建 | 8081 | 经济数据 API（保留为独立服务） |
| model-service | 自建 | 8090 | 嵌入/重排模型服务（x-internal-token） |
| crawl4ai | 自建 | 8082→11235 | 抓取执行器 |
| ais-relay | 自建 | 3004 | AIS 信号转发 |
| api | node:20 构建 | 4000 | 启动时自动 prisma migrate + mongo indexes |
| vector | 自建 | 4010 | Qdrant 适配器 |
| web | node 构建 | 3000 | NEXT_PUBLIC_API_BASE_URL → localhost:4000/api |

镜像按 digest 固定（REL-03 已核）。`pnpm docker:up` 启动；本机未装 Docker，容器级冒烟未实测（见 baseline §5）。

## 4. 后端 apps/api 架构

### 4.1 全局骨架（影响所有契约）

- REST 全局前缀 `api`，**排除 `admin/queues*`（Bull Board）**：`apps/api/src/main.ts:62-67`
- 全局 Guard（REST）：`JwtAuthGuard` + `PermissionsGuard`（`app.module.ts:118-126`）；GraphQL 专用链：`GraphqlRateLimitGuard` → `GqlAuthGuard` → `GqlPermissionsGuard`（`graphql.module.ts:494-513`，限流在鉴权前）
- 全局过滤器 `GlobalExceptionFilter`（REST/GraphQL 双形态，见 api-contract-inventory §5）
- `ValidationPipe{whitelist, forbidUnknownValues, forbidNonWhitelisted, transform}`（`main.ts:68-75`）
- TraceId 中间件：读 `x-trace-id`/`x-request-id`/`traceparent`，回写两者（`common/middleware/trace-id.middleware.ts:8-18`）
- helmet / cookie-parser / json 10MB（保留 rawBody）/ CORS credentials
- **路径重要事实**：GraphQL 挂 `/graphql`、Socket.IO 挂 `/socket.io/{ns}`（**均无 /api 前缀**），代理层路径规则必须区分三者

### 4.2 模块清单（41 个，src/modules/）

auth · rbac · org · audit · cache · config · health · email · storage · geo · items · search-telemetry · crawl · news-pipeline · news-aggregator · news-events · news-indicator · news-signals · knowledge-graph · sentiment · analysis · analysis-workspace · assistant · alerts · archive · dashboard · situation-monitor · realtime-signals · notifications · observability · public-portal · user-settings · user-digest · user-news-behavior · user-content-subscriptions · akshare · model-service · vector · queue · system-settings · websocket

其中 REST/GraphQL/WS 契约的**逐 endpoint 清单**见 `api-contract-inventory.md`（369 REST endpoint + 77 Query/57 Mutation/4 Subscription + 6 gateway 事件表）。

### 4.3 存储分层

| 存储 | 用途 | 访问方 |
|---|---|---|
| MySQL/Prisma | 业务主数据（93 model） | apps/api（唯一写入方） |
| MongoDB | raw_item / processed_item / crawl 产物 / outbox 集合 | apps/api（唯一写入方） |
| Redis db0 | BullMQ 队列（前缀 `bull:`）+ 认证缓存 + GraphQL 响应缓存（orgId:userId 隔离） | apps/api |
| Qdrant | 新闻向量 | 仅 apps/vector 直连；api 经 HTTP 调 vector |
| Elasticsearch | 条目全文索引 | apps/api（search-admin 模块重建） |
| MinIO/S3 | 媒体资产（签名 URL） | apps/api |

### 4.4 队列与定时任务（迁移边界，最后迁移）

- **14 个 BullMQ 队列**：itemPipeline、itemPipelineDlq、crawl4ai(legacy)、crawl4ai-hot、crawl4ai-normal、frontier-llm-judge、frontier-llm-learn、analysis、assistant、alerts、news_event_clustering_recovery、classification_quality、archivePreparation、situationMonitorSignals、akshare-data（Bull Board 注册 11 个，`queue-admin.module.ts:58-68`）
- 10 个 processor 全部为 `OnModuleInit` 手写 `new Worker(...)`（非 `@Processor` 装饰器）——**非标准用法，Go 侧重写时按行为而非框架语义对齐**
- DLQ 语义特殊：itemPipeline 的 DLQ 入队发生在 worker `failed` 事件里（非 BullMQ 原生 moveToDeadQueue），job name `dlq`（`queue.processor.ts:281-334`）
- **21 个 @Cron/@Interval**（21 个 service 文件，见 git 可查）+ BullMQ repeatable（news-source 调度、alerts 周期扫描、telegram/ore-f 轮询）
- **3 套 MongoOutbox**（raw_item / processed_item / cleanup_crawl_results）：租约式 `updateMany` 抢占、staleLock 5min、退避 `base*2^min(attempt,5)-1` + jitter、maxAttempts 10 → dead
- 两处**隐藏写入方**（读代码易漏）：itemPipeline 在结果缺失时同步触发抓取（`news-pipeline-crawl-bridge.service.ts:185-188`）；CrawlTaskJanitor 直接改任务状态
- 全部队列/cron/outbox 写入当前仅存在于 NestJS——**Go 迁移最后阶段前不得双写**

### 4.5 外部服务依赖（保留为独立 HTTP 服务，不并入 Go）

| 服务 | 调用方 | 鉴权 |
|---|---|---|
| Crawl4AI (:8082) | api crawl 模块 | 内部网络 |
| Akshare (:8081) | api akshare 模块 | 内部网络 |
| LiteLLM (:4001) | api LLM 网关（openai-keys 内部端点供其拉取密钥） | `LITELLM_CONFIG_INTERNAL_TOKEN`（时序安全比较） |
| model-service (:8090) | api 嵌入/重排 | `x-internal-token` |
| vector (:4010) | api vector-client（5 search + 1 upsert 调用点；唯一写入方 `news-pipeline-outbox.service.ts:717`） | `x-internal-token`（**非常量时间比较**，SEC-04） |
| ais-relay (:3004) | api realtime-signals | 内部网络 |

## 5. apps/vector（Go 迁移试点目标）

- 3 个端点：`POST /v1/upsert`、`POST /v1/search`、`GET /healthz`（`apps/vector/src/modules/vector/vector.controller.ts:28-48`）
- 鉴权：全局 `InternalAuthGuard` 校验 `x-internal-token` 头（`internal-auth.guard.ts:22-29`）
- 多租户：**orgId 来自请求体**，作为 Qdrant filter.must[0]（SEC-02：上游 api 负责推导，vector 自身不验证）
- 集合命名：`{VECTOR_COLLECTION_PREFIX}_{sha256(model).hex[:16]}`；point ID 为 `sha256("{model}:{processedItemId}")` 确定性 UUID
- 无删除端点；无 metrics；超时 5000ms
- 环境变量：PORT(4010)、VECTOR_INTERNAL_TOKEN(≥8，生产禁用 dev 默认值)、QDRANT_URL、QDRANT_API_KEY、VECTOR_COLLECTION_PREFIX

## 6. 前端 apps/web 架构

- 路由分组：`app/(app)` 56 页（业务台）、`app/(auth)` 6 页、`app/(portal)` 5 页（公共门户，无鉴权）、`app/(reader)` 1 页、9 个 API route；共 72 路由
- Shell：ActionRail（左侧 17 主项 + 3 管理项，3 个重复图标）+ TopNav（589 行：ticker/品牌/命令面板/DEFCON/抓取按钮/通知/组织切换/主题/用户）；宽度白名单 `shell.tsx:33-44`（wide 1920 / fluid / edge-to-edge，默认 1440；newsnow 自加 1760）
- 数据层四套并存：Apollo（39 文件，GraphQL）、TanStack Query（16）、统一 axios `apiClient`（~40）、直接 `fetch`（10 文件）+ Socket.IO 客户端（9）+ 8 个 zustand store（`store/sidebar.ts` 为死代码）
- i18n：`lib/i18n.ts`（服务端安全，locale 解析/格式化）+ `lib/i18n-client.ts`（客户端 i18next）——BL-08 修复后拆分
- 明细见 `frontend-information-architecture.md`

## 7. 横切面：鉴权、多租户与权限

- JWT：仅 `Authorization: Bearer`；claims `{sub, orgId, permissions[]}`；aud/iss 校验 + jti 黑名单；access 15m / refresh 7d **轮换式**（原子单次使用）；机器令牌 `mtk_` 前缀走同一 Guard 分流
- 每请求重推导 membership（组织切换即时生效）；`@Public`/`@AllowAuthenticated`/`@Permissions`(any)/`@PermissionsAll`(all) 四级；**无元数据 → 403 PERMISSION_METADATA_MISSING**（fail-closed，现存 5 个死路由，见 api-contract-inventory §0）
- RBAC：28 权限点、3 默认角色（admin/manager/analyst）；orgId **必须服务端推导**（SEC-01/02 台账记录了现存违例）
- WS 鉴权：handshake 三处取 token（header > auth.token > query.token）+ IP/用户桶限流（退避 1s→60s）+ **30s 周期复验**（登出/吊销即断连）
- GraphQL WS 订阅：connectionParams 合成 headers（键须小写 `authorization`）；PubSub 为**进程内**（非 Redis）——多实例部署订阅不跨进程，迁移时需补齐

## 8. 主数据流（新闻链路）

```
news-source 调度(BullMQ repeat + 20 cron)
  → Crawl4AI / RSS 抓取（crawl4ai-hot/normal 队列，LLM judge/learn 队列辅助）
  → raw_item(Mongo, outbox 租约分发)
  → itemPipeline 队列(process-item)：清洗/LLM 抽取/翻译/质量门
  → processed_item(Mongo) + MySQL 业务表 + Elasticsearch 索引
  → 向量 upsert（news-pipeline-outbox → vector 服务 → Qdrant）   ← 唯一写入点
  → 事件聚类（vector 相似 + LLM backfill，失败入 news_event_clustering_recovery）
  → 前端消费：GraphQL(items/newsEvents/dashboards) + WS(newsnow/ops/quality) + REST(导出/下载)
旁路：alerts 规则引擎（周期扫描→投递通知）· analysis/assistant 任务队列 · situation-monitor telegram/oref 轮询 · akshare 经济数据 · user-digest 定时摘要
```

## 9. 复杂度热点（重构优先级输入）

前端（TSX 行数）：war-map 4420 · alert-center 4074 · task-detail 3822 · CreateCrawlTaskDrawer 3147 · realtime-signals 面板 3014 · crawl-monitor 2993 · quality 2875
后端（service 行数）：crawl-frontier.service 5217 · news-source.scheduler 4837 · crawl-metadata 3389 · litellm 3073
样式：globals.css 2120 行
测试面：web 3 文件 5 用例 / vector 4 文件 11 用例 / **api 0 测试**（结构性缺口）

## 10. 对迁移方案有决定性影响的边界事实（汇总）

1. GraphQL/Socket.IO 不带 `/api` 前缀，与 REST 前缀并存——代理与契约快照都要三套规则
2. 队列/cron/outbox 写入全部在 NestJS 内且存在非标准用法（手写 Worker、failed 事件入 DLQ、两处隐藏写入）——**Go 最后接管，接管前禁止双写**
3. GraphQL Subscription 用进程内 PubSub 而 Socket.IO 用可选 Redis adapter——水平扩容语义不一致，Go 阶段需统一决策
4. vector 服务信任请求体 orgId（SEC-02）且内部 token 非常量时间比较（SEC-04）——Go 试点中一并修复
5. 5 个 REST 端点缺权限元数据（fail-closed 死路由）——契约冻结时决定修复或删除
6. 前端 alert-center 过滤器不入 URL（与 items/search/events 的 URL 同步模式不一致）——IA 重构统一
