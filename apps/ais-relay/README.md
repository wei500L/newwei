# AIS Relay

`apps/ais-relay` 是一个独立的 AISStream 聚合服务。它把上游 WebSocket 报文归并成 HTTP 快照，供 `apps/api` 通过 `/ais/snapshot` 拉取，并通过 `/health` 暴露运行与降级状态。

## 接口

- `GET /health`
  - 无鉴权
  - 返回 `status: "ok" | "degraded"`
  - `diagnostics` 包含最近连接、收包、解析错误、忽略计数和降级原因
- `GET /ais/snapshot`
  - 需要 `Authorization: Bearer <AIS_RELAY_SHARED_SECRET>`，除非 relay 未配置共享密钥
  - 默认返回 `disruptions`、`density`、`vessels`
  - `?candidates=true` 时额外返回 `candidateReports`

## 健康状态

`/health` 的 HTTP 状态码始终是 `200`，真正的健康语义在响应体的 `status` 字段里。Docker Compose 里的健康检查已经按 `status === "ok"` 判定。

常见 `diagnostics.statusReasonCode`：

- `ais_upstream_disconnected`
- `ais_upstream_no_messages_after_connect`
- `ais_upstream_stalled`
- `ais_position_reports_not_retained`
- `ais_position_reports_mostly_ignored`
- `ais_payload_parse_errors`

## 环境变量

上游与服务本身：

- `AISSTREAM_API_KEY`
  - 必填。缺失时进程启动即失败。
- `AISSTREAM_URL`
  - 可选。默认是 `wss://stream.aisstream.io/v0/stream`。
  - 适合 smoke test、内网代理或录制回放。
- `AIS_RELAY_UPSTREAM_URL`
  - 兼容旧别名。新配置优先使用 `AISSTREAM_URL`。
- `AIS_RELAY_PORT`
  - relay 对外 HTTP 端口，默认 `3004`。
- `AIS_RELAY_SHARED_SECRET`
  - `/ais/snapshot` 的 Bearer 鉴权密钥。

健康阈值：

- `AIS_RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS`
  - WebSocket 已建立但长时间没有任何上游消息时，转为 `degraded`。
- `AIS_RELAY_HEALTH_STALE_MESSAGES_MS`
  - WebSocket 仍保持打开但消息流停滞时，转为 `degraded`。
- `AIS_RELAY_HEALTH_MIN_POSITION_REPORTS`
  - 进入“保留失败/忽略比例/解析错误”判定前的最小样本数。
- `AIS_RELAY_HEALTH_MAX_IGNORED_RATIO_PERCENT`
  - 位置报文被忽略的最大容忍比例。
- `AIS_RELAY_HEALTH_MAX_PARSE_ERROR_RATIO_PERCENT`
  - 上游 payload 解析错误的最大容忍比例。

API 访问 relay 需要同步配置：

- `REALTIME_SIGNALS_AIS_BASE_URL`
- `REALTIME_SIGNALS_AIS_SHARED_SECRET`

修改根目录 `.env` 或 `infra/docker/.env` 后，建议执行：

```bash
pnpm --filter infra-scripts run env:check
```

当前检查会覆盖 AIS relay 的 base URL、共享密钥、上游地址和健康阈值格式。

## 本地运行

```bash
pnpm --filter @modular/ais-relay build
AISSTREAM_API_KEY=... \
AIS_RELAY_SHARED_SECRET=... \
pnpm --filter @modular/ais-relay run start
```

## Docker

relay 使用专用镜像定义：

- Dockerfile: `infra/docker/ais-relay.Dockerfile`
- Compose service: `infra/docker/docker-compose.yml`

构建与启动：

```bash
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml build ais-relay
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml up -d ais-relay
```

如果要做确定性 smoke test，可以把 `AISSTREAM_URL` 指向一个本地 mock WebSocket upstream。
