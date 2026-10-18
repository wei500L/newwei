# ITEMS-LIST-001 · 完整GraphQL条目列表与排序

- 状态reserved；2026-10-18第三批并行提示词发出，尚无本任务开工证据。
- 来源BL-05/GAP-LEGACY-001的Query items子范围；[完整提示词](ITEMS-LIST-001.prompt.md)。
- 代码基线9d0462e16d88d146b8afbf67cdd58d8b7419ff29；main相对前批未变，最近5次普通CI成功。业务PR/head/merge/本批CI尚无，实网与部署未验证。
- 编码分支refactor/go-graphql-items-list；worktree /Users/oo/project/newwei-go-graphql-items-list，尚未创建。规划记录复用docs/plan-news-event-brief / [Ready PR #71](https://github.com/wei500L/newwei/pull/71)，本批提交推送后远端可见；规划PR不是业务交付。
- 本批强化用户要求：专注必要业务，不写防御性框架；新增/修改源码注释全英文，在分页/排序/租户绑定处解释原因，文档/提交/PR中文。

## 精确范围和事实源

POST /graphql 的Query items(after:String,filters:ItemsFiltersInput,first:Int!=10,orderBy:ItemsOrderBy!=CREATED_DESC,page:Int,rankingMode:ItemsRankingMode,search:String):ItemConnection!，items.read，org/user取服务端身份。只此新root，完整page/cursor、RECENCY/RELEVANCE/PERSONALIZED、双read-model分支、嵌套投影与必要外部副作用。

已按完整SHA读取Nest items.resolver.ts的items/cursor/totalCount选择/toItemModel、DTO、ItemsListService分页与个性化全链、ItemsSearchService相关性/重排/高亮、helpers/shared权重、ScopedItemsReadingLoader租户绑定；Go itemsreading服务/召回/store/投影、graphql adapter/model、newsbehavior.GetPersonalizationProfile、llmembed.Rerank。

确认：Go REST List只有RECENCY、无items root；现成候选融合不是最终相关性分数。filters:{}覆盖历史filters不能被现有decodeFilters抹去；相关性rerank默认启用且失败503；个性化MIN180/MAX1600/乘8及窗口扩大与正负六维画像必须迁。Nest选择字段驱动count/result加载，Go Context尚无该表面，需要最小只读selection元数据与本页批量装配，避免逐edge调用item()。

## 文件所有权/并行

拥有internal/itemsreading及graphqlread/itemsreading的列表/排序/批量投影，llmembed仅rerank必要options/观测；contract/exec仅只读选择元数据，不变更预规划/权限/Mutation。main/config仅新ITEMS_LIST子开关和items注册段。

NEWS-BRIEF-001已见代码开发，排除newsevents/publicportal/llmlogs；本批新增rerank日志在itemsreading隔离实现，不依赖简报未合入writer。STORAGE-MEDIA-001 worktree已创建，排除S3/client/config导出/crawl/settingscrawl，不改go.mod/go.sum。#70 OPEN/Ready adb765d0，排除工作台八写、公共GraphQL顶层接线与mutation_test。其他候选不认领。

新API_GO_GRAPHQL_ITEMS_LIST_MODE空/legacy/go默认legacy，go须READ与ITEMS_READING均go，不强开父模式；RegisterList复用已有Service和模型，legacy时不注册root、整份operation预规划回Nest。无新worker/cron/事务/部署切流。

## 交接

仅规划/认领，main覆盖数不增。下一次fetch/核对PR与本机差异后实施；完整提示词明确分页/算法/选择投影/模型/日志/外部与错误语义。普通CI与静态核对分开，实网未验证；完成后更新自己的任务和本root，不关闭整个GAP-LEGACY-001。
