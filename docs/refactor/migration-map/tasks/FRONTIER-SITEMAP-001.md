# FRONTIER-SITEMAP-001 · Frontier 站点地图发现配置与诊断闭环

- 状态：`reserved`；2026-11-01 已提供[执行提示词](FRONTIER-SITEMAP-001.prompt.md)，尚无编码 worktree/PR/head/CI。
- 缺口：`GAP-FRONTIER-SITEMAP-001`，对应[采集复核 FN-03](../../review/crawl.md)；不是重做已完成的表格修复或迁移退役。
- 核对基线：main `a8cb0028d38f7237a2586d0d4e5d4571435aebca`，规划 #149 已合入；前一业务 merge `2e63645d` 普通 CI 41286944654 三主 job success，两个 regen skipped。当前 main CI 41307901088 核对时尚未完成，不冒称通过。
- 分支建议：`codex/fix-frontier-sitemap-discovery`；复用匹配独立工作树，否则创建。规划分支为 `codex/plan-go-functional-next`；未合 main 时只取自身 task/prompt，不合并整条规划分支。
- 当前证据：`apps/api-go/internal/crawlfrontiernode/discover.go:913` 的 discoverSitemapSeeds 只实现 disabled，忽略 RequestTimeoutMs，其余模式共走默认链，仅返回 discoveryMode/candidateCount；`internal/crawlmetadata/discover_seed.go:16` 无模式/超时/完整诊断参数。运行内 seedMethod 因而为空。
- 固定历史依据：[e72440e1 的 crawl-metadata.service.ts](https://github.com/wei500L/newwei/blob/e72440e186acbdf671be904cc98d1dd2f9858cbf/apps/api/src/modules/crawl/crawl-metadata.service.ts#L243)，包括 discoverSitemap、resolveSitemapSeedUrls 与 sitemap 遍历/缓存 helper；不恢复 Node app。
- 产品链：Frontier 配置/运行 → ProcessQueuedNode → crawlmetadata sitemap 请求与候选 → run/node 诊断与种子物化 → Web Frontier 控制台。
- 所有权：`internal/crawlmetadata`、`internal/crawlfrontiernode`、必要的采集域内部诊断模型/投影、Web `app/(app)/admin/ops/crawl-frontier`；CI 只允许既有 Frontier 步骤的必要增量。新增具名参数/返回模型，保留其它发现调用的现有默认。
- 并行边界：可与 `NEWS-SOURCE-SNAPSHOTS-001` 分窗口执行；不改 newssources/newssourcescheduler、news-sources Web、main/config 或共享语言资源。本轮 CI 必要增量仅归本任务，另一任务沿用现有 scheduler 选择器。

验收：robots/common_paths/sitemap_only/disabled 按真实历史规则执行；逐请求 timeout 生效且不串改共享配置；八个诊断字段 discoveryMode、seedMethod、robotsUrl、robotsDiscoveredSitemaps、attemptedSitemaps、fetchedSitemaps、parsedSitemaps、candidateCount 反映实际过程；过滤/去重/时间信号/节点落地与 UI 显示一致。common_paths 不请求 robots；旧 helper 中 robots 与 sitemap_only 都可查 robots 并回退常用路径，不凭名称另造语义。

保留逐跳 SSRF/重定向校验、条件 HTTP/XML 缓存、orgId/run/node 绑定、取消与已有预算/调度规则；不放宽安全门供测试、不批量重跑历史任务、不加新迁移 mode/依赖/框架。使用受控 HTTP fixture 与既有 CI，不能用 disabled/frontier_only 代替 sitemap 成功分支覆盖。

本机仅静态检查/必要格式化，不安装或运行 build/test/lint/typecheck/vet/Docker/服务。编码窗口只更新自身 task/PR，交付 Ready PR、精确 head 普通 CI、静态审查 file:line 与未验证边界；正常提交/push，不合并/auto-merge/amend/rebase/force-push，不部署或访问真实网站/crawl4ai。
