# 通知 Socket.IO 传输（Go）— 交付说明

## 结论

- 新增 `API_GO_NOTIFICATIONS_SOCKET_MODE`，默认 `legacy`；`go` 时 Go 在独立路径 `/socket.io-notifications` 接管 `/notifications` namespace 的 Engine.IO v4 + Socket.IO v5 WebSocket 子集。
- `/socket.io` 与其他 Socket.IO namespace 保持 NestJS 原样；Web 默认构建参数仍指向 `/socket.io`，只有显式设置 `NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH=/socket.io-notifications` 才切到 Go。
- 通知行仍由原业务方写 MySQL；Go 只负责实时投递。Nest `NotificationsService.notify` 在 go 模式改为发布标识符-only relay，不再走进程内 dispatcher。

## 协议子集

客户端 `socket.io-client` 已使用 `transports: ["websocket"]`，因此只实现：

- Engine.IO v4：`0` open、`2` ping、`3` pong、`1` close、`4` message；
- Socket.IO v5：`0` CONNECT、`1` DISCONNECT、`2` EVENT（以及拒绝其他类型的路径）；
- 固定 namespace `/notifications`，不实现 polling、binary、ack、动态 namespace。

不满足 `GET + Upgrade: websocket + Connection: upgrade + EIO=4 + transport=websocket` 的请求不会被 Go 处理。

## 事件来源分工

| 来源 | 通道 | 说明 |
|---|---|---|
| Nest `NotificationsService.notify`（go 模式） | `notification:events:v1` | 写库成功后发布 `{version,notificationId,orgId,userId?}`，不再调用 dispatcher |
| Go alert worker | `alert:notifications:v1` | 已存在，本批只消费 |
| Go analysis worker | `analysis:notification:v1` | 已存在，本批只消费 |
| Go digest delivery | `user-digest:notifications:v1` | 已存在，本批只消费 |

Go 收到 relay 后按 `id + orgId`（有 userId 时再加 `userId`）重读 Notification 行；B2 复核 type 与 `data.presentation.kind`，`data` 以 `json.RawMessage` 原样输出。

## B1 本地推送

`Runtime.emit` 只遍历本进程的 `byUser` / `byOrg` 索引，不经过 Socket.IO Redis adapter。每个 API 实例都会收到 relay，但只向本实例的连接发一次，因此不会出现 Nest 早期“dispatcher + Redis adapter 双发”的重复。

## B2 复核与 disconnect(true)

- relay 只带标识符，不携带可变展示字段；行不存在、org/user 不匹配或 presentation 不符时静默丢弃。
- 每 30 秒复核 JWT `exp` 与 Redis blacklist；失效时发送 `41/notifications,` 后关闭 WebSocket，即 `disconnect(true)`。Redis 查询异常保持连接，与 Nest `startTokenRevalidation` 的 fail-open 一致。
- 连接上限是 Go 实例本地计数；Nest adapter 的集群范围计数未在 Go 复刻，已在任务文档中列为已知边界。

## 配置与回滚

```dotenv
API_GO_NOTIFICATIONS_SOCKET_MODE=legacy   # 默认
NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH=/socket.io
```

切换：

1. `API_GO_NOTIFICATIONS_SOCKET_MODE=go`，启动/重启 api-go。
2. Web 以 `NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH=/socket.io-notifications` 重建。
3. 反向代理把 `/socket.io-notifications/` 路由到 api-go；`/socket.io/` 仍到 api。

回滚：把两个值改回 `legacy` / `/socket.io`，重建 Web 并重启；已有 Go 连接在关闭时 `disconnect(true)`，浏览器重连后回到 Nest。无数据迁移、无 Redis 清理。

## 验证状态

- 未在本机运行 `go build`/`go test`、Docker 或服务。
- 新增纯协议单测（包内）覆盖 CONNECT 解析、ping、EVENT 编码/`data` 原样、relay 校验；由现有普通 CI 执行。
- 真实浏览器连接、真实 Redis relay、跨实例顺序/重复、生产切流均未验证，不能据普通 CI 绿灯推断。
