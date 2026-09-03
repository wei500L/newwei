# api-go —— 主后端 Go 网关（Strangler Fig）

NestJS `apps/api` 的渐进替代入口。默认全部流量反向代理到 NestJS（`LEGACY_API_URL`，默认 `http://localhost:4000`）；已迁移路由按四态路由表分流。详细语义见 `docs/refactor/api-go-four-mode.md`。

## 运行

```bash
PORT=4020 LEGACY_API_URL=http://localhost:4000 go run ./cmd/api
curl http://localhost:4020/__go/healthz     # {"ok":true,"routes":[...],"shadow":{...},"canary":{...}}
curl http://localhost:4020/api/healthz/live # shadow 态：NestJS 响应 + Go 异步差分
```

### 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 4020 | 网关监听端口 |
| `LEGACY_API_URL` | http://localhost:4000 | NestJS apps/api 基址 |
| `SHADOW_TIMEOUT_MS` | 2000 | shadow 差分单次执行超时 |
| `SHADOW_MAX_BODY_BYTES` | 1048576 | shadow 请求体上限（超出丢弃差分） |
| `SHADOW_MAX_INFLIGHT` | 16 | shadow 并发上限 |
| `SHADOW_MAX_PER_MINUTE` | 600 | shadow 每分钟预算（令牌桶） |
| `CANARY_PERCENT` | 0 | canary 分流比例（0=legacy，100=go，orgId 稳定哈希分桶） |

## 四态路由（当前路由表）

| 模式 | 当前路由 | 行为 |
|---|---|---|
| legacy | `/api/`、`/graphql`、`/socket.io/`、`/docs`、`/admin/queues` | 反向代理到 NestJS（事实源） |
| shadow | `/api/healthz/live` | NestJS 响应 + Go 实现异步差分（首个迁移单元） |
| canary | （无） | orgId 稳定哈希分流，`CANARY_PERCENT` 控制 |
| go | `/__go/healthz` | Go 原生（网关自省） |

## 迁移一个路由（四态）

路由表在 `internal/legacyproxy/proxy.go` 的 `DefaultRules()`：

1. shadow 起步：把目标前缀改为 `ModeShadow`，在 `cmd/api/main.go` 的 dispatcher 里注册该路由的差分执行者；
2. 差分 0 失败后 canary：改为 `ModeCanary` + 调 `CANARY_PERCENT` 灰度（orgId 稳定哈希）；
3. 全量：改为 `ModeGo` 并 `RegisterGoHandler` 注册处理器；
4. 回滚 = 任意阶段改回 `ModeLegacy`（或 `CANARY_PERCENT=0`）——纯配置变更，无数据耦合。

## 验证

```bash
pnpm --filter @modular/api-go test    # 网关行为测试（四态/代理透传/go 路由/502/trace/shadow 预算/canary 哈希）
pnpm --filter @modular/api-go lint    # go vet
pnpm --filter @modular/api-go build   # go build
```

## 约束

- 纯标准库，不引入 Web 框架（路由表足够小）
- `migrations/` 在 Phase 1 禁止 schema 变更（见该目录 README）
- 契约以 `docs/refactor/api-contract-inventory.md` 为冻结基线；鉴权矩阵（`apps/api/tests/contract/auth-matrix.json`）驱动逐端点语义对齐
- shadow 只对 GET/HEAD/OPTIONS 差分——写请求禁止双发（双层强制：legacyproxy + shadow runner）
