# 历史增量快照（由 README 移出）

本文件保存 README 移出的历史增量快照，内容和顺序原样保留，仅作历史记录；其中所有注册覆盖数字、任务状态与基线 SHA 均为各自发出时点的快照，当前值以 [README.md](README.md) 与 [tasks/README.md](tasks/README.md) 为准。README 中保留的一行常驻导航（`先读本页 → …`）不属于历史增量，未复制到本文件。

2026-10-20 本批整合：main 基线 `91e759b449c4511dc96d86539ea0eb258754d07e`。开放 PR #92–#113（其中 #111 由 #112 取代并关闭）由整合 PR（分支 `integration/merge-open-prs-b92-113`）以 merge commit 一次性收口：21 条业务/文档 head 全部保留，#93 规划与后续交付 task 冲突按交付版归一，`main.go`/`config.go`/`env.sample`/`compose`/`ci.yml`/`go.mod` 按开关/键/步骤取并集；未 squash/rebase/force-push。下表与模块页的覆盖统计仍是各次历史快照，不回填为本批现值；任务状态与最终 head 以[任务索引](tasks/README.md)为准，merged 回填（merge SHA 与 CI 证据）由后续文档提交完成。

2026-10-19分析执行选批：main仍91e759b449c4511dc96d86539ea0eb258754d07e，普通CI39247556593成功，无新业务合并。#92/#94未合且原精确head普通CI成功；四订阅Ready #95观察head8d759fe2、普通CI39302998528运行中，条目入库in_progress，归档in_progress（已见vector/llmembed/规则端口开发），均保留占用。新增[ANALYSIS-RUNS-001](tasks/ANALYSIS-RUNS-001.md) reserved与[完整提示词](tasks/ANALYSIS-RUNS-001.prompt.md)，在Ready规划#93发布：三分析Mutation、原生BullMQ真正Go消费、统计/Geo/真实SSE、结果/事件/最终通知，含running恢复GAP-ANALYSIS-001和有界top30查询。双开关/owner回滚、英文文件注释、禁止占位实现明确。本次只深读该链，不启动业务、不重建地图或增加main覆盖；下方旧快照按原时点理解。

2026-10-19归档选批：fetch后main仍`91e759b449c4511dc96d86539ea0eb258754d07e`，普通CI39247556593成功；审计Ready #92 OPEN/head28c8f761不变，NewsNow Ready #94 OPEN/headcf25026f、普通CI39297914942已成功，均未合main。四订阅已Ready #95 OPEN/head68a4536d，首轮普通CI39301019113因Go modules drift gate失败、已加regen label，继续占contract/exec；条目入库已见itemsingest/pipelineenqueue/go.mod开发，改in_progress。新增[ARCHIVE-READING-001](tasks/ARCHIVE-READING-001.md) reserved及[完整执行提示词](tasks/ARCHIVE-READING-001.prompt.md)，在[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发布：三归档Query+search整路两模式、分类/显示/语义检索/兼容准备入队、单请求快照CSV优化，Nest准备worker明确保留。本次只深读该完整候选与相关共享diff，不重建地图或增加main覆盖；下方旧段落保留为发出快照，以本增量和任务表为准。

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


最新规划增量（2026-10-18）：最终刷新main90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，[IDENTITY-ONBOARDING-001](tasks/IDENTITY-ONBOARDING-001.md)14路已由[#79](https://github.com/wei500L/newwei/pull/79)实际merge f35ec572合入，旧规划#78也已合入；此前#70–#76经#77合入的事实不变。新main普通CI39149114456运行中，旧c39f282f成功不能替代。新认领[LLM-GATEWAY-OPS-001](tasks/LLM-GATEWAY-OPS-001.md)治理与真实探测12路，[独立提示词](tasks/LLM-GATEWAY-OPS-001.prompt.md)改在独立规划分支docs/plan-llm-gateway-ops发布；只深读该候选并更新必要记录。下面3cedce9a/9d0462e1日期和注册统计是历史快照，不能当作最新main现值，合并/新占用看任务索引。生产启用与外部验证不由merge/CI推断。

最新RSS选批增量（2026-10-18）：再次fetch main仍90765633，开放业务#81–#84未变；知识复核目录已见业务开发，摘要投递目录已创建但尚未见改动，均继续占用。新增[RSS-TRANSLATION-001](tasks/RSS-TRANSLATION-001.md) reserved，[完整提示词](tasks/RSS-TRANSLATION-001.prompt.md)随[规划PR #85](https://github.com/wei500L/newwei/pull/85)发布：单Mutation的双provider/四字段/正文分块/两层缓存/日志指标完整链，同时修复GAP-RSS-001状态投影覆盖共享完整网关缓存。仅深入RSS调用链，不重迁条目列表或导出，不启动业务，历史统计不提前增加。

最新digest选批增量（2026-10-18）：fetch后main为`90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`，普通CI39149114456 success；#69/#70已merged，#70–#76经#77合入，#79身份申请/邀请也已合入。开放业务Ready #81网关、#82来源策略、#83 OIDC、#84分析导出继续占用；开放规划[#80](https://github.com/wei500L/newwei/pull/80)的知识复核认领同样保留，不能以main尚无task文件重复派发。新增[DIGEST-DELIVERY-001](tasks/DIGEST-DELIVERY-001.md) reserved：[完整提示词](tasks/DIGEST-DELIVERY-001.prompt.md)，只补每日摘要Cron→到期认领→真实SMTP→状态/通知完整链，原五HTTP不重迁；包含摘要专用Nest通知桥及明确切换所有权。本次只深读该链、维护规划，未实施、未创建业务目录，历史全域统计/审查日期不更新为新验收。

最新规划增量（2026-10-18）：main已到c39f282f11952b487c3ef6fefb14882db265ed9e，#70–#76经[#77](https://github.com/wei500L/newwei/pull/77)合入，普通CI成功，当前无开放PR。新增[IDENTITY-ONBOARDING-001](tasks/IDENTITY-ONBOARDING-001.md)的14条申请/审批/邀请入组完整链，[提示词](tasks/IDENTITY-ONBOARDING-001.prompt.md)已发出。本次只深读identity候选并更新必要认领，不重建全仓地图；下面3cedce9a/9d0462e1日期和注册统计是历史快照，不能当作c39f282f现值，六批合并/新占用看任务索引。生产启用与外部验证不由merge/CI推断。

2026-10-18 本次规划增量：#69 已合并，最新代码基线为 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；相对下述3cedce9a仅文档/导航变化，业务与注册覆盖未变，main普通CI成功。#70仍OPEN/Ready，head adb765d0，继续占用工作台8写。[NEWS-BRIEF-001](tasks/NEWS-BRIEF-001.md) 已reserved，补新闻事件简报冷生成/强刷及必要日志/写回；[执行提示词](tasks/NEWS-BRIEF-001.prompt.md) 已保存，本窗口不实施。其余历史全域审查日期保持，只有本root按最新SHA深入续核。

用户随后要求再并行一批：同一main下认领[STORAGE-MEDIA-001](tasks/STORAGE-MEDIA-001.md)，补存储test、S3交付及已有REST/GraphQL详情URL；[独立提示词](tasks/STORAGE-MEDIA-001.prompt.md)已保存，与简报业务包隔离，共享接线按任务语义段最小增量。两批均reserved、未实施，统一在[规划PR #71](https://github.com/wei500L/newwei/pull/71)发布记录。

第三批增量（仍main9d0462e1）：用户简报目录已见业务开发，改in_progress；存储编码目录已创建，继续占用。新增[ITEMS-LIST-001](tasks/ITEMS-LIST-001.md) reserved：[提示词](tasks/ITEMS-LIST-001.prompt.md)完整迁移items分页/相关性/个性化与批量投影；核心文件与前两批隔离，共享只读selection元数据及items注册段已登记。本规划窗口只改文档，不把本地开发/提示词发出计为main进度。

本轮基线：`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`；2026-10-18 14:37–14:42 MSK 做结构/指定业务分支静态核对，14:49 再 fetch，main 未变。15:01–15:08续审补组织八写/设置缓存与来源策略、导出拆分证据，main未变；深度按审查组记录，未逐字段审完的内容在AUDIT明列。普通 CI 与启用证据只在 EVIDENCE 维护。
