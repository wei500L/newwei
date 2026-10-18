# items · 条目检索、RSS 阅读与处理结果

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

HTTP 条目阅读与索引重建、GraphQL item/itemFacets/rssSources/rssTranslationStatus/searchSuggestions 和 processedItemById 已接线；GraphQL items 列表在 main 仍没有生产注册，不能与 REST 列表混淆。Query `items` 的 Go 实现是[ITEMS-LIST-001](../tasks/ITEMS-LIST-001.md) 候选（[PR #74](https://github.com/wei500L/newwei/pull/74)，CI 39136842080 success，未合 main，覆盖数不提前增加）。

关键数据与副作用：MySQL ItemMeta、Mongo rawitems/processeditems/read-model、Redis reindex 状态/遥测、Elasticsearch 与向量服务。重建是 Go 后台 goroutine 的索引副作用，不是 BullMQ 已整体迁移。

真实剩余缺口：items Query、createItem/updateItem/createItemFromCrawlResult/translateRssItems 等 Mutation 仍为 Nest；RSS 翻译真实模型和内容流水线需独立任务。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#items) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[items](../../../../apps/api/src/modules/items)、[search-telemetry](../../../../apps/api/src/modules/search-telemetry)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：[ITEMS-LIST-001](../tasks/ITEMS-LIST-001.md) pr_open，Query `items` 完整分页/RECENCY/RELEVANCE/PERSONALIZED/批量嵌套投影；分支 `refactor/go-graphql-items-list`，Ready [PR #74](https://github.com/wei500L/newwei/pull/74)，业务 head `c45f1afe`，普通 CI [39136842080](https://github.com/wei500L/newwei/actions/runs/39136842080) success；PR 未合 main 前不更新覆盖数。旧 worktree 不自动视为活动任务。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithCrawlReadTelemetry](../../../../apps/api-go/internal/legacyproxy/crawl_read_telemetry_routes.go) | `API_GO_CRAWL_READ_TELEMETRY_MODE` | [crawlreadtelemetry](../../../../apps/api-go/internal/crawlreadtelemetry) | `legacy` |
| [WithItemsReading](../../../../apps/api-go/internal/legacyproxy/items_reading_routes.go) | `API_GO_ITEMS_READING_MODE` | [itemsreading](../../../../apps/api-go/internal/itemsreading) | `legacy` |
| [WithSearchReindex](../../../../apps/api-go/internal/legacyproxy/search_reindex_routes.go) | `API_GO_SEARCH_REINDEX_MODE` | [searchreindex](../../../../apps/api-go/internal/searchreindex) | `${API_GO_SEARCH_REINDEX_MODE:-legacy}` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 7：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/search-telemetry/summary` | settings.manage | [search-telemetry-admin.controller.ts](../../../../apps/api/src/modules/search-telemetry/search-telemetry-admin.controller.ts) · `summary` | WithCrawlReadTelemetry |
| `POST /api/admin/search/reindex` | settings.manage | [search-admin.controller.ts](../../../../apps/api/src/modules/items/search-admin.controller.ts) · `reindex` | WithSearchReindex |
| `GET /api/admin/search/reindex/:jobId` | settings.manage | [search-admin.controller.ts](../../../../apps/api/src/modules/items/search-admin.controller.ts) · `getReindexJob` | WithSearchReindex |
| `GET /api/items` | items.read | [items.controller.ts](../../../../apps/api/src/modules/items/items.controller.ts) · `list` | WithItemsReading |
| `POST /api/items` | items.write | [items.controller.ts](../../../../apps/api/src/modules/items/items.controller.ts) · `create` | Nest；尚未接管 |
| `GET /api/items/:id` | items.read | [items.controller.ts](../../../../apps/api/src/modules/items/items.controller.ts) · `detail` | WithItemsReading |
| `POST /api/search-telemetry` | items.read | [search-telemetry.controller.ts](../../../../apps/api/src/modules/search-telemetry/search-telemetry.controller.ts) · `record` | WithCrawlReadTelemetry |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Mutation `createItem` | items.write | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `createItem` | Nest；未注册 |
| Mutation `createItemFromCrawlResult` | crawl.read + items.write | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `createItemFromCrawlResult` | Nest；未注册 |
| Mutation `translateRssItems` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `translateRssItems` | Nest；未注册 |
| Mutation `updateItem` | items.write | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `updateItem` | Nest；未注册 |
| Query `item` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `item` | [itemsreading.Register](../../../../apps/api-go/internal/graphqlread/itemsreading/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` |
| Query `itemFacets` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `itemFacets` | [itemsreading.Register](../../../../apps/api-go/internal/graphqlread/itemsreading/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` |
| Query `items` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `items` | main 仍 Nest；本批候选 [RegisterList](../../../../apps/api-go/internal/graphqlread/itemsreading/list.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE + API_GO_GRAPHQL_ITEMS_LIST_MODE`（[PR #74](https://github.com/wei500L/newwei/pull/74)，未合） |
| Query `processedItemById` | items.read | [processed-item.resolver.ts](../../../../apps/api/src/graphql/resolvers/processed-item.resolver.ts) · `processedItemById` | [workspace.Register](../../../../apps/api-go/internal/graphqlread/workspace/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_GRAPHQL_WORKSPACE_READ_MODE` |
| Query `rssSources` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `rssSources` | [itemsreading.Register](../../../../apps/api-go/internal/graphqlread/itemsreading/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` |
| Query `rssTranslationStatus` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `rssTranslationStatus` | [itemsreading.Register](../../../../apps/api-go/internal/graphqlread/itemsreading/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` |
| Query `searchSuggestions` | items.read | [items.resolver.ts](../../../../apps/api/src/graphql/resolvers/items.resolver.ts) · `searchSuggestions` | [itemsreading.Register](../../../../apps/api-go/internal/graphqlread/itemsreading/register.go)；`API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#48](https://github.com/wei500L/newwei/pull/48) | [11c4c8a826a6](https://github.com/wei500L/newwei/commit/11c4c8a826a655da7fa1a81d0ac4b5d6cff0afc6) | ✨ feat(graphqlread): 迁移 workspace 12 个 GraphQL 只读 Query（Go） |
| [#50](https://github.com/wei500L/newwei/pull/50) | [b0e4c178b2af](https://github.com/wei500L/newwei/commit/b0e4c178b2af54ea6a72f4555973e011877f0e88) | ✨ feat(api-go): 采集只读、媒体下发与检索遥测迁入 7 条接口（默认 legacy） |
| [#58](https://github.com/wei500L/newwei/pull/58) | [9da8e75e9d1e](https://github.com/wei500L/newwei/commit/9da8e75e9d1e8bfb683b5f10db8e088121f23191) | ✨ feat(api-go): 条目阅读与 RSS 检索辅助 7 个入口迁入 Go（API_GO_ITEMS_READING_MODE，默认 legacy）+ 修 IR1/IR2/IR3 |
| [#65](https://github.com/wei500L/newwei/pull/65) | [62ca2adbe6f1](https://github.com/wei500L/newwei/commit/62ca2adbe6f1baaa9ac21490a21207e2524e2116) | ✨ feat(search): 迁移搜索索引重建到 Go 并优化检索遥测读写 |
| [#67](https://github.com/wei500L/newwei/pull/67) | [7fc17faa3dc5](https://github.com/wei500L/newwei/commit/7fc17faa3dc5043537bad4038299d11fdba4758d) | 🔀 integration(api-go): 一次性落地 #59/#62/#63/#65/#66 五个迁移批次（冲突统一并集解决 + 全量验证） |

- [docs/refactor/go-items-reading.md](../../go-items-reading.md)

- [docs/refactor/go-search-reindex.md](../../go-search-reindex.md)

- [docs/refactor/go-crawl-read-telemetry.md](../../go-crawl-read-telemetry.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
