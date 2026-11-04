# NEWS-SOURCE-SNAPSHOTS-001 · 新闻源列表补齐缺失运营快照

- 状态：`merged`；2026-11-01 核实 [#159](https://github.com/wei500L/newwei/pull/159) 实际 merge `9ebce09c4fb72f9318443266b295c9501364de3f`；最终源 head `d97821f79c1eb808a9f23007f221264de40b7412` 已是当前 main 祖先，[源普通 CI 41315818788](https://github.com/wei500L/newwei/actions/runs/41315818788) 三主 job success，两个 regen skipped。
- 最终 main `9ebce09c4fb72f9318443266b295c9501364de3f` 的[普通 CI 41317912036](https://github.com/wei500L/newwei/actions/runs/41317912036) 已 completed/success，三主 job success、两个 regen skipped；中间 merge CI 41317901968 cancelled 单列，不冒称通过。规划 #157 仍开放。
- 缺口：`GAP-SOURCE-SNAPSHOTS-001`，对应[采集复核 NS-02](../../review/crawl.md)；不重做此前已修的 NS-03 runtime 计数保留。
- 原规划基线：`a8cb0028d38f7237a2586d0d4e5d4571435aebca`（规划 #149 已合入）；该 head CI 41307901088 后续已 success。当前完成核对基线与 CI 以上述最终 main 为准。
- 分支：`codex/fix-news-source-snapshots`；实际工作树 `/Users/oo/project/newwei-news-source-snapshots`，保留不清理。业务实现已在 main，原提示词不再待执行；完成记录由规划 #157 回填。
- 修复前证据：`apps/api-go/internal/newssources/store.go:123-142` 仅 readSnapshots → runtime 装配 → 空 summary；`cmd/api/news_sources.go:22` 未注入快照生成依赖。`internal/newssourcescheduler/snapshot.go:245` 已有 orgId-scoped RefreshSnapshotsForSources，但列表没有调用。
- 固定历史依据：[e72440e1 的 news-source.service.ts](https://github.com/wei500L/newwei/blob/e72440e186acbdf671be904cc98d1dd2f9858cbf/apps/api/src/modules/crawl/news-source.service.ts#L331)：当前页缺失 IDs → refreshSnapshotsForSources(orgId, IDs) → 重读缺失行 → 合并，再生成列表。
- 产品链：GET `/api/admin/news-sources`（现有 `crawl.read`）→ 当前页缺失检测 → 既有快照聚合/持久化 → 重读 → latestJob/latestCrawlTask/latestArticle/stats24h + runtime → 新闻源运维 UI。
- 所有权：`internal/newssources`、`internal/newssourcescheduler` 的快照能力/必要窄导出、`cmd/api/news_sources.go` 及必要的既有 scheduler 构造复用、Web `app/(app)/admin/ops/news-sources` 与本包集成测试；不改整个启动顺序。
- 并行边界：可与 `FRONTIER-SITEMAP-001` 分窗口执行，不触及 crawlmetadata/crawlfrontiernode/Frontier Web/共享语言资源；不改 CI workflow，测试命中现有 `TestNewsSourceSchedulerIntegration` 选择器。

验收：只为当前 org、当前页真实缺失的 sourceId 生成快照；已存在的不重建；补齐后在同一响应重读呈现真实最新活动和 24 小时统计；重复读取不重复生成，空页无刷新，无历史的真实来源保留合法空值/零统计。runtime 队列/背压/RSS 状态不被空 summary 或刷新覆盖，分页/筛选/排序不变。

使用窄接口/函数注入，避免 newssources 与 scheduler 反向 import 成环。不启动 cron/worker、不派发采集/HTTP/LLM、不依赖 SCHEDULE_ENABLED 才能补齐，也不把本次缺失补齐扩大成每次刷新全部或全库回填。刷新/重读错误按既有语义处理，不吞错伪造成功；保留 tenant、权限与已有幂等 upsert，不另加锁/重试框架。

本机仅静态检查/必要格式化，不安装/运行 build/test/lint/typecheck/vet/Docker/服务。编码窗口只更新本 task/PR，交付 Ready PR、精确 head 普通 CI、静态审查 file:line 和未验证边界；正常提交/push，不合并/auto-merge/amend/rebase/force-push，不访问真实服务。

## 实际落地与验证边界

- `internal/newssources/store.go:27,57,176` 提供窄 SnapshotRefresher、构造注入与当前页缺失补齐/重读；`cmd/api/news_sources.go:29` 以已有 DB/Redis 快照服务完成生产注入，不启动 cron/worker 或派发抓取。原 orgId 分页/重读与 runtime 装配保留。
- `internal/newssourcescheduler/news_source_snapshot_backfill_integration_test.go:155,251,305,325,355,372` 覆盖缺失补齐、只补缺失、空组织、无历史与刷新/重读错误，命中既有 TestNewsSourceSchedulerIntegration 选择器，最终 main 对应步骤 success。Web news-sources-ops-snapshot.test.tsx 覆盖最近活动、24h 统计与 runtime 同时展示。
- 本次仅静态复核相关生产接线、返回/错误、orgId/sourceId 与 CI 去向，不冒充全域重审；未运行本机 build/test/lint/typecheck/vet/Docker/服务，未部署、全库回填或访问真实外部服务。GAP-SOURCE-SNAPSHOTS-001 按源码范围关闭。
