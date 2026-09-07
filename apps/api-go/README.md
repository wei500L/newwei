# api-go —— 主后端 Go 网关（Strangler Fig）

NestJS `apps/api` 的渐进替代入口。默认全部流量反向代理到 NestJS（`LEGACY_API_URL`，默认 `http://localhost:4000`）；已迁移路由按四态路由表分流。详细语义见 `docs/refactor/api-go-four-mode.md`。

Go-批3B 起，**user-settings 六个只读 GET**（`onboarding` / `rss-reader` / `spacetime-timeline` / `war-map` / `newsnow` / `situation-monitor`）在 pilot 中由统一 Go handler **真实接管**（`API_GO_USER_SETTINGS_READ_MODE=go`，见下文「user-settings 只读域 Go 接管」）：Go 独立 JWT 验签 + Redis blacklist + MySQL RBAC + 独立查库 + normalization + 全响应。六个 PUT 仍全部由 NestJS 单写。

## 运行

```bash
PORT=4020 LEGACY_API_URL=http://localhost:4000 go run ./cmd/api
curl http://localhost:4020/__go/healthz     # {"ok":true,"routes":[...],"shadow":{...},"canary":{...},"onboarding":{...},"userSettingsRead":{...}}
curl http://localhost:4020/api/healthz/live # shadow 态：NestJS 响应 + Go 异步差分
```

手工裸启（`API_GO_USER_SETTINGS_READ_MODE` 未设、`API_GO_ONBOARDING_MODE=shadow`）行为与批2C 完全一致——onboarding/rss/spacetime 仍是 shadow 差分，war-map/newsnow/situation-monitor 保持 legacy，无 JWT/Redis 依赖。

## 生产容器与真实入口（Go-批2C）

生产镜像 `infra/docker/api-go.Dockerfile`：多阶段构建（`go mod download` → `CGO_ENABLED=0 go build -mod=readonly -trimpath`），运行阶段 distroless static nonroot（无 shell/无源码/无工具链），与 vector-go 同款策略。二进制内置 `healthcheck` 子命令：

```text
/api-go healthcheck   # GET 127.0.0.1:$PORT/__go/healthz；2xx 退出 0，否则非 0
```

distroless 无 curl——不为探针安装任何东西；Dockerfile 的 `HEALTHCHECK` 指令与 compose 服务的 healthcheck 均用 exec 形式调用该子命令（字符串形式 health-cmd 会经 `/bin/sh` 执行，distroless 下必失败）。

### Compose pilot（api-go-pilot profile，默认不启动）

```bash
docker compose --env-file infra/docker/.env -f infra/docker/docker-compose.yml \
  --profile api-go-pilot up -d api-go
```

- 端口：容器 4020，host `${API_GO_HOST_PORT:-4020}`（默认只绑 `DOCKER_PUBLISH_HOST`，即 loopback）；
- `LEGACY_API_URL=http://api:4000`；`DATABASE_URL` 由与 NestJS 相同的 `MYSQL_*` 派生（同一真实 MySQL，不复制数据）；
- `API_GO_USER_SETTINGS_READ_MODE=go`（Go-批3B 统一读模式：pilot 明确接管六个 user-settings 只读 GET；优先级高于 `API_GO_ONBOARDING_MODE`，后者仍注入 `go` 保持批3A 兼容）+ 与 NestJS 同源的 `JWT_SECRET`/`JWT_ISSUER`/`JWT_AUDIENCE` 与 `REDIS_*`（blacklist 共享，不建第二套撤销名单）；
- `CANARY_PERCENT=0`、`SHADOW_DEBUG_BODY_LOG=false` 固定；
- 依赖 `api`（NestJS）与 `mysql`、`redis` 均 healthy；
- 默认 legacy 模式（`Web → api:4000`）不受影响——profile 服务不随普通 `up` 启动。

### 入口切换与回滚

- 服务端（运行期）：`infra/docker/.env` 的 `API_BASE_URL=http://api-go:4020` → `Web → api-go → NestJS`；web 启动等待自动改探 `http://api-go:4020/api/healthz/live`（不再硬编码 `api:4000`，兼容 base 带不带 `/api`）。
- 浏览器端（构建期）：`NEXT_PUBLIC_API_BASE_URL=http://<host>:4020/api` 重建 web 镜像。
- 回滚（可组合）：① `API_GO_USER_SETTINGS_READ_MODE=shadow`——六个 user-settings GET 全部回到 NestJS 响应 + Go 差分（或删除该变量回到兼容行为：onboarding 由 `API_GO_ONBOARDING_MODE` 控制、rss/spacetime shadow、其余 legacy——批3A 及更早行为）；② `API_BASE_URL` 指回 `http://api:4000`（+ 按原值重建 web）；③ `--profile api-go-pilot down` 停 pilot。无数据迁移耦合——全部 user-settings PUT 始终由 NestJS 单写。

### 远端真实栈 smoke（`api-go-entry-smoke` workflow）

手动触发，不进 push/synchronize 普通 CI。主路径 `workflow_dispatch`（workflow 在默认分支注册后 `gh workflow run`）；PR 期间用 label `api-go-entry-smoke` 显式触发（与 ci.yml 的 regen label 门禁同一模式），运行后移除 label。真实 MySQL/Redis/Mongo service 容器 + 真实 `prisma migrate deploy` + 真实 NestJS 进程 + 构建并启动本 Dockerfile 的 api-go 容器（两阶段：先 `API_GO_USER_SETTINGS_READ_MODE=shadow`，后重启为 `go`）。

Go-批3B 起的四阶段验收（全部经 api-go 入口 + 真实登录 JWT）：

- **Phase A（写入准备）**：六个 PUT（含 situation-monitor 一次写入 monitors/layout/settings 三段）由 NestJS 单写 → MySQL 直查确认 8 个固定 key 均真实存在 → PUT 前后 shadow executed 不增加 → 相似路径（onboarding-x / war-map-x / newsnow/other）不误命中。
- **Phase B（shadow 对比）**：`readMode=shadow` 启动——六个 GET 都由 NestJS 响应，Go 做真实旁路查询与差分：executed 精确 +6（+healthz/live 共 +7）、diffs 零增量、六类 dropped 零增量、inflight 归零——不通过删除字段、宽松比较制造零差异。
- **Phase C（Go 接管）**：`readMode=go` 重启真实容器——六个 GET 与 NestJS 直连逐字段契约对比（status/`Cache-Control: no-store`/content-type/JSON 全等、各端点读自己的 key、situation-monitor 三段 updatedAt 对应正确）；Go 请求不增加 shadow.executed。
- **Phase D（独立性证明）**：停止 NestJS 并确认端口 4000 不可用——六个 GET 仍全部 200（数据是 Phase A 真实持久化的）；代表性 PUT（war-map）返回 502（写路径未迁入 Go）；未迁移 GET（/api/items）返回 502（api-go 不伪装成功）；api-go healthcheck 保持健康。

共享鉴权链负向用例保留代表性端点（onboarding）：数据库无 `items.read`（JWT claim 仍有）双端 403 契约一致 → membership 停用双端 401 同文案 → 篡改签名与 alg=none 拒绝 → 真实 logout 写入真实 Redis blacklist → 撤销 token 401 "Access token revoked"。

**验证状态分层**：静态代码与单元/MySQL+Redis 集成测试由普通 CI 远端验证；真实入口链（容器 + 真实 NestJS + 真实登录 + Go 鉴权链 + Shadow 指标增量）由 `api-go-entry-smoke` 远端真实栈运行验证完成；**生产/预发布真实流量验证未完成**（api-go 未接入任何生产入口）。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 4020 | 网关监听端口 |
| `LEGACY_API_URL` | http://localhost:4000 | NestJS apps/api 基址 |
| `API_GO_USER_SETTINGS_READ_MODE` | （空） | user-settings 六个只读 GET 的统一读模式（Go-批3B）：`shadow`=六个 GET 全部 NestJS 响应 + Go 差分；`go`=六个 GET 全部由统一 Go handler 接管（独立鉴权 + 独立查库 + normalization + 全响应）。**设置时优先级高于 `API_GO_ONBOARDING_MODE`**（onboarding 也归它管）；**未设置（空）=兼容旧行为**：onboarding 由 `API_GO_ONBOARDING_MODE` 控制，rss/spacetime 保持 shadow，war-map/newsnow/situation-monitor 保持 legacy（批3B 之前的部署不变）。非法值启动失败；`go` 模式要求 `JWT_SECRET`/`DATABASE_URL`/`REDIS_HOST` 齐备（缺失启动失败）。compose pilot 固定注入 `go`。回滚 = 改回 `shadow` 或删除本变量 |
| `API_GO_ONBOARDING_MODE` | shadow | onboarding GET 迁移单元模式（Go-批3A 兼容变量）：`shadow`（默认，批2A/2B 行为——NestJS 响应 + Go 差分）或 `go`（Go 独立鉴权 + 全响应）。仅在 `API_GO_USER_SETTINGS_READ_MODE` 未设置时生效。非法值启动失败；`go` 模式依赖同上；compose pilot 固定注入 `go`（批3A 部署等价） |
| `JWT_SECRET` | （空） | NestJS access token 的 HMAC 验签 secret（与 api 服务同一值）。仅 `go` 模式必填。值不进入日志/healthz/错误文本 |
| `JWT_ISSUER` | modular-monolith | 与 NestJS env schema 同默认值；`go` 模式下用于验签 |
| `JWT_AUDIENCE` | modular-monolith-clients | 同上 |
| `REDIS_HOST` | （空） | access-token blacklist 所用 Redis（与 api 服务同一实例）。仅 `go` 模式必填 |
| `REDIS_PORT` | 6379 | Redis 端口 |
| `REDIS_USERNAME` / `REDIS_PASSWORD` | （空） | Redis 凭据（可选，镜像 NestJS 语义）；不进入日志/healthz/错误文本 |
| `REDIS_DB` | 0 | Redis DB 编号 |
| `SHADOW_TIMEOUT_MS` | 2000 | shadow 差分单次执行超时（select 强制中止） |
| `SHADOW_MAX_REQUEST_BODY_BYTES` | 1048576 | 差分可重放的请求体上限（超过仍完整转发，只放弃差分） |
| `SHADOW_MAX_RESPONSE_CAPTURE_BYTES` | 1048576 | 响应差分旁录上限（超过停止旁录，主响应流式透传不变） |
| `SHADOW_MAX_INFLIGHT` | 16 | shadow 并发上限 |
| `SHADOW_MAX_PER_MINUTE` | 600 | shadow 每分钟预算（令牌桶 burst） |
| `SHADOW_DEBUG_BODY_LOG` | false | 差异记录是否保存截断正文（默认只记 sha256 hash） |
| `SHADOW_DEBUG_BODY_LOG_MAX_BYTES` | 2048 | debug 正文的截断长度上限 |
| `CANARY_PERCENT` | 0 | canary 分流比例（0=legacy，100=go；当前无 ModeCanary 路由） |
| `DATABASE_URL` | （空） | MySQL 连接（Prisma 同名同格式 `mysql://user:pass@host:port/db`）。user-settings 只读 shadow（六个 GET 的旁路查询）+ `go` 模式下 authz RBAC 重推导与业务查询共用同一连接池。shadow 模式下**空/无效时网关照常启动并代理全部请求**（shadow 单元跳过，`/__go/healthz` 报 `userSettingsRead.database` 为 `unconfigured`/`invalid`；`configured` 只代表 DSN 已解析为 driver 配置——`sql.Open` 是惰性初始化，不承诺数据库可连接）；`go` 模式下必填且 DSN 无效启动失败。值本身不进入日志/healthz/错误文本 |

## 四态路由（当前路由表）

路由匹配（Go-批3A 起）：**迁移单元 = exact path + method 白名单**（`/api/user-settings/ui/onboarding-x`、`onboarding/other` 等相似路径回落 legacy，绝不误命中；PUT/POST 等不匹配方法回落 `/api/` legacy 由 NestJS 处理——写方法永远 NestJS 单写）；**通用 fallback 规则 = 前缀匹配 + 任意方法**（既有语义不变）。

| 模式 | 当前路由 | 行为 |
|---|---|---|
| legacy | `/api/`、`/graphql`、`/socket.io/`、`/docs`、`/admin/queues`（含六个 user-settings GET 的 PUT/相似路径、其余全部未迁移端点） | 反向代理到 NestJS（事实源） |
| shadow | `/api/healthz/live`（exact + 仅 GET）；六个 user-settings GET 的模式由 `API_GO_USER_SETTINGS_READ_MODE` 决定：`shadow` 时全部 shadow；未设置时 onboarding（`API_GO_ONBOARDING_MODE=shadow` 默认）与 rss-reader/spacetime-timeline shadow，war-map/newsnow/situation-monitor legacy | NestJS 响应 + Go 实现异步差分 |
| canary | （无） | 待鉴权基础设施接入的分流组件（见下） |
| go | `/__go/healthz`；六个 `/api/user-settings/ui/{onboarding,rss-reader,spacetime-timeline,war-map,newsnow,situation-monitor}`（均 exact + 仅 GET）在 `API_GO_USER_SETTINGS_READ_MODE=go` 时——**user-settings 只读域 Go 全响应** | Go 原生（前者网关自省；后者统一 usersettingsread handler：独立鉴权 + 独立查库 + normalization + 响应） |

### user-settings 只读域 Go 接管（Go-批3B，统一六端点）

`API_GO_USER_SETTINGS_READ_MODE=go` 时，六个只读 GET 的完整请求链由 Go 独立完成——不请求 NestJS、不等待 legacy 200、不使用 `LegacyApprovedIdentity`（Go-批3A 曾以 `API_GO_ONBOARDING_MODE=go` 单独接管 onboarding；批3B 起收敛为统一 handler `internal/usersettingsread`，旧 `internal/onboarding` 已删除）：

```text
提取 Bearer（拒绝 mtk_ 机器令牌）
→ JWT 验签（internal/authn：仅 HS256、issuer/audience/exp/nbf 按 jsonwebtoken
  语义、sub/orgId 非空；拒绝 alg=none/HS384/算法混淆；不读 permissions claim）
→ Redis blacklist（internal/authn：access-token:blacklist:<jti>，与 NestJS 同一
  Redis 同一 key；jti 缺失按 NestJS 当前语义放行；查询失败 fail-closed 500）
→ MySQL membership/user/permission 重推导（internal/authz：复用同一 *sql.DB；
  User/Org/Membership active 校验与 getUserProfile 同序同文案 401；
  MembershipRole 多角色优先、空则 primary role 回退；权限名 RolePermission→
  Permission 去重）
→ items.read 判定（usersettingsread：数据库推导的权限集；JWT claim 不参与）
→ 固定 UserSetting 查询（usersettings repository：五个单 key 端点各查一个
  编译期固定 key；situation-monitor 一次聚合查询三个固定 key）
→ normalization（usersettings：六个端点各自的 Build*Response——含批3B 完整
  移植的 war-map-contract / situation-monitor / newsnow 契约）
→ Go 写出响应（internal/authhttp 契约等价错误；200 带 Cache-Control: no-store）
```

- **错误契约**：与 NestJS `GlobalExceptionFilter` 逐字段对齐——JWT 层失败 401 `{"message":"Unauthorized"}`；撤销 401 `"Access token revoked"`；user/org/membership 状态拒绝 401 同文案（`"Organization disabled"` 等）；缺权限 403 `INSUFFICIENT_PERMISSIONS`（any 模式：`detail="Requires any permission: items.read"`，无 `missingPermissions`）；Redis 故障 fail-closed 500、MySQL 故障 fail-closed 503（均通用 `"Internal server error"`，对齐 NestJS 生产环境非 HttpException 路径）。
- **边界**：仅六个只读 GET。登录/refresh/logout/MFA/OIDC/机器令牌仍全部由 NestJS 承载；六个 PUT 与全部其他写请求纯代理 NestJS（exact path + method 白名单：PUT/POST/HEAD 同路径与相似路径回落 legacy）。
- **`/__go/healthz`**：`userSettingsRead.mode` 如实展示当前读模式（空/`shadow`/`go`）、`userSettingsRead.database` 只报 `unconfigured`/`invalid`/`configured`；`go` 模式下六个 GET 不再增加 `shadow.executed`。
- **回滚**：`API_GO_USER_SETTINGS_READ_MODE=shadow`（全部六端点回到 NestJS 响应 + Go 差分）或删除该变量（兼容：onboarding 由 `API_GO_ONBOARDING_MODE` 控制、其余端点回到批3B 前去向）——配置变更，无数据迁移耦合。

### user-settings 只读 shadow（差分阶段，Go-批2A/2B 起步、批3B 扩展）

- **范围**：六个只读 GET 都可处于 shadow（`API_GO_USER_SETTINGS_READ_MODE=shadow`
  时六端点全部 shadow；未设置时 onboarding/rss/spacetime shadow、其余三
  个 legacy——批3B 前的兼容行为）。全部 PUT 始终 legacy（不迁移写入路径）。
- **行为**：客户端响应完全来自 NestJS；Go 在旁路真实读取 MySQL
  `UserSetting` 表（五个单 key 端点 `orgId+userId+固定 key` 三条件参数化
  查询共用同一条私有 SQL；situation-monitor 一次聚合查询三个固定 key，
  对齐 NestJS findMany 语义），并与 NestJS 响应差分（normalization 契约
  逐字段对齐——含批3B 的 war-map 46 layer/legacy key/clamp、newsnow
  有序对象/上限/真值、situation-monitor 三段聚合）。
- **legacy-approved shadow identity（信任边界）**：shadow 是回滚兼容路径，
  不是 Go 的独立鉴权。身份来源是 legacy 信任委托——同一请求先由
  NestJS 执行并返回 200（签名/权限全部通过），此时才从（未验签的）
  Bearer JWT payload 读取 `sub`/`orgId`，只用于本次只读查询。**不是
  「Go 已验证身份」**；不读取、不信任 `permissions` claim；NestJS 非 200
  （401/403/404/5xx）→ Go 零查询。Go 模式（`usersettingsread`）完全不
  经过该身份——但 shadow 回滚能力依赖它，`shadowidentity` 包因此保留。
- **失败非阻断**：MySQL 未配置/不可达/超时、JSON 异常、限流/并发预算
  耗尽——都只跳过本次差分或形成结构化差分记录，客户端始终收到
  NestJS 原响应。
- **回滚**：`API_GO_USER_SETTINGS_READ_MODE=shadow`（六端点全部回 shadow）
  或未设置（兼容行为）——配置变更；路由级单条改回 `ModeLegacy` 亦可
  （纯代码变更，无数据耦合）。

### canary 的信任边界（重要）

当前分流的 orgId 取自**未验签**的 JWT payload claim，不是经过认证的组织
身份。`CANARY_PERCENT` 默认 0，**当前没有任何路由处于 ModeCanary**。
在 Go 侧完成真实 JWT 验签与 org membership 重推导（迁移序 5）之前，
受保护业务路由不得依赖该 claim 决定是否进入 Go——fail-safe 一律回
legacy。详见 `docs/refactor/api-go-four-mode.md`。

## 迁移一个路由（四态）

路由表在 `internal/legacyproxy/proxy.go` 的 `DefaultRules(onboardingMode, readMode)`（迁移单元 = exact path + method 白名单；fallback = 前缀匹配）：

1. shadow 起步：把目标单元改为 `ModeShadow`（exact + method 白名单），在 `cmd/api/main.go` 的 dispatcher 里注册该路由的差分执行者；
2. 差分 0 失败后 canary：改为 `ModeCanary` + 调 `CANARY_PERCENT` 灰度（orgId 稳定哈希——注意当前分流依据仍是未验签 claim，见下）；
3. 全量：改为 `ModeGo` 并 `RegisterGoHandler` 注册处理器（前置件：该路由的 Go 侧鉴权链已落地——参照 Go-批3A 的 authn/authz/authhttp）；
4. 回滚 = 任意阶段改回 `ModeLegacy`（或 `CANARY_PERCENT=0` / 单元模式配置）——纯配置变更，无数据耦合。

## 验证

```bash
pnpm --filter @modular/api-go test    # 网关行为测试（四态/代理透传/go 路由/502/trace/shadow 预算/canary 哈希/user-settings 身份门禁与三端点契约）
pnpm --filter @modular/api-go lint    # go vet
pnpm --filter @modular/api-go build   # go build
```

MySQL + Redis 集成测试（Go-批2A 起步、批2B/批3B 扩展到八个固定 key 与
situation-monitor 三记录聚合、批3A 增加 authz RBAC 重推导与 authn
blacklist，本机禁跑——远端 CI 的 `api-go-user-settings-integration` job
使用固定版本 MySQL + Redis service 执行）：

```bash
cd apps/api-go && go test -tags=integration -count=1 \
  ./internal/usersettings/ ./internal/authz/ \
  -run 'TestUserSettingsMySQLIntegration|TestAuthZMySQLIntegration' -v
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

- 标准库 + 三个第三方依赖：`github.com/go-sql-driver/mysql`（MySQL 查询）、
  `github.com/golang-jwt/jwt/v5`（access token 验签——不手写密码学）、
  `github.com/redis/go-redis/v9`（blacklist 查询）；不引入 Web 框架/ORM/DI
  容器
- `migrations/` 在 Phase 1 禁止 schema 变更（见该目录 README）
- 契约以 `docs/refactor/api-contract-inventory.md` 为冻结基线；鉴权矩阵（`apps/api/tests/contract/auth-matrix.json`）驱动逐端点语义对齐
- shadow 只对 GET/HEAD/OPTIONS 差分——写请求禁止双发（双层强制：legacyproxy + shadow runner；user-settings shadow 单元进一步收窄为仅 GET）
