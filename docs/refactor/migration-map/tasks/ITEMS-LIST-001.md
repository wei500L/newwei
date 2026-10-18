# ITEMS-LIST-001 · 完整GraphQL条目列表与排序

- 状态pr_open；2026-10-18第三批并行提示词发出，编码分支 `refactor/go-graphql-items-list`，
  worktree `/Users/oo/project/newwei-go-graphql-items-list`，从当时 `origin/main
  9d0462e16d88d146b8afbf67cdd58d8b7419ff29` 创建。
- 来源BL-05/GAP-LEGACY-001的Query items子范围；[完整提示词](ITEMS-LIST-001.prompt.md)（规划PR #71）。
- 代码基线9d0462e16d88d146b8afbf67cdd58d8b7419ff29（main run 39127631691 success）。实网与部署未验证。
- Ready [PR #74](https://github.com/wei500L/newwei/pull/74)，业务 head `c45f1afe3754fab3cdd31e6fb8ba5b9eb37bd9eb`，普通 CI [39136842080](https://github.com/wei500L/newwei/actions/runs/39136842080) success；尚未合 main。
- 本批强化用户要求：专注必要业务，不写防御性框架；新增/修改源码注释全英文，在分页/排序/租户绑定处解释原因，文档/提交/PR中文。

## 交付范围

新增接管 POST /graphql 的 Query `items(after, filters, first, orderBy, page, rankingMode, search):
ItemConnection!`，根权限 `items.read`，`orgId`/个性化 `userId` 只取服务端身份。实现 page/after
翻页、`CREATED_DESC`/`PUBLISHED_DESC`/`PERSONALIZED` 排序、`RELEVANCE` rerank 搜索、正负画像个性化、
双 read-model 分支、嵌套内容批量投影；新增独立子开关 `API_GO_GRAPHQL_ITEMS_LIST_MODE`（默认 legacy，
go 要求 `API_GO_GRAPHQL_READ_MODE=go` 且 `API_GO_ITEMS_READING_MODE=go`）。

主要文件：`internal/itemsreading/{itemslist,listtime,liststore,relevance,personalized,rerank,ranking}.go`、
`internal/graphqlread/itemsreading/{list,projection}.go`、`contract`/`exec` 的最小只读选择元数据、
`llmembed` 具名 rerank options/观测、`config.go`/`main.go` 接线、Compose/示例默认 legacy。
细节见 [go-graphql-items-list.md](../../go-graphql-items-list.md)。

## 仍然由 NestJS 执行

`createItem`/`updateItem`/`createItemFromCrawlResult`/`translateRssItems` Mutation 与 RSS 订阅；items 域
其余入口。本批不迁 BullMQ/cron/后台索引/翻译/创建更新/导入/流水线。

## 验证

- 普通 CI：head `c45f1afe3754fab3cdd31e6fb8ba5b9eb37bd9eb`，[run 39136842080](https://github.com/wei500L/newwei/actions/runs/39136842080) success（verify 全步骤 + user-settings/vector integration；smoke 与 regen skipped）。
- 只读静态复核：`gofmt`、`git diff --check`、逐文件类型/契约核对；本机未运行 build/test/Docker/服务。
- 未验证：ES/vector/rerank 模型、真实 MySQL/Mongo/Redis 并发、部署/流量/回滚演练。

## 交接

本任务只覆盖 Query `items` 子范围；不关闭整个 GAP-LEGACY-001，也不改 main 覆盖数（PR 未合）。

## 并行边界与规划记录（文档 PR #71）

- 规划态：reserved（2026-10-18 第三批并行提示词发出，当时无开工证据、worktree 尚未创建）；本页按交付事实更新为 pr_open。
- 规划记录复用 `docs/plan-news-event-brief` / [Ready PR #71](https://github.com/wei500L/newwei/pull/71)，规划 PR 不是业务交付；提示词见 [ITEMS-LIST-001.prompt.md](ITEMS-LIST-001.prompt.md)。
- 所有权：拥有 `internal/itemsreading` 及 `graphqlread/itemsreading` 的列表/排序/批量投影；`llmembed` 仅 rerank 必要 options/观测；`contract`/`exec` 仅只读选择元数据，不变更预规划、权限与 Mutation；`main`/`config` 仅新 `ITEMS_LIST` 子开关与 items 注册段。
- 并行排除：NEWS-BRIEF-001 已见开发，排除 `newsevents`/`publicportal`/`llmlogs`；本批 rerank 日志在 itemsreading 隔离实现，不依赖简报未合入的 writer。STORAGE-MEDIA-001 已建 worktree，排除 S3 client/config 导出/crawl/settingscrawl，不改 `go.mod`/`go.sum`。#70 保持 OPEN/Ready（head adb765d0），排除工作台八写、公共 GraphQL 顶层接线与 `mutation_test`。
- 规划期静态结论：Go REST List 只有 RECENCY、无 items root；现成候选融合不是最终相关性分数；`filters:{}` 覆盖历史 filters 不能被现有 `decodeFilters` 抹去；相关性 rerank 默认启用且失败 503；个性化 MIN180/MAX1600/乘 8 及窗口扩大与正负六维画像必须迁入；Nest 选择字段驱动 count/result 加载，Go Context 需要最小只读 selection 元数据与按页批量装配，避免逐 edge 调用 `item()`。
