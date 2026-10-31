# 任务认领与历史恢复索引

## 2026-10-31 #151 合并后任务

main `fcf1e5334acb0350ea36535c48c4131df7c9698a` 已包含 #151 最终 `e48a2572`；普通 CI 源 head success、merge head 尚未完成，结果分别记录。GO-DEFAULT-CUTOVER-001 标 `merged`；下方旧段落的 #151 OPEN/跟进提示词待修是历史快照。

| 任务 | 当前状态 / 提示词 | 文件所有权与前置 |
|---|---|---|
| [GO-CONTRACT-TOOLING-001](GO-CONTRACT-TOOLING-001.md) | **reserved**；[提示词已发出](GO-CONTRACT-TOOLING-001.prompt.md)，无编码证据 | 契约/生成/工具/fixture/现有 CI 必要增量；保留旧 app 与分流层 |
| [GO-ONLY-RUNTIME-001](GO-ONLY-RUNTIME-001.md) | **planned**；[提示词预先提供](GO-ONLY-RUNTIME-001.prompt.md)，未占用编码文件 | 前一项实际合入与 CI 后，Go main/config/路由/GraphQL/worker 门控收口 |
| [GO-NODE-RETIRE-001](GO-NODE-RETIRE-001.md) | **planned**；[提示词预先提供](GO-NODE-RETIRE-001.prompt.md)，未占用编码文件 | 前两项实际合入与 CI 后，删三 Node app，完成锁文件/编排/本地启动/CI 收尾 |

三项不并开；规划 PR #149 正常 merge 最新 main，保留 #151 实际交付 task 记录。新业务 worktree/PR 均尚未创建，不操作其他聊天、不清理历史 worktree。后两项不能凭前置 PR Ready 提前开工。

## 2026-10-31 当前状态

main = `385c887e8cda2df6a3fadd2109c6641ae62cb6ee`，下方 2026-10-27 的 reserved/planned 为发出时历史快照。

| 任务 | 当前状态 / 证据 | 下一步与所有权 |
|---|---|---|
| [GO-CUTOVER-PREREQS-001](GO-CUTOVER-PREREQS-001.md) | **merged**；#150 → `385c887e`；源 head CI success，merge CI Web 测试失败 | 主体已落地，异常记录仍有残留；不重派整批 |
| [GO-DEFAULT-CUTOVER-001](GO-DEFAULT-CUTOVER-001.md) | **pr_open**；Ready #151/head `b97e181a`，普通 CI 40576119903 success | [继续提示词已发出](GO-DEFAULT-CUTOVER-001.followup.prompt.md)；仅原 `codex/go-default-cutover` / `/Users/oo/project/newwei-go-default-cutover` 继续，补本地配置链，不另开冲突任务 |

规划 PR #149 保持发布入口；本轮在规划分支正常 merge main，并保留 #150 实际交付 task，解决两边新增同名任务文档造成的冲突。未在业务 worktree 改代码或向其他聊天派发消息。下一检查点：#151 新 head 的实际 env/启动链修复与普通 CI；合并和删除阶段仍需分别核实。

## 2026-10-27 当前增量

基线 `origin/main = f15f598d4358b4c9823054ef5a355618e1480a4e`。#142–#147 已由 [#148](https://github.com/wei500L/newwei/pull/148) 合入（实际 main merge `0a48babea69700c7f9cd1bf2262f25d414469527`），六个源 head 已逐一验证祖先关系；下方关于 AIS 仍 pr_open 的段落仅为历史快照。没有新的整合任务，也没有启动编码窗口。

| 任务 | 状态 / 提示词 | 文件所有权与前置 |
|---|---|---|
| [GO-CUTOVER-PREREQS-001](GO-CUTOVER-PREREQS-001.md) | **reserved**；[提示词已发出](GO-CUTOVER-PREREQS-001.prompt.md)，未核实执行器/编码 PR | Go main/httpx/metrics/异常/GraphQL/条目创建体、必要指标调用点；保持默认；分支 `codex/go-cutover-prereqs` |
| [GO-DEFAULT-CUTOVER-001](GO-DEFAULT-CUTOVER-001.md) | **planned**；[提示词预先给出](GO-DEFAULT-CUTOVER-001.prompt.md)，有前置，尚不认领编码文件 | 前一任务实际合入与普通 CI 通过后再认领 config/compose/env/Web/启动工具；分支 `codex/go-default-cutover` |

这两份规划已由 `codex/plan-go-cutover-next` / [Ready 规划 PR #149](https://github.com/wei500L/newwei/pull/149) 发布，业务未实施。历史 50+ worktree 的存在不代表仍活跃；本次未修改或清理它们。编码窗口更新自己的 task 和 PR；规划窗口集中回填共享地图。下一检查点是 main run 40518886959 的失败原因、前置任务 PR 的实际范围与精确 head 普通 CI，不是部署观察。

2026-10-22 `refactor/go-ais-relay`（pr_open，无独立 task ID；基线 `origin/main dc48abc1`，worktree `/Users/oo/project/newwei-go-ais-relay`）：Go AIS relay 端口——Node `apps/ais-relay` 迁为 `apps/api-go/internal/aisrelay` + `apps/api-go/cmd/ais-relay`（同环境变量、同 HTTP 路径、同 JSON 契约），新增 `infra/docker/ais-relay-go.Dockerfile` 与 `go-pilot` profile 的 pilot 服务 `ais-relay-go`（宿主 `3005` → 容器 `3004`）。不改变默认开关：`REALTIME_SIGNALS_AIS_BASE_URL` 仍指向 Node `http://ais-relay:3004`，Node 版保留、本批不新增开关。PR 待创建，最终 head/普通 CI 在 PR 回填。

2026-10-21 Go 队列运维批：main `ed436ead`（#137 已合入），无开放迁移 PR。本批三个并行窗口之一 `refactor/go-queue-ops`（worktree `/Users/oo/project/newwei-go-queue-ops`）承接 `docs/refactor/cutover/ownership-audit.md` 的 **C-6**（`itemPipelineDlq` 人工处理）、**C-8**（Bull Board 运维面）与 §6 的「QueueEvents 派生读侧（统计部分）」「告警规则全量 repeatable 对账」两项残留职责；另外两个窗口 `refactor/go-ops-entrypoints` 与 `refactor/go-crawl-frontier-writes` 同批进行，共享文件按「只追加」约定并行（config.go 连续块、all-go.env 末尾、`allGoRules()` 末尾、`cmd/api/main.go` 最少调用行、cutover 文档与 env 样例）。本批不新建 task ID/task 文件；未合并前状态保持 `pr_open`，HEAD、普通 CI 与集成 job 结论在 PR 回填。

2026-10-21 `refactor/go-ops-entrypoints`（本批新增，无独立 task ID）：关闭审计 C-1/C-5/C-7/C-9，新增 `API_GO_HEALTHZ_LIVE_MODE`（默认 shadow）、`API_GO_VECTOR_DIAGNOSTICS_MODE`、`API_GO_DOCS_MODE`、`API_GO_LEGACY_FALLBACK_MODE`（默认 legacy/legacy/proxy），并新增 `api_go_legacy_rejected_requests_total`；范围与回退见 [runbook](../../cutover/runbook.md#阶段-6停-nest-收尾6a--6b--6c)。状态 pr_open，最终 head/普通 CI 在 PR 回填。

2026-10-21 本批回填（以 `origin/main = dcbe563b917f`，即 #136 为准）：下方任务表的全部历史任务均已合入 main，状态回填为 `merged` 并给出 12 位 merge commit；整合收口关系为 #114 → `d42277219bc4`（#92–#113，#111 由 #112 取代并关闭）、#122 → `d6c6c7bb2135`（#115–#118）、#128 → `1ba22e3beb86`（#119–#127）、#132 → `170a95d86752`（#129–#131）、#136 → `dcbe563b917f`（#133–#135）；更早的 #67 → `7fc17faa3dc5`、#77 → `c39f282f1195`、#89 → `f1167769f8c1`、#90 → `c70b0373990a`。每个 SHA 均已用 `git merge-base --is-ancestor <sha> origin/main` 校验可达；PR #38–#55 不在本次合并抓取窗口内，merge SHA **未核实**，见文末说明。**NOTIFICATIONS-SOCKET-001** 亦已合入（#124 → `9eebc5386dec`，经 #128），其上方 2026-10-20 段落为发出时快照。当前无开放迁移 PR；本批没有新增任务 ID 或 task 文件。

2026-10-21 `refactor/go-crawl-frontier-writes`（pr_open）：C-2/C-3/C-4 三条 crawl-frontier 管理写（`POST /api/admin/crawl-frontier/runs`、`POST /api/admin/crawl-frontier/nodes/retry`、`POST /api/admin/crawl-frontier/nodes/:id/retry`）迁入 `apps/api-go`，新增 `API_GO_CRAWL_FRONTIER_WRITES_MODE`（默认 legacy；=go 时要求 `API_GO_CRAWL_FRONTIER_RUNS_MODE=go`，沿用 `crawl.write` 与 POST 201）；分支 `refactor/go-crawl-frontier-writes`（基线 `ed436ead`），PR 待创建，最终 head/普通 CI 在 PR 回填。

2026-10-20 NOTIFICATIONS-SOCKET-001：新增 [通知 Socket.IO 传输](NOTIFICATIONS-SOCKET-001.md)（`refactor/go-notifications-socket`，基线 `d4227721`）。范围为 `/notifications` namespace 的 Engine.IO v4 + Socket.IO v5 WebSocket 子集、独立路径 `/socket.io-notifications`、四类标识符-only relay、B1 本地推送与 B2 行复核；其他 namespace 与 `/socket.io` 保持 NestJS。状态 pr_open，最终 head/普通 CI 在 PR 回填。

2026-10-20 本批整合：main 基线 `91e759b449c4511dc96d86539ea0eb258754d07e`，21 条开放 PR 由 `integration/merge-open-prs-b92-113` 以 merge commit 一次性收口（#92–#113；#111 由 #112 取代并关闭，未 squash/rebase/force-push）。head：#93 f5dca8d4、#92 28c8f761、#94 cf25026f、#96 761ed72c、#97 b3e760d0、#99 f2891760、#100 daca0be4、#101 479004fc、#102 2e3c172a、#103 96530bb3、#104 e8c32f22、#105 3193eedb、#106 4220940c、#107 35fc68b1、#108 a2113b81、#109 76d974f7、#110 3f6a5192、#112 69f16608、#113 eca49b21、#98 e9c99ec9、#95 47095336。下表六行归一为对应的最终 PR/head；其余 14 个实现单元没有独立 task 页，按 PR/分支/head 记录如下，不新建 task ID。批次状态在整合 PR 合并前保持 `pr_open`，merged 回填与 merge SHA 由后续文档提交完成。

本批无独立 task 页的实现单元：

| PR | 分支 | head | 范围 |
|---|---|---|---|
| #99 | `refactor/go-economic-data` | f2891760 | 经济数据三 Mutation/三管理 HTTP 与 akshare-data worker |
| #100 | `refactor/go-alert-rules` | daca0be4 | 告警规则配置写、默认规则、手动触发与 BullMQ producer |
| #101 | `refactor/go-crawl-task-lifecycle` | 479004fc | 采集任务生命周期 3 REST + 3 Mutation 与队列控制 |
| #102 | `refactor/go-settings-diagnostics` | 2e3c172a | 邮件设置、地理编码与运行诊断 |
| #103 | `refactor/go-situation-insights` | 96530bb3 | 态势监控洞察只读链 |
| #104 | `refactor/go-kg-ingestion` | e8c32f22 | 知识图谱自动构建 Cron |
| #105 | `refactor/go-news-backfill-jobs` | 3193eedb | 聚类 LLM 补救、恢复 worker 与指标关联刷新 |
| #106 | `refactor/go-dashboard-optimization` | 4220940c | 看板图表/时空/统计/SSE 契约与读取共享 |
| #107 | `refactor/go-quality-ops` | 35fc68b1 | 分类质量报告、质量队列 worker 与流水线运行记录 |
| #108 | `refactor/go-account-data` | a2113b81 | 头像上传签名与个人数据导出 |
| #109 | `refactor/go-assistant-runs` | 76d974f7 | Assistant 提交/执行/删除与 worker |
| #110 | `refactor/go-gdelt-snapshot` | 3f6a5192 | GDELT 外部快照定时重建与强制刷新 |
| #112 | `refactor/go-crawl-discovery-2` | 69f16608 | 新闻源预览与工作流试运行/回放的采集发现链（取代 #111） |
| #113 | `refactor/go-alert-worker` | eca49b21 | 告警评估、站内通知与邮件/Webhook 投递 worker |

上述 14 个实现单元的合并证据（merge commit 均为 `origin/main` 祖先；本次只回填证据，不新建 task ID）：#99 → `8d4244fbc5c5`、#100 → `6217c9d41c91`、#101 → `8c439e7ce8a8`、#102 → `abd56b6e3502`、#103 → `152b95c51689`、#104 → `e75bd12073f8`、#105 → `2fc54d48f973`、#106 → `ef09a0d56968`、#107 → `02e6569f2aa4`、#108 → `6474b18dd4ae`、#109 → `4f211b3eda7a`、#110 → `127f22e32be5`、#112 → `10ff0b258c00`（取代已关闭的 #111）、#113 → `d6bcf8831cb3`；整批由 #114 → `d42277219bc4` 一次性收口。

2026-10-19分析执行选批：main仍91e759b4/普通CI39247556593成功，无新业务合并。#92/#94未合，#95观察head8d759fe2/普通CI39302998528运行中，条目入库in_progress、归档in_progress（已见vector/llmembed/规则端口开发）均保持占用。新增[ANALYSIS-RUNS-001](ANALYSIS-RUNS-001.md) reserved与[完整提示词](ANALYSIS-RUNS-001.prompt.md)，Ready规划#93发布；完整三请求/真实Go worker/统计和Geo/模型SSE/结果/通知，双开关、英文文件注释和真实实现要求明确。无业务实施，不重建地图，以下旧段落保留发出快照。

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
| [ANALYSIS-RUNS-001](ANALYSIS-RUNS-001.md) | merged | 三分析Mutation完整Go执行：原生producer/consumer、统计/Geo/真实SSE、结果/事件/最终通知 | Ready #98 → merge `240b86b71b94`（main 祖先），经 #114 → `d42277219bc4` 收口；普通 CI [39316192738](https://github.com/wei500L/newwei/actions/runs/39316192738) success（原 head e9c99ec9）；未部署/未运行验证 |
| [ARCHIVE-READING-001](ARCHIVE-READING-001.md) | merged | 三归档Query+search两模式CSV：分类/显示/语义搜索、兼容BullMQ准备生产与导出快照 | Ready #97 → merge `93c49544ffb7`（main 祖先），经 #114 → `d42277219bc4`；普通 CI [39316394249](https://github.com/wei500L/newwei/actions/runs/39316394249) success（原 head b3e760d0）；Nest 准备 worker 执行权见 GAP-ASYNC-001 |
| [ITEMS-INGEST-001](ITEMS-INGEST-001.md) | merged | 1HTTP+5Mutation：人工条目写/采集入库、Mongo/水合/原子BullMQ producer与raw_item同步/定时补偿 | Ready #96 → merge `bb7cb6f2666c`（main 祖先），经 #114 → `d42277219bc4`；普通 CI [39310062045](https://github.com/wei500L/newwei/actions/runs/39310062045) success（原 head 761ed72c）；Nest 处理 worker 保持 |
| [GRAPHQL-SUBSCRIPTIONS-001](GRAPHQL-SUBSCRIPTIONS-001.md) | merged | 四个Subscription完整WS协议/鉴权/组织投影、PubSub和BullMQ广播观察、非本批operation整份legacy兼容 | Ready #95 → merge `10b716a499b8`（main 祖先），经 #114 → `d42277219bc4`；普通 CI [39310002253](https://github.com/wei500L/newwei/actions/runs/39310002253) success（原 head 47095336） |
| [NEWSNOW-SOURCES-001](NEWSNOW-SOURCES-001.md) | merged | 两公开来源HTTP完整冷获取/强刷；64来源ID/41族、特殊getter/缓存/凭据/实时接缝与批并发优化 | Ready #94 → merge `0b650cffb8ae`（main 祖先），经 #114 → `d42277219bc4`；普通 CI [39297914942](https://github.com/wei500L/newwei/actions/runs/39297914942) success（原 head cf25026f） |
| [AUDIT-OUTBOX-001](AUDIT-OUTBOX-001.md) | merged | 审计Outbox完整消费、三状态扫描/租约/退避/落库与轻字段优化 | Ready #92 → merge `ba429ca21546`（main 祖先），经 #114 → `d42277219bc4`；普通 CI [39248452603](https://github.com/wei500L/newwei/actions/runs/39248452603) success（原 head 28c8f761） |
| [RSS-TRANSLATION-001](RSS-TRANSLATION-001.md) | merged | RSS翻译Mutation完整双provider/正文分块/缓存/指标日志；修状态共享缓存投影写回 | #88 → merge `f85f80200ff7`（main 祖先），经 #90 → `c70b0373990a` 进入 main（原 head d4117032）；普通 CI39163544617 成功；非生产启用证据 |
| [DIGEST-DELIVERY-001](DIGEST-DELIVERY-001.md) | merged | 摘要定时投递：Cron、到期CAS、SMTP、状态和摘要通知桥 | #87 → merge `aec2d3459710`（main 祖先），经 #89 → `f1167769f8c1`（原 head 2b0da7ec）；CI39163544617 成功；审计 outbox 消费已由 #92 → `ba429ca21546` 接管（生产启用另记） |
| [SETTINGS-WRITE-001](SETTINGS-WRITE-001.md) | merged | 13 个设置写已合入；独立开关接线有剩余缺口 | #68 → merge `3cedce9aa320`（main 祖先）；PR/main CI 均成功（main 14:22 复核）；关联独立接线缺口 GAP-GQL-001 已按 `dcbe563b` 关闭（见 GAPS） |
| [WORKSPACE-WRITE-001](WORKSPACE-WRITE-001.md) | merged | 8 个通知/看板/告警交互写 | #70 → merge `8e1ff896e86f`（main 祖先），经 #77 → `c39f282f1195` 进入 main；旧业务目录干净；整合 main 普通 CI 成功，非生产启用证据 |
| [ITEMS-LIST-001](ITEMS-LIST-001.md) | merged | Query items完整分页/三排序/批量投影 | #74 → merge `99e648c89501`（main 祖先），经 #77 → `c39f282f1195` 进入 main；旧业务目录干净；整合 main 普通 CI 成功，非生产启用证据 |
| [NEWS-BRIEF-001](NEWS-BRIEF-001.md) | merged | newsEventBrief生成/强刷/日志与写回 | #72 → merge `e40e9041df6e`（main 祖先），经 #77 → `c39f282f1195` 进入 main；旧业务目录干净；整合 main 普通 CI 成功，非生产启用证据；缺口 GAP-NEWS-001 已按 `dcbe563b` 关闭 |
| [STORAGE-MEDIA-001](STORAGE-MEDIA-001.md) | merged | storage/test与S3媒体/详情URL | #73 → merge `f4ac4aa807b6`（main 祖先），经 #77 → `c39f282f1195` 进入 main；旧业务目录干净；整合 main 普通 CI 成功，非生产启用证据；缺口 GAP-CRAWL-001 已按 `dcbe563b` 关闭 |
| [AUTH-LOGIN-001](AUTH-LOGIN-001.md) | merged | 登录/会话/MFA挑战/找回密码/邮箱变更11路 | #75 → merge `7879629ee33a`（main 祖先），经 #77 → `c39f282f1195` 进入 main；复用基础已限定核对，目录干净；整合 main 普通 CI 成功，非生产启用证据 |
| [CRAWL-METADATA-001](CRAWL-METADATA-001.md) | merged | HTTP+Query元数据完整预览链 | #76 → merge `501c49307e46`（main 祖先），经 #77 → `c39f282f1195` 进入 main；旧业务目录干净；整合 main 普通 CI 成功，非生产启用证据 |
| [IDENTITY-ONBOARDING-001](IDENTITY-ONBOARDING-001.md) | merged | 注册审批与邮件邀请入组14路 | #79 → merge `f35ec572ccdf`（main 祖先）；main CI39149114456 成功，非生产验证 |
| [LLM-GATEWAY-OPS-001](LLM-GATEWAY-OPS-001.md) | merged | 治理与真实探测12路，含远端资源与三类日志 | #81 → merge `f504eb40d6f4`（main 祖先），经 #89 → `f1167769f8c1`（原 head 0b89196f）；CI39163544617 成功；不代表真实探测已验证 |
| [SOURCE-POLICY-WRITE-001](SOURCE-POLICY-WRITE-001.md) | merged | 来源策略四Mutation完整版本管理；旧13写仅补两处接线 | #82 → merge `f293f78053ff`（main 祖先），经 #89 → `f1167769f8c1`（原 head 52340760）；CI39163544617 成功，非重新验收全部设置写；GAP-GQL-001 已按 `dcbe563b` 关闭 |
| [OIDC-LOGIN-001](OIDC-LOGIN-001.md) | merged | 组织SSO三入口，含PKCE/JWKS/MFA/session/handoff | #83 → merge `c3f41f4bff3f`（main 祖先），经 #89 → `f1167769f8c1`（原 head 2c52763c）；CI39163544617 成功，真实 IdP 未验证 |
| [ANALYSIS-EXPORT-001](ANALYSIS-EXPORT-001.md) | merged | 条目/事件两路完整CSV导出与等价去重优化 | #84 → merge `ca92347a843d`（main 祖先），经 #89 → `f1167769f8c1`（原 head 38e4e0e1）；CI39163544617 成功；search 仍排除 |
| [KNOWLEDGE-REVIEW-001](KNOWLEDGE-REVIEW-001.md) | merged | 人工证据复核、关系校正、实体别名、边聚合与队列选取改善 | #86 → merge `afd9ba7d1974`（main 祖先），经 #89 → `f1167769f8c1`（原 head 4d6d24b8）；CI39163544617 成功；GAP-KG-001 的队列选取已按 `dcbe563b` 修复（`graphqlread/settingscrawl/review.go:68-130` keyset 分页） |

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
| `refactor/go-graphql-settings-write` | `/Users/oo/project/newwei-go-graphql-settings-write` | `a1c96172b7eb` | main 祖先 | 干净 | [SETTINGS-WRITE-001](SETTINGS-WRITE-001.md)；#68 → merge `3cedce9aa320`（main 祖先） |
| `refactor/go-graphql-workspace-read` | `/Users/oo/project/newwei-go-graphql-workspace-read` | `48e939a3d260` | main 祖先 | 干净 | [#48](https://github.com/wei500L/newwei/pull/48) |
| `refactor/go-graphql-workspace-write` | `/Users/oo/project/newwei-go-graphql-workspace-write` | `adb765d0180e` | 非 main 祖先；PR 未合入 | 干净 | [#70](https://github.com/wei500L/newwei/pull/70) → merge `8e1ff896e86f`（main 祖先，经 #77 → `c39f282f1195`）；分支 head adb765d0 本身非 main 祖先，属未收口旧 head |
| `refactor/go-graphql-items-list` | `/Users/oo/project/newwei-go-graphql-items-list` | `c45f1afe` | 从 main 9d0462e1 创建；非 main 祖先；PR 未合入 | 本批改动 | [ITEMS-LIST-001](ITEMS-LIST-001.md)；[#74](https://github.com/wei500L/newwei/pull/74) → merge `99e648c89501`（main 祖先，经 #77 → `c39f282f1195`）；分支 head c45f1afe 本身非 main 祖先 |
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

上表 PR #38–#55 的 merge commit **未核实**：它们不在本次 `gh pr list --state merged --limit 80`（#56–#136）的抓取窗口内，也没有对应的 merged-prs 记录；表中「main 祖先」只证明该 head 可达，不能当作 merge SHA。回填时未对任何 SHA 做猜测。

已合并任务无需重建全部历史提示词：按 [模块入口](../README.md) 找域页的 PR/实际 merge SHA/现有报告。最新 #67 集成合入 #59/#62/#63/#65/#66，主线已有网关配置、MFA 管理、组织访问写、索引重建与代理负载均衡；不可因为旧分支/旧报告而重复派发。

kg-impact 的HEAD 9c214555不是main祖先，但 `origin/main..HEAD` 仅一条报告提交，三点diff仅go-kg-impact-read.md；#46实际merge `a80d394539c3ff84174b7d8db239016847e7e99c` 已在main，不是未交付业务，不重复派发。

当前开放业务PR为#70与#72；#69地图文档已经合并，最新main为9d0462e1，业务合并仍止于#68，#67 integration的原批次历史归属不变。设置写主体merged与GAP-GQL-001同时成立；NEWS-BRIEF-001不取得BL-01/#70顶层接线所有权，只允许既有新闻事件读注册区块的本批参数增量。

每次新认领需创建独立 task 文件并保存精确接口/文件所有权。对未提交/未推送的本地记录明确写“其他机器不可见”；正式发出前发布认领记录并再次核对，冲突范围按已有认领或依赖顺序处理。
