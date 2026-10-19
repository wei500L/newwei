# ANALYSIS-RUNS-001 · 三类分析真实后台执行与流式交付

- 状态 **reserved**；2026-10-19 Europe/Moscow，完整[执行提示词](ANALYSIS-RUNS-001.prompt.md)随[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发布。规划目录/分支仍newwei-plan-newsnow-feed/docs/plan-newsnow-feed，仅文档，未实施。
- 代码基线origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`，普通CI39247556593精确head成功；相对地图3cedce9a本候选Nest无业务变化。规划#93追加前86d663b1的CI39301423856已成功，追加后head独立核查，旧绿灯不替代新head。
- 独立业务分支refactor/go-analysis-runs、worktree /Users/oo/project/newwei-go-analysis-runs尚未创建；无业务PR/merge/CI/生产注册/部署或流量证据，执行器活动未核实。
- 来源BL-12完整链，关联GAP-LEGACY-001/GAP-ASYNC-001，新增具体GAP-ANALYSIS-001中断恢复。不是仅提交/状态CRUD，不占其他候选。

## 精确范围、实现要求与复用

三个Mutation requestCorrelationAnalysis/requestAnomalyExplanation/requestGeoTransportAnalysis，均analysis.run、AnalysisResultModel!。DTO/null/返回与源码定位见prompt；保存Mongo pending→BullMQ原生producer→真正Go consumer→统计/Geo数据及真实模型SSE→Mongo完成/失败、gqlsub:analysisEvents、MySQL Notification与分析专用本地通知接缝。analysisResults读取/analysisEvents传输、原协作CRUD/两CSV已迁或被占用，不重迁。

必须在Go实现三类计算、模型流与后台消费，不使用固定结果/缓存/拆分非流式文本/回调Nest业务HTTP。新API_GO_ANALYSIS_RUNS_MODE只接三写（需DB/JWT/Redis/Mongo），API_GO_ANALYSIS_WORKER_MODE单独切analysis消费者owner（需DB/Redis/Mongo/redis bus，无JWT），默认legacy且双端非法启动失败，BULLMQ_WORKERS_ENABLED=false两端停消费；无新cron。

Go已有history模型/端口、publicportal profile/密钥/治理/完成客户端、llmlogs writer助手，但没有真正stream或BullMQ consumer。本批新analysisruns/analysisqueue/graphqlread-analysisruns、公用publicportal新analysis_stream与必要profile字段、llmlogs新analysis_stream，不碰归档的llmembed/llmgatewayprofiles端口。history仅analysis模型窄port与去重，JSON叶子RawMessage，其他业务具名类型。

BullMQ5.63.2 queue=analysis，三个原jobId/payload、完成即删/失败7d10000、attempts默认3；限定原生Lua/MessagePack add/claim/续租/完成失败/retry/stalled/paused/关闭，不能用Redis list替状态机。Nest只改本queue owner gate、必要恢复上下文/条件写与通知接缝，保留默认legacy实现及其他队列。切owner先停旧drain再启新，反向回滚；不清队列，不把两个消费者同时开着。

GAP-ANALYSIS-001：Nest analysis.service.ts:134-148只认pending/failed，BullMQ stalled重排后仍running导致process跳过/队列可完成但记录卡住。Go补持当前执行租约的running恢复与最小条件写/fencing，Nest回滚侧同步窄修；终态/旧token不重复覆盖。静态确认路径，未称生产已复现，关闭证据无。

真实模型两surface、fallback在yield后禁止、增量flush/partial summary/attempt日志；三算法包括四统计检测器与Geo组织/窗口/20状态/每对象30轨迹/完整context。优化为Mongo7.0有界top30替$push全量后截取，去掉相同参数重复空查询，不改对象选择/时间窗/字段。

实时analysis envelope保持现有schema与org，Go只发布，四订阅/Socket.IO仍归原窗口/Nest；通知先SQL再analysis:notification:v1（只id/org/user），Nest重读并emitLocalNotification，不借digest频道或跨adapter重播。没有跨库exactly-once/实时耐久重放承诺。

## 并行占用与交接

审计Ready #92/head28c8f761、NewsNow Ready #94/headcf25026f均未合main且普通CI成功；四订阅Ready #95正在正常补依赖/修复（观察到68a→a042→5b309→后续head，不能拿旧head失败/绿灯替代最终CI），共享实际diff已读：新增变化在自身入口/legacy连接及文档，无分析业务文件。条目入库in_progress，水合/Item投影/pipelineenqueue占用；归档ARCHIVE-READING-001 reserved保留。全部不重复分配。

核心新增文件隔离；共享main/config/env/compose/go依赖/ci只最小并集，英文文件头/GoDoc明确职责、租户/队列所有权、租约/重试、SSE/fallback与Geo有界查询。用户本轮明确“工作量大一些、写好英文文件注释、必须真实实现”，已写入完整prompt与PLANNING偏好。

本次只深读analysis完整service/processor/模块/DTO/models、四检测器/模板、Geo集合/索引、模型stream调用/配置/日志、通知/Redis bus/本地socket桥及Go复用/普通CI；未扩审Assistant/其他worker或全仓。只读原实际shared diff，未重新验收其他PR业务。

一手依据：[BullMQ Worker5.63.2](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/worker.ts)、[Job](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/job.ts)、[Scripts](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/scripts.ts)、[Mongo7 topN](https://www.mongodb.com/docs/v7.0/reference/operator/aggregation/topn/)。仅路线核实，Go worker/stream尚未实现。

本机未装依赖/运行build/test、Docker或服务，无真实DB/Redis/Mongo/模型/部署证据。执行时普通CI既有integration job内做Node BullMQ双向互通+真实Go worker/Mongo/SQL/Redis+HTTP SSE fixture的窄闭环；必要增Mongo7服务/Node fixture步骤，不新建专用job/workflow或Nest/Jest依赖。fixture通过不等于真实外部模型/多实例切换验过。

下一次只核本任务PR三根/消费者真实路径、所有必要副作用、两个独立开关/关闭、恢复GAP与top30优化、精确head CI/跨端协议证据。编码窗口只维护本task+专用交付文档，共享地图由规划集中回填；未合main不提前增加覆盖/关闭整条异步缺口。
