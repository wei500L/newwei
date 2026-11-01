# NEWS-SOURCE-SNAPSHOTS-001 · 新闻源列表补齐缺失运营快照

- 状态：`reserved`；2026-11-01 已提供[执行提示词](NEWS-SOURCE-SNAPSHOTS-001.prompt.md)，尚无编码 worktree/PR/head/CI。
- 缺口：`GAP-SOURCE-SNAPSHOTS-001`，对应[采集复核 NS-02](../../review/crawl.md)；不重做此前已修的 NS-03 runtime 计数保留。
- 核对基线：main `a8cb0028d38f7237a2586d0d4e5d4571435aebca`；前一业务 merge `2e63645d` 普通 CI 41286944654 三主 job success、两个 regen skipped。当前 main CI 41307901088 核对时尚未完成。
- 分支建议：`codex/fix-news-source-snapshots`；规划分支 `codex/plan-go-functional-next`。开工刷新 main/CI/认领，复用匹配独立工作树，否则创建；未合 main 时只取自身 task/prompt。
- 当前证据：`apps/api-go/internal/newssources/store.go:123-142` 仅 readSnapshots → runtime 装配 → 空 summary；`cmd/api/news_sources.go:22` 未注入快照生成依赖。`internal/newssourcescheduler/snapshot.go:245` 已有 orgId-scoped RefreshSnapshotsForSources，但列表没有调用。
- 固定历史依据：[e72440e1 的 news-source.service.ts](https://github.com/wei500L/newwei/blob/e72440e186acbdf671be904cc98d1dd2f9858cbf/apps/api/src/modules/crawl/news-source.service.ts#L331)：当前页缺失 IDs → refreshSnapshotsForSources(orgId, IDs) → 重读缺失行 → 合并，再生成列表。
- 产品链：GET `/api/admin/news-sources`（现有 `crawl.read`）→ 当前页缺失检测 → 既有快照聚合/持久化 → 重读 → latestJob/latestCrawlTask/latestArticle/stats24h + runtime → 新闻源运维 UI。
- 所有权：`internal/newssources`、`internal/newssourcescheduler` 的快照能力/必要窄导出、`cmd/api/news_sources.go` 及必要的既有 scheduler 构造复用、Web `app/(app)/admin/ops/news-sources` 与本包集成测试；不改整个启动顺序。
- 并行边界：可与 `FRONTIER-SITEMAP-001` 分窗口执行，不触及 crawlmetadata/crawlfrontiernode/Frontier Web/共享语言资源；不改 CI workflow，测试命中现有 `TestNewsSourceSchedulerIntegration` 选择器。

验收：只为当前 org、当前页真实缺失的 sourceId 生成快照；已存在的不重建；补齐后在同一响应重读呈现真实最新活动和 24 小时统计；重复读取不重复生成，空页无刷新，无历史的真实来源保留合法空值/零统计。runtime 队列/背压/RSS 状态不被空 summary 或刷新覆盖，分页/筛选/排序不变。

使用窄接口/函数注入，避免 newssources 与 scheduler 反向 import 成环。不启动 cron/worker、不派发采集/HTTP/LLM、不依赖 SCHEDULE_ENABLED 才能补齐，也不把本次缺失补齐扩大成每次刷新全部或全库回填。刷新/重读错误按既有语义处理，不吞错伪造成功；保留 tenant、权限与已有幂等 upsert，不另加锁/重试框架。

本机仅静态检查/必要格式化，不安装/运行 build/test/lint/typecheck/vet/Docker/服务。编码窗口只更新本 task/PR，交付 Ready PR、精确 head 普通 CI、静态审查 file:line 和未验证边界；正常提交/push，不合并/auto-merge/amend/rebase/force-push，不访问真实服务。
