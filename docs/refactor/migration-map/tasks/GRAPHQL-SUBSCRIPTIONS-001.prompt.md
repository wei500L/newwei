# 目标

在 wei500L/newwei 的 apps/api-go 完整接管四条 GraphQL 实时订阅：alertEvents、analysisEvents、assistantEvents、queueEvents。用户连接 Go 的 /graphql 后，应能以现有 graphql-transport-ws 协议订阅本组织的告警、分析、Assistant 和流水线队列状态，得到与 Nest 相同的选择集、字段/null/错误语义，并能正常取消、断线与重连。

这是 GRAPHQL-SUBSCRIPTIONS-001，来自 BL-21 的 GraphQL 子链，工作量在完整 WebSocket 执行与事件桥，不机械增加入口。不迁 Socket.IO，不迁后台业务执行器；不得只接 Redis、再把四条订阅实际代理给 Nest 就宣称完成。

## 1. 基线、任务与独立工作区

- 仓库 /Users/oo/project/newwei；规划核对的 origin/main 为 91e759b449c4511dc96d86539ea0eb258754d07e。该精确 SHA 普通 CI 39247556593 成功；这不是本任务验证或生产启用证据。
- 先 git fetch origin main，读适用 AGENTS.md、docs/refactor/migration-map/{README.md,PLANNING.md,tasks/README.md,GAPS.md,BACKLOG.md}，再读本 task、modules/graphql-runtime.md、modules/async-runtime.md、AUDIT.md 和 DEPENDENCIES.md 的相关段。不做全仓重审。重新查询开放 PR、main 最近五次 CI、git worktree list，以及相关工作区只读 HEAD/status/diff。
- 从当时最新 origin/main 建立分支 refactor/go-graphql-subscriptions，worktree 固定 /Users/oo/project/newwei-go-graphql-subscriptions。分支/目录已存在先核对归属并续作，不能重置、覆盖或新建第二份同任务。main 前进时只续核本域和共享接线，更新基线记录；合入更新用普通 merge，不 rebase。
- 认领和稳定提示词发布于 Ready 规划 PR #93；若 main 尚无本 task，从该 PR 最新文档分支只读取/带入本任务的 task 与原始 prompt 两文件，不把其他规划或业务分支当成代码依赖。本提示词已足够独立执行，不依赖历史聊天。

## 2. 并行占用与允许文件

- AUDIT-OUTBOX-001 已有 Ready 业务 PR #92，规划核对 head 28c8f761a2ce4a447080414f154b567648cc6bd1，普通 CI 39248452603 成功，仍 OPEN、未在 main；消费/双端 gate/租约/审计任务文件归该任务。不得再迁 AuditLogOutbox。
- NEWSNOW-SOURCES-001 已 in_progress：/Users/oo/project/newwei-go-newsnow-sources 有真实业务改动，尚无业务 PR。两公开来源 HTTP、newsnowsources、infrastructuresettings/runtime_reader.go、newsnowclusteringops/registry_port.go、Nest source-refresh subscriber、news-aggregator module 归该任务；其 source-warm/hottest Cron 留 Nest。没有 PR 也不能释放其占用。
- 本批主要新增 apps/api-go/internal/graphqlsubscriptions/ 与 cmd/api/graphql_subscriptions.go；允许对 internal/graphqlread/{contract,exec} 做订阅命名空间、规划和事件投影的最小扩展，复用 alerts/history/workspace 的模型或只注册模型的端口。必要时只增窄的模型注册/错误映射导出，不重写 HTTP 引擎、历史查询或已有业务模型。
- 允许本任务所需最小 main.go、internal/config、legacyproxy 的精确 upgrade 分派、go.mod/go.sum、infra/docker/docker-compose.yml、.env.sample/.env.example、根 README 及自己的任务/交付文档增量。Nest 业务 producer/Resolver/worker、Socket.IO 网关与订阅 bus 不改业务语义，不新增一套 Nest relay；原则上不需要修改它们。
- 已读 #92 实际共享接线 diff，以及 NewsNow 本地 main/config/Nest env/compose 增量。共同文件按语义取并集：AuditOutboxMode、ScheduleEnabled、NewsnowSourcesMode、needsRedis、无效 DSN 校验、构造/关闭与样例配置都须保留；不要整段覆盖。后合入者重新读当时 main 并正常 merge。核心业务可并行；发现新任务占用 contract/exec 时暂停重叠编辑并保留已认领顺序，其他独立部分继续，不引入协调锁或机器人。

## 3. 已有 Go 基础与真实缺口

- internal/authhttp/middleware.go 的 Authenticator.Identify 不写 HTTP 响应，已串联 authn JWT 签名/iss/aud/exp、Redis jti 黑名单、authz MySQL 用户/组织/membership/权限重推导；PermissionSet 用于构建 contract.Identity。直接复用，不信任客户端权限/orgId，不为 GraphQL 接入机器令牌。
- graphqlread/policy/limit.go 的 Limiter.BudgetFor/Consume 已与 Nest 共用 rate:graphql:<ip> 及 :seq，预算 max(login.limit*30,120) 和 login window；复用现有配置与故障策略，不自建限流框架。
- graphqlread/schema 嵌入 SDL，contract Registry、exec.Engine 和 project.go 已支持标准解析/校验/变量、alias/fragment/@skip/@include、强类型模型反射、字段权限、枚举、DateTime 与 non-null 传播。事件选择集必须复用这些能力；不能直接把 Redis envelope 当 GraphQL 响应。
- 当前 Registry 只有 Query/Mutation，exec.rootDefinition 不支持 Subscription；所有 upgrade 仍 legacy。新增明确独立的 Subscription 注册/规划/投影 API：与 Query alertEvents 等同名根分开，不把订阅塞进 Query，不把 HTTP Execute 变成事件读取器。HTTP GET/POST 的 subscription operation 继续整份回 Nest。
- alerts.RegisterModels、history.RegisterModels 已在最新 main 导出，workspace.QueueEventModel 已有强类型定义；可只注册所需返回模型而不装配任何历史 Query/Mutation 或 Mongo 服务。history 旧 Input/Output 的 any 不是新业务 DTO 的范例：本批具名事件模型可用 nullable json.RawMessage，并确保 input/output 为 null。
- contract.FormatDateTime 为 UTC、固定三位毫秒。legacyproxy 的现有反向代理能转发 WebSocket upgrade；httpx.TraceMiddleware 未包装 ResponseWriter，可保留。独立订阅模式不能依赖 READ=go、任何写开关或 Mongo 才有模型/鉴权/路由。

## 4. 精确入口、鉴权与错误

只在独立模式 go 时接管 GET 精确 /graphql 的合法 WebSocket upgrade，客户端子协议包含 graphql-transport-ws，协商也必须返回该值。/graphql/、更长路径、/socket.io、其他子协议/upgrade 继续现有 legacy 行为；HTTP GET/POST/OPTIONS 由原有读写开关处理。

四个根均无参数，均 non-null，不接受客户端 orgId：

| Subscription root | 权限 | 返回 SDL 类型 | 事件来源 |
|---|---|---|---|
| alertEvents | alerts.read | AlertEventModel! | Redis gqlsub:alertEvents |
| analysisEvents | analysis.read | AnalysisResultModel! | Redis gqlsub:analysisEvents |
| assistantEvents | assistant.read | AssistantRunModel! | Redis gqlsub:assistantEvents |
| queueEvents | queue.manage | QueueEventModel! | 本进程读取 BullMQ itemPipeline 事件流 |

源码依据：apps/api/src/graphql/resolvers/{alerts,analysis,assistant,dashboard}.resolver.ts 的对应 @Subscription/@HasPermission；models/{alert,analysis,assistant,dashboard}.model.ts 与 Go schema.gql 的 Subscription。已核四种事件模型自身没有额外字段权限；QueueStatsModel.counts/recentLogs 的 queue.manage 属另一返回对象，不因此注册 queueStats Query。所有选择字段仍经现有投影/字段权限能力，禁止省略校验。

Nest graphql.module.ts 的 onConnect 只保存 createSyntheticGqlRequest，不在 init 拒绝无 token 客户端；保留 ACK 与每个 subscribe 业务鉴权的分层。connection_init.payload 是顶层 header-like 对象，authorization 为 Bearer，graphql.types.ts/toGqlHeaders 接受 string/string[]，不是 payload.headers、URL token 或可信 orgId。不能悄悄改成必须握手 HTTP Authorization 或 init 时全局认证。

每个本地业务 subscribe 先限流，再 Identify，再根权限，身份绑定该 operation；不是每个事件扣限流或重新查库。WS synthetic request 的 ip 来自 socket remoteAddress（request-ip.ts 优先 request.ip），不得用 connectionParams 里的 x-forwarded-for/orgId 冒充。无认证 Unauthorized，撤销 Access token revoked；权限不足 Insufficient permissions，FORBIDDEN/403、appCode INSUFFICIENT_PERMISSIONS、requiredPermissions、permissionsMode:any、detail 与现有 guard/exec 一致。Redis/MySQL 故障沿已有 Identify 和 GraphQL 错误映射，不错误后静默代理。

错误事实源还包括 common/guards/{gql-auth,gql-permissions}.guard.ts、graphql/guards/graphql-rate-limit.guard.ts、common/filters/global-exception.filter.ts：保留 TOO_MANY_REQUESTS/429 与 Too many GraphQL requests. Slow down.、extensions.http.status、traceId、必要 path/locations。不能把 REST 错误体写进已升级连接。SDL 校验错误与 subscribe resolver/guard 返回 ExecutionResult 错误分开：后者在 Nest graphql-ws 5.13.1 中走 next(errors) 后 complete，不一律关闭整条连接；协议 error 消息则终止该 operation、不再 complete。逐事件标量/枚举/non-null 错误走 GraphQL 结果语义。

## 5. WebSocket 协议与整份操作回退

- 使用维护中的成熟 WebSocket 库（优先 coder/websocket 的 Accept/Dial），固定经过上游核实的兼容版本；不手写 RFC6455 frame/mask/fragment 协议。处理 connection_init/connection_ack、JSON ping/pong、subscribe/next/error/complete，同连接多 operationID、取消、关闭和 ID 复用；只有一个序列化写出口。不要加入业务重试/锁平台。
- 以锁文件 graphql-ws 5.13.1 及其 server.ts/PROTOCOL、Nest @nestjs/graphql 11.0.6 GqlSubscriptionService 为协议依据。保留 init 等待 3 秒、未 ACK subscribe=4401、重复活动 ID=4409、重复 init=4429、init 超时=4408、非法消息=4400 等相应生命周期。客户端 complete 后停止该 operation，不因旧 goroutine 或上游迟到结果污染复用 ID；关闭/取消要注销 iterator/reader。
- 新库的默认 Origin、message-size、超时策略必须显式核对：Nest 该 WS service 没有把 HTTP cors/validationRules/Apollo plugin 自动传给 useServer；不要误套新库默认同源限制导致现有跨域客户端失败，也不要把 HTTP 深度/复杂度/APQ/响应缓存宣称已在 Nest WS 生效。本批 WS 采用对应标准 SDL 校验，保留 HTTP 既有策略，不顺带重建安全/缓存体系。
- ownership 在执行前按所选 operation、root 及完整选择集确定。四条完整支持的 Subscription 必须本地执行；同一连接也可能用 subscribe 消息执行 Query/Mutation，不能接管 upgrade 后把原先可用操作直接拒绝，或只支持“连接只能订阅”。
- 非本批 operation（包括 WS Query/Mutation、未来未支持根/选择集）整份交给 Nest：采用每个下游连接最多一条懒建的 legacy graphql-transport-ws 上游连接，地址只由 cfg.LegacyAPIURL 推导 ws/wss /graphql，转发原 connection_init 参数和完整 operation payload（query/operationName/variables/extensions）。仅在需要回退时建立；下游 ACK 一次，上游 ACK 内部处理。维护操作 ID/代次映射，将 next/error/complete 路由回原 ID；complete/连接关闭取消对应上游操作。不要在本地扣一次预算/执行业务后再回退，不拆分 root，不自动重放失败 Mutation。
- 上游连接失败只准确结束其负责的操作，不伪造业务成功；本地四条订阅可继续。没有回退操作时不得连接 Nest WS，更不能让本地四条订阅依赖 Nest executor/HTTP 轮询。legacy 模式则完整 upgrade 继续现有反向代理。

## 6. 三条业务事件的 envelope 与返回契约

事实源 modules/graphql-subscriptions/{graphql-subscription-bus,graphql-subscription-codec,subscription-org}.ts、各域 *.pubsub.ts 与 service 发布方法；orgId 必须与该 operation 的已认证组织精确相等，缺失/其他组织不投递，不 trim 成另一个组织，不全局广播。

三个物理 channel 已存在：gqlsub:alertEvents、gqlsub:analysisEvents、gqlsub:assistantEvents。复用其 wire schema，不改 producer 或另加前缀/relay。支持连接恢复后重新订阅和最后一个监听取消；Redis Pub/Sub 无耐久补发，不制造可重放承诺，不退成进程内“看似成功”。

- alert envelope 为 {orgId,event:{id,ruleId,ruleName?,metricProvider?,metricSlug?,triggeredAt,message?,severity,metricValue,changePercent?,status,context?}}。codec 将 Date 编为单键 {"$gqlDate":"ISO"}；识别有效 tag，兼容其 Date→DateTime UTC 毫秒契约，不能把 tagged object 或零日期直接投影。其他两域 createdAt 本来是 ISO string。不要对整个业务对象做任意 map 解码。
- alert 输出遵循 alerts.serialization.ts/serializeAlertEventPayload：deliveries 永远 []，不为“补完整”查询 DB；metricValue 使用 required finite number，不可转换/非有限/缺失时 0；changePercent/threshold* 可选有限数，否则 null；metricSlug trim 后空值为 null；context 仅非数组对象，否则 null。message/ruleName/provider/operator 等按 nullish 规则，不把空字符串全替 null；envelope 没有的阈值、operator、changeWindowMin 等保持缺省/null，不额外加载 rule。severity/status 保持 SDL 枚举，非法值由 GraphQL 错误路径处理。
- analysis envelope 为 {orgId,result:{id,type,status,summary?,error?,createdAt}}。type 识别 geo_transport/anomaly，否则 correlation；status 识别 pending/running/completed/failed，否则 pending。summary/error 仅缺省/null→null，空字符串保留；input/output 总为 null。
- assistant envelope 为 {orgId,run:{id,type,status,summary?,error?,createdAt}}。type 识别 query/report/forecast，否则 query；status 同上。summary/error 同样保留空字符串；input/output 总为 null；conversationId 未赋值→null，不能复用 history 查询补成更丰富内容。权限是 assistant.read，不能照 analysis.read 复制。
- 数据库 JSON、event envelope、队列上下文和内部消息用具名 Go 强类型；扩展 JSON 叶子用 json.RawMessage。已有通用 GraphQL/驱动边界的 any 可沿用，但不向新业务 DTO 扩散。

## 7. queueEvents：完整 BullMQ 观察链

事实源 modules/queue/{queue.constants,queue.module,queue-event.publisher}.ts、dashboard.resolver.ts；锁文件 BullMQ 5.63.2 的 QueueEvents/QueueKeys 已核。队列 itemPipeline，默认 prefix bull；物理 stream bull:itemPipeline:events，job hash bull:itemPipeline:<jobId> 的 data 是 JSON。

- 每个 Go 进程在模式 go 启动一个共享观察器，使用独立阻塞 Redis 连接 XREAD（不是 XREADGROUP，不领取/ack任务、不执行 worker，不修改 job/stream/retention）。初次从 $ 观察新事件，收到后保存最后 ID，在后续读取/重连继续该 ID；不能每轮重设 $ 丢窗口，也不能从 0 回放全部历史。启动后即使暂无线程订阅也观察上下文，以支持 removeOnComplete 后的终态；订阅者共享该 reader，不每连接新建 reader。
- 只迁现有 active/progress/completed/failed→ACTIVE/PROGRESS/COMPLETED/FAILED，忽略其他 BullMQ 事件。progress.data、completed.returnvalue 是 stream 中的 JSON 文本，先按 BullMQ 解码；不能把文本再当最终 data double encode。
- ACTIVE 的 prev truthy 时 data={prev}，否则缺省。PROGRESS 的真值 object（数组也算）直接作为 data；其余存在值包成 {progress:value}，包括 0/false/null。COMPLETED 的真值非数组对象直接用，其他存在值（含数组/null）包成 {returnvalue:value}。FAILED 有非空 failedReason 才为 {reason}。
- 查租户上下文顺序必须保持：先记下本地未过期 context，再尝试读取 job.data；有效 job context 优先并写入本地和共享缓存，失败/找不到再用本地，最后读共享 queue:pipeline:jobctx:<jobId>。orgId 只接受非空 trim 后字符串，同时保留可选 pipelineJobId/sourceId/rawItemId/itemMetaId/processedItemId，不能用裁剪结构覆盖共享 cache。
- 本地 TTL10分钟/每60秒惰性清理，共享 TTL600秒，CacheService 原生 JSON、无额外 prefix。终态投递后只删本地 context，保留共享缓存，让冷实例在 job 已删除时也能解析组织。共享缓存读取成功只暖本地；缺组织就跳过，不从订阅者当前组织猜测、不全局广播。
- GraphQL QueueEventModel 输出仅 event:String!、jobId:String!、data:String nullable、timestamp:String!；data 是 publisher data 真值时 JSON.stringify 的结果，否则 null，保持标量/数组包装及 JSON 叶子语义。timestamp 为观察并组装事件时的 UTC ISO 毫秒字符串，不是 Redis stream ID 时间，也不是 DateTime 类型；额外 context ID 不成为新 SDL 字段。
- queueEvents 只 fanout 本实例匹配组织的订阅，绝不再发布 gqlsub:queueEvents 或另一个多节点 relay；Nest 每实例既有 QueueEventPublisher、Socket.IO/quality listeners 保持工作，不迁其副作用。此处多观察者是广播读语义，不能引入唯一消费者锁、改 BULLMQ_WORKERS_ENABLED 或停现有 Nest worker。

## 8. 数据、副作用与有价值的优化

本批 MySQL 仅用于现有 JWT 授权读取，Redis 用于撤销/权限限流、三个 Pub/Sub channel、BullMQ stream/job 只读与既有 jobctx cache 写回；没有新业务表、迁移脚本、Mongo、事务、审计生产、入队或外部模型/邮件/采集调用。上游业务持久化/入队/状态生成/发布继续由 Nest producer/worker 拥有；“传输已迁”不能写成“分析/Assistant/告警执行器已迁”。

安排两项具体优化：按 (channel/root,orgId) 索引本地订阅，先定位目标组织再投影，避免每个事件扫描所有租户的所有连接；每个 operation 解析/校验/展开选择集一次，逐事件只做强类型 payload 映射和既有投影。保持同来源观察顺序和单连接写顺序，合理处理慢连接而不无限堆积；不为一个慢连接阻塞全组织广播，也不随意丢终态。复用库/现有关闭和背压能力，必要的有界发送与取消属于传输收口，不另建持久队列、重试/去重框架或性能专项。

## 9. 独立开关、资源装配与回滚

- 新增 API_GO_GRAPHQL_SUBSCRIPTIONS_MODE，空/legacy 默认 legacy，只有 go 接管上述 upgrade，非法值启动失败。go 独立初始化 sharedDB、JWT/authenticator、Redis 及订阅模型；总读/所有写及其他 HTTP 开关 legacy 时四订阅仍可用，不初始化 Mongo。资源缺失/DSN 无效时明确失败，不装空 handler 偷偷回退。
- 使用现有 REDIS_HOST/PORT/USERNAME/PASSWORD/DB，命令、Pub/Sub、阻塞 stream 都连同一实际 DB；阻塞 reader 不占 shared command connection。新增配置/样例/Compose 保持 legacy，Web→Nest 和 CANARY_PERCENT=0 不变，HTTP GraphQL 开关组合不改变。
- GRAPHQL_SUBSCRIPTION_BUS 默认 redis；Go 模式要求与仍在 Nest 发布的三域一致。go+local 启动明确失败，不能接管后等不到跨进程事件；legacy+local 继续原语义。Compose 为相关进程显式传同一 bus 值，避免只在宿主 .env 设置但容器没注入。Nest 既有 GRAPHQL_SUBSCRIPTIONS_ENABLED getter 默认 true，但 env.schema 未声明该键；本批不顺手重构此全局配置，更不能拿 false 停 Nest producer/executor，因为 fallback 仍依赖它。
- 构造/启动失败要释放已开的专用资源；SIGTERM/HTTP listen失败都停止新订阅、取消各 operation/legacy upstream、关闭所有 hijacked WebSocket，再停 Pub/Sub/XREAD 并释放专用连接，最后才关共享 Redis/DB。http.Server.Shutdown 不会替你关闭已 hijack 的连接；Close 必须覆盖这些退出路径并幂等，与 #92、digest、NewsNow 的关闭并集共存。
- 切换只改变经过 Go 入口的新连接；已有连接仍归原进程。滚动排空旧连接，不能让同一订阅同时在 Go/Nest 双执行或 shadow。回滚改本模式 legacy 并重启/排空 Go WS，让客户端重连后整条 upgrade 回 Nest；保留 Nest publisher/worker/WS 服务与兼容 cache，既有 Redis 数据无需清空，不改其他迁移开关。

## 10. 精简验证与依赖处理

- 本机不安装依赖，不运行 build/test、Docker 或服务，不读真实 .env/凭据，不为验证主动调用生产者的真实模型/采集/SMTP。允许静态读码、git diff --check 与普通格式化。源码新增/修改注释用英文，解释租户绑定、观察顺序/终态缓存和取消原因；文档、提交与 PR 描述中文。
- 若添加 WebSocket 库，仅修改明确固定版本的 go.mod，通过现有 ci.yml 的 go-modules-regen label 远端 tidy/build/生成 go.sum；正常同步机器人提交，移除 label 后等待新 head 普通 CI。不得本机 go get/tidy，不覆盖并行依赖，不新建生成 workflow。
- 写少量真正行为验证，交现有普通 CI 执行：握手/ACK、多 ID/取消/复用与迟到结果、同连接 local+legacy Query/Mutation 整份回退且仅执行一次；四根精确权限/双组织不串流；Date tag/null/enum/alias/fragment/非空投影；BullMQ progress/completed JSON 包装、job删除后共享上下文终态、每实例仅一次；订阅独立模式与公共关闭。优先复用现有测试工具/本地假协议端口，不堆镜像实现测试、源码文本断言或 API Jest/e2e 依赖。
- 不新增专用 smoke/workflow。现有 graphql-subscriptions-smoke 验证的是 Nest 跨实例链，不能冒称它已覆盖 Go executor；若未额外实际运行 Go+真实 Redis/多实例，明确记录缺少此证据。普通 CI 记录最终精确 head、job/结果/链接，skipped 不当通过；真实业务产生成功事件、外部服务与生产切流均须独立说明未验证。
- 完成后按 AGENTS 做只读静态 review：协议/GraphQL 类型和错误、orgId 从可信身份与 jobctx 推导、整份回退无重复副作用、所有 startup/close 分支与现有开关并集。发现具体问题修复后再交付，不扩大到全仓审计。

## 11. 任务记录、Ready PR 与交付

只维护本任务 docs/refactor/migration-map/tasks/GRAPHQL-SUBSCRIPTIONS-001.md 和专用 docs/refactor/go-graphql-subscriptions.md，记录实际范围/基线/分支/worktree、开发与 PR 状态、优化、关键源码依据、配置/回退/回滚与真实验证边界；原始 prompt 保留。编码窗口不重复修改共享 README/BACKLOG/GAPS/AUDIT/DEPENDENCIES/模块页或他人 task；向规划窗口在最终交付中提供可回填事实，由规划窗口集中更新。业务 PR 开着只能 pr_open，不提前 merged，不关闭整个 GAP-ASYNC-001。

只提交自己的修改，中文 emoji + type(scope)，正常 commit/push，创建面向 main 的 Ready PR，中文说明四根用户结果、兼容回退、生产者/观察者所有权、独立开关及验证。没有本机 build/test 不伪装已跑；依赖远端生成与普通 CI 完成后记录最终 head，失败要在本任务内修复。不合并、不 auto-merge、不 amend/rebase/force-push，不自动创建其他 Codex 对话、跨对话消息或定时任务。

最终交付：Ready PR URL、最终 head SHA、main 基线、四根完成/剩余情况、WS legacy 兼容边界、普通 CI 精确结果、独立开关与回滚步骤、未验证的真实事件/多实例/外部/部署证据。四条本地执行、事件源和取消收口都完成才称本批交付，不能仅以 root 已注册或 CI 绿灯代替。
