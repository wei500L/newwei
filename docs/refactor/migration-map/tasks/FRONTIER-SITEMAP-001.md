# FRONTIER-SITEMAP-001 · Frontier 站点地图发现配置与诊断闭环

- 状态：`merged`；2026-11-01 核实 [#158](https://github.com/wei500L/newwei/pull/158) 实际 merge `9e66e7f56acd0cd1b56dacb585f4c04f626888dd`；最终源 head `4dd76f7339eaec1bf499cedfb7886c3678fea637` 已是当前 main 祖先，[源普通 CI 41314336961](https://github.com/wei500L/newwei/actions/runs/41314336961) 三主 job success，两个 regen skipped。
- 最终 main `9ebce09c4fb72f9318443266b295c9501364de3f` 的[普通 CI 41317912036](https://github.com/wei500L/newwei/actions/runs/41317912036) 已 completed/success，三主 job success、两个 regen skipped；中间 merge CI 41317901968 cancelled 单列，不冒称通过。规划 #157 仍开放。
- 缺口：`GAP-FRONTIER-SITEMAP-001`，对应[采集复核 FN-03](../../review/crawl.md)；不是重做已完成的表格修复或迁移退役。
- 原规划基线：`a8cb0028d38f7237a2586d0d4e5d4571435aebca`（规划 #149 已合入）；该 head CI 41307901088 后续已 success。当前完成核对基线与 CI 以上述最终 main 为准。
- 分支：`codex/fix-frontier-sitemap-discovery`；实际工作树 `/Users/oo/project/newwei-frontier-sitemap`，保留不清理。业务实现已在 main，原提示词不再待执行；完成记录由规划 #157 回填。
- 修复前证据：`apps/api-go/internal/crawlfrontiernode/discover.go:913` 的 discoverSitemapSeeds 只实现 disabled，忽略 RequestTimeoutMs，其余模式共走默认链，仅返回 discoveryMode/candidateCount；`internal/crawlmetadata/discover_seed.go:16` 无模式/超时/完整诊断参数。运行内 seedMethod 因而为空。
- 固定历史依据：[e72440e1 的 crawl-metadata.service.ts](https://github.com/wei500L/newwei/blob/e72440e186acbdf671be904cc98d1dd2f9858cbf/apps/api/src/modules/crawl/crawl-metadata.service.ts#L243)，包括 discoverSitemap、resolveSitemapSeedUrls 与 sitemap 遍历/缓存 helper；不恢复 Node app。
- 产品链：Frontier 配置/运行 → ProcessQueuedNode → crawlmetadata sitemap 请求与候选 → run/node 诊断与种子物化 → Web Frontier 控制台。
- 所有权：`internal/crawlmetadata`、`internal/crawlfrontiernode`、必要的采集域内部诊断模型/投影、Web `app/(app)/admin/ops/crawl-frontier`；CI 只允许既有 Frontier 步骤的必要增量。新增具名参数/返回模型，保留其它发现调用的现有默认。
- 并行边界：可与 `NEWS-SOURCE-SNAPSHOTS-001` 分窗口执行；不改 newssources/newssourcescheduler、news-sources Web、main/config 或共享语言资源。本轮 CI 必要增量仅归本任务，另一任务沿用现有 scheduler 选择器。

验收：robots/common_paths/sitemap_only/disabled 按真实历史规则执行；逐请求 timeout 生效且不串改共享配置；八个诊断字段 discoveryMode、seedMethod、robotsUrl、robotsDiscoveredSitemaps、attemptedSitemaps、fetchedSitemaps、parsedSitemaps、candidateCount 反映实际过程；过滤/去重/时间信号/节点落地与 UI 显示一致。common_paths 不请求 robots；旧 helper 中 robots 与 sitemap_only 都可查 robots 并回退常用路径，不凭名称另造语义。

保留逐跳 SSRF/重定向校验、条件 HTTP/XML 缓存、orgId/run/node 绑定、取消与已有预算/调度规则；不放宽安全门供测试、不批量重跑历史任务、不加新迁移 mode/依赖/框架。使用受控 HTTP fixture 与既有 CI，不能用 disabled/frontier_only 代替 sitemap 成功分支覆盖。

本机仅静态检查/必要格式化，不安装或运行 build/test/lint/typecheck/vet/Docker/服务。编码窗口只更新自身 task/PR，交付 Ready PR、精确 head 普通 CI、静态审查 file:line 与未验证边界；正常提交/push，不合并/auto-merge/amend/rebase/force-push，不部署或访问真实网站/crawl4ai。

## 实际落地与验证边界

- `internal/crawlmetadata/sitemap_discovery.go:133` 接入模式/逐请求预算及八字段诊断，`crawlfrontiernode/discover.go:902` 调用并转换为原 metadata 协议，`:841,860` 进入节点/run 数据；其它发现 wrapper 保留默认。
- `internal/crawlfrontiernode/integration_test.go:959` 的 TestFrontierNodeSitemapSeedMaterialization 以进程内 stub HTTP transport 执行真实 robots/XML→候选→子节点/诊断落地；既有 CI Frontier 步骤实际 success，逐跳 SSRF/重定向仍在 fetchWithStatus。Web 控制台 `crawl-frontier-console.tsx:2329` 展示具名诊断投影，配套投影测试纳入 Web 门禁。
- 本次仅静态复核相关接线、类型/返回、模式/错误/租户边界与 CI 去向，不冒充整包完整重审；未运行本机 build/test/lint/typecheck/vet/Docker/服务，未访问真实站点/crawl4ai。GAP-FRONTIER-SITEMAP-001 按源码范围关闭，不代表部署或实网验收。
