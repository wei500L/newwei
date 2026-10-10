# GraphQL 订阅的跨实例投递

告警、分析、助手三条 GraphQL 订阅原先各持有一个进程内 `PubSub`。订阅者连在哪个进程，就只能收到那个进程发出的事件。现在这三条共用一个 Redis 事件总线。`queueEvents` 不走这条总线。

回滚不改业务表，也不改已经保存的告警、分析、助手数据。

## 四条链路

| 订阅 | 发布者 | 组织来源 | 跨实例路径 | 订阅点 |
| --- | --- | --- | --- | --- |
| `alertEvents` | 执行告警 worker 的进程，在 `AlertsService` 把事件行提交之后调用 `pubsub.publish("alertEvents")` | 规则行上的 `orgId` | Redis 频道 `gqlsub:alertEvents` | `AlertsResolver`，GraphQL WS + 权限守卫，`withFilter` 只留本组织 |
| `analysisEvents` | 执行分析 worker 的进程，`AnalysisService.process` 里的 `publish` | 分析记录上的 `orgId` | Redis 频道 `gqlsub:analysisEvents` | `AnalysisResolver`，同样按本组织过滤 |
| `assistantEvents` | 执行助手 worker 的进程，`AssistantService.process` 里的 `publish` | 助手记录上的 `orgId` | Redis 频道 `gqlsub:assistantEvents` | `AssistantResolver`，同样按本组织过滤 |
| `queueEvents` | **每个** API 进程自己的 `QueueEventPublisher` | job 数据里的 `orgId`；job 已被删除时读共享缓存 `queue:pipeline:jobctx:{jobId}` | BullMQ `QueueEvents` 本身就是共享 Redis 流。每个进程各自 `XREAD`，再发布到本进程 topic `queueEvents:{orgId}` | `DashboardResolver.asyncIterator(requester.orgId)` |

`orgId` 只来自服务端已经落库或已经入队的业务上下文。订阅参数里没有组织字段，客户端不能指定别人的组织。

## 队列为什么不进 Redis 总线

BullMQ 的 `QueueEvents` 用 `XREAD` 读同一条事件流，不是竞争消费者。A 处理 job 时，B 上的 `QueueEvents` 也会收到 `active`、`progress`、`completed`、`failed`。B 上的 GraphQL 订阅者因此已经能收到终态事件。

如果再把每个进程收到的 `QueueEvents` 广播进 GraphQL Redis 总线，一条 job 会被每个实例各投递一次。所以 `QueueEventPublisher` 仍只用进程内 `PubSub`。

终态在这些情况下仍然可达：

- job 使用 `removeOnComplete: true` 后，`queue.getJob` 可能已经找不到它。更早的 `active` 或 `progress` 会把组织上下文写进共享缓存，冷启动的实例从那里读。
- `removeOnFail` 保留失败 job 时，另一个实例可以直接 `getJob`。
- 订阅者连在没有执行该 job 的实例上时，那个实例自己的 `QueueEvents` 仍会发布到本地订阅。

## Redis 连接

每个 API 进程有一对专用 ioredis 连接，名字是 `modular-api:gql-pub:{pid}` 和 `modular-api:gql-sub:{pid}`。它们使用现有的 `REDIS_HOST` / `REDIS_PORT` / 账号 / db，但不是缓存用的 `REDIS_CLIENT`。订阅连接一旦进入 subscribe 模式就不能再发普通命令，所以必须分开。

告警、分析、助手共用这一对连接，按 trigger 名区分频道。最后一个本地监听者取消订阅时，进程对那个频道执行 `UNSUBSCRIBE`。ioredis 断线重连后会自动恢复订阅；总线在随后的 `ready` 上再订阅一遍当前仍有监听者的频道。

进程收到 `SIGTERM` / `SIGINT` 时，Nest 的 shutdown hook 会 `quit` 这两条连接。Redis 里没有为这些频道保存消息，pub/sub 不落盘。

序列化使用 JSON。`Date` 往返后仍是 `Date`。`undefined` 字段会消失，解析端和原来的 `?? null` 一样。`NaN` / `Infinity` 变成 `null`，告警序列化本来就会把非有限数收成 `null` 或 `0`。`context` 仍是对象；不是对象时订阅解析把它收成 `null`。

## 故障语义

`GRAPHQL_SUBSCRIPTION_BUS=redis`（默认）时，Redis 发布失败会记错误日志，带上 trigger、`orgId` 和这句话的含义：告警、分析、助手的已提交数据保持原样，所有实例上的实时订阅者都收不到这一条，并且不会退回只在当前进程可见的内存总线。

发布失败不会把已经写完的业务记录回滚，也不会让 worker 因为实时通知失败而把整次任务判成失败。

## 回滚

把 `GRAPHQL_SUBSCRIPTION_BUS=local` 配到 API 进程并重启。三个领域恢复为互相独立的进程内 `PubSub`，行为和迁移前的单实例模式一致。不需要迁移，不改业务表，不改已保存的告警、分析、助手数据。队列链路本来就没有改存储。

`BULLMQ_WORKERS_ENABLED=false` 只表示这个进程不消费告警、分析、助手和 item pipeline 的 worker。默认是 `true`。跨实例 smoke 在进程 B 上关掉它，用来证明 job 由 A 执行、事件由 B 收到。这不是订阅回滚开关。

## 验收边界

双进程 smoke 里，订阅者连 B，变更打到 A：

- 告警走 `upsertAlertRule` → worker `evaluateRule` → 生产 `publish`。指标是 `system.memory.usage_pct >= 0`，不依赖外部模型。
- 分析和助手走 `requestCorrelationAnalysis` / `requestAssistantQuery` → worker `process`。`running` 在调用模型之前发布，`failed` 在模型地址不可达之后发布。没有验证模型成功返回后的 `completed`。
- 队列终态用一条缺少 `rawItemId` 的 pipeline job。A 的 worker 把它标成失败，B 的 `QueueEvents` 把 `FAILED` 投给连在 B 上的订阅者，且只出现一次。没有另跑一条真实爬虫成功的 `COMPLETED`；`COMPLETED` 和 `FAILED` 在 `QueueEventPublisher.emit` 之后是同一条本地发布路径。
