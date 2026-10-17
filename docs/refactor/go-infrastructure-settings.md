# 基础设施连接与采集运行凭据配置迁入 Go（7 条 HTTP）

分支 `refactor/go-infrastructure-settings`；基线 `origin/main`
`b89c35a85998512392e32566ccd96b2766f65441`（普通 CI run 39051652549 success）。
独立开关 `API_GO_INFRASTRUCTURE_SETTINGS_MODE`（空串/`legacy`/`go`，默认
`legacy`，非法值启动失败）。生产入口继续 Web → NestJS，Nest 全部保留，
canary 关闭，不启用 shadow，不改前端。

## 1. 七条路由与 Go 接管边界

| # | 方法 | 精确路径 | 权限 | 平台门禁 | 成功码 |
|---|---|---|---|---|---|
| 1 | GET | `/api/system-settings/vector-service` | `settings.manage` | 否 | 200 |
| 2 | PUT | `/api/system-settings/vector-service` | `settings.manage` | 是（Nest 原已存在） | 200 |
| 3 | DELETE | `/api/system-settings/vector-service` | `settings.manage` | 是（Nest 原已存在） | 200 |
| 4 | GET | `/api/admin/settings/storage` | `settings.manage` | 否 | 200 |
| 5 | PATCH | `/api/admin/settings/storage` | `settings.manage` | 是（本批补齐，IS1） | 200 |
| 6 | GET | `/api/system-settings/news-source-runtime-secrets` | `settings.manage` | 否 | 200 |
| 7 | PUT | `/api/system-settings/news-source-runtime-secrets` | `settings.manage` | 是（本批补齐，IS1） | 200 |

全部为 exact path + method 白名单（`WithInfrastructureSettings`，处理器注册键
`InfrastructureSettingsKey = "/api/system-settings#infrastructure"`）。不注册
整段前缀：尾斜杠、HEAD、其他方法、相似前缀（`vector-service-extra`）与多一段
路径全部回落 `/api/` legacy。OPTIONS 由既有 `policy.FinishOptions` 回答预检；
非预检 OPTIONS 仍 `ServeLegacy`。

明确留在 Nest（本批不迁）：

- `GET /api/system-settings/vector-service/diagnostics`（失败次数/熔断时间来自
  Nest 进程内状态，不伪造 Go 零值诊断）；
- `POST /api/admin/settings/storage/test`（真实 S3 HeadBucket/PutObject/
  DeleteObject，不模拟成功）；
- 所有向量检索/upsert/去重/回填、所有 S3 上传下载签名删除、新闻源实际抓取与
  `getSecretsForSource` 消费者链路、模型服务与密钥分发、GraphQL、BullMQ、
  定时调度器。

## 2. 认证、权限与平台门禁

- 人类：复用 `authhttp` 验签 + Redis 撤销名单 + MySQL membership/permission
  重推导；不信任 JWT 的 permissions 或自称平台角色。
- 机器令牌（`mtk_`）：原文 SHA-256 查 `MachineAccessToken`，校验
  `revokedAt`/`expiresAt`/`Org.isActive`，更新 `lastUsedAt`，身份为
  `machine:<tokenId>`。三个 GET 有 `settings.manage` 即可读；四条写一律 403，
  且 `updatedById`/`actorId` 写 SQL NULL（绝不写 `machine:<id>` 触发外键 500）。
- 平台门禁：`GlobalRoleAssignment.userId = 真实 User.id` 且
  `role = 'platform_admin'`，失败 403 `Platform admin access required`。平台角色
  不能替代 `settings.manage`。
- 顺序固定：认证 → `settings.manage` → DTO → 平台门禁 → 业务。DELETE 无 DTO，
  门禁紧跟权限检查。空 body / 空数组 / 无实际变更同样先授权。
- 无权限响应：`code=INSUFFICIENT_PERMISSIONS`、`message=Insufficient permissions`、
  `detail=Requires any permission: settings.manage`、
  `requiredPermissions=["settings.manage"]`、`permissionsMode="any"`，无
  `missingPermissions`。`GlobalExceptionFilter` 的
  `statusCode/message/error/traceId/path/timestamp` 保留。

## 3. 三种缓存差异（刻意保留，未统一）

| 域 | Redis 键 | TTL | 形状 | 管理 GET 是否读缓存 |
|---|---|---|---|---|
| 向量服务配置 | `vector_service:settings` | 30s | `{"exists":bool,"value":{...}}` 信封 | 是（写路径另读 DB，见 IS3） |
| 存储配置 | `storage:settings` | 60s | 以完整 DB key 为属性名的直接对象，缺失键省略，JSON null 保留 | 是 |
| 新闻源运行凭据 | 无 | — | 无 | 否（原实现是 Nest 进程内缓存，最长 30,000ms） |

- IS2 之后，运行凭据的管理 GET 与 PUT 合并基准一律读 MySQL；
  `getSecretsForSource` 等既有消费者仍保留最长 30 秒进程缓存与降级语义
  （不迁移消费者，也不宣称 Go 写入后所有 Nest worker 立即刷新）。Nest 写后仍
  调用已有 `invalidateCache()`。Go 管理路径不新增进程缓存，也不新增 Redis 版本键。
- 向量/存储的缓存 get/parse/set/del 失败都按既有 try/catch 安全回退到 DB；
  这条降级只针对设置缓存，绝不扩展到认证撤销检查（撤销检查始终 fail-closed）。
- 加密策略读取全局 `SystemSetting` key `system_security` 与 Redis
  `system_security:settings`（30 秒 `exists/value` 信封），**只读**：Go 不写该键、
  不写该行。

## 4. 存储配置的九个 key 与 isPublic

| 输入字段 | SystemSetting key | isPublic |
|---|---|---|
| crawlImageStorage | `crawl_image_storage` | true |
| accessKeyId | `storage_s3_access_key_id` | false |
| secretAccessKey | `storage_s3_secret_access_key` | false |
| region | `storage_s3_region` | true |
| bucket | `storage_s3_bucket` | true |
| endpoint | `storage_s3_endpoint` | true |
| publicBaseUrl | `storage_s3_public_base_url` | true |
| forcePathStyle | `storage_s3_force_path_style` | true |
| presignedUrlTtlSeconds | `storage_s3_presigned_url_ttl_seconds` | true |

- create 写入 `description = "Storage configuration"`；update 保留既有 description。
- 同一个 PATCH 的全部有效更新在同一 MySQL 事务内提交，不做逐条 autocommit。
- `updatedById = 平台管理员真实 User.id`。
- 不新增表、不改 schema、不加锁（存储 PATCH 按字段事务更新；不相交字段的并发
  更新不会整体覆盖对方）。

## 5. 向量配置：token 四态与 baseUrl

- 公共响应恒含全部字段；`baseUrl` 无值时为 `null`。
  `source=env|db`，`tokenSource=stored|env|none`。绝不返回 token、密文或指纹。
- 环境变量默认：`VECTOR_SERVICE_ENABLED=false`、
  `VECTOR_SERVICE_FALLBACK_TO_MONGO=true`、`VECTOR_SERVICE_BASE_URL` 未配置、
  `VECTOR_INTERNAL_TOKEN` 未配置、`VECTOR_SERVICE_TIMEOUT_MS=5000`、
  `VECTOR_SERVICE_MAX_RETRIES=2`。
- PUT DTO 声明顺序与消息顺序逐一对照 class-validator 0.14.2：
  `enabled`/`fallbackToMongo`（必填 boolean）、`baseUrl`/`token`（可省略/null，
  否则 string）、`timeoutMs`（必填整数 ≥100，Min → IsInt）、`maxRetries`
  （必填整数 0..10，Max → Min → IsInt）。无任何数字/boolean 隐式转换。
- **token 四态**：absent 保留**锁内 DB**当前 token；`null`/空串/纯空白存 `null`
  并允许 env 回退；非空 string 先 trim 再按加密策略编码。不用 `*string` 合并
  absent 与 null。
- baseUrl：省略/null/空白存 `null`，有效值按 Node WHATWG URL 规范化（仅
  http/https，端口 [0,65535]，默认端口剥离，最后只删除一个尾部 `/`），错误
  400 `baseUrl must be a valid http(s) URL`。
- `enabled=true` 时先校验 effective baseUrl（`baseUrl is required when vector
  service is enabled`），再校验 effective token（`token is required when vector
  service is enabled`），均为 400 且失败无写入。
- 审计：`resource=system_settings`、`action=vector_service_update`，metadata
  仅 `enabled/fallbackToMongo/baseUrl/timeoutMs/maxRetries/tokenUpdated/
  tokenConfigured`；DELETE 为 `vector_service_reset` + `{"ok":true}`；均不含 token。

## 6. 存储清空字段的 JSON null（IS4）与 strict 400/409

- `endpoint`：absent 不改；`null` 写 JSON 字面量 null；合法 URL 字符串 trim 后写入。
- `forcePathStyle`：absent 不改；`false` 必须写入；`null` 写 JSON null。
- `presignedUrlTtlSeconds`：absent 不改；合法数字写入；`null` 写 JSON null。
- Nest 顶层业务 null 使用 `Prisma.JsonNull`（不是 `Prisma.DbNull`，也不删行）；
  Go 向 JSON 列写 `null` 字面量，不传 SQL NULL。远端断言
  `JSON_TYPE(value)="NULL"` 且 `value IS NULL` 为 false。
- 审计 metadata 内的 null 仍是普通 JSON null，绝不序列化 Prisma 哨兵对象。
- 运行凭据 strict 持久化解析保留混合 400/409：统一 409 载荷
  `code=NEWS_SOURCE_RUNTIME_SECRETS_INVALID`、`message=Stored news source runtime
  secrets are invalid.`，detail 按分支为 `Expected object with entries array.` /
  `Unsupported version for runtime secrets settings.` / `entries must be an array.` /
  `entries contains invalid object.` / `Invalid value type for <sourceId>.<key>.`；
  损坏的 sourceId/key 仍走业务 400（`String(raw.field ?? "")` 后再归一化），
  不静默过滤坏项，也不被一次 PUT 当作空配置覆盖。

## 7. 加密协议与指纹差异

- 信封：`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":base64,
  "tag":base64,"data":base64}`；32 字节 key、12 字节安全随机 IV、16 字节 tag 独立
  保存、data 不含 tag、无 AAD。key 支持可选 `0x` 前缀的 64 位 hex 或 Node 兼容
  base64（解码后 32 字节）。
- 策略与 Nest 完全一致：valid key + `secretEncryptionEnabled` 非 false → 加密；
  `configured=false` → 明文；`configured=true` 且 key 存在但非法 → 400
  `Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or
  invalid (<解码错误>)`；`configured=true` 且 key 缺失 → 400 `... is not configured`；
  无 key 且未要求加密时，`NODE_ENV` 精确等于 `production` → 400
  `SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production`，
  否则保留明文 fallback 与安全 warning。
- 三个域的解密降级差异刻意保留：向量解密失败回退 env 且无公共 flag；存储回退 env
  并置 `secretDecryptionFailed=true`；运行凭据公共 GET 不为展示元信息解密。
- 指纹：运行凭据条目为 SHA-256(UTF-8) hex **前 16 位**（不是 OpenAI 密钥的 64 位
  完整指纹）；存储审计的 accessKeyId 为 trim 后 **前 4 个 UTF-16 code unit** + `***`，
  secretAccessKey 值写 `***`。审计与日志都不出现完整 secret 或完整 accessKeyId。
- 存储管理 GET 的 `accessKeyId` 保持原有展示契约：返回完整配置 ID，不改成指纹。

## 8. 两把全局锁

- `infra-settings:vector-service:v1`：向量 PUT 与 DELETE 共用。
- `infra-settings:news-source-runtime-secrets:v1`：运行凭据 PUT。
- 两把锁都不带 orgId/userId 后缀（全局单例），也不与模型配置批次的锁名混用。
- 协议：`GET_LOCK(name,10)` 返回 1 才继续；专用会话持锁至 DB 提交、审计处理与
  缓存失效完成；不用进程 mutex、Redis 租约或仅存在行 `FOR UPDATE`；不在 Prisma
  交互事务 COMMIT 前释放 GET_LOCK。
- Nest 侧 `infrastructure-settings.lock.ts` 只包装既有 `withMysqlSessionLock`，
  使用与 Prisma 相同 `DATABASE_URL`；锁失败（超时/连接/握手）映射
  `ServiceUnavailableException` → 对外 503
  `{statusCode:503,message:"Internal server error",error:"Service Unavailable"}`，
  不含 MySQL 连接信息或锁工具名。
- Go 侧用 `*sql.Conn` 专用连接；释放使用 `context.WithoutCancel` + 独立短超时
  5s；`RELEASE_LOCK` 未确认成功时通过 `driver.ErrBadConn` 驱逐物理连接，不把可能
  仍持锁的会话放回池。

## 9. IS1–IS4 证据与回归

| 编号 | 修复前证据（基线 b89c35a8） | 修法 | 远端回归 |
|---|---|---|---|
| IS1 | `storage/storage-settings.controller.ts:27-33`（PATCH 仅 settings.manage）；`storage/storage-settings.service.ts:170-206`（写 9 个全局 key）；`news-source-runtime-secrets.controller.ts:23-29`；`news-source-runtime-secrets.service.ts:111-201` | Nest：存储 service 首行内联 GlobalRoleAssignment 平台门禁（避免 AuthModule 循环依赖）；运行凭据 service 首行复用已注入 PlatformAccessService。Go：DTO 之后同一门禁 | org A/B 管理员与机器令牌四条写 403 且无副作用；平台管理员四条写 200；三个 GET 对有权限机器令牌 200；无 settings.manage 者权限 403；非法 DTO 先 400 再平台 403 |
| IS2 | `news-source-runtime-secrets.service.ts:123-173`（缓存优先读 + 整体 upsert）、`:334-347`（30s 进程缓存）、`:199`/`:432-434`（只清当前实例） | Nest：管理 GET/PUT 改走 DB 权威 strict parse，整段读改写进全局锁，响应用本次快照。Go：同一锁内 DB 权威读改写，无进程缓存 | 暖缓存后他进程改 DB → 管理 GET 立即返回新值；暖 A、DB 改 [A,B]、再新增 C → 最终 [A,B,C]；Nest/Nest、Go/Go、Nest/Go 真实并发新增/删除/删 A 加 C 集合正确；损坏记录保持 400/409 且不被覆盖 |
| IS3 | `vector-service-settings.service.ts:98`（基准取缓存优先读）、`:188` 起（命中 Redis 旧值）、`:103`（absent token 保留旧基准）、`:124-139`（整体覆盖 DB） | Nest：PUT/DELETE 共用全局锁，token 保留基准改为锁内 DB。Go：同一锁名与四态语义 | DB token=B、Redis 信封 token=A、PUT 省略 token → 解密核对仍为 B（两侧）；PUT 与 DELETE 均等待同一固定锁 |
| IS4 | storage DTO `@IsOptional()` 允许 null；`storage-settings.service.ts:260-308` 保留 null；`:178-202` 原样传 Prisma；`schema.prisma:758-767` 必填 Json；生成的 `SystemSettingUpdateInput.value: JsonNullValueInput \| InputJsonValue` | Nest：具名 `NormalizedStorageSettingsUpdate` + `toStorageJsonValue()`，null → `Prisma.JsonNull`；Go：写 JSON 字面量 null | `endpoint:null`/`forcePathStyle:null`/`presignedUrlTtlSeconds:null` 均 200；`JSON_TYPE(value)="NULL"` 且 `value IS NULL` false；GET 按 env 回退；混合 PATCH 事务原子；空串 endpoint 仍 400 |

## 10. 回滚

只把 `API_GO_INFRASTRUCTURE_SETTINGS_MODE` 改回 `legacy`（或删除该变量）并重启
api-go：七条恢复经 Go 网关代理到 NestJS。无数据迁移耦合——Nest 与 Go 读写同一个
`SystemSetting` 行与同一 Redis 键，加密信封格式相同。Web 入口不变、canary 仍关闭。

## 11. 未验证 / 刻意不做

- **外部实网未验证**：未访问真实 S3/MinIO、vector 服务、OpenAI/LiteLLM、crawl4ai
  或任何新闻源；`storage/test` 与 vector `diagnostics` 仍在 Nest，未迁移。
- 运行凭据消费者（实际抓取链路）仍保留最长 30 秒进程缓存，Go 写入后不保证其他
  Nest worker 立即刷新。
- `accessKeyId` 在存储管理 GET 中仍完整返回（既有契约），不是指纹。
- 三个域的解密降级差异（向量静默回退 / 存储 `secretDecryptionFailed` / 运行凭据
  公共 GET 不解密）刻意保留，未统一。
- Go 侧 baseUrl 规范化覆盖 common-case http/https URL；反例（非 ASCII IDN host）
  未逐一比对 Node WHATWG 解析器的 IDNA 行为。
## 12. 远端验证

- **普通 CI**（`.github/workflows/ci.yml`）：lint、typecheck、web 覆盖率、vector
  单测、API Vitest、OpenAPI 漂移、auth-matrix 漂移、SDL 漂移、api-go `go test`、
  compose 镜像 pin、Build 全部 success。
- **真实栈 smoke**（`.github/workflows/api-go-infrastructure-settings-smoke.yml`，
  label `api-go-infrastructure-settings-smoke` 或 workflow_dispatch）：真实
  MySQL+Mongo+Redis+真实 NestJS 构建与登录，阶段 0–5 全部通过——
  - 阶段 0：四个真实 `/api/auth/login` 身份（平台管理员 P、org A/B 普通管理员、
    无 `settings.manage` 用户）+ 两枚机器令牌；
  - 阶段 1（legacy）：七条经 Go 代理与 Nest 直连逐条比对（状态码 + 完整 JSON
    正文 + MySQL 行状态），四条写的平台门禁 403、三个 GET 的机器令牌 200、
    无权限用户 `INSUFFICIENT_PERMISSIONS` 契约、非法 DTO 400 先于平台 403、
    拒绝请求无配置/审计/缓存副作用；
  - 阶段 2（go，Nest 仍在）：七条由 Go 独立接管并与 Nest 逐条对照；IS1–IS4
    回归（token 四态含「省略 token 保留 DB 中的 B」并用 node 解密核对、
    JSON null 清空语义 `JSON_TYPE=NULL` 且 `value IS NULL=0`、DB 权威合并基准、
    Nest/Nest + Go/Go + Nest/Go 真实并发新增/删除/删 A 加 C）；两把全局锁由独立
    MySQL 会话持有，Go 与 Nest 的写请求均等待 10 秒后 503 且无写入，释放后写入成功；
  - 阶段 3：加密策略矩阵（无 system_security 行 / 字段非 boolean / 显式 false、
    production 无 key、`configured=true` 无 key 与非法 key 的 400 原文）、
    损坏的向量/存储缓存回退 DB、审计掩码（accessKeyId 前 4 位 + `***`、secret `***`）；
  - 阶段 4：停止 NestJS 后七条仍由 Go 服务（阶段 0 的真实 JWT），机器令牌 GET 200 /
    写 403，撤销 JWT 401 `Access token revoked`，
    `vector-service/diagnostics` 与 `storage/test` 仍 502；
  - 阶段 5：改回 legacy 后七条重新代理到 NestJS，无数据迁移。
- 运行 URL、head SHA 与 conclusion 记录在本 PR 的描述与 Actions 页面；本文件不
  复制它们，避免文档与最终 head 漂移。本地未执行任何构建、测试或服务启动。
