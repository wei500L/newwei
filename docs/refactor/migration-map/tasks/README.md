# 任务认领与历史恢复索引

2026-10-19归档选批：fetch后main仍`91e759b449c4511dc96d86539ea0eb258754d07e`，普通CI39247556593成功；审计Ready #92 OPEN/head28c8f761不变，NewsNow Ready #94 OPEN/headcf25026f、普通CI39297914942已成功，均未合main。四订阅已Ready #95 OPEN/head68a4536d，首轮普通CI39301019113因Go modules drift gate失败、已加regen label，继续占contract/exec；条目入库已见itemsingest/pipelineenqueue/go.mod开发，改in_progress。新增[ARCHIVE-READING-001](ARCHIVE-READING-001.md) reserved及[完整执行提示词](ARCHIVE-READING-001.prompt.md)，在[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发布：三归档Query+search整路两模式、分类/显示/语义检索/兼容准备入队、单请求快照CSV优化，Nest准备worker明确保留。本次只深读该完整候选与相关共享diff，不重建地图或增加main覆盖；下方旧段落保留为发出快照，以本增量和任务表为准。

2026-10-19条目写/入库规划：main仍91e759b449c4511dc96d86539ea0eb258754d07e，普通CI39247556593成功。审计Ready #92 OPEN/head28c8f761不变；NewsNow已Ready #94 OPEN/headb33cc1eab4dd56d08e9a802a2670d363a3227462，普通CI39296327154运行中，核心/共享实际diff已核；四订阅worktree在91e759b4已有contract/exec业务增量，in_progress，无业务PR。新增[ITEMS-INGEST-001](ITEMS-INGEST-001.md) reserved及[完整提示词](ITEMS-INGEST-001.prompt.md)，复用Ready规划#93；只领取本完整链与raw_item补偿，不改四订阅contract/exec或其他Outbox。#93旧head c4ae295c普通CI39293839565成功，本轮新head另查。

2026-10-19四订阅规划刷新：origin/main仍`91e759b449c4511dc96d86539ea0eb258754d07e`，[普通CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)精确head成功。Ready审计[#92](https://github.com/wei500L/newwei/pull/92) OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1，普通CI39248452603成功；NEWSNOW-SOURCES-001已有main/config/核心包/来源relay开发，in_progress，无业务PR。新增[GRAPHQL-SUBSCRIPTIONS-001](GRAPHQL-SUBSCRIPTIONS-001.md) reserved：[提示词](GRAPHQL-SUBSCRIPTIONS-001.prompt.md)与原NewsNow规划共同在[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发布；本轮只更新相关占用/深读记录，不启动业务，#93旧head a92d0cab的普通CI39254495422成功不能代替追加后的head。下方各次旧快照按日期理解，状态以本段和表为准。

2026-10-19本次继续选批：最新main `91e759b449c4511dc96d86539ea0eb258754d07e`，相对c70b0373仅合入上批规划#91，未新增业务实现；[普通CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)精确head成功。审计实现[Ready #92](https://github.com/wei500L/newwei/pull/92) OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1，普通CI39248452603成功，范围继续占用，不能提前记main已消费。仅读其真实共享接线diff，没有重审审计业务。

新增[NEWSNOW-SOURCES-001](NEWSNOW-SOURCES-001.md) reserved，[完整提示词](NEWSNOW-SOURCES-001.prompt.md)已发出：两公开HTTP完整冷获取/强刷，64个来源ID、41个可达来源族（不是64个HTTP），双缓存/凭据/特殊解析/实时接缝及保持顺序的10并发池。[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)已发布认领，Go业务尚未实施；推荐、热点模型、Nest source-warm/热点Cron及其他BL-18范围不认领。只更新本链和当前占用，不重建地图或重算全仓统计；下方历史快照不覆盖本增量。

2026-10-19 本次规划刷新（仅占用和审计候选）：fetch 后 main=`c70b0373990ab931758f7a000511c2d34572fc33`；[#89](https://github.com/wei500L/newwei/pull/89) 实际 main merge `f1167769f8c1d90017a6105cc65f135741ea47a1`、[#90](https://github.com/wei500L/newwei/pull/90) 实际 merge `c70b0373990ab931758f7a000511c2d34572fc33` 均已可达。#81–#88 的七个业务 head 均为 main 祖先；#70 早已经 #77 合入，不能再按下方旧快照分配。选批时无开放 PR；[普通 CI39163544617](https://github.com/wei500L/newwei/actions/runs/39163544617) 在精确SHA c70b0373990ab931758f7a000511c2d34572fc33 成功（verify/vector-integration/api-go-user-settings-integration success，两个regen skipped）。只核合并/占用，未重新验收这些全域业务，不从CI推断部署或实网结果。

本次仅新增 [AUDIT-OUTBOX-001](AUDIT-OUTBOX-001.md) reserved：[完整执行提示词](AUDIT-OUTBOX-001.prompt.md)，迁审计失败补偿整链，含三状态轻候选/入选payload查询优化。[Ready规划PR #91](https://github.com/wei500L/newwei/pull/91)已发布认领；尚无业务目录/PR/实现，MySQL+Redis，Nest仍消费；其余Outbox/worker不认领。下面各日期和覆盖统计继续是历史快照，当前任务状态以下表及本增量为准；不重建地图。

main 结构/指定业务分支核对：2026-10-18 14:37–14:42 MSK；任务/worktree 再核14:56；main：`3cedce9aa3200436aba3596f63b559de5490cec8`。返回[入口](../README.md)。

## 当前占用与已合并历史

本批整合（2026-10-18）：main=`90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`。开放 PR [#80](https://github.com/wei500L/newwei/pull/80)/[#85](https://github.com/wei500L/newwei/pull/85)（规划）与 [#81](https://github.com/wei500L/newwei/pull/81)/[#82](https://github.com/wei500L/newwei/pull/82)/[#83](https://github.com/wei500L/newwei/pull/83)/[#84](https://github.com/wei500L/newwei/pull/84)/[#86](https://github.com/wei500L/newwei/pull/86)/[#87](https://github.com/wei500L/newwei/pull/87)（实现）由[整合 PR #89](https://github.com/wei500L/newwei/pull/89)（分支 `integration/merge-open-prs-b80-87`）以 merge commit 一次性收口（冲突按开关/键取并集，未 squash/rebase/force-push）；8 个 head：84f8ffde、e8ac410e、0b89196f、52340760、2c52763c、38e4e0e1、4d6d24b8、2b0da7ec。下表为本批收口后的当前占用事实，每个任务 ID 只有一行；merged 回填（merge SHA 与 CI 证据）由后续文档提交完成。以下“最新…”段落为各次发出快照（不同会话交错），不覆盖本段与下表。

本批续并（2026-10-18）：[RSS-TRANSLATION-001](RSS-TRANSLATION-001.md) 的[Ready PR #88](https://github.com/wei500L/newwei/pull/88)（head d4117032，+3692/-35，26 文件，自身普通 CI 成功）在整合 PR #89 之后由集成分支 `integration/merge-open-prs-b88` 单独收口；下表该行由 reserved 归一为 pr_open，均随本批进入 main。

最新复核选批（2026-10-18）：main90765633/普通CI39149114456 success；#81网关head0b89196f、#82来源策略head52340760、#83OIDC head2c52763c均Ready开放，CSV导出已见独立目录开发。新增[KNOWLEDGE-REVIEW-001](KNOWLEDGE-REVIEW-001.md) reserved，人工证据复核/关系校正/边聚合与队列选取改善；[完整提示词](KNOWLEDGE-REVIEW-001.prompt.md)随规划#80发布，未创建业务目录/PR。后续“最新”段落为各次发出快照，以本段及下表为本次占用事实；不干预已运行编码对话。

最新RSS选批（2026-10-18）：main仍90765633，#81/#82/#83/#84仍Ready且head分别0b89196f/52340760/2c52763c/38e4e0e1；已核其实际文件/共享接线，#81的llmlogs私有metadata helper重命名由新writer隔离。KNOWLEDGE-REVIEW-001目录已见review.go/new包开发，状态in_progress；DIGEST-DELIVERY-001目录已创建于main、未见业务改动，仍reserved，存在不代表代理在线。新增[RSS-TRANSLATION-001](RSS-TRANSLATION-001.md) reserved，[提示词](RSS-TRANSLATION-001.prompt.md)随[Ready规划PR #85](https://github.com/wei500L/newwei/pull/85)发出，业务目录未创建。只领取BL-24的RSS翻译，不重复派发其他item/采集/异步范围。

最新digest选批（2026-10-18）：main90765633/普通CI39149114456 success。开放Ready #81 head0b89196f（网关）、#82 head52340760（来源策略/旧设置写漏接线）、#83 head2c52763c（OIDC）、#84 head38e4e0e1（分析导出，后续修正已提交推送）均占用；已读实际diff中的业务文件及共享接线。开放规划[#80](https://github.com/wei500L/newwei/pull/80)含KNOWLEDGE-REVIEW-001 reserved，目录在main基线已创建且未见开发，保留认领；#80其他四批记录也继续有效，尚未合main不能重复派发。只读工作目录不等于确认执行器在线。

新增[DIGEST-DELIVERY-001](DIGEST-DELIVERY-001.md) reserved，原五HTTP契约不变，补每分钟摘要投递执行链、稳定分批到期扫描、旧slot失败认领和摘要专用通知桥；[提示词](DIGEST-DELIVERY-001.prompt.md)已保存并发出，业务分支/目录尚未创建。认领由独立docs/plan-digest-delivery文档分支在[Ready规划PR #85](https://github.com/wei500L/newwei/pull/85)发布，不改#80工作目录。下方旧快照和“最新”均按各次时间理解，本段仅刷新当前范围与冲突。

最新增量（2026-10-18）：fetch后main为c39f282f11952b487c3ef6fefb14882db265ed9e，#70–#76已通过[整合PR #77](https://github.com/wei500L/newwei/pull/77)合入；该SHA普通CI39142523834成功，开放PR为空。以下六批主提交/主要接线已在main，旧worktree均干净，不因目录保留而继续占用。只深入本次identity候选，不把此次合并核对当全仓业务验收。

最新导出选批（2026-10-18）：main90765633/普通CI39149114456 success不变，开放业务#81仍Ready/head0901ca15，来源策略在独立目录开发，OIDC reserved；均继续占用。新增[ANALYSIS-EXPORT-001](ANALYSIS-EXPORT-001.md) reserved，[完整提示词](ANALYSIS-EXPORT-001.prompt.md)在规划#80发布：items/events两路CSV，最多5000，保留筛选/排名/补全与CSV字节契约，token索引保持事件去重等价。search整路/归档/采集写不认领；核心analysisexport/itemsreading/newsevents窄端口与三批隔离，共享接线保留并集。

最新OIDC选批（2026-10-18）：main90765633/普通CI39149114456 success不变；开放业务Ready #81，head0901ca15aa31d5c00e98aa5c0c3f94a201b27219，实际业务/共享接线diff已核，网关仍未计入main。来源策略独立worktree已见policy/register及typed写支持开发，in_progress。新增[OIDC-LOGIN-001](OIDC-LOGIN-001.md) reserved，[完整提示词](OIDC-LOGIN-001.prompt.md)在#80发布；本批业务目录未创建，核心authlogin/authfactors/oidclogin与前两批隔离，公共接线保留并集。

最新选批增量（2026-10-18）：main90765633未变，普通CI39149114456已success；仅开放规划#80。LLM-GATEWAY-OPS-001已创建worktree并见llmgatewayops、profiles/ports.go及llmlogs probe writer开发，状态in_progress，不因没有业务PR释放。新认领[SOURCE-POLICY-WRITE-001](SOURCE-POLICY-WRITE-001.md) reserved：[完整提示词](SOURCE-POLICY-WRITE-001.prompt.md)，四策略写+GAP-GQL-001两处剩余接线，本批目录未创建；两批业务文件隔离，共享main/config/env保留并集。认领与提示词在#80正常提交发布。

最新增量（2026-10-18）：最终fetch后main90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，#79通过f35ec572合入，旧规划#78也已合入；该时刻开放业务PR为空（此后 #80–#87 相继开放，本批整合见上文）。此前#70–#76通过[整合PR #77](https://github.com/wei500L/newwei/pull/77)合入c39f282f的事实不变；旧SHA普通CI39142523834成功，新main普通CI39149114456运行中。旧worktree保留不代表继续占用。只深入本次model-gateway候选与新身份公共接线，不把此次核对当全仓业务验收。

上一批[IDENTITY-ONBOARDING-001](IDENTITY-ONBOARDING-001.md)现merged：[#79](https://github.com/wei500L/newwei/pull/79)实际merge f35ec572ccdf607b9224d88d1962cf792f9915be为main祖先，14路规则/wire/main/config资源OR落地已核；原head e105b3ab。OIDC/头像/导出未认领。

本批[LLM-GATEWAY-OPS-001](LLM-GATEWAY-OPS-001.md) reserved：[12条HTTP完整执行提示词](LLM-GATEWAY-OPS-001.prompt.md)。治理启停/预算/轮换、模型列表、健康/model-info缓存、completion/embedding/rerank与LB真实探测及Mongo日志；新llmgatewayops、profiles窄端口、llmlogs probe writer，核心业务不碰已合#79。独立业务目录尚未创建；#78合并时未包含本批新增，改在独立规划分支docs/plan-llm-gateway-ops发布；共享接线保留并集。

本次规划刷新：2026-10-18，origin/main 9d0462e16d88d146b8afbf67cdd58d8b7419ff29。#69已merged；#70仍OPEN/Ready、head adb765d0180e8b34910181e8c6fde8be400a2dff，实际diff与所有现存worktree HEAD/状态已只读刷新；历史工作目录状态无业务新增证据。这里只增加本批认领，不把旧表日期统一刷新成全仓审查。

| ID | 状态 | 精确范围 | 是否已有业务 PR / 推送 |
|---|---|---|---|
| [ARCHIVE-READING-001](ARCHIVE-READING-001.md) | reserved | 三归档Query+search两模式CSV：分类/显示/语义搜索、兼容BullMQ准备生产与导出快照 | 完整提示词在Ready规划#93发布，业务worktree/PR未创建；Nest准备worker保留 |
| [ITEMS-INGEST-001](ITEMS-INGEST-001.md) | in_progress | 1HTTP+5Mutation：人工条目写/采集入库、Mongo/水合/原子BullMQ producer与raw_item同步/定时补偿 | 已见itemsingest/pipelineenqueue及go.mod开发，尚无业务PR；Nest处理worker保持 |
| [GRAPHQL-SUBSCRIPTIONS-001](GRAPHQL-SUBSCRIPTIONS-001.md) | pr_open | 四个Subscription完整WS协议/鉴权/组织投影、PubSub和BullMQ广播观察、非本批operation整份legacy兼容 | Ready #95 OPEN/head68a4536d，普通CI39301019113在modules drift gate失败、已加regen label；contract/exec占用保持 |
| [NEWSNOW-SOURCES-001](NEWSNOW-SOURCES-001.md) | pr_open | 两公开来源HTTP完整冷获取/强刷；64来源ID/41族、特殊getter/缓存/凭据/实时接缝与批并发优化 | Ready #94 OPEN/headcf25026f，普通CI39297914942成功；最新提交只补验证文档，未合main/无部署证据 |
| [AUDIT-OUTBOX-001](AUDIT-OUTBOX-001.md) | pr_open | 审计Outbox完整消费、三状态扫描/租约/退避/落库与轻字段优化 | Ready #92 OPEN，head28c8f761a2ce4a447080414f154b567648cc6bd1；普通CI39248452603 success，真实共享接线diff已核；尚未合main，继续占用 |
| [RSS-TRANSLATION-001](RSS-TRANSLATION-001.md) | merged | RSS翻译Mutation完整双provider/正文分块/缓存/指标日志；修状态共享缓存投影写回 | 经#90实际merge c70b0373990ab931758f7a000511c2d34572fc33；原#88 head d4117032，main祖先；普通CI39163544617成功，非生产启用证据 |
| [DIGEST-DELIVERY-001](DIGEST-DELIVERY-001.md) | merged | 摘要定时投递：Cron、到期CAS、SMTP、状态和摘要通知桥 | 经#89实际merge f1167769f8c1d90017a6105cc65f135741ea47a1；原#87 head 2b0da7ec，main祖先；CI39163544617成功；审计outbox消费仍Nest |
| [SETTINGS-WRITE-001](SETTINGS-WRITE-001.md) | merged | 13 个设置写已合入；独立开关接线有剩余缺口 | [PR #68](https://github.com/wei500L/newwei/pull/68) → 3cedce9a；PR/main CI 均成功（main14:22复核） |
| [WORKSPACE-WRITE-001](WORKSPACE-WRITE-001.md) | merged | 8 个通知/看板/告警交互写 | #70经#77进入main c39f282f；实际原PR merge 8e1ff896，旧业务目录干净；整合main普通CI成功，非生产启用证据 |
| [ITEMS-LIST-001](ITEMS-LIST-001.md) | merged | Query items完整分页/三排序/批量投影 | #74经#77进入main c39f282f；实际原PR merge 99e648c8，旧业务目录干净；整合main普通CI成功，非生产启用证据 |
| [NEWS-BRIEF-001](NEWS-BRIEF-001.md) | merged | newsEventBrief生成/强刷/日志与写回 | #72经#77进入main c39f282f；实际原PR merge e40e9041，旧业务目录干净；整合main普通CI成功，非生产启用证据 |
| [STORAGE-MEDIA-001](STORAGE-MEDIA-001.md) | merged | storage/test与S3媒体/详情URL | #73经#77进入main c39f282f；实际原PR merge f4ac4aa8，旧业务目录干净；整合main普通CI成功，非生产启用证据 |
| [AUTH-LOGIN-001](AUTH-LOGIN-001.md) | merged | 登录/会话/MFA挑战/找回密码/邮箱变更11路 | #75经#77进入main c39f282f；实际原PR merge 7879629e，复用基础已限定核对，目录干净；整合main普通CI成功，非生产启用证据 |
| [CRAWL-METADATA-001](CRAWL-METADATA-001.md) | merged | HTTP+Query元数据完整预览链 | #76经#77进入main c39f282f；实际原PR merge 501c4930，旧业务目录干净；整合main普通CI成功，非生产启用证据 |
| [IDENTITY-ONBOARDING-001](IDENTITY-ONBOARDING-001.md) | merged | 注册审批与邮件邀请入组14路 | #79实际merge f35ec572已在main90765633；新main CI39149114456成功，非生产验证 |
| [LLM-GATEWAY-OPS-001](LLM-GATEWAY-OPS-001.md) | merged | 治理与真实探测12路，含远端资源与三类日志 | 经#89实际merge f1167769f8c1d90017a6105cc65f135741ea47a1；原#81 head 0b89196f，main祖先；CI39163544617成功；不代表真实探测已验证 |
| [SOURCE-POLICY-WRITE-001](SOURCE-POLICY-WRITE-001.md) | merged | 来源策略四Mutation完整版本管理；旧13写仅补两处接线 | 经#89实际merge f1167769f8c1d90017a6105cc65f135741ea47a1；原#82 head 52340760，main祖先；CI39163544617成功，非重新验收全部设置写 |
| [OIDC-LOGIN-001](OIDC-LOGIN-001.md) | merged | 组织SSO三入口，含PKCE/JWKS/MFA/session/handoff | 经#89实际merge f1167769f8c1d90017a6105cc65f135741ea47a1；原#83 head 2c52763c，main祖先；CI39163544617成功，真实IdP未验证 |
| [ANALYSIS-EXPORT-001](ANALYSIS-EXPORT-001.md) | merged | 条目/事件两路完整CSV导出与等价去重优化 | 经#89实际merge f1167769f8c1d90017a6105cc65f135741ea47a1；原#84 head 38e4e0e1，main祖先；CI39163544617成功；search仍排除 |
| [KNOWLEDGE-REVIEW-001](KNOWLEDGE-REVIEW-001.md) | merged | 人工证据复核、关系校正、实体别名、边聚合与队列选取改善 | 经#89实际merge f1167769f8c1d90017a6105cc65f135741ea47a1；原#86 head 4d6d24b8，main祖先；CI39163544617成功；审计outbox消费仍Nest |

本次增量（2026-10-18）：origin/main 仍为 9d0462e16d88d146b8afbf67cdd58d8b7419ff29；#70 保持 OPEN/Ready、head adb765d0。新增 NEWS-BRIEF-001 与 STORAGE-MEDIA-001 占用，只维护文档与独立编码目录，不取得 BL-01/#70 顶层接线所有权；原表日期不统一刷新成全仓审查。

第五批增量：main仍9d0462e1，main最近五次普通CI成功；只深入元数据两入口实际调用链并复核相关公开PR/现存认领。CRAWL-METADATA-001新增独立业务包，不改S3的crawlreadtelemetry/settingscrawl注册或items的contract/exec。共享依赖清单按模块条目：本批HTML解析x/net，S3批AWS SDK；各自远端生成，后合者正常merge主线后再生成并集，不覆盖其他分支。

第四批发出前只读增量核对：main仍9d0462e1，#70仍OPEN/Ready head adb765d0，#71为规划文档PR；ITEMS-LIST-001目录已创建于9d0462e1，因此继续保留占用，不据目录存在宣称已完成。前三批认领与正在运行的编码对话不变。AUTH-LOGIN-001与其核心业务文件隔离；共享接线仅本批条件增量，地图回填由规划窗口集中维护。

两个历史任务的原始认领/发出时间未提供。状态定义见 [PLANNING](../PLANNING.md)。地图首版通过 [PR #69](https://github.com/wei500L/newwei/pull/69) 发布并合并。本规划窗口先后发布NEWS-BRIEF-001、STORAGE-MEDIA-001、ITEMS-LIST-001三批提示词，只维护文档；用户编码窗口的开发证据按表独立记录，不把规划PR当业务交付。记录复用Ready PR #71，见[证据](../EVIDENCE.md)。

## 其他历史任务与本机 worktree

下表于14:49全部只读刷新（工作台写14:56再核） HEAD/状态/祖先关系，不是运行中代理列表。历史 PR 实际 merge SHA 和业务覆盖以域页证据/当前源码为准；分支 HEAD 为 main 祖先只能证明该提交可达，不能证明工作目录后来没有增量。非祖先也不证明未合入（可能 integration/补充同步）。创建任务前重新查 diff、PR、认领；不自动删除或归档旧 worktree。

| 分支 | 本机 worktree | HEAD | 提交关系 | 工作目录快照 | 任务/历史 PR |
|---|---|---|---|---|---|
| `refactor/go-crawl-templates` | `/Users/oo/project/newwei` | `33cbc8866742` | main 祖先 | 1 条状态（只读，不干预） | [#38](https://github.com/wei500L/newwei/pull/38) |
| `refactor/go-account-security` | `/Users/oo/project/newwei-go-account-security` | `c447d7408a57` | main 祖先 | 干净 | [#60](https://github.com/wei500L/newwei/pull/60) |
| `refactor/go-admin-logs` | `/Users/oo/project/newwei-go-admin-logs` | `786d44b2aeab` | main 祖先 | 干净 | [#40](https://github.com/wei500L/newwei/pull/40) |
| `refactor/go-auth-factors` | `/Users/oo/project/newwei-go-auth-factors` | `8d1b59a2d828` | main 祖先 | 干净 | [#62](https://github.com/wei500L/newwei/pull/62) |
| `refactor/go-classification-rss-ops` | `/Users/oo/project/newwei-go-classification-rss-ops` | `723ebd944faa` | main 祖先 | 干净 | [#51](https://github.com/wei500L/newwei/pull/51) |
| `refactor/go-crawl-frontier-runs` | `/Users/oo/project/newwei-go-crawl-frontier-runs` | `9f5c277e1dac` | main 祖先 | 干净 | [#53](https://github.com/wei500L/newwei/pull/53) |
| `refactor/go-crawl-read-telemetry` | `/Users/oo/project/newwei-go-crawl-read-telemetry` | `38e75c7890c9` | main 祖先 | 干净 | [#50](https://github.com/wei500L/newwei/pull/50) |
| `refactor/go-data-runtime-settings` | `/Users/oo/project/newwei-go-data-runtime-settings` | `1c970f8e32d3` | main 祖先 | 干净 | [#61](https://github.com/wei500L/newwei/pull/61) |
| `refactor/go-exception-ingest-diagnostics` | `/Users/oo/project/newwei-go-exception-ingest-diagnostics` | `380593e004b3` | main 祖先 | 干净 | [#64](https://github.com/wei500L/newwei/pull/64) |
| `refactor/go-graphql-org-access-write` | `/Users/oo/project/newwei-go-graphql-org-access-write` | `132fba4493c0` | main 祖先 | 干净 | [#63](https://github.com/wei500L/newwei/pull/63) |
| `refactor/go-graphql-settings-crawl-read` | `/Users/oo/project/newwei-go-graphql-settings-crawl-read` | `f5655cfe9df0` | main 祖先 | 干净 | [#52](https://github.com/wei500L/newwei/pull/52) |
| `refactor/go-graphql-settings-write` | `/Users/oo/project/newwei-go-graphql-settings-write` | `a1c96172b7eb` | main 祖先 | 干净 | [SETTINGS-WRITE-001](SETTINGS-WRITE-001.md)；已合并 PR #68（14:18核对） |
| `refactor/go-graphql-workspace-read` | `/Users/oo/project/newwei-go-graphql-workspace-read` | `48e939a3d260` | main 祖先 | 干净 | [#48](https://github.com/wei500L/newwei/pull/48) |
| `refactor/go-graphql-workspace-write` | `/Users/oo/project/newwei-go-graphql-workspace-write` | `adb765d0180e` | 非 main 祖先；PR 未合入 | 干净 | [#70](https://github.com/wei500L/newwei/pull/70)；pr_open |
| `refactor/go-graphql-items-list` | `/Users/oo/project/newwei-go-graphql-items-list` | `c45f1afe` | 从 main 9d0462e1 创建；非 main 祖先；PR 未合入 | 本批改动 | [ITEMS-LIST-001](ITEMS-LIST-001.md)；[#74](https://github.com/wei500L/newwei/pull/74)；pr_open |
| `refactor/go-infrastructure-settings` | `/Users/oo/project/newwei-go-infrastructure-settings` | `709dfbcffcc8` | main 祖先 | 干净 | [#55](https://github.com/wei500L/newwei/pull/55) |
| `refactor/go-items-reading` | `/Users/oo/project/newwei-go-items-reading` | `52dadb0af794` | main 祖先 | 干净 | [#58](https://github.com/wei500L/newwei/pull/58) |
| `refactor/go-kg-impact-read` | `/Users/oo/project/newwei-go-kg-impact-read` | `9c21455555c1` | 仅合并后报告提交不在 main；#46 已 merged | 干净 | [#46](https://github.com/wei500L/newwei/pull/46) |
| `refactor/go-knowledge-graph-read` | `/Users/oo/project/newwei-go-knowledge-graph-read` | `34d26c86412c` | main 祖先 | 干净 | [#44](https://github.com/wei500L/newwei/pull/44) |
| `refactor/go-llm-gateway-profiles` | `/Users/oo/project/newwei-go-llm-gateway-profiles` | `268ec60fcb60` | main 祖先 | 干净 | [#59](https://github.com/wei500L/newwei/pull/59) |
| `refactor/go-llm-logs` | `/Users/oo/project/newwei-go-llm-logs` | `2323ec869e6c` | main 祖先 | 干净 | [#41](https://github.com/wei500L/newwei/pull/41)、[#42](https://github.com/wei500L/newwei/pull/42) |
| `refactor/go-model-access-settings` | `/Users/oo/project/newwei-go-model-access-settings` | `62db46a3198b` | main 祖先 | 干净 | [#56](https://github.com/wei500L/newwei/pull/56) |
| `refactor/go-news-indicators` | `/Users/oo/project/newwei-go-news-indicators` | `f7d1486dc69f` | main 祖先 | 干净 | [#45](https://github.com/wei500L/newwei/pull/45) |
| `refactor/go-newsnow-clustering-ops` | `/Users/oo/project/newwei-go-newsnow-clustering-ops` | `0f0ae3779a4e` | main 祖先 | 干净 | [#49](https://github.com/wei500L/newwei/pull/49) |
| `refactor/go-platform-governance-settings` | `/Users/oo/project/newwei-go-platform-governance-settings` | `71a65af468c7` | main 祖先 | 干净 | [#54](https://github.com/wei500L/newwei/pull/54) |
| `refactor/go-proxy-load-balancing` | `/Users/oo/project/newwei-go-proxy-load-balancing` | `269d1513981a` | main 祖先 | 干净 | [#66](https://github.com/wei500L/newwei/pull/66) |
| `refactor/go-quality-overview` | `/Users/oo/project/newwei-go-quality-overview` | `b287f815e248` | main 祖先 | 干净 | [#43](https://github.com/wei500L/newwei/pull/43) |
| `refactor/go-rbac` | `/Users/oo/project/newwei-go-rbac` | `6230915996d0` | main 祖先 | 干净 | [#39](https://github.com/wei500L/newwei/pull/39) |
| `refactor/go-runtime-settings` | `/Users/oo/project/newwei-go-runtime-settings` | `91790b405429` | main 祖先 | 1 条状态（只读，不干预） | [#47](https://github.com/wei500L/newwei/pull/47) |
| `refactor/go-search-reindex-ops` | `/Users/oo/project/newwei-go-search-reindex-ops` | `6a8bd5802d7a` | main 祖先 | 干净 | [#65](https://github.com/wei500L/newwei/pull/65) |
| `refactor/go-situation-monitor-signals` | `/Users/oo/project/newwei-go-situation-monitor-signals` | `536817f6e52d` | main 祖先 | 干净 | [#57](https://github.com/wei500L/newwei/pull/57) |

已合并任务无需重建全部历史提示词：按 [模块入口](../README.md) 找域页的 PR/实际 merge SHA/现有报告。最新 #67 集成合入 #59/#62/#63/#65/#66，主线已有网关配置、MFA 管理、组织访问写、索引重建与代理负载均衡；不可因为旧分支/旧报告而重复派发。

kg-impact 的HEAD 9c214555不是main祖先，但 `origin/main..HEAD` 仅一条报告提交，三点diff仅go-kg-impact-read.md；#46实际merge `a80d394539c3ff84174b7d8db239016847e7e99c` 已在main，不是未交付业务，不重复派发。

当前开放业务PR为#70与#72；#69地图文档已经合并，最新main为9d0462e1，业务合并仍止于#68，#67 integration的原批次历史归属不变。设置写主体merged与GAP-GQL-001同时成立；NEWS-BRIEF-001不取得BL-01/#70顶层接线所有权，只允许既有新闻事件读注册区块的本批参数增量。

每次新认领需创建独立 task 文件并保存精确接口/文件所有权。对未提交/未推送的本地记录明确写“其他机器不可见”；正式发出前发布认领记录并再次核对，冲突范围按已有认领或依赖顺序处理。
