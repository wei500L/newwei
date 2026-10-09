# ADR：主后端渐进式迁移 Go（Strangler Fig）

> 状态：已接受 · 2026-09-03 · 适用仓库 newwei @ `edf0c8cf`
> 决策人：重构任务（第一阶段产出）。实现始于 roadmap M2。

---

## 0. 背景与目标

主后端 `apps/api` 为 NestJS 11（770 文件：71 controller / 25 resolver / 6 gateway / 10 processor / 222 service）。迁移动机：单进程承载 REST+GraphQL+WS+队列+cron 导致资源争抢与部署耦合；目标语言 Go 的并发模型与部署形态（静态二进制、低内存、CD 交叉编译）匹配「采集-处理-推送」负载特征。

**目标**：Go 逐步接管 API 网关、鉴权、编排、cron、realtime；**非目标**：重写 Crawl4AI/Akshare/LiteLLM/model-service（保留为独立 HTTP 服务），更换数据库（MySQL/Mongo/Redis/Qdrant/MinIO/ES 一律不动）。

## 1. 决策：Strangler Fig（绞杀者模式），拒绝一次性重写

- 新代码进 `apps/api-go/`，旧 `apps/api` 保持线上运行；反向代理按路由粒度分流
- **每个迁移单元独立可回滚**：代理层一条路由规则回切即回滚，无数据迁移耦合
- 禁止「删旧再补」：Go 侧实现未达契约差分通过前，旧实现不下线
- 迁移期间契约冻结（`api-contract-inventory.md` 为基线）

被否决的方案：
- **大爆炸重写**：770 文件单体无测试保护网（api 0 测试），风险不可控；违反任务红线
- **仅新增功能用 Go（双栈长期并存）**：两套鉴权/队列语义长期漂移，维护成本高于迁移本身
- **Node 内微服务化**：不解决运行时资源问题，反而增加进程数

## 2. 目标架构（apps/api-go/）

```
apps/api-go/
├── cmd/api/main.go              # 入口：装配 + 路由注册 + legacy 路由表
├── internal/
│   ├── platform/                # 横切能力（不含业务）
│   │   ├── httpx/               # 中间件：trace-id、recover、日志、超时
│   │   ├── authn/               # JWT 验签（aud/iss/jti 黑名单）、机器令牌、MFA 中间件
│   │   ├── authz/               # 28 权限点 RBAC、orgId 服务端推导、fail-closed 语义
│   │   ├── config/              # env 加载（对齐 env.schema.ts 的 Zod 语义）
│   │   ├── mysql/  mongo/  redis/  # 连接池（复用既有库，不加 schema 变更）
│   │   └── observability/       # 指标、异常事件 side-channel（对齐 REST/GraphQL 错误结构）
│   ├── domains/<bounded-context>/   # 按限界上下文（auth、items、alerts…），禁止横向 import
│   └── legacyproxy/             # 未迁移路由的反向代理（默认全量兜底）
├── migrations/README.md         # 空目录占位：Phase 1 禁止任何 DB schema 变更
└── tests/contract/              # 契约差分测试（Go 实现vs NestJS 双发比对）
```

- Web 框架：**标准库 net/http + chi**（或纯 165 路由表自实现——以最小依赖为原则决策）；不引入 Nest 风格 DI 容器，用显式构造函数
- 路由模式：`legacy | shadow | canary | go` 四态（见 §4）
- BullMQ：**最后迁移**，且不手工复刻其内部语义（见 §5）

## 3. 迁移顺序（依赖倒排，低风险先行）

| 序 | 单元 | 理由 |
|---|---|---|
| 0 | 骨架 + legacyproxy 全量兜底 + 契约快照/差分框架 | 先立保护网再动刀 |
| 1 | **vector 服务 Go 重写（试点）** | 独立部署、3 端点、无队列无 DB——验证 Go 出包/部署/回滚全链路；顺带修 SEC-02（orgId 推导）与 SEC-04（常量时间比较） |
| 2 | 低副作用只读端点：health、public-portal、dashboard/stats 类 | 无写入，差分失败零数据风险 |
| 3 | 用户偏好 CRUD（user-settings/user-digest/subscriptions） | 单租户、幂等、写入面小 |
| 4 | GraphQL 层（gqlgen 或自研执行器，消费冻结 SDL） | 复杂度高峰，放在保护网成熟后 |
| 5 | Auth/Org/RBAC | 最高风险：JWT/MFA/OIDC/refresh 轮换/机器令牌语义逐项对齐（鉴权矩阵驱动） |
| 6 | crawl 编排、news-pipeline、scheduler、BullMQ、WebSocket | 最后：见 §5 边界 |

## 4. 流量切换与回滚

- 入口代理（web 的 NEXT_PUBLIC_API_BASE_URL 指向处，或独立 nginx/网关）维护路由表：默认 `legacy`
- **shadow**：请求仍由 NestJS 执行，异步复制到 Go 实现比对（差分日志，不影响响应）
- **canary**：按 orgId 哈希小比例切真实流量到 Go
- **go**：全量；NestJS 对应路由保留 ≥2 个发布周期后摘除
- 回滚 = 路由表改回 legacy（配置变更，无代码回滚）；canary 期任一契约差分失败自动回切

### 4.1 shadow 期的身份信任边界（Go-批2A 确立）

Go 在完成迁移序 5（JWT 验签 + membership 重推导 + RBAC）之前，**不存在
Go 侧可信身份**。受保护业务端点进入 shadow 的唯一合法身份来源是
**legacy-approved shadow identity**（临时信任委托）：

1. 同一请求先由 NestJS 执行（JWT 验签、jti 黑名单、membership、权限全部
   由 NestJS 判定）；
2. 只有 NestJS 返回 HTTP 200，才允许从（未验签的）Bearer JWT payload
   读取 `sub`/`orgId`，且只用于本次只读差分查询；
3. `permissions` claim 一律不读取、不信任；NestJS 非 200（401/403/404/5xx）
   → Go 零执行、零数据库查询。

这不是「Go 已验证身份」，更不是 canary-ready identity。shadow 单元表
（`cmd/api/main.go` 的 `shadowUnits`）以 `RequireLegacyOK` 声明该前提；
路由表被误切 ModeCanary/ModeGo 时状态契约测试失败（先落地 Go Auth/RBAC）。
适用单元：user-settings 的确定性只读 GET——Go-批2A `GET /api/user-settings/
ui/onboarding` 起步（迁移序 2 的首个真实业务端点，从 MySQL 主数据库真实
读取进入 shadow 差分）；Go-批2B 扩展 `rss-reader`、`spacetime-timeline`
（同一 repository 的固定 `SettingKey` 查询与同一身份门禁）。其余三个
user-settings GET（situation-monitor/war-map/newsnow）与全部 PUT 仍 legacy。
Go-批3A 起 onboarding 具备独立 Go 鉴权（§4.3）并可在 pilot 切 ModeGo——
其 shadow 单元随之下线；`LegacyApprovedIdentity` 的剩余消费者是
`rss-reader`/`spacetime-timeline` 两个 shadow 单元与 shadow 模式下的
onboarding（默认部署路径）。

### 4.2 入口链与部署形态（Go-批2C）

api-go 自批2C 起具备真实可运行的入口链，但**默认部署仍 Web → NestJS 直连**：

- 生产镜像：`infra/docker/api-go.Dockerfile`（多阶段、`-mod=readonly -trimpath`、
  distroless static nonroot；内置 `/api-go healthcheck` 子命令作 exec 形式
  HEALTHCHECK——distroless 无 shell，字符串形式 health-cmd 不可用）。
- Compose：独立 `api-go-pilot` profile 的 `api-go` 服务（:4020，依赖 `api`/
  `mysql` healthy，`DATABASE_URL` 与 NestJS 同源 `MYSQL_*`，`CANARY_PERCENT=0`）。
  默认 `up` 不启动——legacy 行为零变化。
- 切换：服务端 `API_BASE_URL=http://api-go:4020`（运行期）；浏览器端
  `NEXT_PUBLIC_API_BASE_URL` 构建期内联（需重建 web）。web 启动等待已改为
  探测最终配置的 API base（不再硬编码 `http://api:4000`）。回滚 = 指回
  `http://api:4000`，无数据耦合。
- 验证分层：普通 CI 只验证静态/单元/MySQL 集成；手动 `api-go-entry-smoke`
  workflow 完成**远端真实栈运行验证**（真实 MySQL+migration+真实 NestJS+
  api-go 容器+真实登录 JWT+Shadow 指标增量断言）；**生产/预发布真实流量
  验证未完成**。canary/go 接管（§4 后两态）在迁移序 5 完成前保持禁止
  （例外见 §4.3——onboarding 单元的 go 接管以最小闭环 Go Auth 为前置件）。

### 4.3 Go Access Token 鉴权最小闭环 + onboarding 首个 go 接管（Go-批3A；Go-批3B 扩展为六端点统一接管，见 §4.4）

迁移序 5（Auth/Org/RBAC）的最小闭环先行落地，并立刻服务于一个真实接管
的业务端点（而不是只写鉴权代码）：

- **接管单元**：`GET /api/user-settings/ui/onboarding` 在 pilot 中由
  `API_GO_ONBOARDING_MODE=go` 显式切到 ModeGo（compose `api-go-pilot`
  profile 固定注入 `go`；默认部署与手工裸启仍 `shadow`——旧行为零变化）。
- **Go 独立鉴权链**（`internal/authn` → `internal/authz` →
  `internal/authhttp` → `internal/onboarding`，依赖方向单向）：HS256
  验签（拒绝 alg=none/算法混淆/mtk_ 机器令牌；issuer/audience/exp/nbf
  按 jsonwebtoken 语义；jti 缺失按 NestJS 当前语义放行）→ 真实 Redis
  blacklist（`access-token:blacklist:<jti>`，与 NestJS 同一实例同一
  key，不建第二套撤销名单；查询失败 fail-closed）→ 真实 MySQL 重推导
  User/Org/Membership 与 MembershipRole/RolePermission/Permission 权限
  （与 getUserProfile 同序同文案 401；多角色优先、空则 primary 回退）→
  `items.read` 判定（JWT 的 permissions claim 一律不读——`authn.Token`
  结构上不存在该字段）→ 既有 UserSetting repository 查询 + Go 全响应。
  错误契约与 GlobalExceptionFilter 逐字段对齐（401/403/500/503 映射见
  `internal/authhttp/errors.go`）。
- **路由匹配升级**：迁移单元 exact path + method 白名单（PUT 同路径、
  `onboarding-x`、`onboarding/other` 等回落 `/api/` legacy——写方法
  永远 NestJS 单写，相似路径不误命中）；fallback 规则仍前缀匹配。
- **远端真实栈验收**（`api-go-entry-smoke`）：契约对比（NestJS 直连 vs
  Go handler 全等）、数据库无权限而 JWT claim 有 → 双端 403、
  membership inactive → 双端 401 同文案、真实 logout blacklist → 401
  revoked、篡改签名/alg=none → 401、**NestJS 停止后 onboarding GET 仍
  200 且未迁移端点 502**（独立接管证明，非代理/Shadow 假象）、onboarding
  零 shadow 执行。
- **边界（如实登记）**：这只是迁移序 5 的最小闭环——MFA、OIDC、refresh
  轮换、机器令牌、Platform Admin 语义未迁移（登录/refresh/logout 仍全部
  NestJS，mtk_ 在 Go 端点被拒绝）；批3B 前其余端点仍 shadow/legacy；
  canary router 仍消费未验签 claim（未改造为已验证身份分流），
  CANARY_PERCENT 保持 0；默认部署仍 Web → NestJS 直连，生产流量未切换。

### 4.4 user-settings 只读域统一 Go 接管（Go-批3B）

批3A 的单端点接管收敛为整个只读域的统一接管——六个 GET 共享同一
handler、同一鉴权链装配、同一连接池，不复制六份实现：

- **接管单元**：`GET /api/user-settings/ui/{onboarding,rss-reader,
  spacetime-timeline,war-map,newsnow,situation-monitor}` 全部由
  `API_GO_USER_SETTINGS_READ_MODE=go` 切到 ModeGo（compose
  `api-go-pilot` profile 固定注入 `go`；该变量优先级高于
  `API_GO_ONBOARDING_MODE`——批3A 变量保留为兼容：未设置 read mode 时
  仍单独控制 onboarding。默认部署与手工裸启均未设置——旧行为零变化）。
- **统一 handler**（`internal/usersettingsread`）：批3A 的
  `internal/onboarding` 被完全替代并删除（不新旧并存）。请求链 = Bearer
  提取 → JWT 验签 → Redis blacklist → MySQL membership/RBAC 重推导 →
  `items.read` → 固定 UserSetting 查询 → normalization → Go 全响应。
  六端点只差「查哪个语义方法 + 哪个 Build*Response」——一张编译期绑定
  表，不是注册框架。
- **repository 扩展**：五个单 key 端点共用同一条私有参数化查询
  （`orgId+userId+固定 key`，key 为 `usersettings` 包编译期常量，共 8 个）；
  situation-monitor 一次聚合查询三个固定 key（对齐 NestJS `findMany`）。
  无任意 key 查询 API——SettingKey 封闭集合。
- **三个新 normalization**（`internal/usersettings`）：War Map 完整移植
  `packages/utils/src/war-map-contract.ts`（45 layer + legacy key 映射 +
  viewState clamp + bearing/pitch 归零 + 枚举回退）；Situation Monitor
  三段聚合（monitors/layout/settings 各自规整 + 三段 updatedAt）；
  NewsNow（有序对象 columnOrders/sourceAffinity——`Object.entries` 顺序
  与「前 N 项」上限语义用流式有序解码，不用 map 随机遍历；Boolean 真值；
  clamp/round；smart→personalized 归一）。
- **远端真实栈验收**（`api-go-entry-smoke` 四阶段）：Phase A 六个 PUT
  NestJS 单写 + 8 key 落库确认；Phase B shadow 差分（executed 精确 +6、
  diffs 零增量）；Phase C go 接管契约对比（六端点 NestJS 直连 vs Go
  handler 逐字段全等）；Phase D 停止 NestJS 后六端点仍 200 + 代表性
  PUT/未迁移 GET 502（独立接管与写路径未迁移证明）。
- **边界（如实登记）**：六个 PUT 仍全部由 NestJS 单写（exact path +
  method 白名单回落）；登录/refresh/logout/MFA/OIDC/机器令牌仍全部
  NestJS；`LegacyApprovedIdentity` 保留（shadow 回滚路径的消费者——
  Go 模式完全不经过它）；canary 仍未激活；默认生产入口未切换（pilot
  profile 之外 Web → NestJS 直连）；远端真实栈验证不等于生产/预发布
  真实流量验收。

### 4.5 user-settings 写路径 Go 接管（Go-批3C）

六个 PUT 在 `API_GO_USER_SETTINGS_WRITE_MODE=go` 时由 Go 写入现有
`UserSetting` 表（同一八个固定 key），写后用批3B 的 `Query` 重读并返回
完整 envelope。默认 `legacy`（未设置同义）：PUT 仍纯代理 NestJS。
`go` 要求 `API_GO_USER_SETTINGS_READ_MODE=go`，否则进程拒绝启动。

- **写入**：一条 `INSERT ... ON DUPLICATE KEY UPDATE`，命中
  `(orgId, userId, key)`。`id` 由 Go 显式生成（列无数据库默认值）。
  `updatedAt` 截断到毫秒。`orgId`/`userId` 只来自已验证身份。
- **空写**：五个单 key 仅当 `settings` 出现（含显式 `null`）才 upsert；
  请求体 `{}` 不插入行。Situation Monitor 的 `monitors`/`layout`/
  `settings` 各自独立 upsert，**没有事务**。某一段失败时已成功的段会
  留下，与 NestJS `Promise.all` 相同，不构成原子提交。
- **DTO**：未知顶层字段与错误顶层类型返回 ValidationPipe 400；字段缺失、
  显式 null、错误类型分开处理。非法 JSON 也是 JSON 400（Nest 把
  body-parser 错误映射成 BadRequestException）。读取上限 10 MiB，与
  `main.ts` 的 `json({limit:"10mb"})` 一致。远端 smoke 确认 100KiB+1
  仍会进入 JSON 解析而不是超限；超过 10 MiB 时 Nest 生产过滤器返回
  500 `Internal server error`（不保留 body-parser 的 413 文案），Go 与之相同。
  超限请求不写库。
- **浏览器 CORS**：Web 跨源请求 `:4020`。读写模式均为 `go` 时，六个精确
  路径的有效 `OPTIONS` 预检由 Go 直接 204（不验 JWT、不查 Redis/MySQL、
  不写库）。GET/PUT 的成功与 401/400 等响应使用同一份 `CORS_ORIGIN`
  白名单和 `credentials: true`；未列出的 Origin 不反射，也不返回 `*`。
  其他路径、未接管模式，以及没有预检头的 `OPTIONS`，仍代理 NestJS。
  `X-Frame-Options` 仍只来自 NestJS `helmet()`，Go 不补：浏览器
  `axios` 读 JSON 不依赖它。
- **回滚**：先把 `API_GO_USER_SETTINGS_WRITE_MODE` 改回 `legacy`，再按需
  把读模式改回 `shadow`、`API_BASE_URL` 指回 NestJS、停止 pilot。不新增
  表，不迁移数据。预检随之回到 NestJS。
- **边界**：登录/refresh/logout/MFA/OIDC/机器令牌仍是 NestJS。canary 仍
  未启用。这不是完整 Auth 模块迁移，也没有切换生产入口。

### 4.6 public-portal 首页与频道 Go 接管（Go-批4A）

只接管两个匿名 GET。故事详情仍由 NestJS 响应。默认部署不改入口。

- **接管单元**（`API_GO_PUBLIC_PORTAL_MODE=go`，compose `api-go-pilot`
  固定注入；未设置或 `legacy` 时这两条仍代理 NestJS）：
  - `GET /api/public-portal/home`（exact + 仅 GET）
  - `GET /api/public-portal/channels/:topic`（前缀之后恰好一个路径段 + 仅 GET）
- **不接管**：`GET /api/public-portal/stories/id/:id`、
  `GET /api/public-portal/stories/slug/:slug`，以及 `channels` 的多段路径、
  `home` 的子路径、这两个路径上的非 GET。它们继续回落 `/api/`。
- **数据**：只读现有 MySQL（与 user-settings 同一连接池）。公开组织只来自
  `SystemSetting.public_portal_org_slug`，且 `Org.isActive`。没有配置或组织
  已停用时，首页返回 `org: null` 的空 envelope，频道返回 404
  `Channel not found`。不回退到最近组织，不接受请求里的租户参数。
  故事来自该组织的 `active` 事件：非空标题/摘要、至少 2 条关联、
  来源 `authoritative` 或 `mixed`、可信度至少 60。热度、breaking、来源分类
  和可信度读取事件条目，并套用该组织已持久化的来源策略（缺省名单 +
  `news_event_source_policy:<orgId>` 的 delta）。策略读失败时回落默认名单；
  事件查询失败返回通用 500，响应里不带数据库错误。
- **分页**：每页 96 条、最多 30 页；排序 `lastAt, startAt, id` 降序。首页 12
  条（第 1 条 featured，其余 latest），频道 18 条。`Cache-Control` 为
  `public, max-age=60, s-maxage=60, stale-while-revalidate=300`。
- **鉴权**：匿名。不进入 user-settings 的 JWT/RBAC 链，也不要求 Redis。
  `go` 只要求 `DATABASE_URL`，否则进程拒绝启动。
- **回滚**：`API_GO_PUBLIC_PORTAL_MODE=legacy`（或删除该变量）。不新增表。
  故事详情本来就不在这个开关里。
- **边界**：这不是整个 public-portal 已迁移。批4A 当时两个故事详情仍是 NestJS。
  来源策略读的是已落库的 SystemSetting，不是 Nest 那份 60 秒 Redis 缓存副本。
  默认生产入口仍是 Web → NestJS。

### 4.7 public-portal 故事详情 Go 接管（Go-批4B）

同一开关 `API_GO_PUBLIC_PORTAL_MODE=go` 再接管两个匿名 GET。默认仍是
`legacy`（未设置同义）。生产入口不因本批改变。

- **接管单元**（仅 GET，前缀后恰好一个非空路径段）：
  - `GET /api/public-portal/stories/id/:id`
  - `GET /api/public-portal/stories/slug/:slug`
- **不接管**：这两个路径上的 POST、空段、额外路径段，以及仍未迁移的其他
  public-portal 路径。它们继续回落 `/api/`。
- **数据**：与首页共用公开组织（`SystemSetting.public_portal_org_slug` 且
  `Org.isActive`）。事件、条目、时间线、文章、相关故事都带该 `orgId`。
  归档、其他组织、标题或摘要为空、条目不足、来源或可信度不合格的事件
  返回 404 `Story not found`。`Cache-Control` 与首页相同。
- **详情**：id 与 slug 共用一条实现。`NewsEvent.id` 是 Prisma `cuid()`，
  不含连字符；slug 为 `id-标题`，按第一个 `-` 切出 id（与 Nest
  `extractStoryId` 相同）。时间线最多 12 条，窗口为
  `max(backfillDays, lookbackDays)`，缺省 30 天，按 `bucketStart` 升序。
  引用文章先取时间线 `referencedArticleIds` 去重，没有时回退最近 24 条
  事件条目；再只保留属于该组织且挂在该事件上的文章，按 `processedAt`
  降序最多 12 条。相关故事复用首页列表，同频道、排除自身、最多 4 条。
- **brief**：缓存命中读 `NewsEvent.metadata.briefV1`（版本、语言、指纹一致）。
  指纹与 Nest `JSON.stringify` 相同，不把来源 URL 里的 `&`、`<`、`>` 转成
  `\uXXXX`。缺失或指纹失效时，用同一套来源选择和提示词调用已配置的模型网关
  （`SystemSetting.llm_gateway_profiles` 的活动 completion profile；
  凭据为明文或 `SYSTEM_SETTINGS_ENCRYPTION_KEY` 解密的
  `system-settings:v1`；治理开启且命中目标 profile 时改用 managed runtime
  key，缺失则 503）。成功后把 `briefV1` 写回 metadata，保留其他键。
  写缓存失败仍返回已生成的 brief。没有可用来源时 `brief` 为 null。
  网关或校验失败返回 500，不返回缺 brief 的 200。
- **回滚**：`API_GO_PUBLIC_PORTAL_MODE=legacy`（或删除该变量）。首页、频道
  和两个故事详情一起回到 NestJS。不新增表，不删除 `briefV1` 或其他数据。
- **验证**：已真实验证缓存命中详情、id/slug、公开组织边界，以及 NestJS
  停止后 Go 独立返回完整缓存详情。缓存缺失或过期时访问真实模型网关、生成
  并写回新 brief 已实现，尚未真实调用模型。普通 CI 通过不能代替这次冷路径。
- **边界**：这仍不是整个 public-portal，也不是登录或其他 API。默认生产入口
  与 public-portal 默认模式仍是 `legacy`，不能声称生产流量已经切换。将来
  启用 `go` 前应确认模型网关配置可用。

### 4.8 dashboard stats 只读接管（Go-批5A）

只接管一条精确 GET。默认 `API_GO_DASHBOARD_STATS_MODE=legacy`（未设置同义）。
pilot 注入 `go`。生产入口不因本批改变。

- **接管单元**：`GET /api/dashboard/stats`（exact + 仅 GET）。同一路径的
  有效 `OPTIONS` 预检由 Go 按 `CORS_ORIGIN` 回答。POST、子路径、
  `GET /api/dashboard/stream` 以及其他图表 GET 继续回落 `/api/`。
- **身份**：复用 access token 验签、Redis `access-token:blacklist`、MySQL
  membership/RBAC。`orgId` 与 `items.read` 只来自这次重推导。不读 JWT
  `permissions`，不读 query 里的 `orgId`，不调用 NestJS。
- **数据**（与 `DashboardService.stats` 的 `Promise.all` 相同）：
  - MySQL `ItemMeta` 按 orgId 计数；
  - Mongo `processeditems` 按同一 orgId 计数；
  - Mongo `tasklogs` 中 `queue=itemPipeline`，按 `createdAt` 降序最多 10 条，
    投影 `createdAt/jobId/message/stage/status`，日期为 `Date.toISOString()`；
  - Redis hash `queue:itemPipeline:org:<orgId>:counts` 的
    waiting/active/completed/failed/delayed。缺失或无效为 0。命令失败时
    五个计数为 0 且 `queueCountsAvailable=false`，其余字段仍返回。
- **失败**：MySQL 失败 → 503；Mongo 计数或 TaskLog 失败 → 500。都不会把
  故障写成 `itemCount/processedCount/recentQueueLogs` 的 0。不启动 Go
  队列 worker，不写 Redis 计数，不复制 BullMQ。
- **配置**：`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。
  缺失或 URI 无法解析则拒绝启动。错误与日志不包含连接串。
- **回滚**：`API_GO_DASHBOARD_STATS_MODE=legacy`。不新增表，不复制数据。

### 4.9 dashboard 三个只读图表（Go-批5B）

只接管三条精确 GET。默认 `API_GO_DASHBOARD_CHARTS_MODE=legacy`（未设置同义）。
pilot 注入 `go`。与 `API_GO_DASHBOARD_STATS_MODE` 互不影响。生产入口不因本批改变。

- **接管单元**（exact + 仅 GET；同一路径的有效 OPTIONS 预检由 Go 按 `CORS_ORIGIN` 回答）：
  - `GET /api/dashboard/sector-heatmap`
  - `GET /api/dashboard/financial-candlestick`
  - `GET /api/dashboard/war-map/geojson`
- **不接管**：`GET /api/dashboard/stats`（仍只看批5A 开关）、`war-map/layers`、`war-map/transport-detail`、spacetime 系列、`/api/dashboard/stream`，以及其他方法与更长路径。`war-map/events` 与 `war-map/news-markers` 不在本开关里，见批5C。这些继续回落 `/api/`，除非各自的开关显式为 `go`。
- **身份**：复用 access token 验签、Redis 撤销名单、MySQL membership/RBAC。三条都要求 `dashboards.read`。GeoJSON 也不是匿名接口。不读 JWT `permissions`，不读 query 里的 `orgId`（多余 query 键按 ValidationPipe 返回 400）。
- **日期**：三条都先执行与 `DashboardTimeRangeQueryDto` + `resolveRange` 相同的契约。`start`/`end` 做 ISO 8601 校验；缺省 end 为现在、start 为对齐前的 end 往前 30 天；再对齐到 UTC 日初与日末（23:59:59.999）。`2026-02-31` 这种超出当月的日期按 JavaScript `Date` 溢出（到 `2026-03-03`），不是 400。格式通过但 `Date` 无法解析时才是 `Invalid date range`。对齐后 start 晚于 end 是 `Start must be before end`。GeoJSON 不按日期过滤，但非法日期仍然 400。
- **热力图**：MySQL `EconomicDataItem`（`isActive` 且类别 `economic-short`，按 `displayName` 最多 8 条）和范围内的 `EconomicDataPoint`。首选字段来自 `metadata.dataViz.heatmap.preferredSourceFields`，否则用内置列表；parser 的 field/label 参与映射；未命中时回退并给出 `SOURCE_FIELD_FALLBACK`。变化率用首末点，保留两位小数。没有序列的条目不占格。不返回固定演示数组。
- **K 线**：MySQL 中 slug `sp500_index` 及其数据点。OHLC 别名优先用 `metadata.dataViz.candlestick.ohlc`，否则用内置中英别名；同一时刻低序号别名优先；缺任一 OHLC 的时刻跳过并计入 `skippedIncompleteCount`。范围内有点但没有任何 OHLC 字段匹配时返回 500 `DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH`，不返回空图冒充成功。条目不存在时返回空 `points`，symbol 为 slug，interval 为 `daily`。
- **GeoJSON**：构建时嵌入仓库里的 `world.geo.json`。响应为 `{name, geoJson, center:[0,20], zoom:1.1}`，`Cache-Control: no-store`。不是 FeatureCollection 时 500 `GEOJSON_LOAD_FAILED`。请求路径不调用 NestJS，也不访问外网。
- **失败**：MySQL 查询失败 → 503，正文不包含连接信息，也不把故障写成空图成功。图表 500 的 `message` 与 Nest 生产过滤器一样是 `Internal server error`，`code`/`detail` 仍保留。
- **契约差异**：Go 错误体的 `path` 与既有 Go 接管路由一样，只有路径、不含 query。NestJS `GlobalExceptionFilter` 使用的 `request.url` 含 query。成功响应没有 `path`。
- **配置**：`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`。不要求 `MONGO_URI`。缺失则拒绝启动。错误与日志不包含连接串。
- **回滚**：`API_GO_DASHBOARD_CHARTS_MODE=legacy`。不新增表，不复制经济数据，不新建抓取或调度。

### 4.10 War Map 事件与新闻标记（Go-批5C）

只接管两条精确 GET。默认 `API_GO_DASHBOARD_WAR_MAP_MODE=legacy`（未设置同义）。
pilot 注入 `go`。与 stats、charts 开关互不影响。生产入口不因本批改变。

- **接管单元**（exact + 仅 GET；同一路径的有效 OPTIONS 预检由 Go 按 `CORS_ORIGIN` 回答）：
  - `GET /api/dashboard/war-map/events`
  - `GET /api/dashboard/war-map/news-markers`
- **不接管**：`war-map/layers`、`war-map/transport-detail`、`war-map/geojson`（仍只看批5B）、stats、spacetime、`/api/dashboard/stream`，以及其他方法与更长路径。
- **身份**：复用 access token 验签、Redis 撤销名单、MySQL membership/RBAC。两条都要求 `dashboards.read`。orgId 只来自重推导，并进入 MySQL、Mongo 和 `dashboard:query:*` 缓存键。JWT `permissions` 与 query `orgId` 都不作为授权或租户来源。
- **日期**：`alignToUtcDay: false`。ISO 校验与批5B 相同，但起止时刻不拉到 UTC 日界。同一 UTC 日里 start 晚于 end 是 `Start must be before end`。仅日期 `2026-02-31` 仍按 JavaScript 溢出。带时间的 `2026-02-31T12:00:00.000Z` 在 Node 20+ 与 `time.Parse` 都是无效日期，返回 `Invalid date range`，解析器不改。
- **events**：该组织时间范围内的 `AlertEvent`（经 `AlertRule.orgId`，最多 1000，`triggeredAt` 降序）和 `hasLocation` 的 `ProcessedArticle`（最多 2500，`eventAt`/`articleId` 降序）。告警 context 提取国家代码；严重度、分数、新闻计数、`latestAt`、国家中心点来自同一份 `world.geo.json`。MySQL 新闻结果为空才查 Mongo `processeditems`。Mongo 失败只记日志并继续；MySQL 失败返回 500，不返回空数组。
- **news-markers**：同一组织的 `ProcessedArticle` 联 `Article`，最多 500。标题、URL、时间按 Nest 的回退顺序。MySQL 为空才查 Mongo `processeditems` / `rawitems`。地点实体清洗、国家识别、地理候选、Redis `geo:geocode:v1` 缓存、最多 3 次 Nominatim、国家中心点回退、无效坐标剔除都在 Go 内完成。外部地理服务失败时继续最佳努力，不跳过这段逻辑。
- **翻译**：`translate=zh-CN`（或 `zh`）走既有 DeepLX / fallback 配置（SystemSetting `situation_monitor_settings` 与 `SITUATION_MONITOR_TRANSLATION_*`）。失败或未配置时省略 `nameZh` / `titleZh` / `locationZh` / `displayNameZh`，不让整段请求失败。
- **缓存**：新闻查询缓存键 `dashboard:query:war-map-events|war-map-news-markers:<sha1>`，TTL 10 秒，payload 含 orgId 与未对齐的起止时刻。
- **配置**：`go` 要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。Nominatim 与翻译沿用 Nest 的环境变量和 SystemSetting，不新建地理数据源。
- **回滚**：`API_GO_DASHBOARD_WAR_MAP_MODE=legacy`。不新增表，不复制数据。

## 5. 队列/cron/outbox 边界（红线）

- 全部 BullMQ 队列、21 个 @Cron/@Interval、3 套 MongoOutbox 的**写入权在最终阶段前仅属 NestJS**——Go 侧提前双写会制造消息重复/顺序破坏
- Go 接管队列时**重新实现的是「行为契约」**（job name、重试语义、DLQ 效果、repeat 间隔），不是 BullMQ 内部数据结构；旧队列内积压任务排空后才切换 worker
- 三个非标准语义必须在对齐清单中显式覆盖：DLQ 在 worker failed 事件入队（`queue.processor.ts:281-334`）、itemPipeline 结果缺失时同步触发抓取（`news-pipeline-crawl-bridge.service.ts:185-188`）、CrawlTaskJanitor 直改状态
- GraphQL Subscription 进程内 PubSub → Go 侧统一 Redis pub/sub（多实例语义变更，需在切换公告中明示）

## 6. 契约与安全保护网（迁移的门禁）

1. OpenAPI + SDL 快照差分（CI）
2. 鉴权矩阵：369 端点 × {匿名, 无权限 JWT, 有权限 JWT, 错 org} 四态断言（含 403 `PERMISSION_METADATA_MISSING` fail-closed 语义）
3. 错误结构逐字段比对（statusCode/message/code/traceId/extensions.appCode——REST 与 GraphQL 两套）
4. orgId **一律服务端推导**（membership 重推导），请求体 orgId 仅作展示——SEC-01/02 的教训写进 Go 侧 code review checklist
5. 性能基线：每单元迁移前后 P95/P99 对比（shadow 期采集）

## 7. 后果与风险登记

- **正面**：部署解耦（编排类负载可独立扩缩容）；单路由渐进降险；契约保护网同时服务前端重构
- **负面/成本**：双栈并存期（预计 6–10 个里程碑）review/CI 复杂度上升；NestJS 侧冻结期新功能排期受影响
- **风险**：① JWT/MFA 语义细节差导致会话失效（缓解：鉴权矩阵 + canary 按 org 灰度）；② BullMQ 行为差异导致任务丢失/重复（缓解：排空切换 + 行为清单）；③ GraphQL 错误 extensions 形状漂移（缓解：快照差分覆盖错误路径）
- **退出条件（放弃迁移的预案）**：若连续 2 个里程碑契约差分无法收敛或回滚次数 >3，冻结 Go 侧范围，已迁移的只读/低风险单元保留，其余回到 NestJS 演进——本 ADR 不构成「必须迁完」的承诺
