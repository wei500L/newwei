# Go-批8 新闻事件控制台 GraphQL 读查询

基线是 GraphQL 读查询试点合并后的 `7d25a90a03c8924b637b816595d08c15bcd320dd`（PR #32）。`API_GO_GRAPHQL_READ_MODE` 默认 `legacy`，启动日志里的 16 个 query 只计这一批。六个新闻事件 root 另看 `API_GO_GRAPHQL_NEWS_EVENTS_MODE`，默认 `legacy`，非法值启动失败。两个都是 `go` 才登记；读查询为 `legacy` 时不另挂 `/graphql`。新闻事件为 `legacy` 时，含这六个 root 的文档整包回 NestJS。生产入口不切换。回滚只把 `API_GO_GRAPHQL_NEWS_EVENTS_MODE` 改回 `legacy`。Mongo 驱动保持 `go.mongodb.org/mongo-driver/v2 v2.9.2`。

真实栈工作流：`.github/workflows/api-go-news-events-read-smoke.yml`（label `api-go-news-events-read-smoke`）。验收链接在该 run 出现后回填到本文。

## 迁入的 root

权限都是服务端重推导的 `items.read`。组织只来自 membership，不读 JWT 里的 orgId 或 permission。

| Root | 行为 |
| --- | --- |
| `newsEvents` | 按 orgId、时间窗、status、entity 读 `NewsEvent`。热度、可信度、来源分类、去重和排序对齐 Nest resolver。`windowDays` 省略时列表窗是 30 天，权威统计窗仍是 45 天。 |
| `newsEvent` | 错组织返回 null。带 items、timeline、来源证据和分类分布。时间线窗取 `max(backfillDays, lookbackDays)`，缺省 30 天。 |
| `newsEventBrief` | 只在 `metadata.briefV1` 指纹和语言命中时返回缓存简报。`forceRefresh` 或未命中不返回空简报，按生产 Nest 的失败语义给出 internal error。 |
| `newsEventReferencedArticles` | 只返回该组织、该事件实际关联的文章。 |
| `topicGroups` | Mongo `processeditems` 聚合，缓存键与 Nest 相同。 |
| `eventGroups` | 同上，按 duplicate / entity / topic 分组。 |

`newsEventSourcePolicySyncStatus`、`newsEventSettings`、来源策略读写、mutation、subscription、聚类和采集留在 NestJS。选中未迁 root 时整包回 Nest。

热度和权威打分复用公开故事详情里已经对齐 Nest 的未导出公式，`eventscore.go` 只增加导出包装。来源分类只看四张名单。

## 未验证

- 真实模型网关。缓存未命中不调用模型，不写 `briefV1`，返回 internal error，不返回空简报。
- 浏览器点击和生产流量。
- Web 的 URL、SDL 和客户端 query 没有改。
- FE-TPL-02 仍开放。SEC-01 的真实登录态未在本批验证。
