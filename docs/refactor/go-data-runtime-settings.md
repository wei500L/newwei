# 数据运行设置与归档状态迁入 Go（9 条 HTTP）

分支 `refactor/go-data-runtime-settings`；基线 `origin/main`
`57d1d4baa5f8432686c8db396968633fd559d43e`（普通 CI run 39064805065 success）。
独立开关 `API_GO_DATA_RUNTIME_SETTINGS_MODE`（空串/`legacy`/`go`，默认
`legacy`，非法值启动失败，错误原句
`API_GO_DATA_RUNTIME_SETTINGS_MODE must be one of legacy|go`）。生产入口继续
Web → NestJS，Nest 全部保留，canary 关闭，不启用 shadow，不改前端。本批
backend-only，未改 `apps/web`。

## 1. 九条路由与 Go 接管边界

| # | 方法 | 精确路径 | 权限 | 平台门禁 | 成功码 |
|---|---|---|---|---|---|
| 1 | GET | `/api/system-settings/realtime-signals` | `settings.manage` | 否 | 200 |
| 2 | PUT | `/api/system-settings/realtime-signals` | `settings.manage` | 是（本批补齐，DS1） | 200 |
| 3 | DELETE | `/api/system-settings/realtime-signals` | `settings.manage` | 是（本批补齐，DS1） | 200 |
| 4 | GET | `/api/system-settings/archive-preparation` | `settings.manage` | 否 | 200 |
| 5 | PUT | `/api/system-settings/archive-preparation` | `settings.manage` | 是（本批补齐，DS1） | 200 |
| 6 | DELETE | `/api/system-settings/archive-preparation` | `settings.manage` | 是（本批补齐，DS1） | 200 |
| 7 | GET | `/api/admin/archive-preparation/status` | `settings.manage` | 否 | 200 |
| 8 | GET | `/api/system-settings/geo/nominatim` | `settings.manage` | 否 | 200 |
| 9 | PUT | `/api/system-settings/geo/nominatim` | `settings.manage` | 是（本批补齐，DS1） | 200 |

全部为 exact path + method 白名单（`WithDataRuntimeSettings`，处理器注册键
`DataRuntimeSettingsKey = "/api/system-settings#data-runtime"`）。不注册整段前缀：
尾斜杠、HEAD、未列方法、相似前缀（`realtime-signals-extra`、
`geo/nominatim-extra`）与多一段路径全部回落 `/api/` legacy。OPTIONS 由既有
`policy.FinishOptions` 回答预检；非预检 OPTIONS 仍 `ServeLegacy`。与
runtime/infrastructure 等已迁开关同时 `go` 时互不覆盖（新增路由表测试锁定）。

明确留在 Nest（本批不迁）：

- 实时信号采集器、ACLED OAuth 刷新与全部上游网络请求；
- 归档分类、embedding、rerank、BullMQ producer/worker、状态索引写入与裁剪；
- `archiveDigest` / `archiveCalendar` / `archiveDetail`；
- `POST /api/system-settings/geo/nominatim/test`、`POST /api/geo/geocode` 与全部
  地理编码调用（`GEO_NOMINATIM_BASE_URL` 不迁移）；
- 全部 GraphQL、调度器与其他 `/api/system-settings/*`。

## 2. 认证、权限与平台门禁（DS1）

- 人类：复用 `authhttp` 验签 + Redis 撤销名单 + MySQL membership/permission
  重推导；不信任 JWT 的 `permissions` 或自称平台角色。
- 机器令牌（`mtk_`）：原文 SHA-256 查 `MachineAccessToken`，校验
  `revokedAt`/`expiresAt`/`Org.isActive`，更新 `lastUsedAt`，身份为
  `machine:<tokenId>`。四条 GET 有 `settings.manage` 即可读；五条写一律 403，且
  `SystemSetting.updatedById`/`AuditLog.actorId` 写 SQL NULL（绝不写
  `machine:<id>` 触发外键 500）。
- 平台门禁：`GlobalRoleAssignment.userId = 真实 User.id` 且
  `role = 'platform_admin'`，失败 403 `Platform admin access required`。平台角色
  不能替代 `settings.manage`。
- 顺序固定：认证 → `settings.manage` → DTO → 平台门禁 → 锁/业务。DELETE 无 DTO，
  门禁紧跟权限检查。拒绝请求不改变 DB/cache/audit（真实栈断言）。

**DS1 根因与修法**

- 证据（基线 `57d1d4ba`）：`realtime-signals-settings.service.ts` 的
  `updateSettings`/`resetToEnv`、`archive-preparation-settings.service.ts` 的
  `updateSettings`/`resetToDefaults`、`geo-nominatim-settings.service.ts` 的
  `updateSettings` 均无平台检查；三组 controller 只要求 `settings.manage`，
  三个 `SystemSetting.key` 没有 org 维度。
- 后果：任何租户的组织管理员都能改所有租户的运行参数、全局凭证、Nominatim 身份
  与归档并发。
- 修法（Nest）：五个 service 公开写方法**首行**
  `await this.platformAccess.assertPlatformAdmin(actorId)`；`SystemSettingsModule`
  已导入 `AuthModule`、`AuthModule` 已导出 `PlatformAccessService`，因此直接构造
  注入，未改共享 module 注册结构，也未改 controller 的装饰器或 handler 签名。
  写 User 外键与审计 actor 前统一经 `normalizeAuditActorId`。
- 修法（Go）：DTO 校验之后执行同一门禁（`GlobalRoleAssignment` 实查），机器身份
  直接 403。
- 门禁位置在 service 而非 controller，controller 未变，生成式 auth-matrix 无法扫描
  出 handler 级门禁证据；本文件、契约清单与真实栈断言记录该 service 门禁。

## 3. 三种缓存形状（刻意保留，未统一）

| 域 | Redis 键 | TTL | 形状 | 管理 GET 是否读缓存 |
|---|---|---|---|---|
| 实时信号设置 | `realtime-signals:settings` | 30s | `{"exists":bool,"value":{...}}` 信封 | 是（写路径读 DB，见 DS2） |
| ACLED 派生状态 | `realtime-signals:acled-auth-state` | 30s | `{"exists":bool,"value":{...}}` 信封 | 不读（ACLED 固定关闭，仅失效/删除） |
| 归档准备设置 | `archive_preparation:settings` | 30s | 原始设置对象或 JSON 字面量 `null`（**无信封**） | 是 |
| `system_security` 策略 | `system_security:settings` | 60s | `{"exists":bool,"value":{...}}` 信封 | **只读**，本批不写该键、不写该行 |
| Nominatim 身份 | 无 Redis 键 | 30,000ms | 进程内缓存 | 是（写路径读 DB，见 DS2） |

- 实时设置的缓存读/写/失效失败按 Nest 的 catch/log 降级到 DB；这条降级只针对设置
  缓存，绝不扩展到认证撤销检查（始终 fail-closed），也不把数据库错误吞成默认成功。
- 归档设置缓存值**不是** `{exists,value}`：缓存 `null` 表示"没有行"，绝不被当成
  "存在一行且值为 null"。响应 `source` 按原 `getPublicSettings` 对返回存储值的
  JavaScript truthiness 判断（`{}`/`[]` 为真，`null`/`0`/`false`/`""` 为假），
  不简化成"有 DB 行就是 db"。
- Go 侧归档设置缓存采用 read-through，未复刻 Nest `CacheService.wrap` 的 Redis
  抢锁/续租/释放：loader 是确定性的单行 SELECT，抢锁只影响并发重算次数，缓存载荷
  与 HTTP 响应完全不受影响。Nest 侧 wrap 锁保持原样未改。

## 4. DTO 与转换差异（本批最易错之处）

消息与顺序逐一对照 class-validator 0.14.2 + class-transformer 0.5.1，并已被合并批次
的真实栈断言固定：

- 未知字段（`whitelist + forbidNonWhitelisted`）消息 `property <name> should not
  exist`，出现在**属性校验消息之前**，顺序为请求体键顺序（去重取首次位置）。
- 属性按 **DTO 声明顺序** 出现；单个属性内的约束按**装饰器反向顺序**出现，因为
  TypeScript 自底向上应用属性装饰器而 class-validator 保留注册顺序：
  `@IsInt() @Min(x) @Max(y)` → `Max`、`Min`、`IsInt`。
- 顶层 `message` 数组由 `GlobalExceptionFilter` 用 `"; "` 连接。
- 实时设置 PUT：**没有** `@Type(Number)`，数字字符串不能通过数字校验
  （`requestTimeoutMs: "5000"` → 400 三条消息）；`@IsOptional()` 同时放行
  `undefined` 与 `null`，两者语义在合并中保持可区分。
- 归档设置 PUT：四个字段必填且带 `@Type(() => Number)`，class-transformer 先跑
  `Number()` 再校验，因此 `"50"` 通过、`""` → `0`（只违反 `Min`）、`true` → `1`
  （**通过**）、`null` **不被转换成 0**（class-transformer 对 null/undefined 直接
  返回原值 → `Max`/`Min`/`IsInt` 三条全失败）、数组/对象一律不是数字。
- Nominatim：`userAgent` 为 `@IsOptional() @IsString() @MinLength(1)`，消息顺序
  `MinLength` → `IsString`；`email` 为 `@IsOptional() @IsString() @IsEmail()`，
  顺序 `IsEmail` → `IsString`。`userAgent: ""` 被 DTO 拒绝；`"   "` 通过
  `MinLength` 再由 service 归一化为 null；`email: ""` 被 DTO 拒绝；未加
  `MaxLength`。

## 5. 实时信号设置：合并、别名与 null 语义

PUT 名为 PUT 实为部分合并：

- **别名保留 nullish-coalescing**：`openskyEnabled ?? adsbEnabled`、
  `openskyIntervalSec ?? adsbIntervalSec`、`openskyBaseUrl ?? adsbBaseUrl`、
  `aisRelayBaseUrl ?? relayBaseUrl`、`aisRelaySharedSecret ?? relaySharedSecret`。
  这些表达式**不能**替换成"字段是否存在"：`openskyBaseUrl: null` 且未传 alias 时
  `null ?? undefined` 为 `undefined`，语义是"保留现值"，与直接 `null` 的清空不同。
  读取侧同样保留两处不同的写法：`openskyBaseUrl` 先对**原始存储成员**做 `??` 再
  归一化，而 `aisRelayBaseUrl`/`aisRelaySharedSecret` 是各自解析后再 `??`。
- 数值：`asBoundedInt` 用 `Math.trunc(Number(value))` 后 clamp，
  `asBoundedNumber` 用 `Number(value)` 后 clamp；`undefined` 或非有限值回退，
  **`null` → `Number(null) === 0` 再被 clamp 到下限**（不是"不修改"）。
- 字符串/密钥：missing 保留当前原始存储值；非别名字符串的 `null`/空白清为 `null`；
  新密钥 trim 后按加密策略编码；**未修改的密文保持原字节**，不重新生成随机 IV；
  密文无法解密时按既有逻辑视为无可用 stored secret 并回退 env，同时保留正确
  `source`。
- URL：新提供的非空 URL 按 WHATWG 等价处理（小写 scheme/host、剥离默认端口、
  删除结尾全部斜杠），只允许 http/https，错误原句
  `<fieldName> must be a valid http(s) URL`（规范字段名 `openskyBaseUrl`、
  `openskyTokenUrl`、`aisRelayBaseUrl`、`polymarketProxyUrl`）；读取历史值只做
  既有 `normalizeUrl`，不新增读取拒绝策略，也**不请求**这些 URL。
- 更新规范化的旧别名迁移、`relayBaseUrl`/`relaySharedSecret` 的 `undefined` 省略、
  历史 `acledAccessToken` 写 `null`、不新增 `updatedById`/`isPublic` 字段，全部按源码；
  SystemSetting 其他元数据更新策略不变（create/update 均写 description，不写
  isPublic/updatedById）。
- 四个跨字段约束与**顺序/原句**：`openskyDailyCreditBudget must be greater than 0`、
  `openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt`、
  `openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct`、
  `openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec`。
  GET 的 effective config 同样调用该校验（不静默修正冲突关系）。
- 环境变量按 `EnvService.realtimeSignalsConfig` 完整透传并解析，env Boolean 与
  `apiEnvSchema` 一致（trim/lower 后 true/1/yes/y/on 为真，false/0/no/n/off 为假，
  空串先按 schema 视为 undefined）。**OpenSky 旧优先级刻意保留**：
  `apiEnvSchema` 已给 `REALTIME_SIGNALS_OPENSKY_ENABLED`/`_INTERVAL_SEC`/`_BASE_URL`
  设了默认值，`get(OPENSKY_*) ?? get(ADSB_*)` 的 ADSB 分支不可达，因此 Go 也不读
  `REALTIME_SIGNALS_ADSB_*`（不"修复"旧行为）。本批为 Go 增加独立 typed defaults，
  未改变既有 Go 采集器字段（`RealtimeSignals*`/`Opensky*`）的语义。

## 6. 公开响应与 `updatedFields`

- 保留 `RealtimeSignalsSettingsPublic` 完整字段（含 `source`、全部规范
  enabled/interval/timeout/retry/预算/阈值、四个 URL、clientId 与全部 has/source、
  `acledApiEnabled`/`acledApiDisabledReason` 与 ACLED token 的可选状态字段）。
  `SecretSource` = `stored|env|none`；clientId/username 照常返回，真正 secret 只公开
  `has`/`source`，响应与审计都不出现明文或密文。
- **审计 `updatedFields` 是常量数组**：target ES2022 且未关 `useDefineForClassFields`，
  TypeScript 把 DTO 的每个声明都编译成 class 字段（编译产物实测 47 个 `name;`），
  所以 `Object.keys(input)` 恒为该 47 项声明序数组，**与请求体无关**。Go 侧写同一
  常量数组，真实栈同时断言 Nest 实际值与 Go 实际值相等。
  `secretsUpdated` 按 `!== undefined` 判断（`null` 也算提供了该字段），metadata 不含
  任何 secret 值。实时设置审计是 awaited，沿用 AuditLog → AuditLogOutbox 失败回退
  与最终错误传播。

## 7. 归档准备设置与归档状态

- 归档设置：四字段（`jobBatchSize` 1..100 默认 20、`embeddingBatchSize` 1..100 默认
  20、`embeddingMaxConcurrency` 1..8 默认 1、`rerankMaxConcurrency` 1..8 默认 1）；
  PUT 是完整四字段替换，**本批不给它加锁**（没有 read-modify-write 窗口）。存储读取
  归一化用 `Number(value)` + `Math.round` + clamp，并保留 JS 半值行为与
  `Number(null) === 0`。PUT upsert 四字段并每次更新 description 与 `isPublic=false`；
  DELETE 只删 `archive_preparation_settings`，不清状态索引、不取消 job、不改分类记录。
- 归档状态（GET `/api/admin/archive-preparation/status`）：zset
  `archive:preparation:status:index`，成员键
  `archive:preparation:status:<scope>:<orgId>:<scopeValue>`，单记录 TTL 3600s，writer
  索引上限 200 条（**writer 政策，Go reader 不新增截断**）。读取顺序为 ZCARD →
  ZRANGE 0..total-1 → MGET → 跳过过期 null → orgId 缺失时按旧 key 第 5 段回退 →
  只保留当前 orgId → reverse。reader 不写入、不裁剪、不续租、不删除记录，也不按
  `updatedAt` 重排或用 BullMQ delayed zset"修正" `delayed=0`。
- 计数口径：`QUEUED`→waiting，`PROCESSING`/`PARTIAL`→active，`READY`→completed，
  `FAILED`→failed，`IDLE`/其他未知值不加任何计数，`delayed` 恒 0；`pending =
  waiting + active + delayed`。counts 覆盖整份快照，`recentStatuses` 最多 10 条。
- 响应不含 `orgId`、Redis key、`traceId` 或原始 queue payload；`errorMessage` 缺失为
  `null`、空串保留；输出前做 DS3 脱敏。

## 8. DS2 两把全局锁与 DS3/DS4

**DS2 跨实例部分更新丢失**

- 证据：`realtime-signals-settings.service.ts` 从 Redis
  `loadStoredSettings()` 取合并基准后整体 upsert；
  `geo-nominatim-settings.service.ts` 读 `current` 后整体 upsert，均无跨实例锁。
  两个不同字段的并发 PUT 会互相覆盖，实时设置还会用旧缓存把另一实例刚写的字段回滚。
- 修法（Nest）：新增 `data-runtime-settings.lock.ts`，只包装既有
  `withMysqlSessionLock`（未改底层协议），提供两把**全局**锁
  `data-runtime-settings:realtime:v1`、`data-runtime-settings:nominatim:v1`（无 orgId
  后缀）。实时 `updateSettings`/`resetToEnv` 共用 realtime 锁；geo `updateSettings`
  用 nominatim 锁；门禁在锁之前；不嵌套加锁。锁覆盖 DB 写入及本方法必要的 cache
  失效/更新；geo 的 fire-and-forget 审计差异保留。
- 失败的映射：`GET_LOCK` 未取得 → 409，文案
  `Realtime signals settings are being updated by another request; retry later` /
  `Nominatim identity settings are being updated by another request; retry later`；
  连接/握手/协议异常 → 503 `{statusCode:503,message:"Internal server error",
  error:"Service Unavailable"}`；业务 `HttpException` 原样上抛，不被覆盖。
- 修法（Go）：`*sql.Conn` 专用连接 `GET_LOCK(name,10)`，不在 `db.Exec` 取锁后换连接
  释放；释放使用 `context.WithoutCancel` + 独立 5s 超时，请求取消也能清理；
  事务提交前不释放；`GET_LOCK` 返回 0 → 409（域内文案），NULL/查询失败 → 503；
  `RELEASE_LOCK` 未确认成功时用 `driver.ErrBadConn` 驱逐物理连接。
- 合并基准：实时设置锁内从 `loadStoredSettingsFromDB()` 取原始配置；geo 锁内从
  `loadOverridesFromDB()` 取；都不使用 Redis、进程缓存或公开脱敏响应。

**DS3 归档公开错误缺少脱敏**

- 证据：`archive-preparation.processor.ts` 把 worker `error.message` 传给
  `markFailed`；`archive-preparation-queue.service.ts` 的 `getStatus` 与
  `toPublicStatusRecord` 原样输出 `errorMessage`。
- 修法：仅公开读取输出调用既有 `redactSensitiveFields`（Nest 用 `@modular/utils`，Go
  复用 `adminlogs.RedactSensitiveFields`，不复制第二套正则），覆盖两个公开映射。
  不改 worker、不改 Redis 原文、不删诊断字段；普通文本不变，`null`/空串语义保留。

**DS4 同一状态响应两次取数**

- 证据：`archive-preparation-queue.service.ts` 先 `getRecentStatuses` 再
  `getScopedCounts`，两者各自重新 ZRANGE/MGET；worker 在两次读取之间更新状态时列表
  与计数可互相矛盾。
- 修法：`getOperationalStatus` 只取**一份** org-scoped 记录快照，用它同时派生
  `recentStatuses` 与 `counts`，保持排序、最多 10 条、计数映射与 pending 公式。
  只保证"一次请求使用同一份已读取结果"，不宣称 ZRANGE/MGET 是整索引原子事务，
  不增加 Lua 全局锁、不锁 worker、不改写入协议。

## 9. 加密协议与 ACLED 固定政策

- 信封 `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":base64,"tag":base64,
  "data":base64}`：32 字节 key、12 字节随机 IV、16 字节 tag 独立保存、无 AAD。
  key 支持可选 `0x` 前缀的 64 位 hex 或 Node 兼容 base64。策略与 Nest 完全一致：
  valid key + `secretEncryptionEnabled !== false` → 加密；显式 `false` → 明文逃生舱；
  显式 `true` 无 key → 400 `Secret encryption is enabled but
  SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured`；`true` 且 key 存在但非法 → 400
  `... is missing or invalid (<解码错误>)`；生产无 key 且未显式关闭 → 400
  `SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production`；
  非生产无 key 且未显式开启 → 保留明文回退与 warning。`system_security:settings`
  缓存 TTL 60s、`{exists,value}` 信封、本批只读。
- ACLED 固定关闭：`acledApiEnabled=false`、`acledApiDisabledReason="Open myACLED
  does not include API access."`、`hasAcledAccessToken=false`、
  `acledAccessTokenSource=none`、`acledAccessTokenStatus=missing`，不可达状态字段按
  `undefined` 省略。**即使 DB 仍存历史 token/auth-state 也不报告 ready**，不读取它们
  偷偷启用 OAuth，不移植未执行的 refresh 网络代码，不调用 ACLED/OpenSky/AIS/
  Cloudflare/Wingbits/Polymarket。DELETE 同时删除 `realtime_signals_settings` 与
  `realtime_signals_acled_auth_state` 并失效两个缓存。

## 10. 回滚

只把 `API_GO_DATA_RUNTIME_SETTINGS_MODE` 改回 `legacy`（或删除该变量）并重启
api-go：九条恢复经 Go 网关代理到 NestJS。无数据迁移耦合——Nest 与 Go 读写同一个
`SystemSetting` 行与同一 Redis 键，加密信封格式相同。Web 入口不变、canary 仍关闭。

## 11. 未验证 / 刻意不做

- **外部实网未验证**：未访问 ACLED、OpenSky、AIS/relay、Cloudflare、Wingbits、
  Polymarket、Nominatim 或任何模型/地理编码上游；本批没有调用这些服务的代码路径。
- 配置可读性只以 HTTP + DB/Redis 断言证明，**不代表任何上游调用成功**。
- 归档状态是 Redis 派生状态记录，不是 BullMQ 实时 job counts；`delayed` 按现状恒 0。
- Nominatim 的 30 秒进程缓存是刻意保留的已知行为：一个实例写入后，其他实例 GET
  最多 30 秒仍可能返回旧值；真实栈用"31 秒后比较"而非改造缓存来验证。
- `validator.js` 邮箱校验移植覆盖常见形式（长度、本地部分字符集、FQDN/TLD 规则、
  引号本地部分），未逐一比对带转义控制字符的引号本地部分、punycode 变体与 IP 字面量
  域名的极端输入。
- URL 规范化覆盖 common-case http/https；未比对非 ASCII IDN host 的 Node WHATWG
  IDNA 行为。
- 本机未执行任何构建、测试、docker 或服务启动；全部执行验证在 GitHub Actions。

## 12. 远端验证

- **普通 CI**（`.github/workflows/ci.yml`）：lint、typecheck、web 覆盖率、vector
  单测、API Vitest、OpenAPI 漂移、auth-matrix 漂移、SDL 漂移、api-go `go test`、
  compose 镜像 pin、Build 全部 success（controller/DTO 未改，生成契约预期不变）。
- **真实栈 smoke**
  （`.github/workflows/api-go-data-runtime-settings-smoke.yml`，label
  `api-go-data-runtime-settings-smoke` 或 workflow_dispatch）：真实
  MySQL 8.4 + Mongo 7 + Redis 7，真实 migration/seed 与 Nest 登录，阶段覆盖：
  - 阶段 0：真实 `/api/auth/login` 四个身份（平台管理员 P、org A/B 普通管理员、
    无 `settings.manage` 用户）+ 两枚机器令牌 + 归档状态 fixture（org A 12 条以上、
    org B 1 条、同 score 两条、旧无 orgId 一条、索引残留一条、含敏感模式错误文本）；
  - 阶段 1：开关四态与非法值启动失败原句；legacy 下九条经 Go 代理与 Nest 直连
    逐条比对（状态码 + 完整 JSON + DB 行）；
  - 阶段 2：go 接管后九条再次逐条比对；未迁相邻路径仍来自 NestJS；DS1 五条写对
    org 管理员与机器令牌 403 且无 DB/cache/audit 副作用；四条 GET 不加门禁；无权限
    403 契约；非法 DTO 先 400；四个跨字段约束原句；别名/null/数值下限/source
    default/env/db；审计 `updatedFields` 精确 47 项数组与 `secretsUpdated` 掩码；
    动态授予/撤销平台角色即时生效；DS2 缓存预热后的 DB 权威合并（双向 + 交叉 + geo
    双字段）与真实 MySQL 持锁 409/释放恢复；DS3/DS4 归档状态计数、排序、同 score、
    旧 orgId 回退、org 隔离、脱敏与 Redis 原文不变；加密策略矩阵（Nest↔Go 互通、
    未修改密文原字节、显式 false 逃生、生产无 key 400、错 key 降级）；
    geo 30 秒进程缓存保留并到期后两侧一致；geo 异步审计有界轮询；
  - 阶段 3：停 NestJS（确认进程停止、端口不可达）后以**全新 Go 进程**清缓存读
    MySQL/Redis 非空 fixture，九条独立服务、五条写仍受门禁、配置更新/reset/缓存
    失效/审计真实发生、撤销 JWT 401，未迁路径
    `geo/nominatim/test`、`/api/geo/geocode`、`situation-monitor`、
    `external-snapshot/refresh` 均 502；
  - 阶段 4：改回 legacy 后九条重新代理到停机中的 NestJS（502），重启 Nest 后再次
    逐条比对，无数据迁移。
- 运行 URL、head SHA 与 conclusion 记录在本 PR 描述与 Actions 页面；本文件不复制
  它们，避免文档与最终 head 漂移。
