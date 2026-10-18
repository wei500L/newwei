# ITEMS-LIST-001 · 完整GraphQL条目列表与排序

- 状态in_progress；2026-10-18第三批并行提示词发出，编码分支 `refactor/go-graphql-items-list`，
  worktree `/Users/oo/project/newwei-go-graphql-items-list`，从当时 `origin/main
  9d0462e16d88d146b8afbf67cdd58d8b7419ff29` 创建。
- 来源BL-05/GAP-LEGACY-001的Query items子范围；[完整提示词](ITEMS-LIST-001.prompt.md)（规划PR #71）。
- 代码基线9d0462e16d88d146b8afbf67cdd58d8b7419ff29（main run 39127631691 success）。实网与部署未验证。
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

- 普通 CI：待 PR head 运行后补齐精确 head/run URL/verify 结论。
- 只读静态复核：`gofmt`、`git diff --check`、逐文件类型/契约核对；本机未运行 build/test/Docker/服务。
- 未验证：ES/vector/rerank 模型、真实 MySQL/Mongo/Redis 并发、部署/流量/回滚演练。

## 交接

本任务只覆盖 Query `items` 子范围；不关闭整个 GAP-LEGACY-001，也不改 main 覆盖数（PR 未合）。
