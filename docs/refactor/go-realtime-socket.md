# 实时 Socket.IO 五 namespace 与分类质检告警调度（Go）— 交付说明

> 分支 `refactor/go-realtime-socket`；基线 `origin/main = 1ba22e3beb86cbd0d588ab9cff4adbe375d8ae17`（#128 整合 #115–#127）。
> 本机未运行 go build/go test/pnpm/Docker/服务，全部验证由普通 CI 执行；未在浏览器实测、未在部署环境切换。

## 结论

- 新增 `API_GO_REALTIME_SOCKET_MODE`（默认 `legacy`）。`go` 时 Go 在独立 Engine.IO 路径 `/socket.io-realtime` 上用一个 websocket 多路复用 5 个 namespace：`/newsnow`、`/ops`、`/quality`、`/queue`、`/situation-monitor`。`/socket.io` 与 `/notifications`（#124）保持原样。
- 新增 `API_GO_CLASSIFICATION_QUALITY_ALERT_MODE`（默认 `legacy`）。`go` 时由 Go 每 5 分钟执行分类质检告警评估，Nest `@Interval` 在领取共享 tick gate 前直接返回。
- Web 新增构建参数 `NEXT_PUBLIC_REALTIME_SOCKET_PATH`（默认 `/socket.io`）。7 处 `io()` 全部传入该 `path`：只有显式设置为 `/socket.io-realtime` 并重建 Web 才连接 Go；默认构建行为不变。
- 切换与回退见文末；两边无数据迁移、无 Redis 清理。

## 与 #124 的差异：multiplex

#124 的 `/socket.io-notifications` 一条连接只服务一个 namespace。本批 5 个 namespace 共用同一个 Engine.IO 路径，而 `socket.io-client` 4.8.1 的 Manager 缓存键包含 Engine.IO path（`build/esm/url.js` 的 `id = protocol://host:port + path`），同一 path 下的 5 个 `io()` 复用同一个 Manager、同一条 websocket。因此 Go 必须支持：

- 一条 Engine.IO 连接上依次收到多个 `CONNECT`（`40/<ns>,{auth}`），每个 namespace 有独立 SID、鉴权结果、房间、复核定时器与生命周期；
- 单 namespace 的 `DISCONNECT` 只关闭该 socket（`41/<ns>,`），不影响其他 namespace；
- 连接到本路径不支持的 namespace → `CONNECT_ERROR {"message":"Invalid namespace"}`，连接保持（socket.io 4.8.1 `client.js#connect` 语义）；
- `disconnect(true)`（鉴权/限流/复核失败）按 socket.io 4.8.1 `socket.js#disconnect` → `client.js#_disconnect` 语义：对**所有已连接 namespace** 依 CONNECT 顺序写 `41/<ns>,`，再关闭底层传输；这会让同一浏览器的其他 namespace 一起收到 `io server disconnect`。本批按此 1:1 实现（Q1 结论见下）。
- 同一 websocket 的写操作单写者串行；任一 namespace 关闭整条连接时，其他 namespace 的复核 goroutine 与订阅全部退出。

## 协议子集

沿用 #124 的 Engine.IO v4 + Socket.IO v5 WebSocket 子集（`0` open、`2` ping、`3` pong、`1` close、`4` message；`0` CONNECT、`1` DISCONNECT、`2` EVENT、`4` CONNECT_ERROR），并补齐 multiplex。不实现 HTTP 长轮询、二进制附件、服务端 ack、客户端 ack 与 Redis adapter 的跨节点 RPC。

- 握手门控：`GET + Upgrade: websocket + Connection: upgrade + EIO=4 + transport=websocket`，路径精确匹配 `/socket.io-realtime`（含尾斜杠）；其余请求不归 Go 处理。
- 生效默认值与 Nest 一致（engine.io 6.6.4 源码核对）：`pingInterval=25000`、`pingTimeout=20000`、`maxHttpBufferSize=1_000_000`。close 时 engine.io 不额外发 engine 级 close 包，直接关 ws。
- 客户端 `parseClientPacket` 支持 `40/ns,{auth}`、`41/ns,`、`42/ns,[event,...]`；服务端事件帧 `42/<ns>,[event,payload]`，载荷为已序列化 JSON（保留原始字段顺序）。
- 应用层错误一律走 `<ns>:error` 自定义事件（Nest 网关没有 namespace middleware；CONNECT ack 先于认证），随后 `disconnect(true)`。

## A4 事件来源（每类事件只有一条路径）

| namespace | 事件来源 | Go 接收方式 |
|---|---|---|
| `/newsnow` | Nest `NewsNowRealtimeDispatcher` → 网关 `server.to(org:{orgId}).emit` → Redis adapter 广播；Go 抓取模式下 Go `newsnowsources` 发布 `newsnow:source-refresh:v1` relay | PSUBSCRIBE `${WS_REDIS_ADAPTER_KEY}#/newsnow#*` 解码 notepack msgpack；消费 relay 时按 Nest 相同的 fanout NX 选举后以 adapter 广播格式发布，再由订阅端落到本机连接 |
| `/situation-monitor` | 态势事件桥 `situation-monitor:signals:events:v1`（契约见下） | SUBSCRIBE 事件桥，按本实例在线用户批量补充载荷后逐用户推送本地连接 |
| `/queue`、`/ops`、`/quality` | 6 个 BullMQ 队列事件流（`itemPipeline`、`crawl4ai-hot`、`crawl4ai-normal`、`analysis`、`assistant`、`alerts`） | 每队列每实例一个 XREAD（`$` 起点、不使用消费组），解析 orgId 后只推送本实例连接（B1） |

### redis-adapter「本地没有 socket 时是否 publish」核对结论

有。`@socket.io/redis-adapter@8.3.0` 的 `broadcast(packet, opts)` 只在 `opts.flags.local === true` 时跳过 publish；否则无条件 `pubClient.publish(...)`，与本实例是否有 socket、房间是否存在无关（`redis-adapter/dist/index.js:458-476`，本地投递在 publish 之后）。因此 Nest 侧只要调用了 `server.to(room).emit(...)`，即使该实例一个 socket 都没有，其它实例（含 Go 订阅者）也会收到广播。

同一源码核对结论（PR 中需要的两点）：
- `@socket.io/redis-adapter@8.3.0` **没有覆写 `sockets()`**，`server.in(room).allSockets()` 走内存实现 = **本实例计数**；跨节点的只有 `fetchSockets()`。因此 Go 的连接上限按实例计数与 Nest 等价，不是已知偏差（#124 文档中「Nest adapter 集群计数」的表述按源码修正）。
- Go 只 PSUBSCRIBE `${key}#<nsp>#*` 广播频道，**不订阅** `-request#`/`-response#`；Nest 的 `serverCount()` 用 `PUBSUB NUMSUB` 统计节点数，Go 不订阅就不会让 Nest 等待超时（`allSockets` 异常 fail-open 返回 0 会使上限失效）。

### `/newsnow` 生产者核对与目标组织解析

newsnow 实时事件的全部生产者：
1. Nest 拉取（legacy sources 模式）：`news-aggregator.service.ts#publishRealtimeUpdate` 计算增量后调 dispatcher；目标 org 来自 `resolveRealtimeTargetOrgIds`，无显式 orgId 时取 `NewsnowActiveSourceRegistryService.getOrgIdsForSource`（**进程内**注册表，由 Nest 本地网关的 `newsnow:set-active-sources` 填充）。
2. Nest 订阅 Go relay（`API_GO_NEWSNOW_SOURCES_MODE=go`）：`newsnow-source-refresh.subscriber.ts` 校验消息、按同样注册表解析目标 org、用 `SET newsnow:source-refresh:fanout:{refreshId}:{orgId} NX EX 60` 选举唯一实例后调 dispatcher。
3. Go `newsnowsources`：刷新有新条目时发布 `newsnow:source-refresh:v1`（无 orgId）；`newsnowhottest` 不发布任何实时事件。

因目标 org 解析依赖**进程内**注册表，Web 全部连到 Go 后 Nest 注册表为空，Nest 不会产生 newsnow 广播。为使 `/newsnow` 在 Go 接管后仍能收到事件，Go 侧：
- 接收并校验客户端的 `newsnow:set-active-sources`（校验规则与 Nest 网关一致：数组、trim、`/^[a-z0-9_-]+$/i`、去重、≤60；socket 关闭清理），维护本实例的 active-source 注册表；
- 消费 `newsnow:source-refresh:v1`：对「本实例存在且该 source 活跃」的 org 执行与 Nest 相同的 fanout NX 选举，赢者以 adapter 广播格式发布 `newsnow:update`（频道 `${key}#/newsnow#org:<orgId>#`，packet data 与 Nest 网关一致），随后本地投递；订阅端跳过自己 uid 的消息。这样在 Nest+Go 混合连接时也是恰好一次。
- **配置前置条件（已知）**：`/newsnow` 实时事件需要 `API_GO_NEWSNOW_SOURCES_MODE=go`（Go 拉取单元发布的 relay 是 Go 接管 socket 后唯一可用的事件源）。该组合在启动时记录 warn 并写入 README；legacy sources + go socket 不会产生 newsnow 实时事件，这是 Nest 进程内注册表决定的既有约束。

### 态势事件桥契约与回环检查

契约（两个窗口共同遵守，不得各自改动）：
- 频道 `situation-monitor:signals:events:v1`；
- 消息 JSON `{"version":1,"type":"situation:telegram.update"|"situation:oref.update","payload":<原始载荷>,"timestamp":<ISO 毫秒 Z>}`；
- payload 与 Nest dispatcher.publish 收到的完全相同（尚未按用户补充的原始载荷），timestamp 与 `SituationMonitorRealtimeEvent.timestamp` 相同。

生产者：
- `API_GO_SITUATION_SIGNALS_WORKER_MODE=go`：Go 态势信号 worker 发布（态势窗口负责）；
- worker 仍在 Nest 且 `API_GO_REALTIME_SOCKET_MODE=go`：Nest `situation-monitor-signals.dispatcher.ts` 在进程内 listener 之后发布（本批实现；失败只 warn）。

消费者：Go `/situation-monitor`（本批）。载荷补充移植 Nest `augmentTelegramRealtimePayloadForUsers` / `augmentOrefRealtimePayloadForUsers`：按 orgId 批量取在线用户与其监控规则、批量 embedding/rerank、返回每用户 `monitorMatches`（telegram）或 `alertMonitorMatches`（oref；`historyEntry` 存在时另有 `historyMonitorMatches`）；补充失败退回原始载荷（与 Nest fallback 相同）；按 orgId 批量查询（O3），不逐用户查库。

回环检查：态势窗口的 Nest 订阅者只做本地推送、不回调 `dispatcher.publish`；dispatcher 中的桥发布只发生在 Nest 进程，Go 订阅者不会回调 Nest。桥是单向下行，不形成回环。代码路径：Nest `publish()` → listeners（gateway 本地推送）→ Redis publish；Go 订阅 → 本地 emit。

**Nest 基线核对发现（不作为本批修复对象）**：Nest 网关 `getConnectedUsersByOrg()` 读 `this.server?.sockets?.sockets`，而 namespaced gateway 注入的 `@WebSocketServer()` 是 `Namespace` 实例（`Namespace.sockets` 已是 `Map`），该表达式恒为 `undefined` → 广播提前 return。也就是说 Nest 基线的 `situation:telegram.update`/`situation:oref.update` 实际不会推送到浏览器。本批 Go 实现按契约正常推送（相对 Nest 为修复，不是回归）；网关/模块由并行窗口负责，本批不改。回退到 legacy socket 时情况恢复为现状。

## B1 / B2

### B1 · 多实例重复推送（queue/ops/quality）

依据：`queue-event.publisher.ts` 等 5 个 publisher 都在每个 API 实例各自读取同一个 BullMQ 事件流（XREAD，不是竞争消费组），随后网关用经 Redis adapter 的 `server.to(room).emit` 广播。部署 N 个实例时每个客户端收到 N 份相同事件。

修复：Go 的每实例读一次事件流（O1）、只推本实例连接，不订阅这三个 namespace 的 adapter 频道。混合模式（Nest 与 Go 同时有连接）下，Nest 侧仍按原语义工作。测试：两个 Go 实例 + 一条事件 → 每个连接恰好一次。

### B2 · 长连接复核只检查令牌

依据：`socket-token-revalidation.ts` 注释要求登出/权限撤销断开连接，但实现只检查 `exp` 与 blacklist。

修复：5 个 namespace 的 30s 复核在令牌检查后，再用 Go `authz` 重新推导成员关系/用户停用/namespace 所需权限；任一失效即静默 `disconnect(true)`（与 Nest 复验一致的静默断开，不补 `<ns>:error`）；MySQL/Redis 基础设施错误 fail-open 保持连接。推导结果按 `(userId, orgId)` 每复核周期最多查询一次（本实例缓存，O3）。

行为变化：
- Nest 的 `/quality` 网关**没有** token 复验，本批统一加上（补齐 B2；只会更严格）。
- `/notifications` 的复核未改动（#124 现状：exp + blacklist）；共享复核代码未与之合并，列为后续项。

## O1–O3 与补充优化

- O1：每个队列在每个 Go 实例只运行一个 XREAD 循环，结果按 orgId 分发到本地房间，不为每个连接开读取循环。
- O2：newsnow 每个 namespace 一个 PSUBSCRIBE、态势一个 SUBSCRIBE；消息解码一次后按房间索引查找本地连接（房间索引 `map[room]set[*session]`），不遍历所有连接。
- O3：复核按 `(userId, orgId)` 批量推导；态势载荷按 orgId 一次查询本组织在线用户的监控规则。
- 补充优化：multiplex 单写者 + 每 namespace 独立 Session 避免跨 namespace 写竞争；adapter 消息 use-once 解码（收到即投递，不保留大对象）；队列事件只保留本批需要的字段。
- Nest 侧 dispatcher 桥发布：Redis 断连时不应拖住 BullMQ 回调，发布采用 fire-and-forget（内部 catch + warn）。

## Q1–Q3 核实结论

- **Q1（disconnect(true) 连带其他 namespace）**：核实为真。按 socket.io 4.8.1 源码，`socket.disconnect(true)` → `client._disconnect()` 对每个已连接 namespace 写 `41/<ns>,` 后关闭传输；客户端每个 socket 收到 `io server disconnect`，`Manager._destroy` 在无 active socket 时 `_close` 并置 `skipReconnect`，因此**默认不会自动重连**，需页面刷新或重新 `connect()`。Web 端会触发的情况：限速/退避/连接数超限/鉴权或权限失败（认证失败、成员关系失效）以及 30s 复核失效；`/queue` 页面虽在客户端按权限过滤入口，服务端鉴权失败仍会触发。本批保持与 Nest 相同语义，不改为只断单个 namespace。
- **Q2（quality 事件生产者）**：不存在独立的 quality publisher/队列。`quality:event` 与 `ops:event` 同源，来自 5 个 publisher（`itemPipeline`、`crawl4ai-hot`、`crawl4ai-normal`、`analysis`、`assistant`、`alerts` 的 QueueEvents），quality 网关只保留 `{orgId,source,event,jobId,timestamp}`（剥离 `data` 与扩展字段）；`classification_quality` 队列不产生任何 socket 事件。Go 侧按同一事件流生成，`/quality` 事件只带 5 个字段。
- **Q3（ops crawl 是否含 Frontier LLM 队列）**：不含。`CrawlQueueEventPublisher` 只绑定 `crawl4ai-hot`/`crawl4ai-normal`；`frontier-llm-judge`/`frontier-llm-learn` 从未产生 `ops:event`/`quality:event`。#125 迁移的是这两个队列的 worker，队列事件语义不变，本批不新增 socket 事件。

## 分类质检告警调度（A6）

`API_GO_CLASSIFICATION_QUALITY_ALERT_MODE=go` 时 Go 每 5 分钟执行一次 Nest `ClassificationQualityAlertSchedulerService.evaluate` 的等价流程：

1. tick gate：`SET cron:classification-quality-alert:tick-gate {"claimedAt":<ISO>} EX 285 NX`（与 Nest 同键同 TTL，多实例只跑一个 tick）。
2. 活跃组织：`SELECT id FROM Org WHERE isActive = true ORDER BY id ASC`，共享缓存 `org:active:list:v1`（15s，锁 2s/重试 50ms/最长 500ms，异常回源 DB）。
3. 并发度：`SystemSetting.multi_tenant_scheduler_runtime_settings` 的 `classificationQualityAlertOrgConcurrency`（默认 4、1..16、运行态缓存 30s），扇出保持输入顺序。
4. 每组织：`withLock(lock:quality:classification:alert-scheduler:{orgId}:1h, TTL 240s)`，抢到后调分类质量摘要（`window=1h`）。
5. 摘要副作用：Go `classificationrssops.ClassificationSummary` 已包含 60s `cache.wrap`、p95/gate 告警计算、`quality:classification:alert:notify:*` 900s 节流、收件人缓存（`settings.manage` 活跃成员，最多 500，300s）与 Notification 落库。本批补齐实时副作用：`API_GO_NOTIFICATIONS_SOCKET_MODE=go` 时在落库成功后发布 `notification:events:v1` identifiers-only relay（`{version:1,notificationId,orgId,userId?}`），使分类质量告警能实时出现在通知中心（此前 Go 写入只落库、不推送）。
6. 指标：`scheduler_runs_total{scheduler="classification_quality_alerts", status="success"|"failure"}`（复用 #127 metrics 包既有 family，不重复注册）。
7. 失败只 warn；抢不到 tick/组织锁为 skipped。

Nest 侧：开关为 `go` 时 `@Interval` 在 `claimSchedulerTick` 之前直接返回；两边共用 tick gate 与组织锁，切换时只有一个执行者。

## 开关与切换

```dotenv
API_GO_REALTIME_SOCKET_MODE=legacy                 # 默认；go 时有 5 个 namespace
API_GO_CLASSIFICATION_QUALITY_ALERT_MODE=legacy    # 默认；go 时由 Go 调度
NEXT_PUBLIC_REALTIME_SOCKET_PATH=/socket.io         # 默认；go 时 /socket.io-realtime
```

约束：
- `API_GO_REALTIME_SOCKET_MODE=go` 需要 JWT、MySQL、Redis，且 `WS_REDIS_ADAPTER_ENABLED` 不能为 false（否则 newsnow 收不到任何广播）；违反时启动失败。
- 非法开关值启动失败；空串等价 legacy。
- Web 的 `NEXT_PUBLIC_*` 是构建期内联：修改后必须重建镜像，运行期注入无效。

Socket 切换：
1. ipi 与 api-go 都设置 `API_GO_REALTIME_SOCKET_MODE=go` 并重启（api 需要该开关才会把态势事件发布到事件桥；api-go 需要它接管 `/socket.io-realtime`）。
2. 反向代理把 `/socket.io-realtime/` 路由到 api-go（`/socket.io/`、`/socket.io-notifications/` 路由不变）。
3. 以 `NEXT_PUBLIC_REALTIME_SOCKET_PATH=/socket.io-realtime` 重建 Web。

Socket 回退：把 Web 路径改回 `/socket.io` 并重建，再把两侧开关改回 `legacy`；已建立的 Go 连接在关闭时 `disconnect(true)`，浏览器重连回 Nest。无数据迁移。

分类质检告警调度：先把 api 服务开关设为 `go`（Nest 停止评估），再把 api-go 开关设为 `go`；回滚反向。共享一个 tick gate 与组织锁，不会双重执行。

## 验证状态

- 未在本机运行 `go build`/`go test`、`pnpm`、Docker 或任何服务；未在浏览器实测、未在部署环境切换。
- 普通 CI（verify 的 `go test ./...`、lint/typecheck/Web 测试）与集成 job 的 `realtimeintegration` 步骤是唯一验证来源；结论以 PR 的 CI run 精确 head SHA 为准。
- 已知未验证/边界：
  - 真实浏览器握手与 `socket.io-client` 4.8.1 互操作、真实 Redis adapter 混合模式、真实部署切流。
  - `/situation-monitor` 载荷补充的 LLM rerank 依赖真实模型网关；集成测试不调用真实上游。
  - newsnow 在 `API_GO_NEWSNOW_SOURCES_MODE!=go` 时无实时事件（配置前置条件，见上）。
