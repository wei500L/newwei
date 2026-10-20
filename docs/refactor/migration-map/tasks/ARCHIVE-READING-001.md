# ARCHIVE-READING-001 · 归档检索、月历、详情与搜索导出

- 当前状态 **pr_open**；2026-10-19 Europe/Moscow，完整[执行提示词](ARCHIVE-READING-001.prompt.md)在[Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)发布。规划目录 /Users/oo/project/newwei-plan-newsnow-feed，分支 docs/plan-newsnow-feed；本窗口仅文档，无业务实施。
- 基线 origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`，[普通CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)精确head success。规划#93追加前head76f6d06ecf5ac0300249b611f57f4cf192302972的普通CI39297509652成功，新head须独立查询。
- 业务分支 refactor/go-archive-reading、worktree /Users/oo/project/newwei-go-archive-reading，已创建于91e759b4；分析选批发布前续核出现itemsreading/vector_port.go、llmembed/archive_port.go、newsnowclusteringops/archive_port.go开发，尚无业务提交/PR/merge/CI/生产注册/部署证据；执行器活动未核实。
- 来源BL-09第一阶段+BL-08剩余search整路，关联GAP-LEGACY-001/GAP-ASYNC-001。不认领Go归档准备worker或其他候选。

## 精确范围与所有权

Query archiveDigest(input:ArchiveQueryInput!):ArchiveDigestModel!、archiveCalendar(input:ArchiveCalendarInput!):[ArchiveCalendarDayModel!]!、archiveDetail(processedArticleId:String!):ArchiveDetailModel，三根items.read；POST /api/analysis/exports/search（analysis.write/JWT+mtk_、201 CSV），包括items/headlines两模式。main已迁items/events两CSV与归档状态HTTP不重迁。四入口数量少但包含分类文本hash/模型新鲜度/完整规则信号、Mongo显示资格、双路召回+重排、双层缓存/指标、BullMQ状态/入队和5000导出，工作量偏大。

Go负责查询、语义搜索和archivePreparation producer；Nest ArchivePreparationProcessor仍唯一消费（concurrency1），执行缺失分类生成/显示信号backfill/SQL写回及PROCESSING/PARTIAL/READY/FAILED。新API_GO_ARCHIVE_READING_MODE默认legacy、非法启动失败；单开须装配三Query及search、DB/JWT/Redis/Mongo，不依赖READ/ANALYSIS_EXPORT。不新建worker/cron、不中断Nest、不清队列；回滚退四入口，已有job继续消费。

队列固定BullMQ5.63.2原生Lua/MessagePack，queue/name archivePreparation，jobId精确scope:orgId:date/month三段（该版本允许），getState等待/活跃/延迟不重排，其余受锁remove后add；保留5次指数15秒、完成1h/1000、失败7d/10000、traceId与状态索引200/TTL3600。新internal/archivepreparation与条目pipelineenqueue隔离，不能假设后者已实现或用NestHTTP代替。Redis协议在现ci.yml已有Redis integration job验证；完整Nest worker/模型服务未实跑。

MySQL只读ProcessedArticle/Article/ArchiveArticleClassification/NewsEvent/Item/Timeline和组织source policy/settings，Mongo读取completed ProcessedItem显示信号，另按真实embedding/rerank尝试best-effort写llmrequestlogs（新typed observer/writer复用现有metadata过滤，不冒充Probe日志）；无新SQL事务或分类写。Redis缓存/指标/准备状态与原子队列为必要副作用。Digest缺口并集计数在业务过滤前；入队失败返回已有结果+FAILED，Calendar入队失败只log。Detail无正文翻译/分类冷生成，旧地图相关表述本次限定纠正。

复用newsnowclusteringops已有部分rule classifier/geo/data_gen，通过新archive_port.go补完整signals输入/输出；不复制词典或改generated文件。复用publicportal.ClassifyEventSource、llmembed及llmgatewayprofiles窄model/outcome端口、itemsreading新vector_port.go（不使用其Mongo recall降级）、analysisexport.ExportItemsCSV/CSV/参数/延迟响应。无Go全归档classifier/producer已存在的假设。

优化：headlines在单请求固定anchor、候选/分类/显示/搜索结果快照，按五栏目每轮100/ID去重输出至5000，不逐页重跑模型/筛选；无搜索扫至既有12000预算或穷尽，解决交互约3000前缀使导出过早结束的限制。明确属于导出改善，交互摘要候选预算/游标不变；搜索保持500召回/180重排，记录静态/用例成本证据，不宣称生产提速。

## 并行隔离与发布

审计Ready #92 OPEN/head28c8f761a2ce4a447080414f154b567648cc6bd1、普通CI39248452603成功；NewsNow Ready #94 OPEN/headcf25026ff99b26fb3bf2122cd240d4ac4021889a、普通CI39297914942成功（Nest订阅smoke39297914851成功，非本批Go验收）；两者未合main。实际diff已核，NewsNow最新cf250只追加验证文档，不覆盖archive_port新文件。

发布前四订阅已Ready #95 OPEN/head68a4536d37eabde0695edfe152987cadffcc41f7，首轮普通CI39301019113在modules drift gate失败、已加regen label，实际main/config/contract diff已读；尚未合main。条目入库已出现itemsingest/pipelineenqueue/go.mod开发，in_progress、无业务PR。新任务不碰contract/exec/WS、workspace、settingscrawl、itemsreading hydration/readmodel/GraphQL Item projection、pipelineenqueue/raw_item补偿、NewsNow registry_port/provider/relay、审计consumer。共享main/config/env/compose/go依赖/ci仅最小并集，新业务包archivereading/archivepreparation/graphqlread-archivereading/analysisexport-search。编码窗口只改自己task+专用交付文档，规划集中回填共享地图。

## 核对深度与下一次恢复

本次只深读三根DTO/Resolver/SDL/model、ArchiveService全查询/显示/搜索/缓存/状态路径、classification cached/stale/hash/selection与完整本地classifier及taxonomy规则字段、queue service与worker生命周期、analysis search导出、模型配置/真实调用每次尝试日志/向量/来源/Go规则/CSV复用、普通CI和相关实际共享diff。相对地图3cedce9a，Nest候选文件无业务增量；Go新增两CSV已在main，三根与search未注册。没有重审全仓/准备生成器模型算法/所有worker。

一手兼容依据：[BullMQ Scripts 5.63.2](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/scripts.ts)、[Job 5.63.2](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/job.ts)。只确认实施路线，Go准备producer尚不存在。

规划只做静态核对/git diff --check；未安装依赖/运行build/test、Docker或服务，真实DB/Mongo/Redis/Nest worker、外部embedding/vector/rerank和部署均未验证。下一次核执行PR逐入口/必要入队/独立开关/导出快照、最终head普通CI和Redis协议证据；未合main不增加注册数，不关闭worker依赖或GAP-ASYNC-001。


- Ready PR [#97](https://github.com/wei500L/newwei/pull/97)，业务 head `6b70350df46851b25885e9d06ecdb11b5ac25c3e`。首轮普通 CI 39306149780：`verify` 与 `api-go-user-settings-integration` 均因 `go.sum` 尚无 `msgpack/v5` 条目失败（drift gate 只报依赖清单差异，未进入编译/用例）；`go-modules-regen` 已成功提交 `517592ad`（go.mod/go.sum 增加 msgpack/v5 与 tagparser），label 已移除。最终代码 head `5885ca13` 的普通 CI [39314849303](https://github.com/wei500L/newwei/actions/runs/39314849303) 全绿：`verify`（含 lint/Go tests）、`api-go-user-settings-integration`（含 archivepreparation 真实 Redis 7.2 协议用例）、`vector-integration` 均 success；`go-modules-regen`/`contract-baseline-regen` skipped 不计通过。此前 5683e0cf 的 [39310112110](https://github.com/wei500L/newwei/actions/runs/39310112110) 同样全绿。

## 本次执行记录（2026-10-19）

- 已实现四入口：三个 Query 根（`items.read`）与 `POST /api/analysis/exports/search`（`analysis.write`，201 CSV，items/headlines 两模式）。新增 `internal/archivereading`、`internal/archivepreparation`、`internal/graphqlread/archivereading`、`analysisexport` search 文件、精确 legacyproxy 规则与 `cmd/api/archive_reading.go`。
- 复用窄端口：`newsnowclusteringops/archive_port.go`（完整 rule signals/国家表）、`itemsreading/vector_port.go`（不回落 Mongo）、`llmembed/archive_port.go`（真实模型 outcome/每次 attempt）、`llmlogs/archive_search.go`（专用 writer）。未改 `data_gen.go`、`registry_port.go`、hydration/readmodel 或条目搜索算法。
- 分类新鲜度、显示资格、真实 embedding/vector/lexical/rerank、两层缓存/指标、错误 appCode、缺数据准备入队与状态投影均已接线；headlines 导出改为单请求五栏目快照（每轮 100、去重至 5000），items 模式复用已迁 12 列。
- BullMQ producer 固定 5.63.2 Lua/MessagePack，waiting/active/delayed 去重、其他状态受锁移除再 add、状态 TTL 3600 与 200 条裁剪；Nest `ArchivePreparationProcessor` 仍是唯一消费者。Redis 协议用例加入现有 `api-go-user-settings-integration` job。
- 开关 `API_GO_ARCHIVE_READING_MODE` 默认 legacy，单开装配三 Query、GraphQL handler、search HTTP、DB/JWT/Redis/Mongo 与 items 导出依赖；回滚改 legacy 并重启。
- 本机仅 gofmt/静态审阅；未运行 build/test/Docker/服务。最终代码 head 5885ca13 普通 CI 39314849303 全绿（见上）。真实 MySQL/Mongo、Nest worker 消费、模型/向量上游与部署切流未验证。
