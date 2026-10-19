# Go GraphQL 实时订阅传输（GRAPHQL-SUBSCRIPTIONS-001）

- 状态：实现完成，等待业务 PR 与普通 CI；未合并、未部署、未切流。
- 基线：`origin/main 91e759b449c4511dc96d86539ea0eb258754d07e`。
- 分支/worktree：`refactor/go-graphql-subscriptions` / `/Users/oo/project/newwei-go-graphql-subscriptions`。
- 范围：`apps/api-go` 接管精确 `/graphql` 的 `graphql-transport-ws` upgrade，本地执行
  `alertEvents`、`analysisEvents`、`assistantEvents`、`queueEvents` 四条完整订阅；
  不迁 Socket.IO、Nest producer/worker/Cron，也不改变后台业务执行所有权。

## 入口、权限与选择集

只接管 `GET` 精确 `/graphql`、`Upgrade: websocket` 且 `Sec-WebSocket-Protocol`
包含 `graphql-transport-ws` 的连接。`/graphql/`、更长路径、`/socket.io`、其他
子协议/upgrade、HTTP GET/POST/OPTIONS 继续原 legacy 代理或原 GraphQL 读写开关。
四个根都无参数、返回类型 non-null：

| 根 | 权限 | 返回模型 | 事件来源 |
|---|---|---|---|
| `alertEvents` | `alerts.read` | `AlertEventModel!` | Redis `gqlsub:alertEvents` |
| `analysisEvents` | `analysis.read` | `AnalysisResultModel!` | Redis `gqlsub:analysisEvents` |
| `assistantEvents` | `assistant.read` | `AssistantRunModel!` | Redis `gqlsub:assistantEvents` |
| `queueEvents` | `queue.manage` | `QueueEventModel!` | 本进程只读 BullMQ `bull:itemPipeline:events` |

- 复用既有 `contract.Registry`、`exec.Engine` 的解析/校验/变量/alias/fragment/
  `@skip`/`@include`/字段权限/枚举/DateTime/non-null 投影；Subscription 使用独立
  `RegisterSubscription` 命名空间，不注册到 Query，也不把 HTTP `Execute` 变成事件读取器。
- 每个 operation 只规划、限流、`Identify`、根权限一次；逐事件只做强类型 envelope
  映射和既有投影。`(channel/root, orgId)` 索引先定位组织，再向该组织的 operation 投影。

## 协议与错误

- 使用 `coder/websocket v1.8.12` 的 `Accept`/`Dial`，不手写帧/掩码/分片。
- 单写 goroutine 串行输出 `connection_ack`、`next`、`error`、`complete`、`pong`；
  显式关闭压缩；显式关闭同源校验（Nest 的 `GqlSubscriptionService` 未把 HTTP CORS
  应用到 WS）；消息上限显式设为 16 MiB。
- 保留 graphql-ws 5.13.1 生命周期：init 等待默认 3 秒（`4408`）、未 ACK subscribe
  `4401`、重复活动 operation ID `4409`、重复 init `4429`、非法消息 `4400`、JSON
  ping/pong、同连接多 operation、取消、ID 复用与迟到结果隔离。
- `connection_init.payload` 按顶层 header-like 对象处理，只接受 string/string[]；
  每次 subscribe 才做 JWT/Redis 黑名单/MySQL 权限重推导。IP 取 socket remote
  address，不接受客户端 `x-forwarded-for`/`orgId`。Unauthorized、撤销、限流、
  `INSUFFICIENT_PERMISSIONS` 的 message/code/http.status/appCode/detail/
  requiredPermissions/permissionsMode 与现有 HTTP guard/filter 一致。
- guard/解析器失败作为 GraphQL `next(errors)` 后 `complete`，不关闭整条连接；协议级
  错误才关闭连接。SDL 校验/解析/未知 operation 由整份转发的 Nest 返回其原始错误。

## 整份回退

- 同一连接上的 Query/Mutation、未来未支持根、未支持选择集、非本批 operation 一律
  按原 payload 整份转发。每个下游连接最多懒建一条 `ws/wss · LEGACY_API_URL + /graphql`
  上游连接；仅在需要时建立，上游 ACK 内部处理，下游只 ACK 一次。
- 维护 downstream ID ↔ upstream ID ↔ generation 映射；`next/error/complete` 回原 ID，
  `complete`/连接关闭取消上游 operation；不自动重放 Mutation。没有回退 operation
  时不连接 Nest WS。上游失败只以 error 结束其负责的 operation，不伪造成功，本地四条
  订阅继续可用。
- 回退前不在本地扣预算/执行，不拆分 root；本地已执行四条订阅不依赖 Nest executor
  或 HTTP 轮询。

## 三域 envelope 与返回契约

- 复用既有物理频道与 wire schema；orgId 必须与已认证组织精确相等，缺失/其他组织
  不投递，不 trim、不全局广播。Redis Pub/Sub 无补发承诺。
- `alertEvents`：识别单键 `{"$gqlDate":"ISO"}` 与兼容 ISO 字符串；无效/零日期按
  GraphQL 错误路径（`triggeredAt`）处理，不投影 tagged object。`deliveries=[]`，
  `metricValue` 缺失/非有限为 0，`changePercent` 非有限为 null，`metricSlug` trim
  后空为 null，`context` 仅对象；阈值/operator/changeWindowMin 不查规则、保持 null；
  message/ruleName/provider 保留空字符串。context 内嵌套 Date tag 递归还原为 ISO。
- `analysisEvents`：type 仅 `geo_transport`/`anomaly`，否则 `correlation`；status 仅
  四个值，否则 `pending`；summary/error 保留空字符串；input/output 恒 null。
- `assistantEvents`：type 仅 `query`/`report`/`forecast`，否则 `query`；status 同上；
  summary/error 保留空字符串；input/output/conversationId 恒 null；权限是
  `assistant.read`。

## queueEvents 观察链

- 每进程一个共享观察器，使用专用阻塞 Redis 连接 `XREAD`（不是 `XREADGROUP`，不
  ACK、不领取/执行任务、不修改 stream/job/retention）。首次从 `$` 开始；每批后保存
  最后 ID，错误/重连继续该 ID，不回放全部历史。
- 观察器随模式 go 启动，即使暂无线程订阅也持续观察，从而在 `removeOnComplete` 前
  写入共享上下文。只映射 `active/progress/completed/failed`。
- `progress.data`、`completed.returnvalue` 先按 JSON 文本解码一次：对象（数组也算）
  直接作为 data；其他存在值（含 0/false/null/数组/null）分别包成
  `{progress:...}` / `{returnvalue:...}`；ACTIVE 仅 `prev` 非空为 `{prev}`；
  FAILED 仅非空 failedReason 为 `{reason}`。最终 `data` 是该 data 的 JSON 字符串，
  否则 null。
- 组织解析顺序：本地未过期 context → `bull:itemPipeline:<jobId>` 的 `data`（有效则
  写本地+共享）→ 本地 → 共享 `queue:pipeline:jobctx:<jobId>`。orgId 只接受非空
  trim 字符串；保留五个可选 ID；共享写入不丢字段。本地 TTL 10 分钟、每 60 秒惰性
  清理；共享 TTL 600 秒。终态投递后只删本地，保留共享供冷实例解析已删除 job。
- 只 fanout 本实例匹配组织，不再发布 `gqlsub:queueEvents` 或任何多节点 relay；不
  引入唯一消费者锁、不改 `BULLMQ_WORKERS_ENABLED`、不停 Nest worker。GraphQL 输出
  只有 SDL 四字段；timestamp 是观察组装时刻的 UTC ISO 毫秒字符串。

## 开关、资源与回滚

- 新增 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE`：空/`legacy` 默认，只有 `go` 接管；非法
  值启动失败。`go` 独立要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求
  `MONGO_URI`，不依赖 `API_GO_GRAPHQL_READ_MODE` 或任何写开关。
- `GRAPHQL_SUBSCRIPTION_BUS` 默认 `redis`；`go + local` 明确启动失败，`legacy + local`
  保持原 Nest 语义。Compose 为 `api` 与 `api-go` 显式注入同一 bus 值。
- 专用资源：go-redis 共享命令客户端、惰性 Pub/Sub 连接、独立阻塞 XREAD 客户端、
  共享 jobctx 缓存写入、hijacked WS、懒建 legacy upstream。构造/启动失败释放已开
  资源；关闭顺序为停止新订阅 → 取消 operation/upstream → 关闭 hijacked WS →
  停 Pub/Sub/XREAD → 释放专用连接，最后才关共享 Redis/DB。`http.Server.Shutdown`
  不关闭 hijacked 连接，故由 Runtime.Close 覆盖 SIGTERM 与 listen 失败路径，并幂等。
- 回滚：把 `API_GO_GRAPHQL_SUBSCRIPTIONS_MODE` 改回 `legacy` 并重启/排空 Go
  WebSocket，让客户端重连后整条 upgrade 回 Nest；Nest producer/worker/WS 与既有
  `gqlsub:*`/jobctx 数据无需清理，不改变其他迁移开关。切换只影响经过 Go 入口的新
  连接；已建立连接仍归原进程，滚动排空，避免同一订阅双执行。

## 实际优化

- 三域 Pub/Sub 按 `(channel, orgId)` 建本地索引，消息只解码一次；先定位组织再投影，
  不扫描全部租户/连接。
- 每个 operation 只解析/校验/展开选择集一次，逐事件复用投影；选择元数据只构建一次。
- 每连接单写出口与有界队列；queue hub 对慢订阅者有界丢弃非终态、终态驱逐旧项保留。
- queue 观察器跨订阅共享；终态共享缓存让冷实例在 job 删除后仍能解析组织。

## 验证边界

- 本机未安装依赖，未运行 build/test/Docker/服务/Redis/WS，也未读取真实 `.env` 或
  调用外部模型/采集/SMTP。仅做静态读码、`gofmt`、`git diff --check`。
- 新增行为测试交由现有普通 CI 的 `go test ./...` 执行：握手/ACK、多 ID/取消/复用
  与迟到结果、同连接 local+legacy 整份回退且仅执行一次、四根权限/双组织隔离、
  Date tag/null/enum/alias/fragment/non-null、queue progress/completed 包装/job
  删除后共享上下文/每实例一次、独立模式配置与公共关闭。
- 普通 CI [39305405252](https://github.com/wei500L/newwei/actions/runs/39305405252) 已在代码/测试
  head `33492e0f7c73c80450bd9915055a521032578e9b` success：verify（含 Lint、
  `Go tests (api-go gateway + vector-go pilot)`、Build）、vector-integration、
  api-go-user-settings-integration success；两个 regen skipped。依赖已由
  `go-modules-regen` 在 cfa0c4fc 远端生成。
- 未验证：Go+真实 Redis/多实例、真实 Nest producer 产生的事件、真实 BullMQ job
  终态、生产切流/部署。现有 `graphql-subscriptions-smoke` 只覆盖 Nest 跨实例链，
  不能作为 Go executor 证据。

## 关键源码

- Nest 事实源：`apps/api/src/graphql/graphql.module.ts`、
  `graphql/resolvers/{alerts,analysis,assistant,dashboard}.resolver.ts`、
  `alerts.serialization.ts`、`models/{alert,analysis,assistant,dashboard}.model.ts`、
  `modules/graphql-subscriptions/*`、`modules/queue/queue-event.publisher.ts`、
  `common/guards/*`、`common/filters/global-exception.filter.ts`。
- Go 复用：`internal/authhttp`、`internal/graphqlread/{contract,exec,policy,schema}`、
  `alerts.RegisterModels`、`workspace.QueueEventModel`、`legacyproxy`、`main/config`。
- 本批新增：`internal/graphqlsubscriptions/*`、`cmd/api/graphql_subscriptions.go`、
  `exec/subscription.go`、`contract` Subscription 命名空间、窄模型注册
  `workspace.RegisterQueueEventModel`。
