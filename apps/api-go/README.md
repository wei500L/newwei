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
| `SHADOW_TIMEOUT_MS` | 2000 | shadow 差分单次执行超时（select 强制中止） |
| `SHADOW_MAX_REQUEST_BODY_BYTES` | 1048576 | 差分可重放的请求体上限（超过仍完整转发，只放弃差分） |
| `SHADOW_MAX_RESPONSE_CAPTURE_BYTES` | 1048576 | 响应差分旁录上限（超过停止旁录，主响应流式透传不变） |
| `SHADOW_MAX_INFLIGHT` | 16 | shadow 并发上限 |
| `SHADOW_MAX_PER_MINUTE` | 600 | shadow 每分钟预算（令牌桶 burst） |
| `SHADOW_DEBUG_BODY_LOG` | false | 差异记录是否保存截断正文（默认只记 sha256 hash） |
| `SHADOW_DEBUG_BODY_LOG_MAX_BYTES` | 2048 | debug 正文的截断长度上限 |
| `CANARY_PERCENT` | 0 | canary 分流比例（0=legacy，100=go；当前无 ModeCanary 路由） |
| `DATABASE_URL` | （空） | MySQL 连接（Prisma 同名同格式 `mysql://user:pass@host:port/db`）。仅供 user-settings 只读 shadow（onboarding / rss-reader / spacetime-timeline 三个 GET）的 MySQL 只读查询；**空/无效时网关照常启动并代理全部请求**（这些 shadow 单元跳过，`/__go/healthz` 报 `userSettingsShadow.database` 为 `unconfigured`/`invalid`；`configured` 只代表 DSN 已解析为 driver 配置——`sql.Open` 是惰性初始化，不承诺数据库可连接）。值本身不进入日志/healthz/错误文本 |

## 四态路由（当前路由表）

| 模式 | 当前路由 | 行为 |
|---|---|---|
| legacy | `/api/`、`/graphql`、`/socket.io/`、`/docs`、`/admin/queues` | 反向代理到 NestJS（事实源） |
| shadow | `/api/healthz/live`、`/api/user-settings/ui/onboarding`、`/api/user-settings/ui/rss-reader`、`/api/user-settings/ui/spacetime-timeline`（均仅 GET） | NestJS 响应 + Go 实现异步差分 |
| canary | （无） | 待鉴权基础设施接入的分流组件（见下） |
| go | `/__go/healthz` | Go 原生（网关自省） |

### user-settings 只读 shadow（第二/三个迁移单元，Go-批2A + 批2B）

- **范围**：仅三个确定性只读 GET——`/api/user-settings/ui/onboarding`
  （批2A）、`/api/user-settings/ui/rss-reader` 与
  `/api/user-settings/ui/spacetime-timeline`（批2B）。**其余三个 GET
  （situation-monitor / war-map / newsnow）与全部 PUT 保持 legacy**；
  不迁移写入路径。
- **行为**：客户端响应完全来自 NestJS；Go 在旁路真实读取 MySQL
  `UserSetting` 表（`orgId+userId+固定 key` 三条件参数化查询；三个端点
  共用同一 repository 的同一条查询，key 是编译期固定常量），并与
  NestJS 响应差分（normalization 契约逐字段对齐：RSS 的 trim/截断/
  稳定去重/严格布尔；spacetime 的枚举回退/浮点 clamp 不取整）。
- **legacy-approved shadow identity（信任边界）**：Go 尚未完成 JWT 验签、
  jti blacklist、membership 重推导与 RBAC。身份唯一来源是 legacy 信任
  委托——同一请求先由 NestJS 执行并返回 200（签名/权限全部通过），
  此时才从（未验签的）Bearer JWT payload 读取 `sub`/`orgId`，只用于本次
  只读查询。**不是「Go 已验证身份」**；不读取、不信任 `permissions`
  claim；NestJS 非 200（401/403/404/5xx）→ Go 零查询。
- **失败非阻断**：MySQL 未配置/不可达/超时、JSON 异常、限流/并发预算
  耗尽——都只跳过本次差分或形成结构化差分记录，客户端始终收到
  NestJS 原响应。
- **不能进入 canary/go**：在 Go 完成 Auth/RBAC（迁移序 5）前，这些端点
  保持 shadow；路由表被误改为 ModeCanary/ModeGo 时
  `cmd/api/main_test.go` 的状态契约测试会失败。
- **回滚**：`internal/legacyproxy/proxy.go` 中对应路由单条改回
  `ModeLegacy`——纯代码变更，无数据耦合（两个新端点回滚不影响
  onboarding shadow）。

### canary 的信任边界（重要）

当前分流的 orgId 取自**未验签**的 JWT payload claim，不是经过认证的组织
身份。`CANARY_PERCENT` 默认 0，**当前没有任何路由处于 ModeCanary**。
在 Go 侧完成真实 JWT 验签与 org membership 重推导（迁移序 5）之前，
受保护业务路由不得依赖该 claim 决定是否进入 Go——fail-safe 一律回
legacy。详见 `docs/refactor/api-go-four-mode.md`。

## 迁移一个路由（四态）

路由表在 `internal/legacyproxy/proxy.go` 的 `DefaultRules()`：

1. shadow 起步：把目标前缀改为 `ModeShadow`，在 `cmd/api/main.go` 的 dispatcher 里注册该路由的差分执行者；
2. 差分 0 失败后 canary：改为 `ModeCanary` + 调 `CANARY_PERCENT` 灰度（orgId 稳定哈希）；
3. 全量：改为 `ModeGo` 并 `RegisterGoHandler` 注册处理器；
4. 回滚 = 任意阶段改回 `ModeLegacy`（或 `CANARY_PERCENT=0`）——纯配置变更，无数据耦合。

## 验证

```bash
pnpm --filter @modular/api-go test    # 网关行为测试（四态/代理透传/go 路由/502/trace/shadow 预算/canary 哈希/user-settings 身份门禁与三端点契约）
pnpm --filter @modular/api-go lint    # go vet
pnpm --filter @modular/api-go build   # go build
```

MySQL 集成测试（Go-批2A 起步、批2B 扩展三个固定 key，本机禁跑——远端 CI
的 `api-go-user-settings-integration` job 使用固定版本 MySQL service 执行）：

```bash
cd apps/api-go && go test -tags=integration -count=1 ./internal/usersettings/
```

## 依赖清单（go.mod / go.sum）

`go.sum` 是 tracked file（Go-批2A 起有第三方依赖）。本仓库约束「生成器不在
本机执行」：

- 依赖变更时，给 PR 加 `go-modules-regen` label → CI 的 `go-modules-regen`
  job 远端运行 `go mod tidy` 并把 `go.mod`/`go.sum` 提交回 PR 分支；完成后
  移除 label。
- 平时 verify 的漂移门禁保持 fail-on-drift：go.sum 必须被跟踪、远端
  `go mod tidy` 后 `go.mod`/`go.sum` 零漂移。
- 集成 job 只用 `go mod download` 消费已提交的校验信息，不修改清单。

## 约束

- 标准库 + `github.com/go-sql-driver/mysql`（唯一第三方依赖，user-settings
  只读查询用）；不引入 Web 框架/ORM/DI 容器
- `migrations/` 在 Phase 1 禁止 schema 变更（见该目录 README）
- 契约以 `docs/refactor/api-contract-inventory.md` 为冻结基线；鉴权矩阵（`apps/api/tests/contract/auth-matrix.json`）驱动逐端点语义对齐
- shadow 只对 GET/HEAD/OPTIONS 差分——写请求禁止双发（双层强制：legacyproxy + shadow runner；user-settings shadow 单元进一步收窄为仅 GET）
