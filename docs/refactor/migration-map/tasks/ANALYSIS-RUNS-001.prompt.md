# 目标

为 wei500L/newwei 完整迁移“提交关联分析/异常解释/地理运输分析 → 持久任务 → Go后台真实计算和模型流 → 结果历史 → 实时进度与最终通知”。任务ID：ANALYSIS-RUNS-001。三个Mutation入口虽少，但本批包含真正的BullMQ生产/消费、三类业务计算、模型流协议、重试恢复、Mongo结果、SQL通知与实时发布，是工作量较大的完整产品链。

必须真实实现：不能只创建pending记录、固定返回summary、读取旧缓存、调用Nest业务HTTP、用非流式结果切片伪装模型流，或把Nest继续计算写成Go worker完成。Go模式下三类计算/流式调用/结果写回均在Go，Nest只保留未切流入口、既有队列观察/实时传输和通知本地接缝。迁移范围内不得留下TODO/no-op/固定成功分支；真正合法空数据和显式失败按契约处理。

## 1. 基线、记录与独立目录

- 规划基线：origin/main **91e759b449c4511dc96d86539ea0eb258754d07e**，普通CI39247556593精确head成功。#69地图已合main，#70八交互写早经#77合入，不重复迁移。
- 先在/Users/oo/project/newwei执行git fetch origin main、git rev-parse origin/main、gh pr list --state open、gh run list --branch main --limit 5、git worktree list，读适用AGENTS.md和迁移地图README/PLANNING/tasks/README/GAPS/BACKLOG、本task、modules/analysis.md、AUDIT的analysis段、DEPENDENCIES的分析/实时依赖。
- 本认领和稳定提示词发布于Ready规划PR #93、分支docs/plan-newsnow-feed；若尚未合main，从最新规划分支读取，只带入自己的task/prompt。不能按旧主工作目录推断main。main前进只核候选/公共接线增量，已有实现剔除，不重做全仓审计。
- 新分支 **refactor/go-analysis-runs**，独立worktree **/Users/oo/project/newwei-go-analysis-runs**。不存在时从fetch后的origin/main用git worktree add -b创建，已存在先确认属于本任务。不要在主目录/规划目录/其他任务目录改业务。本次明确后端专项，不扩UI。
- 稳定任务：docs/refactor/migration-map/tasks/ANALYSIS-RUNS-001.md；提示词同目录ANALYSIS-RUNS-001.prompt.md。

## 2. 精确入口、模型与源码依据

三个Mutation，均为analysis.run，均返回AnalysisResultModel!：

- requestCorrelationAnalysis(input: CorrelationAnalysisInput!)
- requestAnomalyExplanation(input: AnomalyAnalysisInput!)
- requestGeoTransportAnalysis(input: GeoTransportAnalysisInput!)

orgId和triggeredById从验证身份重推导，禁止输入指定组织/用户。沿既有GraphQL认证、权限、变量/别名/fragment/选择集/错误投影；没有额外analysis.read/settings.manage/platform-admin门槛。analysisResults已迁，不重迁其读入口；analysisEvents传输由GRAPHQL-SUBSCRIPTIONS-001占用，本批只生产兼容事件。

成功提交返回id、type、pending、createdAt、已保存input，summary/error/output按原Resolver缺省/null投影，不等待模型完成。type=correlation/anomaly/geo_transport；status=pending/running/completed/failed。AnalysisResultModel的input/output是JSON scalar叶子，不给它们发明GraphQL子字段。创建失败/入队失败经既有ExceptionFilter失败，不假装已提交成功。

事实源（规划SHA以上；开工再核最新）：

- apps/api/src/graphql/resolvers/analysis.resolver.ts；dto/analysis.input.ts；models/analysis.model.ts；apps/api/schema.gql。
- apps/api/src/modules/analysis/analysis.service.ts：submit*、process、notifyFinalFailure、notifyResult、run*、buildGeoTransportContext、loadTrackPointsByObjectKeys、streamMessages、publish，完整697行。
- 同目录analysis.processor.ts、analysis.module.ts、analysis.constants.ts、analysis.types.ts、analysis.errors.ts、analysis-prompt.service.ts、anomaly-detector.ts、analysis-queue-event.publisher.ts。
- packages/config/src/prompts/analysis.ts（默认模板与renderPromptTemplate）；packages/mongo/src/models/{analysis-result.ts,map-transport.ts}。
- apps/api/src/modules/news-pipeline/litellm.service.ts的stream/executeStream/executeResponsesStream、SSE/模型选择/治理/兼容错误/日志；llm-request-log.service.ts。
- notifications.service.ts、notification.dispatcher.ts、notifications.gateway.ts、user-digest-notification.subscriber.ts；GraphQL subscription bus/codec；config.service.ts:analysisConfig、env.schema.ts、BullMQ retention与连接配置。

## 3. DTO与默认/null语义

- Correlation：indicatorName/startDate/endDate为必填String；value/changePercent为必填有限Float；newsSummaries为必填字符串数组。没有额外非空、ISO日期、最大数组数/文本长度约束，不擅自补成另一份DTO。
- Anomaly：metric/timestamp必填String；value/deviationPercent必填有限Float；newsList/policyList必填字符串数组；series可缺省/null→服务计算用[]，数组项timestamp String/value Float。保留输入记录的缺省与显式null差异，不把原始input全重写成默认值。
- Geo：transportKinds必填数组，1..2项，枚举aircraft/vessel；保留重复项源语义。startDate/endDate必填String，DTO没有IsDateString；bbox可缺省/null，若存在恰4个有限Float，顺序[minLng,minLat,maxLng,maxLat]；objectKeys可缺省/null字符串数组。Resolver只把长度4的bbox、非空objectKeys带入service input；空数组/缺省不能当作额外过滤条件。
- 不在入口新增日期合法性/区间顺序/坐标范围校验；Geo执行阶段Date解析、无效日期查询失败等按源路径形成运行失败，不改为新的提交400。保留GraphQL标量/枚举及DTO的原有校验。
- 配置默认：ANALYSIS_QUEUE_CONCURRENCY=2、ANALYSIS_MAX_RETRIES=3；模型timeout getter默认300000ms、flushChars默认80且至少1、flushMs默认250且至少0；六个ANALYSIS_PROMPT_*覆盖使用nullish语义（空串不是无配置）。先核env schema实际接受/保留哪些key，与getter真实运行值对齐，不把未被当前EnvService接收的环境变量写成已有效。ANALYSIS_AUTOTRIGGER_ENABLED不作为本批新增自动触发/cron。

## 4. 真实已有Go基础与缺口

- internal/graphqlread/history已有AnalysisResultModel、analysisResults读取、RegisterModels。本批通过独立analysis_port.go暴露仅注册AnalysisResultModel的端口，处理和history读/其他写同时启用的去重，不为三写装配全部历史/Assistant根。新业务结构全部具名；已有GraphQL JSON scalar边界可承接json.RawMessage，不把新增业务搬入any/map。
- internal/publicportal/gateway.go及brief_completion.go已有全局profile读取、resolveCompletionProfile、apiBase规范化、密钥解密/治理、双路径请求和attempt观察基础，**没有本链的真实stream实现**。新增analysis_stream*.go窄流式能力，复用这些已有解析/鉴权helper；必要时仅给私有profile/env补流式需要的temperature/maxOutputTokens等字段，旧brief/RSS默认行为不变。不能用CompleteBrief冒充流。
- publicportal.MySQLStore.GatewaySettings可作为窄只读profile/governance reader，不要复制profile表或要求settings.manage。完整stream参数对齐Nest完成配置/profile覆盖，而非沿用brief硬编码参数；缺密钥/治理密钥不可读须真实失败。不要修改ARCHIVE-READING-001占用的llmembed/llmgatewayprofiles端口。
- internal/llmlogs/completion.go已有collection、组织/模型/usage归一、metadata过滤和脱敏助手，新增analysis_stream.go专用具名writer。旧CompletionWriter的requestType=completion不能直接当stream日志；不冒充gateway_probe/RSS日志。
- dashboardstats共享Mongo连接、MySQL/Redis、authn/authz/authhttp、GraphQL contract.Bind/Failure与main生命周期可复用。dashboardwarmap已有运输集合/字段读取事实，但私有弱类型地图查询不是本批业务模型，不重写地图服务。
- 当前main没有Go BullMQ worker；条目pipelineenqueue和归档archivepreparation均为其他未合任务，不能当已有能力或前置依赖。本批只为analysis队列实现限定兼容运行器，不领取通用BullMQ平台。

## 5. 持久化、队列与运行状态

- Mongo collection=analysisresults，ObjectId、orgId、type、status、具名input/output、summary/error、triggeredById、createdAt/updatedAt兼容Mongoose。提交先插pending再入队；源路径没有跨Mongo/Redis事务或审计，不新增自建Outbox来掩盖入队失败。明确保留“插入成功但入队失败会有pending残留”的原有边界，不把错误吞成成功。
- 队列name=analysis、默认prefix=bull。job name/payload.type分别correlation/anomaly/geo_transport；payload={type,analysisId,orgId,traceId}，trace来自现有上下文。jobId分别corr-<id>/anomaly-<id>/geo-transport-<id>；removeOnComplete=true、attempts=ANALYSIS_MAX_RETRIES，源提交无backoff；removeOnFail继承{age:604800,count:10000}。要兼容Nest产生的旧payload（orgId/traceId可能缺省），无org时仅从真实持久记录确定组织；有org时必须匹配，type也须匹配，不能修改其他组织记录。
- 正常认领pending/failed→running，清旧error，发布running；执行后output/summary/completed与updatedAt写回、清error，发布最终completed，再发完成通知。执行错误写failed/error/非空partialSummary，发布failed，再交队列重试；中间失败不发用户失败通知，最后一次才发。创建时间沿原record，不用每个chunk的当前时间替换。
- 处理已完成/不存在/不可认领记录沿源无重复计算语义；不能在缓存里伪造completed。任务取消、锁丢失或旧尝试不能覆盖新尝试/已完成结果。业务“Mongo完成”和“BullMQ ack完成”分开说明，不能承诺跨库exactly-once。

### GAP-ANALYSIS-001：中断后的running恢复

基线analysis.service.ts:134-148仅认领pending/failed；BullMQ stalled重排后同记录仍running，process会直接return，队列可能结束而Mongo永远running。此为静态确认路径，未声称生产已复现。

本批必须补真实恢复：只有持有该analysis job当前BullMQ执行租约的worker能恢复running；使用最小的attempt token/条件更新或已证明等价的方式阻止失去租约的旧尝试写终态。确需Mongo辅助字段时用具名可选字段、更新analysis-result schema并保留历史文档兼容，不加第二套队列/全局锁。Nest Processor/AnalysisService仅同步补本链恢复/条件写所需窄上下文，使回滚后Nest也能接续遗留running，不能让回滚重新卡死。completed不重复跑，stalled终止/重试耗尽须将Mongo/最终事件/通知推进到正确终态。

## 6. BullMQ生产与真正Go消费

新增internal/analysisqueue/。以pnpm-lock锁定的BullMQ **5.63.2** 的Worker/Job/Scripts和官方Lua为事实源，固定必要scripts/includes并保留版本/来源/许可证/摘要，运行时不下载。MessagePack使用核过的固定版本库，不手写编码器；新增参数/结果/作业opts用具名类型。

必须完整实现本队列实际用到的standard add、moveToActive、锁续租、completed/failed finish、即时retry、必要delayed唤醒/paused、stalled检测与回收、attempt计数、retention、events/marker和关闭。不能用BLPOP/HSET替代BullMQ状态机，不用asynq/内存goroutine替代耐久队列，不直接删除他人的active/lock；不扩展repeat/flow/其他业务worker。

按固定版默认保持锁时长30000ms、约15000ms续租、stalled间隔30000ms、maxStalledCount=1、并发读取ANALYSIS_QUEUE_CONCURRENCY；网络/锁失效时停止本尝试流和写入，让受支持的队列恢复接续。阻塞读取使用独立连接，保持已有Redis地址/用户名/密码/DB/prefix；不用一个无限阻塞共享命令连接。失败字段/stack/attemptsMade与锁token校验必须走兼容脚本语义，不手工减重试计数。

队列协议一手依据：
https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/worker.ts
https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/job.ts
https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/scripts.ts

不要只验证Go自写producer与自写consumer互通；必须用锁定Node BullMQ做双向协议验证，见验证段。

## 7. 三类真实计算与提示词

- Correlation不是本地Pearson计算：按源模板传indicatorName/value/changePercent/date/news生成模型分析，不凭标题另造相关系数算法。新闻按输入顺序编号，空时“无相关新闻”。output={summary,raw}。
- Anomaly完整实现四检测器，输入顺序不排序/去重：z-score为全序列总体方差、阈值3、std=0无结果；rolling用此前20点/总体std、2.5倍；trend为3个采样点（不是按日历重采样），首值非0、除abs(start)，绝对变化≥10%；volume用此前20均值、均值>0且当前≥3倍。保留阈值包含边界、reason字符串/JS toFixed与findings按z/spike/trend/volume拼接顺序，同一点可多项命中。异常统计摘要和前缀“统计检测：\n...\n\n”、新闻/政策空文案、原模板替换完整迁移，不能只调用LLM省略统计。output={summary,raw,statisticalFindings}。
- Geo真实读取maptransportobjectstates/maptransporttrackpoints，不直接调用OpenSky/AIS、不启动采集。状态组织+kind+observedAt闭区间+可选bbox过滤，objectKeys过滤只取输入前20项，observedAt DESC最多20状态。按源顺序构造名称回退、分类/角色/国家/位置可null字段；每对象同组织同窗口最近30轨迹点，输出观测ID/ISO UTC时间/坐标/heading/course/speed/altitudeFt/geoCell；不要误过滤轨迹bbox（源仅状态受bbox约束）。保持filters、objectKeys、trackPointIds、hotspots前10（count DESC并保留同分原顺序）、objects的完整具名context，promptVersion=geo-transport-v1。output={summary,raw,promptVersion,context}。空观测仍把真实空context交模型并要求指出数据不足，不能伪造轨迹。
- 六个模板覆盖及默认内容以packages/config/src/prompts/analysis.ts逐字为准；renderPromptTemplate只替换{{word}}，缺变量为空，保留JSON.stringify(context,null,2)在prompt中的结构/缺省null语义，不把Go HTML escape/时区/数字格式带成新内容。

### 有价值的查询优化

Geo当前$group:$push全量轨迹后$slice30，缺轨迹还重复执行相同range查询。使用仓库Compose的Mongo7.0支持的有界每组top30聚合（如$topN），或等价有界查询，让每组只保留需要的30点；删掉“同参数空结果再查一次”的无效fallback。保持组织/窗口/对象选择、最近30排序及字段不变；同时间点若原来未定义次序，要明确并验证不引入任意业务排序。最多20对象、每对象30；不读取全部数据后Go内存截断。验证大量历史轨迹/窗口外/双组织/空对象的结果与成本边界，不虚报生产基准。

## 8. 真流式模型、部分结果与日志

新增publicportal的窄AnalysisStreamer能力及analysisruns领域流适配，直接调用配置中的真实completion模型。必须支持Nest实际启用的chat_completions与responses两种apiSurface、/v1与短路径404/405兼容、profile/治理凭据、temperature/top_p/max tokens/response_format参数。

沿LiteLlmService.stream：主模型/fallback顺序去重；只有尚未yield任何chunk才能换模型，已经yield（包括只有finishReason的chunk）后失败不切另一模型拼文本；guardrail拒绝和兼容性错误直接失败。本链源调用没有metadata/显式guardrails，不额外给它套RSS/网页的untrusted-content策略或新增feature标签；已有响应中的拒绝/错误仍正确识别。不能把整份JSON响应当SSE成功。

SSE解析处理跨网络chunk/UTF-8边界、CRLF/空行、多行data、[DONE]、chat delta/finish、Responses delta/done/error和源兼容分支、usage/cost；请求取消、worker关闭和锁丢失可中断读。沿源处理无效帧/EOF，不自行把每个delta作为完整summary。timeout使用ANALYSIS_LLM_TIMEOUT_MS实际有效值，不沿简报超时硬编码。

streamMessages：buffer按JS字符串长度（UTF-16长度，不是UTF-8字节）达到flushChars或处理到新chunk时经过flushMs才flush；它不是每250ms强制定时心跳。发布running事件的summary是增量chunk，最终completed是完整summary。异常统计prefix先flush；结束flush；失败也尽量flush并保存已有summary。raw={stream:true,model:lastModel}，无model时字段按源缺省，不能伪造实际模型名。

每次真实模型流尝试写llmrequestlogs，requestType=stream，apiSurface/model/org/profile/治理、success/error/latency、已报告usage/cost保持，缺值null；不发明metadata，沿既有过滤/脱敏。新增internal/llmlogs/analysis_stream.go，失败best effort，不把已算完结果变失败；缓存或配置读取不伪造调用日志。

## 9. GraphQL事件与用户通知

Go发布到现有 **gqlsub:analysisEvents**，envelope精确为{orgId,result:{id,type,status,summary?,error?,createdAt:ISO字符串}}。这里createdAt本来就是字符串，不套$gqlDate；undefined字段按源省略，不能混入input/output或发布到queueEvents。running/增量/最终事件都要有正确组织。

复用Nest bus的best-effort发布失败语义，不新增事件Outbox/跨实例重复广播框架。本批不改订阅executor、Redis codec或Socket.IO transport；现有Nest订阅和#95 Go订阅都能消费同一schema。Go worker模式要求GRAPHQL_SUBSCRIPTION_BUS=redis，两端校验，legacy+local保持原语义。

通知：有triggeredById才写MySQL Notification；完成用analysis_completed，失败只在最终重试耗尽用analysis_failed，保留notifyResult/notifyFinalFailure各自title/body/data/presentation差异，不能每次失败都通知。通知DB或分发失败按源warn不重做成功模型任务；不新增审计。

NotificationDispatcher目前仅Nest进程内，只写SQL不能实现实时通知。新增分析专用 **analysis:notification:v1** Redis接缝，只携{version:1,notificationId,orgId,userId}；Nest新增analysis-notification.subscriber.ts，在worker owner=go时订阅，按id+org+user重读真实通知并检查analysis类型/presentation，再调用已存在NotificationsGateway.emitLocalNotification。每实例只发本地匹配组织和用户的socket，绕过Socket.IO跨节点adapter避免重复。复用digest subscriber的生命周期模式，不改digest频道、数据格式或subscriber、不扩成通用通知迁移。SQL通知是持久结果，实时接缝仍best effort，不承诺断线重放。

## 10. 两个独立开关、资源和关闭

- **API_GO_ANALYSIS_RUNS_MODE**：只拥有三Mutation；空/legacy默认，go启用，非法值启动失败。单开go需DB/JWT/Redis/Mongo，不能依赖READ/分析历史/导出开关；Nest worker仍可消费Go生产的相同job。
- **API_GO_ANALYSIS_WORKER_MODE**：analysis消费者owner；空/legacy默认Nest，go使Nest AnalysisProcessor在创建Worker前退出并启Go worker；双端非法值启动失败。后台单开go需DB/Redis/Mongo及redis subscription bus，无JWT或GraphQL读写开关要求；可消费Nest旧入口产生的任务。
- BULLMQ_WORKERS_ENABLED=false必须两端都不启动analysis消费，按已有布尔语义接入；它不是SCHEDULE_ENABLED，不能拿关闭全部Nest worker替代本队列owner。没有新增Cron、自动分析触发器或全队列开关。
- main/config中的sharedDB、数据库错误传播、needsRedis、Mongo、GraphQL路由/handler OR、Registry模型去重分别补齐；后台不要错误加入requiresJWT集合。init与Start分开，所有构造失败路径也会关闭本批连接/worker。
- 关闭先停止新claim，drain在途并续租；截止时间到则取消模型、正确留存partial/状态和可接续队列，旧token不能ack新租约；停止stalled/renew/阻塞连接再关共享Redis/Mongo/SQL。不要复用http请求context来运行已接受的持久job。
- 切换顺序：先部署两端代码且默认legacy；停止/排空所有Nest analysis消费者，确认无旧owner，再启Go owner；旧请求生产者可保持Nest或独立切Go。回滚先停Go领取/drain或按恢复协议交还，再启Nest owner，最后按需退三入口；不flush队列、不删分析记录。硬崩溃后running/stalled也必须可接续（GAP-ANALYSIS-001）。不合并不代表已部署，Web→Nest与canary默认保持现状。

## 11. 文件范围与并行冲突

主包：新增internal/analysisruns/、internal/analysisqueue/、internal/graphqlread/analysisruns/、cmd/api/analysis_runs.go。
窄复用：history新增analysis_port.go及必要模型注册去重；publicportal新增analysis_stream*.go及gateway中最小profile字段补充；llmlogs新增analysis_stream.go。新增业务数据用具名类型，JSON scalar叶子可RawMessage，不能顺手重构全部历史/地图/gateway。

Nest仅允许：AnalysisProcessor的owner gate及本链恢复上下文、AnalysisService必要恢复/条件写、analysis-result可选运行字段（确需时）、分析专用通知subscriber/NotificationsModule增量、EnvService/schema、env/Compose；生产实现留作legacy。禁止改GraphQL Resolver/DTO装饰器或签名来降低契约要求。

共享main.go/config.go/env/Compose/README/go.mod/go.sum/ci.yml只做最小并集。main前进正常merge，不rebase/覆盖他人开关或关闭顺序。

并行占用开工重查：
- AUDIT-OUTBOX-001 Ready #92（head28c8f761，普通CI39248452603成功），不碰审计consumer。
- NEWSNOW-SOURCES-001 Ready #94（headcf25026f，普通CI39297914942成功），不碰来源/provider/relay、infra runtime reader、ops registry。
- GRAPHQL-SUBSCRIPTIONS-001 Ready #95，正在正常修复/依赖regen，head变化快、最终普通CI另查；不把旧失败或旧绿灯当最新结论。不碰contract/exec/workspace/WS包；本批只生产其既有analysis envelope。
- ITEMS-INGEST-001 in_progress，独立目录已有itemsingest/pipelineenqueue、itemsreading水合/GraphQL投影及go.mod开发；这些文件/producer归其所有，不能复用未合能力或改它们。
- ARCHIVE-READING-001 in_progress，独立目录已有vector/llmembed/规则端口开发、无业务PR；拥有归档查询/search导出、archivepreparation、llmembed/llmgatewayprofiles窄端口、llmlogs/archive_search.go、ops archive_port、items vector_port；本批不碰这些文件，流式与日志用独立新文件。

排除Assistant/告警/经济/AkShare/crawl/归档worker、分析协作CRUD和CSV、analysisResults重迁、四订阅transport、其他队列/Outbox/cron、地图采集。不能把本任务扩成全模型网关或全BullMQ重构。

## 12. 英文文件注释与实现质量

用户本次明确要求写好英文文件注释：每个新增业务源文件写简洁英文文件/包说明，交代职责、组织数据归属、生产/消费所有权或协议边界；导出类型/函数用准确GoDoc。worker/脚本适配写清租约、ack/retry/stalled与关闭；SSE文件写清fallback何时停止、部分结果和UTF-16 flush；Geo聚合写清窗口/top30与排序原因。修改旧文件时新增/修改范围的注释用英文，保留官方Lua版权/版本。不要只贴模板句、逐行翻译代码或批量重写无关旧注释。

专注真实迁移和功能，不堆防御代码、额外锁/重试/框架。Go DTO、结果、队列、Mongo JSON、SSE、缓存、通知、日志使用具名强类型；禁止any/interface{}/map[string]any/[]any承载新增业务。仅现有通用GraphQL/Redis驱动边界沿用，JSON叶子RawMessage。业务校验、租户隔离、必要条件写和协议租约必须保留。文档、提交与PR中文。

## 13. 精简但真实的验证

本机不安装依赖、不运行build/test、Docker或服务；允许静态审阅、gofmt、git diff --check。通过现有普通CI执行检查，不默认新建专用smoke/workflow/job。新依赖选核实过的固定版，go.mod按并集，复用go-modules-regen远端生成go.sum，不本机go get/tidy，不覆盖机器人提交。

少量行为测试覆盖三DTO/组织/独立开关、统计边界与顺序、真实Geo数据筛选/top30、真实SSE两surface/半包/部分失败/fallback边界、running恢复/旧token禁止写、完成及最终失败通知、模型日志/事件schema。不要镜像源码/做文本断言或建设泛化测试平台。

本批首次迁真正worker，普通CI内必须有跨端与持久化证据：在现ci.yml的api-go-user-settings-integration job保留原MySQL/Redis与其他任务增量，必要时增加Mongo7.0 service及锁定Node BullMQ fixture运行步骤（只远端；使用仓库已有bullmq依赖，不新增Nest/Jest测试依赖）。不新增专用job/workflow。

窄集成场景：Node BullMQ5.63.2入队→真实Go worker→真实Mongo/SQL/Redis+本地HTTP SSE fixture→完成；Go入队→Node Worker能读/ack；一次失败再成功、最终失败通知一次、paused不领取、锁续租/丢锁stalled恢复、completed不重复模型调用、双组织、Geo大量轨迹仍每组30。读取真实Redis queue/events/opts和Mongo终态，不能只mock Redis脚本成功。SSE fixture只能证明协议与本地闭环，不能称真实外部模型已验证。

记录最终精确head SHA、普通CI run/job与实际覆盖；skipped不算通过。外部真实模型、生产数据、Go/Nest多实例切换和部署未跑就列未验证，不能从代码/fixture/旧smoke推断切流。

## 14. 文档、Ready PR与交付

编码窗口只维护自己的tasks/ANALYSIS-RUNS-001.md和docs/refactor/go-analysis-runs.md（必要时带本prompt），记录三入口/worker/算法、真实副作用、GAP-ANALYSIS-001修复、两个独立开关/owner切换/回滚、PR/head/CI/未验证项。共享README/AUDIT/DEPENDENCIES/GAPS/BACKLOG及模块覆盖由规划窗口集中回填，不要求其他运行窗口重做文档；未合main不标merged，不提前关闭跨域缺口。

只stage自己改动，中文emoji+type(scope)正常提交/push，创建Ready PR；不合并、不auto-merge、不amend/rebase/force-push。PR围绕完整三分析执行、真正Go worker/SSE、恢复和Geo优化、独立默认legacy开关及验证证据，不只写三root已注册。

交付必须给PR/最新head、逐入口/内部步骤完成证据、普通CI与跨端队列闭环结果、开关/初始化/关闭/回滚、英文注释覆盖、仍由Nest提供的传输接缝、真实外部未验证项。迁移范围若遇已实现/新冲突先核并缩小具体剩余，不擅自换域，不以pending/缓存/转发代替真实实现，也不要只留下计划结束。
