# 后端迁移地图

2026-10-19条目入库选批：main仍91e759b449c4511dc96d86539ea0eb258754d07e/普通CI39247556593成功；审计#92仍OPEN，NewsNow已Ready #94（headb33cc1ea、普通CI39296327154运行中），四订阅已有contract/exec开发/in_progress，均继续占用。新认领[ITEMS-INGEST-001](tasks/ITEMS-INGEST-001.md) reserved，[完整提示词](tasks/ITEMS-INGEST-001.prompt.md)在Ready规划#93发布：1HTTP+5Mutation、原文/读模型/原子BullMQ producer与raw_item同步/定时补偿，Nest流水线worker保留。仅本候选深读，登记hydration具体GAP-ITEMS-001，不重建地图或把未合PR计main。

2026-10-19四订阅选批：fetch后main仍`91e759b449c4511dc96d86539ea0eb258754d07e`、普通CI39247556593成功，无新业务合并；审计Ready #92仍OPEN/head28c8f761，NewsNow工作区已有main/config/新业务包及Nest来源relay开发，状态in_progress、无业务PR，均保持占用。新增[GRAPHQL-SUBSCRIPTIONS-001](tasks/GRAPHQL-SUBSCRIPTIONS-001.md) reserved及[完整执行提示词](tasks/GRAPHQL-SUBSCRIPTIONS-001.prompt.md)，复用[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发布。只迁四个Subscription完整WebSocket执行/投影、三通道PubSub和itemPipeline广播观察链，以及同连接非本批operation整份legacy兼容；Socket.IO/producer/worker/cron不认领。仅限定深读相关源码及两批共享diff，不重建地图或增加main注册数；下方旧快照不覆盖本增量。

2026-10-19本次继续选批：最新main `91e759b449c4511dc96d86539ea0eb258754d07e`，相对c70b0373仅合入上批规划#91，未新增业务实现；[普通CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)精确head成功。审计实现[Ready #92](https://github.com/wei500L/newwei/pull/92) OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1，普通CI39248452603成功，范围继续占用，不能提前记main已消费。仅读其真实共享接线diff，没有重审审计业务。

新增[NEWSNOW-SOURCES-001](tasks/NEWSNOW-SOURCES-001.md) reserved，[完整提示词](tasks/NEWSNOW-SOURCES-001.prompt.md)已发出：两公开HTTP完整冷获取/强刷，64个来源ID、41个可达来源族（不是64个HTTP），双缓存/凭据/特殊解析/实时接缝及保持顺序的10并发池。[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)已发布认领，Go业务尚未实施；推荐、热点模型、Nest source-warm/热点Cron及其他BL-18范围不认领。只更新本链和当前占用，不重建地图或重算全仓统计；下方历史快照不覆盖本增量。

2026-10-19 本次规划刷新（仅占用和审计候选）：fetch 后 main=`c70b0373990ab931758f7a000511c2d34572fc33`；[#89](https://github.com/wei500L/newwei/pull/89) 实际 main merge `f1167769f8c1d90017a6105cc65f135741ea47a1`、[#90](https://github.com/wei500L/newwei/pull/90) 实际 merge `c70b0373990ab931758f7a000511c2d34572fc33` 均已可达。#81–#88 的七个业务 head 均为 main 祖先；#70 早已经 #77 合入，不能再按下方旧快照分配。选批时无开放 PR；[普通 CI39163544617](https://github.com/wei500L/newwei/actions/runs/39163544617) 在精确SHA c70b0373990ab931758f7a000511c2d34572fc33 成功（verify/vector-integration/api-go-user-settings-integration success，两个regen skipped）。只核合并/占用，未重新验收这些全域业务，不从CI推断部署或实网结果。

本次仅新增 [AUDIT-OUTBOX-001](tasks/AUDIT-OUTBOX-001.md) reserved：[完整执行提示词](tasks/AUDIT-OUTBOX-001.prompt.md)，迁审计失败补偿整链，含三状态轻候选/入选payload查询优化。[Ready规划PR #91](https://github.com/wei500L/newwei/pull/91)已发布认领；尚无业务目录/PR/实现，MySQL+Redis，Nest仍消费；其余Outbox/worker不认领。下面各日期和覆盖统计继续是历史快照，当前任务状态以任务索引及本增量为准；不重建地图。

本批整合（2026-10-18）：main=`90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`。开放 PR [#80](https://github.com/wei500L/newwei/pull/80)/[#85](https://github.com/wei500L/newwei/pull/85)（规划）与 [#81](https://github.com/wei500L/newwei/pull/81)/[#82](https://github.com/wei500L/newwei/pull/82)/[#83](https://github.com/wei500L/newwei/pull/83)/[#84](https://github.com/wei500L/newwei/pull/84)/[#86](https://github.com/wei500L/newwei/pull/86)/[#87](https://github.com/wei500L/newwei/pull/87)（实现）由[整合 PR #89](https://github.com/wei500L/newwei/pull/89)（分支 `integration/merge-open-prs-b80-87`）以 merge commit 一次性收口（冲突按开关/键取并集，未 squash/rebase/force-push）；8 个 head：84f8ffde、e8ac410e、0b89196f、52340760、2c52763c、38e4e0e1、4d6d24b8、2b0da7ec。本页下方注册覆盖与模块页的统计日期仍是各自历史快照，不回填为本批现值；任务占用与状态以[任务索引](tasks/README.md)为准，merged 回填（merge SHA 与 CI 证据）由后续文档提交完成。以下“最新…”段落为各次发出快照（不同会话交错），不覆盖本段。

最新知识图谱选批（2026-10-18）：main仍90765633，普通CI39149114456成功；网关#81、来源策略#82、OIDC#83均Ready开放，CSV导出已见独立目录开发。新认领[KNOWLEDGE-REVIEW-001](tasks/KNOWLEDGE-REVIEW-001.md)，完整迁人工证据复核/关系校正/边聚合与审计缓存，并改善已迁复核队列的固定候选遮挡，[完整提示词](tasks/KNOWLEDGE-REVIEW-001.prompt.md)在规划#80发布。只需MySQL/Redis，ingestion与outbox消费者留Nest；仅续核本域，不新增业务实现、不重建地图。

最新导出选批（2026-10-18，main90765633未变，普通CI39149114456成功）：网关#81/来源策略/OIDC占用保持。新认领[ANALYSIS-EXPORT-001](tasks/ANALYSIS-EXPORT-001.md)，完整迁移items/events两路CSV及5000选择/批量投影/等价去重优化，[提示词](tasks/ANALYSIS-EXPORT-001.prompt.md)在规划#80发布。search整路因归档准备保留Nest；只核本候选，不新增业务实现/注册或重建地图。

最新OIDC选批（2026-10-18）：main仍90765633，普通CI39149114456成功；网关12路已提交Ready #81，来源策略四写已见独立worktree开发，两者继续占用。新认领[OIDC-LOGIN-001](tasks/OIDC-LOGIN-001.md)的组织SSO三入口完整协议/会话/MFA/handoff链，[提示词](tasks/OIDC-LOGIN-001.prompt.md)复用规划#80发布；只深入该身份候选，不包含头像/导出，不重建地图。

最新本批（2026-10-18，main90765633未变）：普通CI39149114456已success。LLM-GATEWAY-OPS-001已见独立worktree真实业务开发，保持占用；新认领[SOURCE-POLICY-WRITE-001](tasks/SOURCE-POLICY-WRITE-001.md)的来源策略四Mutation完整版本链及旧设置13写两处剩余公共接线，[执行提示词](tasks/SOURCE-POLICY-WRITE-001.prompt.md)复用规划#80发布。仅深入settings本候选，不重建全仓地图；不修改正在开发窗口的记录要求。

先读本页 → [PLANNING](PLANNING.md) → [当前任务](tasks/README.md) + [缺口摘要](GAPS.md#当前摘要) → [候选队列](BACKLOG.md) → 候选域与源码。[实现核对深度](AUDIT.md)、[开关/执行所有权/复用入口](DEPENDENCIES.md)、[证据](EVIDENCE.md)按需展开。Nest 暂时保留。

最新规划增量（2026-10-18）：最终刷新main90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，[IDENTITY-ONBOARDING-001](tasks/IDENTITY-ONBOARDING-001.md)14路已由[#79](https://github.com/wei500L/newwei/pull/79)实际merge f35ec572合入，旧规划#78也已合入；此前#70–#76经#77合入的事实不变。新main普通CI39149114456运行中，旧c39f282f成功不能替代。新认领[LLM-GATEWAY-OPS-001](tasks/LLM-GATEWAY-OPS-001.md)治理与真实探测12路，[独立提示词](tasks/LLM-GATEWAY-OPS-001.prompt.md)改在独立规划分支docs/plan-llm-gateway-ops发布；只深读该候选并更新必要记录。下面3cedce9a/9d0462e1日期和注册统计是历史快照，不能当作最新main现值，合并/新占用看任务索引。生产启用与外部验证不由merge/CI推断。

最新RSS选批增量（2026-10-18）：再次fetch main仍90765633，开放业务#81–#84未变；知识复核目录已见业务开发，摘要投递目录已创建但尚未见改动，均继续占用。新增[RSS-TRANSLATION-001](tasks/RSS-TRANSLATION-001.md) reserved，[完整提示词](tasks/RSS-TRANSLATION-001.prompt.md)随[规划PR #85](https://github.com/wei500L/newwei/pull/85)发布：单Mutation的双provider/四字段/正文分块/两层缓存/日志指标完整链，同时修复GAP-RSS-001状态投影覆盖共享完整网关缓存。仅深入RSS调用链，不重迁条目列表或导出，不启动业务，历史统计不提前增加。

最新digest选批增量（2026-10-18）：fetch后main为`90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`，普通CI39149114456 success；#69/#70已merged，#70–#76经#77合入，#79身份申请/邀请也已合入。开放业务Ready #81网关、#82来源策略、#83 OIDC、#84分析导出继续占用；开放规划[#80](https://github.com/wei500L/newwei/pull/80)的知识复核认领同样保留，不能以main尚无task文件重复派发。新增[DIGEST-DELIVERY-001](tasks/DIGEST-DELIVERY-001.md) reserved：[完整提示词](tasks/DIGEST-DELIVERY-001.prompt.md)，只补每日摘要Cron→到期认领→真实SMTP→状态/通知完整链，原五HTTP不重迁；包含摘要专用Nest通知桥及明确切换所有权。本次只深读该链、维护规划，未实施、未创建业务目录，历史全域统计/审查日期不更新为新验收。

最新规划增量（2026-10-18）：main已到c39f282f11952b487c3ef6fefb14882db265ed9e，#70–#76经[#77](https://github.com/wei500L/newwei/pull/77)合入，普通CI成功，当前无开放PR。新增[IDENTITY-ONBOARDING-001](tasks/IDENTITY-ONBOARDING-001.md)的14条申请/审批/邀请入组完整链，[提示词](tasks/IDENTITY-ONBOARDING-001.prompt.md)已发出。本次只深读identity候选并更新必要认领，不重建全仓地图；下面3cedce9a/9d0462e1日期和注册统计是历史快照，不能当作c39f282f现值，六批合并/新占用看任务索引。生产启用与外部验证不由merge/CI推断。

2026-10-18 本次规划增量：#69 已合并，最新代码基线为 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；相对下述3cedce9a仅文档/导航变化，业务与注册覆盖未变，main普通CI成功。#70仍OPEN/Ready，head adb765d0，继续占用工作台8写。[NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md) 已reserved，补新闻事件简报冷生成/强刷及必要日志/写回；[执行提示词](tasks/NEWS-BRIEF-001.prompt.md) 已保存，本窗口不实施。其余历史全域审查日期保持，只有本root按最新SHA深入续核。

用户随后要求再并行一批：同一main下认领[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)，补存储test、S3交付及已有REST/GraphQL详情URL；[独立提示词](tasks/STORAGE-MEDIA-001.prompt.md)已保存，与简报业务包隔离，共享接线按任务语义段最小增量。两批均reserved、未实施，统一在[规划PR #71](https://github.com/wei500L/newwei/pull/71)发布记录。

第三批增量（仍main9d0462e1）：用户简报目录已见业务开发，改in_progress；存储编码目录已创建，继续占用。新增[ITEMS-LIST-001](tasks/ITEMS-LIST-001.md) reserved：[提示词](tasks/ITEMS-LIST-001.prompt.md)完整迁移items分页/相关性/个性化与批量投影；核心文件与前两批隔离，共享只读selection元数据及items注册段已登记。本规划窗口只改文档，不把本地开发/提示词发出计为main进度。

本轮基线：`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`；2026-10-18 14:37–14:42 MSK 做结构/指定业务分支静态核对，14:49 再 fetch，main 未变。15:01–15:08续审补组织八写/设置缓存与来源策略、导出拆分证据，main未变；深度按审查组记录，未逐字段审完的内容在AUDIT明列。普通 CI 与启用证据只在 EVIDENCE 维护。

## 注册覆盖

HTTP/Query/Mutation 为“生产 Go 接管注册 / Nest 契约入口”，不是功能完成率或启用比例；`—` 为无此类主 API 入口。HTTP 以 METHOD+完整路径去重，SSE 算一条；四订阅和传输见域页。vector-go 三条独立 HTTP 不并入主 API 分母。

| 模块 ID | 产品域 | HTTP | Query | Mutation | 队列与外部依赖 | 详情 |
|---|---|---|---|---|---|---|
| `identity` | 身份、组织与访问控制 | 21/51 | 7/7 | 8/8 | 邮件/OIDC；会话缓存 | [详情](modules/identity.md) |
| `personal` | 个人设置、阅读工作台与公共门户 | 31/31 | — | — | 邮件 Cron；模型冷路径 | [详情](modules/personal.md) |
| `workspace` | 通知、看板与告警交互 | 13/13 | 10/11 | 0/11 | 告警 worker；Nominatim/OpenSky | [详情](modules/workspace.md) |
| `items` | 条目检索、RSS 阅读与处理结果 | 6/7 | 6/7 | 0/4 | 索引后台任务；ES/vector | [详情](modules/items.md) |
| `analysis` | 分析协作工作区与导出 | 23/26 | 1/1 | 0/3 | analysis 队列/导出 | [详情](modules/analysis.md) |
| `news` | 新闻事件、指标、聚类与内容流水线 | 12/17 | 9/9 | 0/1 | 流水线/聚类恢复/模型 | [详情](modules/news.md) |
| `knowledge` | 知识图谱、实体情报与影响传播 | — | 11/11 | 0/1 | ingestion Cron/证据 | [详情](modules/knowledge.md) |
| `crawl` | 采集源、模板、画像、工作流与 Frontier | 54/68 | 2/3 | 0/5 | crawl4ai/Frontier/BullMQ | [详情](modules/crawl.md) |
| `situation` | 态势监控、地理与实时信号 | 12/16 | — | — | Telegram/Oref/AIS/刷新 | [详情](modules/situation.md) |
| `settings` | 设置中心与平台治理 | 39/43 | 16/16 | 13/17 | 共享设置缓存/SMTP | [详情](modules/settings.md) |
| `model-gateway` | 模型接入、密钥与 LLM 网关 | 21/33 | — | — | LiteLLM/密钥下发 | [详情](modules/model-gateway.md) |
| `infrastructure-data` | 基础设施、采集凭据与数据运行 | 15/25 | — | — | S3/vector/归档/地理 | [详情](modules/infrastructure-data.md) |
| `observability` | 日志、异常、质量、遥测与运维 | 26/32 | — | — | 分类报告/恢复队列 | [详情](modules/observability.md) |
| `assistant` | Assistant 与模型任务 | — | 3/3 | 0/4 | assistant worker/模型 | [详情](modules/assistant.md) |
| `economic` | 经济数据与 AkShare | 0/3 | 6/6 | 0/3 | AkShare/repeat job | [详情](modules/economic.md) |
| `archive` | 归档阅读与准备任务 | 1/1 | 0/3 | — | 准备任务/模型 | [详情](modules/archive.md) |
| `async-runtime` | 队列、调度、Outbox 与实时传输 | 0/4 | — | — | worker/Cron/Outbox/WS | [详情](modules/async-runtime.md) |
| `vector` | 独立 Go 服务与 vector 上游切换 | — | — | — | 独立 Qdrant 服务 | [详情](modules/vector.md) |


合计 **370 HTTP / 77 Query / 57 Mutation / 4 Subscription**；Go 注册 **274 / 71 / 21 / 0**。18 域/42 Nest 模块归属已重新核对，分母及 main 注册相对14:18均无变化。本轮是文档与证据完善，新增业务迁移数为0；公开 live 仍 shadow，由 Nest 响应，不计 Go 接管。

## 实现与接线缺口

- [GAP-NEWS-001](GAPS.md#gap-news-001)：newsEventBrief 已注册，缓存 miss/forceRefresh 缺模型生成与 metadata 写回。
- [GAP-CRAWL-001](GAPS.md#gap-crawl-001)：采集媒体入口已注册，MySQL blob 可下发，S3 分支固定空返回导致404。
- [GAP-GQL-001](GAPS.md#gap-gql-001)：设置13写已合并，但 main 的独立路由/资源条件漏接。可达组合和 #70 候选修复范围见运行时页；不重新派发13写。
- [GAP-ASYNC-001](GAPS.md#gap-async-001)：历史/配置/缓存读取在 Go，不代表生成、入队、worker、Cron、订阅执行也在 Go。
- wireDataRuntimeSettings 吞错已确认；当前合法初始化路径尚未证实可触发，列为 OBS-DATA-001，不能宣称九路必然不可用。

## 当前占用与剩余顺序

- [SETTINGS-WRITE-001](tasks/SETTINGS-WRITE-001.md)：merged，#68 → `3cedce9a`；剩余接线关联 GAP-GQL-001。
- [WORKSPACE-WRITE-001](tasks/WORKSPACE-WRITE-001.md)：pr_open，[Ready #70](https://github.com/wei500L/newwei/pull/70)，14:56 head `adb765d0180e8b34910181e8c6fde8be400a2dff`（比200ab944只多历史报告文档），worktree 干净，已正常 merge #68；8写仍未进 main，不重复派发。其公共接线仍需检查设置写路由遗漏。
- 地图首版 [#69](https://github.com/wei500L/newwei/pull/69) 已于2026-10-18 15:31 MSK合并，merge为9d0462e1；本次规划增量使用独立文档分支，见NEWS-BRIEF-001。目录存在、工作目录干净都不能证明执行器活跃。

[BACKLOG](BACKLOG.md) 保存未认领队列：先协调 BL-01 公共接线，再补 BL-02 简报/BL-03 S3；随后完整条目查询、来源策略、导出、metadata 与登录主链。归档/采集/告警/分析/Assistant/经济等异步链先明确生产者、消费者与外部边界。候选包含未迁入口、已注册部分实现、接线及必要 Nest 步骤，不只筛 Nest 行。

真实部署、生产流量和实网调用均未核实。源码默认/Compose pilot 与实际启用分别表达；目前不能给出“完整迁移总数”。新对话短启动提示词见 [PLANNING](PLANNING.md#新对话短启动提示词)。
