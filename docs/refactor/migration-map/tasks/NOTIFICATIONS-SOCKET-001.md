# NOTIFICATIONS-SOCKET-001 · 通知 Socket.IO 传输迁移（notifications namespace）

- 状态：pr_open（实现与普通 CI 结果在 PR 中回填）
- 分支：`refactor/go-notifications-socket`
- worktree：`/Users/oo/project/newwei-go-notifications-socket`
- 基线：`origin/main d42277219bc4bd5f63113a178d9114b4ef332091`（PR #114 合并后的 main）
- 开关：`API_GO_NOTIFICATIONS_SOCKET_MODE`，空串/`legacy` 默认 legacy，只有 `go` 接管；其他值启动失败。
- 入口：Go 只在独立路径 `/socket.io-notifications` 接受 Engine.IO v4 + Socket.IO v5 的 WebSocket 升级；`/socket.io` 与其他 namespace 仍由 NestJS 提供。Web 构建参数 `NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH` 默认 `/socket.io`，go 模式改为 `/socket.io-notifications`。

## 范围

1. `/notifications` namespace 的握手、JWT 验签、Redis blacklist、MySQL membership/权限重推导、连接限速/失败退避、Origin 白名单、每用户/每 IP 本地连接上限。
2. `notification` 事件推送；`notification:error`、`notification:connected` 与 `disconnect(true)` 的 Socket.IO 语义。
3. 四类标识符-only Redis relay：
   - `notification:events:v1`（Nest `NotificationsService.notify` 在 go 模式发布）；
   - `alert:notifications:v1`；
   - `analysis:notification:v1`；
   - `user-digest:notifications:v1`。
4. B1 本地推送：Go 只遍历本进程 socket，不经过 Socket.IO Redis adapter，避免每个实例重复推送。
5. B2 复核：收到 relay 后按 `id + orgId (+ userId)` 重读 Notification 行，并复核 type/presentation；不信任 relay 里的展示数据。
6. 30 秒 token 复核：过期或 jti 进入 blacklist 时发送 `41/notifications,` 并关闭底层连接（`disconnect(true)`）；Redis 异常保持连接（与 Nest 一致）。

## 明确不迁

- 其他 Socket.IO namespace（queue/ops/quality/situation-monitor/newsnow）。
- Engine.IO polling、binary attachment、ack、Socket.IO Redis adapter。
- 通知的业务创建（Nest 业务仍写 Notification 行；本批只接管实时传输与推送）。
- 专用 smoke；验证走现有普通 CI。

## 契约证据

- Nest 事实源：`apps/api/src/modules/notifications/notifications.gateway.ts`、`notifications.service.ts`、`notification.dispatcher.ts`、`websocket/*`、`cache/rate-limiter.service.ts`、`common/cors/cors-origin.ts`。
- 客户端：`apps/web/app/(app)/components/use-notification-stream.ts`（已强制 `transports: ["websocket"]`，因此 Go 只需 WebSocket 子集）。
- Go 复用：`authn.Verifier`、`authn.RedisBlacklist`、`authz.Repository`、`cors.Policy`、共享 MySQL/Redis 句柄。
- 事件 shape 与 `NotificationEvent` 逐字段对齐；`data` 用 `json.RawMessage` 原样透传，避免重排/丢字段。

## 已知边界

- 连接上限按 Go 实例本地统计；Nest Socket.IO Redis adapter 的 `allSockets()` 是集群范围。多实例下每个 Go 实例各自允许上限，PR 中如实记录，未声称与 Nest 的集群计数完全等价。
- 真实浏览器握手、真实 Redis relay、多实例重复/顺序、生产切流均未在本机验证；由普通 CI 的编译/单测和上线前联调覆盖。
- 未运行 `go build`/`go test`/Docker/服务，本机只做静态检查与 `gofmt`。
