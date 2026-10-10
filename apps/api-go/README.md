# api-go —— 主后端 Go 网关（Strangler Fig）

NestJS `apps/api` 的渐进替代入口。默认全部流量反向代理到 NestJS（`LEGACY_API_URL`，默认 `http://localhost:4000`）；已迁移路由按四态路由表分流。详细语义见 `docs/refactor/api-go-four-mode.md`。

Go-批3B 起，**user-settings 六个只读 GET** 在 pilot 中由统一 Go handler 接管（`API_GO_USER_SETTINGS_READ_MODE=go`）。Go-批3C 起，**同一六个 PUT** 在 `API_GO_USER_SETTINGS_WRITE_MODE=go` 时由 Go 写入现有 `UserSetting` 并重读返回；该变量默认 `legacy`，且 `go` 要求读模式同为 `go`。登录、refresh、logout、MFA、OIDC、机器令牌仍是 NestJS。

Go-批4A 起，**公开首页与频道**在 `API_GO_PUBLIC_PORTAL_MODE=go` 时由 Go 查 MySQL 并完整响应（匿名，不走 JWT/RBAC）。Go-批4B 起，同一开关再接管 `GET /api/public-portal/stories/id/:id` 与 `stories/slug/:slug`（各恰好一个路径段，仅 GET）。默认 `legacy`，生产入口仍是 Web → NestJS。缓存命中的故事详情已在真实栈验证；缓存缺失时调用真实模型网关并写回新 brief 已实现，尚未真实调用模型。启用 `go` 前应确认模型网关配置可用。回滚：`API_GO_PUBLIC_PORTAL_MODE=legacy`。public-portal 没有整模块迁完。

Go-批5A 起，**`GET /api/dashboard/stats`** 在 `API_GO_DASHBOARD_STATS_MODE=go` 时由 Go 独立响应：验签后的 orgId 与 `items.read` 来自 MySQL 重推导，再读 `ItemMeta` 计数、Mongo `processeditems` / `tasklogs`，以及 Redis 里已有的组织队列计数。默认 `legacy`。不启动队列 worker，不写 Redis 计数。MySQL 或 Mongo 失败返回 5xx，不用 0 代替。Redis 计数读失败时 `queueCountsAvailable=false` 且五个计数为 0。回滚：`API_GO_DASHBOARD_STATS_MODE=legacy`。其他 dashboard 路径仍是 NestJS。

Go-批5B 起，**三个只读图表 GET** 在 `API_GO_DASHBOARD_CHARTS_MODE=go` 时由 Go 独立响应：`GET /api/dashboard/sector-heatmap`、`GET /api/dashboard/financial-candlestick`、`GET /api/dashboard/war-map/geojson`。三条都验签并重推导 `dashboards.read`，即使 GeoJSON 是静态文件也不能匿名访问。热力图和 K 线读真实 MySQL `EconomicDataItem` / `EconomicDataPoint`（`economic-short` 最多 8 格，K 线固定 `sp500_index`）。GeoJSON 使用编译进二进制的 `world.geo.json`，请求时不访问 NestJS 或外网。日期查询与 NestJS 相同：ISO 校验、缺省 30 天、UTC 日边界。默认 `legacy`。这个开关不改变 `GET /api/dashboard/stats`，也不接管 war-map 的 layers/transport-detail、spacetime 或 `/api/dashboard/stream`。events 与 news-markers 见批5C。回滚：`API_GO_DASHBOARD_CHARTS_MODE=legacy`。

Go-批5C 起，**两个 War Map GET** 在 `API_GO_DASHBOARD_WAR_MAP_MODE=go` 时由 Go 独立响应：`GET /api/dashboard/war-map/events` 与 `GET /api/dashboard/war-map/news-markers`。两条都验签并重推导 `dashboards.read`。orgId 只来自 membership，并贯穿 MySQL、Mongo 和 Redis 缓存键。events 读该组织时间范围内的 `AlertEvent` 和有位置的 `ProcessedArticle`；news-markers 读 `ProcessedArticle` 及其 `Article`。只有 MySQL 新闻结果为空时才回退 Mongo `processeditems`（标记还会读 `rawitems` 的 URL）。日期不按 UTC 整日对齐。新闻标记会走已有地理缓存、最多 3 次 Nominatim，失败后用国家中心点。`translate=zh-CN` 使用 SystemSetting 里的翻译配置和 `SITUATION_MONITOR_TRANSLATION_*`；没有凭据或调用失败时省略中文字段，请求仍然成功。默认 `legacy`。启用 `go` 前需要 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。layers、transport-detail、stream 不在这个开关里。回滚：`API_GO_DASHBOARD_WAR_MAP_MODE=legacy`。

Go-批5D 起，**transport-detail** 与 **layers** 各有独立开关，默认都是 `legacy`。`API_GO_DASHBOARD_WAR_MAP_TRANSPORT_MODE=go` 只接管精确 `GET /api/dashboard/war-map/transport-detail`：验签并重推导 `dashboards.read`，orgId 只来自 membership，从 Mongo `MapTransportObjectState` / `MapTransportTrackPoint` 读该组织对象。范围内没有轨迹才回退该对象最近轨迹。对象不存在时 `detail` 为 null。`API_GO_DASHBOARD_WAR_MAP_LAYERS_MODE=go` 只接管精确 `GET /api/dashboard/war-map/layers`：静态图层在 Go 内生成，动态图层复用批5C 的 events/news 查询，不回调 NestJS。military 航班读该组织 Redis ADS-B 快照；AIS 读该组织 AIS 快照和 source state。`flightMode=all` 走现有 OpenSky viewport、配置和信用预算，不新开采集 worker。`translate=zh-CN` 复用当前翻译配置，失败则省略中文字段。这两个开关都不改变 events/news-markers，也不接管 `/api/dashboard/stream`。spacetime 见批6A。回滚分别把对应变量改回 `legacy`。

Go-批6A 起，**Spacetime 热力图**与**传播图**各有独立开关，默认都是 `legacy`。`API_GO_DASHBOARD_SPACETIME_GEO_MODE=go` 只接管精确 `GET /api/dashboard/spacetime/geo-heatmap` 和 `GET /api/dashboard/spacetime/geo-heatmap/articles`。`API_GO_DASHBOARD_SPACETIME_PROPAGATION_MODE=go` 只接管精确 `GET /api/dashboard/spacetime/propagation` 和 `GET /api/dashboard/spacetime/propagation/articles`。四条都验签并重推导 `dashboards.read`，orgId 只来自 membership。日期按 UTC 整日对齐，不使用 War Map 的非整日范围。热力图读该组织有地点的 `ProcessedArticle`，Mongo 只补充情感；snapshot 写入 `dashboard:spacetime:geo-heatmap:snapshot:<orgId>:<id>`，TTL 一小时，并可被 NestJS 读回。传播图读 `NewsEventItem` 及关联文章，返回节点和传播边。MySQL 失败是 500，不是空数组。这两个开关不改变 stats、图表、War Map 或 `/api/dashboard/stream`。回滚：把对应变量改回 `legacy`。外部地理解析沿用已有缓存和国家中心点，实网 Nominatim 不在本批验收内。

## 运行

```bash
PORT=4020 LEGACY_API_URL=http://localhost:4000 go run ./cmd/api
curl http://localhost:4020/__go/healthz     # routes/shadow/canary/onboarding/userSettingsRead/userSettingsWrite
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
- 浏览器端（构建期）：`NEXT_PUBLIC_API_BASE_URL=http://<host>:4020/api` 重建 web 镜像。页面源与 API 不同源时，Go 用与 NestJS 相同的 `CORS_ORIGIN` 回答六个 user-settings GET/PUT 的预检和实际响应（凭据开启，不反射名单外 Origin，不返回 `*`）。`X-Frame-Options` 仍只出现在 NestJS 代理响应上。
- 回滚按序：① `API_GO_USER_SETTINGS_WRITE_MODE=legacy`；② `API_GO_USER_SETTINGS_READ_MODE=shadow`（或删除该变量回到更早的读去向）；③ `API_BASE_URL` 指回 `http://api:4000`；④ 停 pilot。没有新表。

### 远端真实栈 smoke（`api-go-entry-smoke` workflow）

手动触发，不进 push/synchronize 普通 CI。主路径 `workflow_dispatch`（workflow 在默认分支注册后 `gh workflow run`）；PR 期间用 label `api-go-entry-smoke` 显式触发（与 ci.yml 的 regen label 门禁同一模式），运行后移除 label。真实 MySQL/Redis/Mongo service 容器 + 真实 `prisma migrate deploy` + 真实 NestJS 进程 + 构建并启动本 Dockerfile 的 api-go 容器（两阶段：先 `API_GO_USER_SETTINGS_READ_MODE=shadow`，后重启为 `go`）。

Go-批3B 起的四阶段验收（全部经 api-go 入口 + 真实登录 JWT）：

- **Phase A（写入准备）**：六个 PUT（含 situation-monitor 一次写入 monitors/layout/settings 三段）由 NestJS 单写 → MySQL 直查确认 8 个固定 key 均真实存在 → PUT 前后 shadow executed 不增加 → 相似路径（onboarding-x / war-map-x / newsnow/other）不误命中。
- **Phase B（shadow 对比）**：`readMode=shadow` 启动——六个 GET 都由 NestJS 响应，Go 做真实旁路查询与差分：executed 精确 +6（+healthz/live 共 +7）、diffs 零增量、六类 dropped 零增量、inflight 归零——不通过删除字段、宽松比较制造零差异。
- **Phase C（Go 接管）**：`readMode=go` 重启真实容器——六个 GET 与 NestJS 直连逐字段契约对比（status/`Cache-Control: no-store`/content-type/JSON 全等、各端点读自己的 key、situation-monitor 三段 updatedAt 对应正确）；Go 请求不增加 shadow.executed。
- **Phase C 写接管**（`WRITE_MODE=go`）：六个 PUT 由 Go 写入；之后 NestJS GET 与 Go GET 读同一行。空请求不插行。一个 key 的并发 upsert 只有一行。未知字段/错误类型/无权限/撤销 token 不写库。第二个 org/user 行数为 0。
- **Phase D（独立性证明）**：停止 NestJS 后六个 PUT 与六个 GET 仍成功；未迁移 GET（/api/items）返回 502。

共享鉴权链负向用例保留代表性端点（onboarding）：数据库无 `items.read`（JWT claim 仍有）双端 403 契约一致 → membership 停用双端 401 同文案 → 篡改签名与 alg=none 拒绝 → 真实 logout 写入真实 Redis blacklist → 撤销 token 401 "Access token revoked"。

**验证状态分层**：静态代码与单元/MySQL+Redis 集成测试由普通 CI 远端验证；真实入口链（容器 + 真实 NestJS + 真实登录 + Go 鉴权链 + Shadow 指标增量）由 `api-go-entry-smoke` 远端真实栈运行验证完成；**生产/预发布真实流量验证未完成**（api-go 未接入任何生产入口）。

Go-批4B 故事详情在同一真实栈里已验证缓存命中的 id/slug、公开组织边界，以及 NestJS 停止后 Go 独立返回完整缓存详情。缓存缺失时的模型网关调用和 `briefV1` 写回只做了静态审查，尚未真实调用模型。远端没有 `LITELLM_API_BASE` 或 `LITELLM_API_KEY` 时，smoke 跳过这段并写明未执行，不把跳过记为通过；凭据齐备时，真实请求失败、未写回 `briefV1` 或盖掉其他 metadata 仍然失败。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 4020 | 网关监听端口 |
| `LEGACY_API_URL` | http://localhost:4000 | NestJS apps/api 基址 |
| `API_GO_USER_SETTINGS_READ_MODE` | （空） | user-settings 六个只读 GET 的统一读模式（Go-批3B）：`shadow`=六个 GET 全部 NestJS 响应 + Go 差分；`go`=六个 GET 全部由统一 Go handler 接管（独立鉴权 + 独立查库 + normalization + 全响应）。**设置时优先级高于 `API_GO_ONBOARDING_MODE`**（onboarding 也归它管）；**未设置（空）=兼容旧行为**：onboarding 由 `API_GO_ONBOARDING_MODE` 控制，rss/spacetime 保持 shadow，war-map/newsnow/situation-monitor 保持 legacy（批3B 之前的部署不变）。非法值启动失败；`go` 模式要求 `JWT_SECRET`/`DATABASE_URL`/`REDIS_HOST` 齐备（缺失启动失败）。compose pilot 固定注入 `go`。回滚 = 改回 `shadow` 或删除本变量 |
| `API_GO_USER_SETTINGS_WRITE_MODE` | legacy | 六个 PUT（Go-批3C）。`legacy` 代理 NestJS；`go` 由 Go upsert 现有 `UserSetting` 并重读。`go` 要求读模式同为 `go`，否则启动失败。pilot 注入 `go`。回滚先改回 `legacy` |
| `API_GO_PUBLIC_PORTAL_MODE` | legacy | 公开首页、频道和故事详情（Go-批4A/4B）。`legacy` 代理 NestJS；`go` 时 `GET /api/public-portal/home`、`channels/:topic`、`stories/id/:id`、`stories/slug/:slug`（后三个恰好一个路径段，且仅 GET）由 Go 查 MySQL 并完整响应。详情 brief 冷路径读取 `llm_gateway_profiles`，并用已有的 `SYSTEM_SETTINGS_ENCRYPTION_KEY` / `LITELLM_*` 作为凭据与缺省网关。启用 `go` 前应确认模型网关配置可用。`go` 要求 `DATABASE_URL`，不要求 JWT/Redis。pilot 注入 `go`。默认生产入口不切换。回滚改回 `legacy`，不删数据 |
| `API_GO_DASHBOARD_STATS_MODE` | legacy | 只接管精确 `GET /api/dashboard/stats`（Go-批5A）。`go` 时 Go 验签、查 Redis 撤销名单、从 MySQL 重推导 orgId 与 `items.read`，再读 ItemMeta、Mongo processeditems/tasklogs 和 Redis 组织计数 hash。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`，缺失则拒绝启动，错误不含连接串。pilot 注入 `go`。其他方法、子路径、`dashboard/stream` 和图表接口仍代理 NestJS。回滚改回 `legacy` |
| `API_GO_DASHBOARD_CHARTS_MODE` | legacy | 只接管三个精确 GET（Go-批5B）：`/api/dashboard/sector-heatmap`、`/api/dashboard/financial-candlestick`、`/api/dashboard/war-map/geojson`。`go` 时验签、查撤销名单、从 MySQL 重推导 `dashboards.read`。热力图和 K 线读 EconomicDataItem/EconomicDataPoint；GeoJSON 来自构建时嵌入的 world.geo.json，并带 `Cache-Control: no-store`。要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`，不要求 `MONGO_URI`。与 stats 开关独立。pilot 注入 `go`。其他方法、war-map 其余路径、spacetime 和 stream 仍代理 NestJS。回滚改回 `legacy` |
| `CORS_ORIGIN` | （空） | 与 NestJS 相同的逗号分隔来源白名单。读写模式均为 `go` 时，六个精确路径的浏览器预检由 Go 204 回答，GET/PUT（含 401/400）回同一来源头。空名单不放行任何 Origin。pilot 注入与 api 服务相同的值 |
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

路由匹配：**迁移单元 = exact path + method 白名单**。相似路径、POST 以及写模式为 `legacy` 时的 PUT 回落 `/api/`。写模式为 `go` 时，同一六个路径的 PUT 另有 exact+PUT 规则。

| 模式 | 当前路由 | 行为 |
|---|---|---|
| legacy | `/api/`、`/graphql`、`/socket.io/`、`/docs`、`/admin/queues`（含六个 user-settings GET 的 PUT/相似路径、其余全部未迁移端点） | 反向代理到 NestJS（事实源） |
| shadow | `/api/healthz/live`（exact + 仅 GET）；六个 user-settings GET 的模式由 `API_GO_USER_SETTINGS_READ_MODE` 决定：`shadow` 时全部 shadow；未设置时 onboarding（`API_GO_ONBOARDING_MODE=shadow` 默认）与 rss-reader/spacetime-timeline shadow，war-map/newsnow/situation-monitor legacy | NestJS 响应 + Go 实现异步差分 |
| canary | （无） | 待鉴权基础设施接入的分流组件（见下） |
| go | `/__go/healthz`；读模式 `go` 时六个 GET（exact）；写模式 `go` 时六个 PUT（exact） | Go 原生。GET 走 `usersettingsread`；PUT 走 `usersettingswrite`（同一鉴权链，写后重读） |

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
  逐字段对齐——含批3B 的 war-map 45 layer/legacy key/clamp、newsnow
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
