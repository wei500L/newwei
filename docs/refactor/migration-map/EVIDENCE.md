# 核对证据与边界

[返回入口](README.md)。此页保存首次建图的可复核证据，不替代各域源码。

## 基线与远端

- 核对时间：2026-10-18 13:51 MSK（UTC+03:00）；`git fetch origin main` 后 `origin/main = 7fc17faa3dc5043537bad4038299d11fdba4758d`。
- 专用 worktree：`/Users/oo/project/newwei-backend-migration-map`；分支 `docs/backend-migration-map`，由 origin/main 创建。原仓库 checkout 当时停在旧 crawl-templates 分支，不用于推断 main。
- 首次检查未发现同目的 migration-map/分支/PR；`gh pr list --state open` 返回空。历史 PR #1–#67 可读，域页所列 merge commit 均通过祖先关系检查；#67 integration 包含 #59/#62/#63/#65/#66，不能只靠原分支判断完成。
- 基线[CI run 39118934491](https://github.com/wei500L/newwei/actions/runs/39118934491) headSha 完全一致，success。verify、[vector-integration](https://github.com/wei500L/newwei/actions/runs/39118934491/job/117650363887)、[api-go-user-settings-integration](https://github.com/wei500L/newwei/actions/runs/39118934491/job/117650363896) 成功。按需 go-modules-regen、contract-baseline-regen skipped，不计额外通过。
- 最近另四次 main 普通 CI 同样成功：9da8e75e（39117313330）、3c9ce2f5（39115834065）、776d17bb（39109567813）、f5648fab（39082685243）。这些不是本次业务外部调用证据。
- 地图交付：[Ready PR #69](https://github.com/wei500L/newwei/pull/69)，首版提交 `4e37f285aa47d39813c2253a64ee65613bce9e56` 已正常推送至 origin/docs/backend-migration-map。PR 为 OPEN、isDraft=false、autoMergeRequest=null；仅发布文档，尚未合入，不是两个历史业务任务的 PR。其后补充文档证据采用正常追加提交，最新 head/普通 CI 以该 PR Checks 为准，不将启动/排队计为通过。

## 核对路径与统计口径

1. 阅读根 AGENTS.md；未发现更深层 AGENTS.md。只改地图、导航与一条根 AGENTS 迁移导航，不改业务/运行配置/schema/测试。
2. 主 HTTP 来自当前 [Controller 源码](../../../apps/api/src/modules)、[main.setGlobalPrefix](../../../apps/api/src/main.ts) 与 [auth-matrix.json](../../../apps/api/tests/contract/auth-matrix.json)/[OpenAPI 快照](../../../apps/api/tests/contract/openapi.snapshot.json)。370 条 METHOD+完整路径，无重复；369 个常规方法装饰器 + 1 个 @Sse(stream)。Controller 列表与所属模块声明交叉核对，并沿 AppModule/SystemSettings/Storage 等 imports 确认装配，不把独立 vector 纳入。
3. Go HTTP 逐组核对 [legacyproxy](../../../apps/api-go/internal/legacyproxy) 的精确方法/动态段/尾缀规则、[main.run/wire*](../../../apps/api-go/cmd/api) 的初始化与 RegisterGoHandler，以及对应业务包。274 个与上述 Nest HTTP 标识匹配；OPTIONS/示例/测试/重复文档不计。公开 live 是 shadow，不算 Go 接管。
4. GraphQL 从 [完整 SDL](../../../apps/api/schema.gql) 提取 77 Query / 57 Mutation / 4 Subscription，逐 root 关联当前 Resolver 方法与权限；再对照生产 register.go 和 main 条件，得到 71/8/0 注册。返回字段与回退规则见 [GraphQL 运行时](modules/graphql-runtime.md)。SDL 和 Go 内嵌 SDL 应由现有普通 CI 漂移检查约束，不能凭 SDL 存在计实现。
5. 所有主入口只在一个域页出现一次；共享包/开关在多个域出现可以，但只计自己入口。各分域的分母合计 370/77/57/4。HTTP 计数是注册覆盖口径；业务实现和启用另记，不据此给全后端百分比。
6. 读新源码核对 Job/cron/repeat/outbox/外部 HTTP：已注册 newsEventBrief 的冷生成缺失（固定报错，不是仅未做实网验证）、crawlMetadata 主动网页/sitemap 抓取、归档 ensure*Coverage、经济 updateFetchConfig→ensureRepeatableJobs、看板读取创建默认看板、故事 brief 冷路径、地图地理/翻译/OpenSky、NewsNow 上游刷新等均保留副作用标记。精确 runtime job 数和实网结果未运行核实。
7. 两批历史任务从用户明确线索恢复，查对应历史 PR、远端分支、main 开关/Registry、两个本机 worktree 的 status/diff。初始两者无 PR；14:03 MSK 增量复核：设置写已推送 Ready PR #68（a1c96172，普通 CI 进行中），工作台写出现 config/alerts 未提交增量。main SHA 未变化，两个任务都保留占用。

本次不安装依赖、不启动服务、不运行本地 build/test；git/gh/rg、源码阅读和临时文档链接/去重检查是验证范围。普通 CI 与外部调用验证分开。

## 42 个 Nest 模块目录归属

源码目录全覆盖，不是“42 个都已迁移”。跨域配置/日志/协议的具体入口按产品用途拆分，域页精确入口表为准。

| Nest 模块目录 | 主事实页 |
|---|---|
| [modules/akshare](../../../apps/api/src/modules/akshare) | [economic](modules/economic.md) |
| [modules/alerts](../../../apps/api/src/modules/alerts) | [workspace](modules/workspace.md) |
| [modules/analysis](../../../apps/api/src/modules/analysis) | [analysis](modules/analysis.md) |
| [modules/analysis-workspace](../../../apps/api/src/modules/analysis-workspace) | [analysis](modules/analysis.md) |
| [modules/archive](../../../apps/api/src/modules/archive) | [archive](modules/archive.md) |
| [modules/assistant](../../../apps/api/src/modules/assistant) | [assistant](modules/assistant.md) |
| [modules/audit](../../../apps/api/src/modules/audit) | [async-runtime](modules/async-runtime.md) |
| [modules/auth](../../../apps/api/src/modules/auth) | [identity](modules/identity.md) |
| [modules/cache](../../../apps/api/src/modules/cache) | [async-runtime](modules/async-runtime.md) |
| [modules/config](../../../apps/api/src/modules/config) | [async-runtime](modules/async-runtime.md) |
| [modules/crawl](../../../apps/api/src/modules/crawl) | [crawl](modules/crawl.md) |
| [modules/dashboard](../../../apps/api/src/modules/dashboard) | [workspace](modules/workspace.md) |
| [modules/email](../../../apps/api/src/modules/email) | [async-runtime](modules/async-runtime.md) |
| [modules/geo](../../../apps/api/src/modules/geo) | [situation](modules/situation.md) |
| [modules/graphql-subscriptions](../../../apps/api/src/modules/graphql-subscriptions) | [async-runtime](modules/async-runtime.md) |
| [modules/health](../../../apps/api/src/modules/health) | [observability](modules/observability.md) |
| [modules/items](../../../apps/api/src/modules/items) | [items](modules/items.md) |
| [modules/knowledge-graph](../../../apps/api/src/modules/knowledge-graph) | [knowledge](modules/knowledge.md) |
| [modules/model-service](../../../apps/api/src/modules/model-service) | [async-runtime](modules/async-runtime.md) |
| [modules/news-aggregator](../../../apps/api/src/modules/news-aggregator) | [news](modules/news.md) |
| [modules/news-events](../../../apps/api/src/modules/news-events) | [news](modules/news.md) |
| [modules/news-indicator](../../../apps/api/src/modules/news-indicator) | [news](modules/news.md) |
| [modules/news-pipeline](../../../apps/api/src/modules/news-pipeline) | [news](modules/news.md) |
| [modules/news-signals](../../../apps/api/src/modules/news-signals) | [news](modules/news.md) |
| [modules/notifications](../../../apps/api/src/modules/notifications) | [workspace](modules/workspace.md) |
| [modules/observability](../../../apps/api/src/modules/observability) | [observability](modules/observability.md) |
| [modules/org](../../../apps/api/src/modules/org) | [identity](modules/identity.md) |
| [modules/public-portal](../../../apps/api/src/modules/public-portal) | [personal](modules/personal.md) |
| [modules/queue](../../../apps/api/src/modules/queue) | [async-runtime](modules/async-runtime.md) |
| [modules/rbac](../../../apps/api/src/modules/rbac) | [identity](modules/identity.md) |
| [modules/realtime-signals](../../../apps/api/src/modules/realtime-signals) | [situation](modules/situation.md) |
| [modules/search-telemetry](../../../apps/api/src/modules/search-telemetry) | [items](modules/items.md) |
| [modules/sentiment](../../../apps/api/src/modules/sentiment) | [workspace](modules/workspace.md) |
| [modules/situation-monitor](../../../apps/api/src/modules/situation-monitor) | [situation](modules/situation.md) |
| [modules/storage](../../../apps/api/src/modules/storage) | [infrastructure-data](modules/infrastructure-data.md) |
| [modules/system-settings](../../../apps/api/src/modules/system-settings) | [settings](modules/settings.md) |
| [modules/user-content-subscriptions](../../../apps/api/src/modules/user-content-subscriptions) | [personal](modules/personal.md) |
| [modules/user-digest](../../../apps/api/src/modules/user-digest) | [personal](modules/personal.md) |
| [modules/user-news-behavior](../../../apps/api/src/modules/user-news-behavior) | [personal](modules/personal.md) |
| [modules/user-settings](../../../apps/api/src/modules/user-settings) | [personal](modules/personal.md) |
| [modules/vector](../../../apps/api/src/modules/vector) | [async-runtime](modules/async-runtime.md) |
| [modules/websocket](../../../apps/api/src/modules/websocket) | [async-runtime](modules/async-runtime.md) |

## 接入与未知边界

- `/graphql`、`/socket.io`、`/admin/queues` 不带 /api；Bull Board 条件启用，Socket.IO 与四个 Subscription 仍由 Nest 负责。它们不并进主 REST 或 root 统计。
- [compose](../../../infra/docker/docker-compose.yml) 的 Web 默认仍用 api:4000；api-go-pilot 是 opt-in，canary 固定 0。模块页展示该源码可见注入，不能当真实部署。user-settings 读有历史 shadow 默认例外。
- 不读/公开真实 .env、数据库凭据或部署秘密，因此实际部署值和生产流量未核实。外部服务真实验证与历史 smoke 的精确 head 关联见入口未知清单。
- [main.run](../../../apps/api-go/cmd/api/main.go) 的 wireDataRuntimeSettings 返回错误未在调用处返回；这里只记录后续核对点，不增加业务修复范围。
- 旧 [system-map](../system-map.md)、[roadmap](../roadmap.md)、[api-contract-inventory](../api-contract-inventory.md) 仍保留历史价值；其中独占写库、已迁范围、订阅后端等描述可能过时，不能覆盖本次源码事实。

## 文档自检与后续刷新

提交前检查所有内部路径、入口唯一性、分域求和、两批任务占用、任务状态与 main 注册一致（PR 进展不提前计 main 覆盖），以及仅允许文档路径变化。独立阅读审查验证新对话能判断设置写/工作台写是否重复、剩余 Query 是否有副作用、CI 与切流能否区分。

下次不必重扫全仓：按 PLANNING 增量比较本 SHA 与 origin/main，深入候选域并更新本页或对应域的核对 SHA。只有实际重新核对的范围可以刷新其时间与事实，不能只改全局日期掩盖过时条目。

提交前静态检查结果：26 个地图 Markdown 文件、370 条唯一 HTTP、77/57/4 唯一 GraphQL root；Go 注册数 274/71/8，所有相对文档/源码路径存在。独立读者复验通过；已据审查补充 newsEventBrief 部分实现与 crawlMetadata 主动抓取，并统一两批任务的增量快照。仅 28 个 Markdown 路径变化，无业务或配置改动。
