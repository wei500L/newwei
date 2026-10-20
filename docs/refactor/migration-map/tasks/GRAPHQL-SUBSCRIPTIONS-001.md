# GRAPHQL-SUBSCRIPTIONS-001 · 四条 GraphQL 实时订阅完整传输

- 状态 **pr_open**（Ready [PR #95](https://github.com/wei500L/newwei/pull/95)，head `51fb0d1aecf39c29c44fa91dfea1f425e488b7e7`（代码/测试 head））；2026-10-19 Europe/Moscow，规划窗口保存并发出[完整独立提示词](GRAPHQL-SUBSCRIPTIONS-001.prompt.md)，执行窗口已接续实施。
- 代码基线 origin/main `91e759b449c4511dc96d86539ea0eb258754d07e`；[普通 CI39247556593](https://github.com/wei500L/newwei/actions/runs/39247556593)在该精确 SHA success，verify/vector-integration/api-go-user-settings-integration success，两个 regen skipped。不是本任务运行/部署证据。
- 业务分支 `refactor/go-graphql-subscriptions`，worktree `/Users/oo/project/newwei-go-graphql-subscriptions` 已从精确基线创建；实现见 [go-graphql-subscriptions](../../go-graphql-subscriptions.md)。PR/head 已回填；未合并、未部署、未切流。
- 规划记录复用 `docs/plan-newsnow-feed`、`/Users/oo/project/newwei-plan-newsnow-feed` 和 [Ready规划PR #93](https://github.com/wei500L/newwei/pull/93)正常增量发布，保留原 NewsNow 认领；本轮发布提交/head/CI在后续交接追加，不以此前该 PR 绿灯代替新 head。
- 首次四订阅认领/完整提示词发布提交 `1ee329a21beede567c0e86977d08a4fa8a6c0338` 已正常推送到该PR，GitHub确认OPEN/非Draft。后续交接文档提交不改变任务范围；普通CI以最终PR head实时结果为准。
- 来源 BL-21 的 GraphQL 子链，关联 GAP-LEGACY-001 / GAP-ASYNC-001；不领取 Socket.IO/业务 producer/worker/cron。

## 精确范围与可独立条件

仅 GET 精确 /graphql + WebSocket upgrade + graphql-transport-ws，新增默认 legacy 独立 API_GO_GRAPHQL_SUBSCRIPTIONS_MODE。四根均无参数、non-null：alertEvents/alerts.read/AlertEventModel；analysisEvents/analysis.read/AnalysisResultModel；assistantEvents/assistant.read/AssistantRunModel；queueEvents/queue.manage/QueueEventModel。不能误抄 assistant 权限，也不与 Query alertEvents 混名注册。

交付握手/协议、每 operation 限流与 JWT/DB 权限、org 过滤、强类型事件投影、同连接多操作/取消/ID复用/关闭。Query/Mutation 与未接管 operation 在该 WS 上整份转 Nest，懒建固定 legacy 上游，不拆 root、不本地执行后回退、不自动重放 Mutation；没有回退操作时不连接 Nest WS。HTTP subscription 继续原 legacy，不打开其他协议升级。

三个既有通道 gqlsub:alertEvents/analysisEvents/assistantEvents，Date 单键 $gqlDate codec 与 resolver 的缺省/null/枚举映射不变。alert deliveries=[]；analysis/assistant input/output=null、assistant conversationId=null，不能查历史补成其他契约。Go bus 要求 GRAPHQL_SUBSCRIPTION_BUS=redis；go+local 明确启动失败，legacy+local 原行为保持。Nest producer/worker 与 WS fallback 保留。

queueEvents 是独立广播观察器：每 Go 进程一次 XREAD bull:itemPipeline:events，从 $ live 开始并保留最后 ID重连；不是 XREADGROUP/任务消费者，不用唯一锁。job hash data→本地context→共享queue:pipeline:jobctx:<jobId>，TTL600秒；终态只删本地，保留共享防 job删除后冷实例丢终态。只映射 ACTIVE/PROGRESS/COMPLETED/FAILED，data JSON.stringify 字符串契约和 observer 时间戳保持。不得将队列事件再广播到 gqlsub，避免按实例数重复。

只需 sharedDB/JWT/Redis，无 Mongo/新表/事务/审计生产/入队/真实模型或邮件外调。优化为 (root/channel,org) fanout 索引及 operation 规划一次、逐事件复用投影。独立模式不用 READ/写模式；专用 Pub/Sub/XREAD、hijacked WS、懒建 legacy socket 都先于共享连接关闭。

## 复用与源码证据

基于上述 SHA，只深入本候选：

- Nest graphql.module.ts/类型/三全局Gql guard/ExceptionFilter、四 Subscription Resolver与返回模型；alerts.serialization、三个 pubsub envelope和 service 发布点。
- graphql-subscriptions bus/codec/module/org匹配；queue constants/module/event.publisher完整 event/context/终态清理；GraphQL 多节点既有文档与锁文件。
- Go authhttp.Identify/authn/authz、policy.Limiter、contract/exec/schema/project、alerts/history.RegisterModels、workspace.QueueEventModel、legacyproxy upgrade/main/config/HTTP Trace与关闭。
- 相对地图3cedce9a，本候选 Nest Resolver/事件/queue链未变化，Go已有模型拆分和items选择集增强已合main；当前仍无 Subscription executor。只读增量不代表其他域/所有worker已审。
- 外部一手实现静态核对：graphql-ws5.13.1（init默认3秒、Query/Mutation也用subscribe消息、resolver错误ExecutionResult）；@nestjs/graphql11.0.6 GqlSubscriptionService（未将HTTP CORS/validationRules/Apollo plugin注入WS）；BullMQ5.63.2 QueueEvents/QueueKeys（XREAD与progress/completed解析）。不是实网或运行证明。

上游一手来源：[graphql-ws5.13.1 server](https://github.com/enisdenjo/graphql-ws/blob/v5.13.1/src/server.ts)、[Nest GraphQL11.0.6 GqlSubscriptionService](https://github.com/nestjs/graphql/blob/v11.0.6/packages/graphql/lib/services/gql-subscription.service.ts)、[BullMQ5.63.2 QueueEvents](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/queue-events.ts)、[QueueKeys](https://github.com/taskforcesh/bullmq/blob/v5.63.2/src/classes/queue-keys.ts)。版本来自本基线pnpm-lock.yaml，不以master替代锁定依赖行为。

## 文件所有权和并行

主业务 internal/graphqlsubscriptions、新 cmd/api/graphql_subscriptions.go；仅增量扩展 graphqlread contract/exec 的独立Subscription规划/投影与必要模型端口。共享 main/config/legacyproxy/Go依赖/样例/compose/根说明按语义取并集，不重构 HTTP 引擎。

AUDIT-OUTBOX-001：Ready [#92](https://github.com/wei500L/newwei/pull/92) OPEN/head `28c8f761a2ce4a447080414f154b567648cc6bd1`，普通CI[39248452603](https://github.com/wei500L/newwei/actions/runs/39248452603) success。NEWSNOW-SOURCES-001：in_progress，main/config/infra runtime reader/registry port/newsnowsources/Nest source relay已有工作区改动，无业务PR。已读两批实际共享diff，保留 AuditOutboxMode/ScheduleEnabled/NewsnowSourcesMode/needsRedis/生命周期并集；不触碰其核心包或task，不要求运行窗口重做记录。

## 验证与下一检查点

本规划只改文档：未创建业务worktree/安装依赖/运行build/test、Docker、服务、Redis/WS或外部模型；没有生产配置或流量证据。业务窗口通过少量行为测试和现有普通CI验证协议、四权限/组织、投影、队列删除后终态、取消与混合legacy一次执行；不新增专用smoke。已有graphql-subscriptions-smoke只验证Nest，不能当Go覆盖。

执行器仅维护自己的task与docs/refactor/go-graphql-subscriptions.md；共享地图由规划窗口回填。下一次只核业务PR实际四root/源/回退与独立接线、最终head普通CI、关闭与未验证多实例，未落main前不加覆盖数或关闭跨域GAP。


## 执行记录（2026-10-19）

- 已实现精确 `GET /graphql` + `graphql-transport-ws` upgrade 接管；HTTP GET/POST/OPTIONS、其他子协议/upgrade、`/graphql/` 与更长路径保持原 legacy 或原 GraphQL 读写开关行为。
- 新增 `internal/graphqlsubscriptions`：`coder/websocket v1.8.12` 协议层、四根独立 Subscription 注册、Redis `gqlsub:*` 组织索引、每进程 BullMQ `XREAD` 观察器与 `queue:pipeline:jobctx:*` 回退、懒建 Nest graphql-ws 上游整份回退、关闭/背压收口。
- `contract` 新增独立 `Subscription` 命名空间；`exec` 新增只用于 WS 的 `PlanSubscription`/`PrepareSubscription`/`OpenSubscription`/`ProjectSubscriptionEvent`，复用既有投影与错误语义；`workspace.RegisterQueueEventModel` 只注册所需模型。
- 新增 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE`（默认 legacy，go 要求 JWT/MySQL/Redis，不要求 Mongo）与 `GRAPHQL_SUBSCRIPTION_BUS`（默认 redis；go+local 启动失败）；Compose/Sample 显式注入同一 bus。
- 行为测试覆盖握手/ACK、四根权限与双组织隔离、取消/ID 复用/迟到结果、Date tag/null/enum/alias/fragment/non-null、同连接 local+legacy 整份回退且仅执行一次、queue 包装/共享上下文/每实例一次、关闭与配置校验。
- 验证边界：本机未安装依赖、未运行 build/test/Docker/服务/真实 Redis/WS；未验证真实 producer 事件、多实例和部署切流。依赖 `go-modules-regen` label 远端生成 go.sum，普通 CI 以最终 head 为准。

## PR 与 CI 记录

- Ready PR [#95](https://github.com/wei500L/newwei/pull/95) → main，head `51fb0d1aecf39c29c44fa91dfea1f425e488b7e7`（代码/测试 head），base `91e759b449c4511dc96d86539ea0eb258754d07e`；未合并、未 auto-merge。
- 首次普通 CI [39301019113](https://github.com/wei500L/newwei/actions/runs/39301019113) 在精确 head 失败于 `go.sum` 缺少 `github.com/coder/websocket v1.8.12` 两行；`go-modules-regen` 因 label 添加不会重触发 PR 事件而 skipped。后续推送新 head 触发远端 tidy/build，生成 go.sum 后再移除 label 运行普通 CI。skipped 不算通过。

- 远端 `go-modules-regen` 在 head `1d4d64ab` 通过 `go mod tidy` + `go build ./...`，bot 提交 [cfa0c4fc](https://github.com/wei500L/newwei/commit/cfa0c4fcecc4141e49f9b18b653268f8e09fbc30) 补充 coder/websocket go.sum；构造/编译错误已在本任务内修复（legacy operation 类型、gateway handler 类型）。bot 触发的 workflow 被 GitHub 标为 `action_required`，不以该状态计通过；移除 label 后由普通提交触发最终普通 CI。

- 普通 CI [39305405252](https://github.com/wei500L/newwei/actions/runs/39305405252) 在精确 head `33492e0f7c73c80450bd9915055a521032578e9b` **success**：verify（Lint、Go tests（api-go gateway + vector-go pilot）、Build）、vector-integration、api-go-user-settings-integration success；go-modules-regen / contract-baseline-regen skipped（依赖已由 cfa0c4fc 生成，skipped 不作为通过项）。此前 8d759fe2 的普通 CI 仅在本任务测试断言/关闭帧顺序上失败，已在本任务内修复。
- 本任务后续仅再提交一次性任务记录/交付文档；最终 PR head 以 GitHub 实时显示为准，并以其新 head 的普通 CI 结果复核，不改变上述代码 head 的四根本地执行与事件源证据。

- 后续修正：SDL 解析/校验错误改为本地 operation 级 `error`（不 complete、不关闭连接），未知 operation/变量错误保持 `next+complete`，避免为无效文档拨起 Nest 上游；对应行为测试已加入。
- 最新普通 CI [39308530143](https://github.com/wei500L/newwei/actions/runs/39308530143) 在精确 head `51fb0d1aecf39c29c44fa91dfea1f425e488b7e7` **success**：verify（Lint、Go tests、Build）、vector-integration、api-go-user-settings-integration success；两个 regen skipped。此前 39305405252 在 33492e0f 的 success 仅覆盖修正前的协议错误语义。
- 最终只追加本任务记录/交付文档提交；最终 PR head 与普通 CI 以 GitHub 实时为准并在交付说明中给出。
