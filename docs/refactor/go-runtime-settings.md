# 运行时与治理设置（Go 接管）

本批把 `/api/system-settings` 下七个运行时 / 治理设置子域的十八条 HTTP 从
NestJS 迁到 `apps/api-go`，默认仍由 NestJS 响应。开关
`API_GO_RUNTIME_SETTINGS_MODE` 默认 `legacy`，只有显式设为 `go` 时这十八条
才由 Go 执行。回滚只改这一个开关。

Go 侧实现：`internal/legacyproxy/runtime_settings_routes.go`（路由规则）、
`internal/runtimesettings/`（handler / 鉴权 / 七个域的服务）、
`cmd/api/runtime_settings.go`（装配）。整包只用命名的强类型 struct 与具名的
字符串 / 切片类型：`json.RawMessage` 只在“存储值本身没有 schema”的边界出现
并随即解码成具名 struct；非 struct 的容器只有两处——具名接口
`encodedResponse`（响应自渲染）与 Redis `HGETALL` 返回的
`map[string]string`（键值都是 string，仅用于指标行聚合）。**没有 `any`、
`interface{}` 或 `map[string]any`**；GoDoc 注释一律英文。

## 开关与路由

`API_GO_RUNTIME_SETTINGS_MODE` 只接受空字符串、`legacy` 或 `go`（空串与
`legacy` 等价；其他值让**进程启动失败**，错误文本是
`API_GO_RUNTIME_SETTINGS_MODE must be one of legacy|go`）。`go` 时要求
`JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`（缺一即启动失败，错误文本形如
`JWT_SECRET is required when API_GO_RUNTIME_SETTINGS_MODE=go`）；**不要求
`MONGO_URI`**，不启动 worker / 定时任务，不打开 shadow。

`go` 时由 `WithRuntimeSettings` 追加十八条精确规则（`:feature` 恰好一段）：

| 方法 | 路径 | 子域 | 权限 | 成功 |
| --- | --- | --- | --- | --- |
| GET | `/api/system-settings/rate-limit-policies` | 限流策略 | `settings.manage` | 200 |
| POST | `/api/system-settings/rate-limit-policies` | 限流策略 | `settings.manage` | 201 |
| GET | `/api/system-settings/rate-limit-policies/:feature` | 限流策略 | `settings.manage` | 200 |
| PUT | `/api/system-settings/rate-limit-policies/:feature` | 限流策略 | `settings.manage` | 200 |
| DELETE | `/api/system-settings/rate-limit-policies/:feature` | 限流策略 | `settings.manage` | 200 |
| GET | `/api/system-settings/rate-limits` | 全局限流桶 | `settings.manage` | 200 |
| PUT | `/api/system-settings/rate-limits` | 全局限流桶 | `settings.manage` | 200 |
| GET | `/api/system-settings/auth-cache` | 鉴权缓存 | `settings.manage` | 200 |
| PUT | `/api/system-settings/auth-cache` | 鉴权缓存 | `settings.manage` | 200 |
| GET | `/api/system-settings/audit-log` | 审计日志保留 | `settings.manage` | 200 |
| PUT | `/api/system-settings/audit-log` | 审计日志保留 | `settings.manage` + 平台管理员 | 200 |
| GET | `/api/system-settings/multi-tenant-schedulers` | 多租户调度 | `settings.manage` | 200 |
| PUT | `/api/system-settings/multi-tenant-schedulers` | 多租户调度 | `settings.manage` | 200 |
| GET | `/api/system-settings/news-source-scheduler` | 新闻源调度 | `settings.manage` | 200 |
| PUT | `/api/system-settings/news-source-scheduler` | 新闻源调度 | `settings.manage` | 200 |
| GET | `/api/system-settings/newsnow-personalization` | NewsNow 个性化 | `settings.manage` | 200 |
| PUT | `/api/system-settings/newsnow-personalization` | NewsNow 个性化 | `settings.manage` | 200 |
| GET | `/api/system-settings/newsnow-personalization/metrics` | NewsNow 指标 | `settings.manage` | 200 |

注册顺序与形态是语义的一部分：`/newsnow-personalization/metrics` 比
`/newsnow-personalization` 更长，必须先声明才能赢最长前缀匹配；`:feature`
恰好一个非空路径段，所以 `/rate-limit-policies` 自身与任何更长路径都不会
落进动态规则。DELETE 的成功体是 `{"ok":true}`。

**其他 `/api/system-settings/*` 全部仍代理 NestJS**，包括
`GET /api/system-settings/security`，以及 email、task-logs、llm-gateways、
vector-service、archive-preparation、assistant-quota、assistant-safety、
realtime-signals/runtime、llm-request-logs 等；Go 不返回自己的 404。预检
`OPTIONS` 由 Go 的 CORS helper 直接应答，非预检 `OPTIONS` 仍代理 legacy。

生产 Web 仍是 Web → NestJS；canary 保持关闭（路由表没有任何 `ModeCanary`
条目）；**未启用 shadow**。回滚：**只把 `API_GO_RUNTIME_SETTINGS_MODE` 改回
`legacy`**（纯配置变更；`legacy` 时不注册 handler、不追加规则、不额外打开
任何连接）。

## 鉴权

十八条统一要求 `settings.manage`，与 NestJS 的 Guard 链一致：

- 缺少 `Authorization` 或不是 Bearer → 401；
- `mtk_` 前缀 → 机器令牌路径：SHA-256 十六进制查
  `MachineAccessToken.tokenHash` 并连 `Org.isActive`，撤销 / 过期 / 组织停用
  → 401 `Invalid machine token`，命中后刷新 `lastUsedAt`；权限与 `orgId` 只
  来自令牌行；
- 其他 token → `authhttp.Authenticate`：JWT 验签 + Redis 撤销名单 +
  membership 重推导。人类 `orgId` 与权限来自 membership 重推导，**不看
  JWT 的 permissions claim，也不看 body / query 里的 `orgId`**；
- 缺少 `settings.manage` → 403 `INSUFFICIENT_PERMISSIONS`。

`PUT /api/system-settings/audit-log` 在 `settings.manage` 之外还要求当前用户
是平台管理员（`GlobalRoleAssignment.role = 'platform_admin'`），否则 403
`Platform admin access required`。机器令牌永远不能满足这一条（
`GlobalRoleAssignment.userId` 是 `User(id)` 外键）；GET 只要求
`settings.manage`。

## 读接口

- `GET /rate-limit-policies`：按 `feature asc` 列出全部策略，响应恒为数组
  （无行时是 `[]`，不是 `null`）。
- `GET /rate-limit-policies/:feature`：Redis 优先（缓存里存了 `null` 也表示
  “不存在”），未命中查 MySQL 并回写 60 秒缓存；不存在 → 404
  `Rate limit policy not found`。`feature` 先 `trim().toLowerCase()` 再按
  `^[a-z][a-z0-9_.]*$` 校验，非法 400 `Invalid rate limit feature name`。
- `GET /rate-limits`：三个桶 `login` / `crawlCreate` / `rbacWrite`，Redis
  命中先重新归一化；MySQL 读失败时**直接返回环境原始默认值，不让请求失败**
  （与 Nest 的容错一致）。行缺失时返回未 clamp 的 env 原值。
- `GET /auth-cache`：`profileTtlSeconds` / `lockTtlMs` / `maxWaitMs` /
  `retryDelayMs` 四个键；行缺失返回 env 原值；此路径**不容错**，Redis 或
  MySQL 失败直接冒泡到过滤器。
- `GET /audit-log`：`{retentionDays}`；前面有一层与 Nest 相同的 30 秒
  进程内缓存。存储值接受裸 JSON 数字或 `{"retentionDays": n}`，其他形状回落
  env 默认值（`AUDIT_LOG_RETENTION_DAYS`，默认 90，归一化到 [1, 3650]）。
- `GET /multi-tenant-schedulers`：`source` + 十一个并发值。无行 →
  `source:"default"` + 默认值；有行则逐字段校验，**出现但非法**的字段让整条
  记录 409（fail-closed，不自愈）。
- `GET /news-source-scheduler`：`source` + 十五个值，带 30 秒进程内缓存；
  行存在但任一字段非法或违反交叉规则 → 409。
- `GET /newsnow-personalization`：`source` + 十个值；无行 → 默认；有行按
  字段规则与权重约束校验，非法 → 409。
- `GET /newsnow-personalization/metrics`：每 UTC 日一个 Redis hash，按日期
  升序输出 `windowDays` 行（`from`/`to`/`windowDays`/`totals`/`rows`）。
  `days` 参数缺省 7、非有限数 7、`floor` 后收口到 [1, 90]；重复传参当
  缺省。单日 Redis 读失败只记日志并输出全零行，不让请求失败。

## 写接口

- `POST /rate-limit-policies`：创建成功 201；`feature` 先按 DTO 校验，
  服务层再 `trim().toLowerCase()` 并二次校验；`description` 归一化后写入
  （见下）。与已存在 feature 冲突 → 409
  `Rate limit policy already exists for <feature>`。
- `PUT /rate-limit-policies/:feature`：patch 语义，未提供的字段保留库内值；
  行在读写之间消失（Prisma `P2025`）→ 404
  `Rate limit policy not found for <feature>`。
- `DELETE /rate-limit-policies/:feature`：成功 200 `{"ok":true}`；删掉 0 行
  → 404 同上（修复 Prisma `P2025` 未捕获 500）。
- `PUT /rate-limits`：三条 upsert 在**同一事务**内提交，然后写审计、刷新
  缓存；缺省的桶回落到 env 原始默认值。
- `PUT /auth-cache`：四个字段都必填，归一化后 upsert、best-effort 审计、
  awaited 缓存刷新。
- `PUT /audit-log`：`retentionDays` 必填、`floor` 后收口 [1, 3650]；upsert
  裸数字、best-effort 审计、刷新进程内缓存。
- `PUT /multi-tenant-schedulers`：**整条替换**，缺省的可选字段写回默认值
  （不是 patch）。响应 `source:"db"`。
- `PUT /news-source-scheduler`：十五个字段全必填；写成功后 best-effort 按
  顺序删四个 Redis 前缀 `news-source:sitemap:` / `news-source:rss:` /
  `news-source:list:` / `news-source:deep:`。
- `PUT /newsnow-personalization`：整条替换 + 权重交叉规则。

写路径的 description 语义：audit-log、auth-cache 与三个限流桶只在与 Prisma
create 对应的 INSERT 分支写 description（已存在的行保留旧值）；多租户调度、
新闻源调度与 NewsNow 个性化三个域在 UPDATE 分支也覆盖 description，对应
`upsertSettingForceDescription`。

### SystemSetting 主键

`rate_limit_login`、`rate_limit_crawl_create`、`rate_limit_rbac_write`、
`auth_profile_cache_settings`、`audit_log_retention_days`、
`multi_tenant_scheduler_runtime_settings`、`news_source_scheduler_settings`、
`newsnow_personalization_settings`。七个域各占一行全局记录，`SystemSetting`
没有 org 维度。

### Redis 键与 TTL

| 键 | 写入方 | TTL |
| --- | --- | --- |
| `rate_limit_policy:<feature>` | 策略读写路径 | 硬编码 60 秒 |
| `rate_limit:settings` | `GET/PUT /rate-limits` | `RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS`，缺省 / ≤0 时 60 秒 |
| `auth_cache:settings` | `GET/PUT /auth-cache` | 硬编码 60 秒 |
| `newsnow:personalization:metrics:v1:<YYYY-MM-DD>` | 聚合器写 hash，Go 只 `HGETALL` 读 | 由聚合器设定，Go 不设 |

## 错误契约

- **400 交叉规则**：新闻源调度在读写两侧共用三条规则，写路径错误正文就是
  下面三句之一（读路径命中时换成对应的 409）：
  - `rssAdaptiveWarmHitRatePercent must be less than or equal to rssAdaptiveHotHitRatePercent`
  - `rssAdaptiveColdMaxIntervalSeconds must be greater than or equal to rssAdaptiveWarmMinIntervalSeconds`
  - `rssAdaptiveWarmDiscoveryCacheTtlCapSeconds must be greater than or equal to rssAdaptiveHotDiscoveryCacheTtlCapSeconds`
  其余 DTO 校验复刻 class-validator 的默认措辞并按声明顺序用 `"; "` 拼接；
  未知字段 400 `property <name> should not exist`；非法 JSON 400
  `Unexpected token in JSON body`；超过 10 MiB 体上限的响应与 Nest 生产环境
  一致是 500 `Internal server error`。
- **409（带安全 code 的存储值冲突）**——`{statusCode, message, error:"Conflict", code, detail}`：
  - `MULTI_TENANT_SCHEDULER_SETTINGS_INVALID` /
    `Stored multi-tenant scheduler runtime settings are invalid.` /
    detail `Multi-tenant scheduler concurrency settings must be integers between 1 and 16.`
  - `NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID` /
    `Stored news source scheduler settings are invalid.` /
    detail `seedFreshnessWindowDays must be an integer between 1 and 3650; seedCacheTtlSecondsSitemapRss and seedCacheTtlSecondsListDeep must be integers between 10 and 3600; seedCacheTtlForceGlobal must be a boolean; seedUrlQueryParamAllowlist must be an array of valid query keys; rssAdaptive* settings must be within configured integer ranges and satisfy warmHitRate<=hotHitRate, warmCacheTtlCap>=hotCacheTtlCap, coldMaxInterval>=warmMinInterval.`
  - `NEWSNOW_PERSONALIZATION_SETTINGS_INVALID` /
    `Stored NewsNow personalization settings are invalid.` /
    detail `Expected valid values for cacheTtlMs/maxCacheEntries/throttleWindowMs/maxRequestsPerWindowPerUser/affinitySourceWeight/behaviorSourceWeight/focusSourceBonus/staleTtlStrategy/staleTtlMultiplier/staleTtlFixedMs.`
- **409（业务冲突）**：重复创建策略
  `Rate limit policy already exists for <feature>`。
- **400（扁平服务层）**：多租户调度“出现但非法”的可选字段
  `<field> must be an integer between 1 and 16`；NewsNow 的
  `<field> must be an integer between <min> and <max>` /
  `<field> must be a number between <min> and <max>` /
  `staleTtlStrategy must be one of multiplier, fixed` /
  `affinitySourceWeight + behaviorSourceWeight must be greater than 0`。
- **404**：`Rate limit policy not found for <feature>`（update / delete 路径）。
- **鉴权失败**：401；缺权限 403 `INSUFFICIENT_PERMISSIONS`；`settings.manage`
  之外的平台管理员检查失败 403 `Platform admin access required`。
- **基础设施失败 fail-closed**：Redis 查询失败 → 500
  `Internal server error`；MySQL 连接类失败 → 503 同形状。

## 缺陷修复（Nest 与 Go 两侧同修）

1. **机器令牌写入 NULL actor**：`SystemSetting.updatedById`、
   `RateLimitPolicy.updatedById` 与 `AuditLog.actorId` 都是指向
   `User(id)` 的外键，而机器令牌身份是 `machine:<tokenId>`。原实现把它原样
   写库，MySQL 报外键错误 1452，接口变成 500。修复后
   `nullableActorID` 把 `machine:` 前缀（以及空串）统一转成 SQL `NULL`；
   `AuditLogOutbox` 的 `actorId` 同样写 `null`。
2. **`description` 无法清空**：Prisma 的 `undefined` 表示“保持不变”，因此
   此前显式传 `description: ""` 也清不掉旧值。修复后是三态：**键缺失 = 保留
   旧值**；**键存在且是 `""` / 纯空白 / `null` = 清成 SQL `NULL`**；其他值
   `trim` 后写入。
3. **并发创建 / 删除**：存在性检查与 INSERT 之间的并发插入会撞唯一键。修复后
   MySQL 1062（Prisma `P2002`）统一收成 409
   `Rate limit policy already exists for <feature>`；update / delete 期间行被
   并发删除（Prisma `P2025`）收成 404
   `Rate limit policy not found for <feature>`，不再是未捕获 500。

## 未做 / 边界

- 不改前端，不改 Web 的 API 地址；生产 Web 仍指向 NestJS。
- 不打开 canary，**未启用 shadow**；不改其他 `API_GO_*` 的默认值。
- `GET /api/system-settings/security` 与其余全部 `/api/system-settings/*`
  仍在 NestJS（本开关只管十八条）。
- 不新增表、不启动 worker / 调度任务，不接 Mongo。
- 不处理 FE-TPL-02。
- **SEC-01 的真实登录态未在本批验证。**

## 验证

- 普通 CI：lint / typecheck / `api-go` 单测（路由规则测试 + 七个域的归一化、
  缓存键、错误文案与并发收口测试）。
- 契约比对以 Go handler 直连与 NestJS 直连逐字节对照为准；真实栈 smoke 不进
  普通 CI，需手动触发。
