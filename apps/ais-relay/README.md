# AIS Relay

`apps/ais-relay` 是一个独立的 AISStream 聚合服务。它把上游 WebSocket 报文归并成 HTTP 快照，供 `apps/api` 通过 `/ais/snapshot` 拉取，并通过 `/health` 暴露运行与降级状态。

## 接口

- `GET /healthz/live`
  - 无鉴权
  - 仅表示 relay HTTP 进程在线，可用于容器 liveness / startup probe
- `GET /health`
  - 无鉴权
  - 返回 `status: "ok" | "degraded"`
  - `diagnostics` 包含最近连接、收包、解析错误、忽略计数和降级原因
- `GET /ais/snapshot`
  - 需要 `Authorization: Bearer <AIS_RELAY_SHARED_SECRET>`，除非 relay 未配置共享密钥
  - 默认返回 `disruptions`、`density`、`vessels`
  - `?candidates=true` 时额外返回 `candidateReports`

## 健康状态

`/healthz/live` 的 HTTP `200` 只表示 relay 进程在线，适合 Docker / K8s 的容器探针。

`/health` 的 HTTP 状态码始终是 `200`，真正的运行态健康语义在响应体的 `status` 字段里。这里的 `degraded` 代表上游断流、停滞或解析质量问题，不应再阻止依赖服务启动。

`diagnostics.statusReasonCode` 的权威枚举与 API/Web 共享，定义在 `packages/utils/src/realtime-signals-contract.ts` 的 `AIS_RELAY_REASON_CODES` / `AisRelayReasonCode`。

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

确定性启动 smoke test：

```bash
pnpm docker:smoke:ais-relay-startup
```

这条脚本会：

- 用临时 Compose project 启动 `mock-ais-upstream`、`ais-relay`、`api`
- 把 relay 上游固定到一个“连上但不发消息”的本地 WebSocket mock
- 验证 relay `/health` 进入 `ais_upstream_no_messages_after_connect`
- 同时验证容器 health 仍然基于 `/healthz/live`，不会卡住 `api` 启动

## Go 版

Go 版 AIS relay 是 Node 版 `apps/ais-relay` 的**契约等价实现**：同一组环境变量、同样的 HTTP 路径、同样的 JSON 形状，区别只是运行时不再需要 Node。

- 代码位置：实现 `apps/api-go/internal/aisrelay`，命令入口 `apps/api-go/cmd/ais-relay`（与 api-go 同一个 Go module `github.com/wei500L/newwei/apps/api-go`）。
- 镜像定义：`infra/docker/ais-relay-go.Dockerfile`；运行阶段是 distroless 静态镜像，镜像内只有 `ais-relay` 一个二进制（无 node、无 npm、无 pnpm）。
- 环境变量与 Node 版同名同义：`AISSTREAM_API_KEY`（必填，缺失时进程启动即非零退出）、`AISSTREAM_URL`（及旧别名 `AIS_RELAY_UPSTREAM_URL`）、`AIS_RELAY_SHARED_SECRET`（及旧别名 `RELAY_SHARED_SECRET`）、`AIS_RELAY_PORT` / `PORT`（默认 `3004`）、`AIS_RELAY_HOST` / `HOST`（默认 `0.0.0.0`）、`AIS_RELAY_HEALTH_*` 阈值，以及 `AIS_SNAPSHOT_INTERVAL_MS`、`AIS_UPSTREAM_*`、`AIS_MAX_*` 等调优项。
- HTTP 契约与 Node 版一致：`GET /healthz/live`（容器探针）、`GET /health`（`status: ok | degraded` 与 `diagnostics`）、`GET /ais/snapshot`（`Authorization: Bearer <AIS_RELAY_SHARED_SECRET>`，`candidates=true` 时带 `candidateReports`）。
- 容器健康检查：`ais-relay healthcheck`（镜像与 compose 的 healthcheck 命令都用这个子命令，与 `api-go healthcheck` 一致），即对 `http://127.0.0.1:$PORT/healthz/live` 发 HTTP GET，HTTP `200` 退出 `0`，其余非 `0`。

### 运行（docker compose）

Go 版在 `go-pilot` profile 下，默认部署不会启动：

```bash
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml \
  --profile go-pilot build ais-relay-go
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml \
  --profile go-pilot up -d ais-relay-go
```

- 服务名：`ais-relay-go`；profile：`go-pilot`。
- 端口：宿主 `127.0.0.1:3005` → 容器 `3004`（默认 `${DOCKER_PUBLISH_HOST:-127.0.0.1}:${AIS_RELAY_GO_HOST_PORT:-3005}:3004`，宿主端口可用 `AIS_RELAY_GO_HOST_PORT` 覆盖）。Node 版 `ais-relay` 仍占宿主 `3004`，两个版本可并行运行。
- 容器内监听端口与 Node 版相同（`3004`），因此同一份 `infra/docker/.env` 同时驱动两个服务：`AISSTREAM_API_KEY`、`AIS_RELAY_SHARED_SECRET`、`AISSTREAM_URL` 与健康阈值都直接复用，没有新增变量名，也没有 `.env` 或密钥写进镜像。

### 切换到 Go 版与回滚

`apps/api-go`（以及 NestJS `apps/api`）通过 `REALTIME_SIGNALS_AIS_BASE_URL` 选择 relay 实现，默认仍指向 Node 版：

- 切换到 Go 版：把 `REALTIME_SIGNALS_AIS_BASE_URL` 改为 `http://ais-relay-go:3004`（同一 compose 网络内的服务名 + 容器端口），然后重启调用方（`api-go` 或 `api`，取决于当前哪一侧在采集 AIS 信号）。
- 回滚：把 `REALTIME_SIGNALS_AIS_BASE_URL` 改回 `http://ais-relay:3004`，重启调用方即可。relay 本身无持久化状态，不需要数据迁移，也不需要停掉或删除 Node 版。

本批不改变默认值：`infra/docker/.env` 的 `REALTIME_SIGNALS_AIS_BASE_URL` 仍是 Node 版 `http://ais-relay:3004`，Node 版 `apps/ais-relay` 与 `infra/docker/ais-relay.Dockerfile` 保持不变，也没有新增任何功能开关。
