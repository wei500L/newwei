# 模型接入设置与 OpenAI 密钥分发（Go · 10 条接口）

> 基线 `b89c35a8`（origin/main，普通 CI run 39051652549 success）· 分支
> `refactor/go-model-access-settings` · 开关 `API_GO_MODEL_ACCESS_SETTINGS_MODE`
> （空串/`legacy`/`go`，默认 `legacy`，非法值启动失败）。
> 生产入口仍是 Web → NestJS；canary 关闭，不启用 shadow，不改前端。
> 本批同时修 3 个缺陷（MA1/MA2/MA3），Nest 与 Go 两侧同步。

## 1. 路由与三层边界

| # | 方法 | 精确路径 | 认证 | 权限 | 平台门禁 | 成功码 |
|---|---|---|---|---|---|---|
| 1 | GET | `/api/system-settings/model-service` | JWT 或 `mtk_` | `settings.manage` | 否 | 200 |
| 2 | PUT | `/api/system-settings/model-service` | JWT 或 `mtk_` | `settings.manage` | 是（MA1 补齐） | 200 |
| 3 | DELETE | `/api/system-settings/model-service` | JWT 或 `mtk_` | `settings.manage` | 是（MA1 补齐） | 200 |
| 4 | GET | `/api/system-settings/openai-keys` | JWT 或 `mtk_` | `settings.manage` | 否 | 200 |
| 5 | PUT | `/api/system-settings/openai-keys` | JWT 或 `mtk_` | `settings.manage` | 是（MA1 补齐） | 200 |
| 6 | POST | `/api/system-settings/openai-keys` | JWT 或 `mtk_` | `settings.manage` | 是（MA1 补齐） | 201 |
| 7 | DELETE | `/api/system-settings/openai-keys/key/:fingerprint` | JWT 或 `mtk_` | `settings.manage` | 是（MA1 补齐） | 200 |
| 8 | DELETE | `/api/system-settings/openai-keys` | JWT 或 `mtk_` | `settings.manage` | 是（MA1 补齐） | 200 |
| 9 | GET | `/api/internal/litellm/openai-keys` | 内部 bearer token | 不使用 JWT/RBAC | 否 | 200 |
| 10 | POST | `/api/internal/litellm/openai-keys/applied` | 内部 bearer token | 不使用 JWT/RBAC | 否 | 201 |

三层边界与失败顺序：

1. **认证（401/500/503）**：前 8 条复用 `authhttp` 链——HS256 验签、issuer/
   audience/过期、Redis 撤销名单、MySQL 用户/组织/membership 权限重推导；
   JWT 自带 permissions 一律不参与。`mtk_` 机器令牌按既有路径：SHA-256
   tokenHash 查 `MachineAccessToken`，校验 `revokedAt`/`expiresAt`/
   `Org.isActive`，刷新 `lastUsedAt`，身份为 `machine:<tokenId>`。
2. **权限（403 `INSUFFICIENT_PERMISSIONS`）**：前 8 条统一要求
   `settings.manage`（any 模式：`detail="Requires any permission:
   settings.manage"`，不带 `missingPermissions`）。
3. **DTO（400）**：有 body 的接口在 service 之前执行，顺序与 NestJS
   ValidationPipe 一致。
4. **平台门禁（403 `Platform admin access required`）**：六条管理写的第一
   步，位于 service 内，因此晚于 DTO——这正是 NestJS 的真实顺序。
5. **业务校验/数据库写入**：`enabled=true` 时的 baseUrl/internalToken 缺失、
   OpenAI key 归一化后超过 100 条。

第 9/10 条只使用 `LITELLM_CONFIG_INTERNAL_TOKEN`：handler 在同一包内先按
精确路径分流到内部 bearer guard，绝不进入 JWT/membership/机器令牌认证。
失败顺序：内部 token 未配置 → 403 `LITELLM_CONFIG_INTERNAL_TOKEN is not
configured`；无可提取 bearer → 401 `Missing bearer token`；不匹配 → 401
`Invalid bearer token`（常量时间比较）；第 10 条随后才做 DTO 校验。
内部 token 缺失**不阻止启动**，它是接口契约。

路由接管范围刻意收窄：全部 exact path（`key/:fingerprint` 为恰好一个非空
段），不使用 `/api/system-settings/` 或 `/api/internal/litellm/` 大前缀。
`/api/internal/litellm/proxy-load-balancing`、`/api/system-settings/llm-gateways`
与其余所有设置接口继续回落 NestJS；尾斜杠、多一段路径、HEAD/PATCH 等未列
方法同样回落。

## 2. DTO 与四态 token

**模型配置 PUT**（字段声明顺序 = 消息组装顺序）：

| 字段 | 规则 | 原始消息 |
|---|---|---|
| `enabled` | 必填 boolean | `enabled must be a boolean value` |
| `baseUrl` | 可省略/可 null；非 null 必须 string | `baseUrl must be a string` |
| `internalToken` | 可省略/可 null；非 null 必须 string | `internalToken must be a string` |
| `timeoutMs` | 必填 JSON number、整数、>=100，无上限 | `timeoutMs must not be less than 100` → `timeoutMs must be an integer number` |
| `maxRetries` | 必填 JSON number、整数、0..10 | `maxRetries must not be greater than 10` → `maxRetries must not be less than 0` → `maxRetries must be an integer number` |

没有 `@Type(() => Number)`：`"100"`、`"2"`、`"true"`、`1` 都不被接受。
同一字段的多个约束独立执行（不 stop-at-first）；未知属性报
`property <名> should not exist`，且在属性消息之前（class-validator 的
whitelist 先于逐属性校验）。`__proto__` 按 `stripProtoKeys` 被剔除。

`internalToken` 的四态（Go 用带 `kind` 的具名联合，不用 `*string`）：

| 输入 | 语义 |
|---|---|
| 省略 | 保留**锁内数据库**当前 token（MA3） |
| `null` | 存 null（清除 stored token，仍可回退 env） |
| 空白字符串 | 同 null |
| 非空字符串 | JS trim 后按当前加密策略编码 |

**OpenAI 密钥 PUT/POST**：`keys` 必填 array、最多 100 项、每项 string、
空数组合法；约束顺序 `IsString(each)` → `ArrayMaxSize` → `IsArray`
（消息 `each value in keys must be a string` →
`keys must contain no more than 100 elements` → `keys must be an array`）。
空字符串、重复项通过 DTO，由业务层归一化。

**内部已应用状态 POST**：`source` 顺序为 `IsIn` → `IsString`（`source must
be one of the following values: db, env, none` 在前），`keyFingerprints` 与
`keys` 同构。内部 guard 先于 DTO。

## 3. 数据、缓存与业务语义

MySQL（不改 schema、不新增 migration）：

* `SystemSetting`：`key` 是全局主键、无 orgId；`value` 是 JSON；`isPublic=false`；
  管理写 `updatedById` 为通过平台门禁的真实用户 ID；内部上报 `updatedById=null`。
* `GlobalRoleAssignment`（平台门禁）、`MachineAccessToken`/`Org`（机器令牌）、
  `AuditLog`/`AuditLogOutbox`（审计）。

| 用途 | SystemSetting key | Redis 键 | TTL |
|---|---|---|---|
| 模型配置 | `model_service` | `model_service:settings` | 30s |
| 密钥配置 | `openai_keys` | `openai_keys:settings` | 30s |
| 已应用状态 | `litellm_openai_keys_applied` | `openai_keys:applied_status` | 30s |
| 加密开关（只读） | `system_security` | `system_security:settings` | 60s（源码硬编码 60，非 30） |

缓存是 `{"exists":true,"value":{...}}` 信封；`exists = Boolean(record)`
（行存在即为 true，即使 value 不是对象——此时 `value` 被省略，等价于
`JSON.stringify` 丢弃 `undefined`）。读失败/解析失败/set/del 失败都按
Nest 的 try/catch：记安全警告并回退数据库或继续（**仅**设置缓存可降级；
JWT 撤销检查仍然 fail-closed）。日志绝不写完整 value、token 或 keys。

**读取归一化**（与写入 DTO 是两层不同规则，不把 Min/Max 套到存量行）：

* `enabled`：只有 stored boolean 覆盖 env。
* `baseUrl`：stored 为非空 trim 字符串时优先，否则回退 env（env 值先 trim）。
* `timeoutMs`：JS `Number(value)` 有限且 >0 再 `Math.floor`，否则 env。
* `maxRetries`：JS `Number(value)` 有限且 >=0 再 `Math.floor`，否则 env。
* stored token：明文 trim 非空 / v1 加密解密后 trim 非空才可用；无 key、
  非法 key、解密失败、其他形状都视为没有 stored token 并回退
  `MODEL_SERVICE_INTERNAL_TOKEN`。
* `source`：是否有可识别 stored 记录（对象或**数组**都算，`typeof [] ===
  "object"`）；`tokenSource`：`stored`/`env`/`none`。

**模型的 baseUrl 规范化**：等价 Node WHATWG `new URL()`，仅接受 http/https，
返回 `toString().replace(/\/$/,"")`。Go 侧实现覆盖 scheme 大小写、缺失/多余
solidus、userinfo、IPv6、百分号编码 host、默认端口、`080` 端口、`.`/`..` 段、
反斜杠分隔、路径空格编码、query/fragment；不用 `strings.TrimRight`，也不直接
用 `net/url` 的原始输出。非 ASCII host（IDNA punycode）与非法百分号序列是
已知边界（未验证）。

**OpenAI 密钥三个独立算法**（刻意不合并，差异由单测与 smoke 保留）：

* `countStoredKeys`：按结构计数，不解密；包装项按 value 的 JS truthy 计数。
* `resolveKeys`：能解密的解密、解不开的跳过（不 500），按首次出现顺序去重；
  明文项 stripBearer 后为空则丢弃。
* `listKeyFingerprints`：包装项直接取非空 fingerprint（不解密）；明文项即使
  stripBearer 后为空也计算 SHA-256；直接加密项需解密成功才计算。

`normalizeKeys` 逐步：只留 string → `value.replace(/^bearer\s+/i,"")` →
再 trim → 丢空 → 首次出现顺序去重。`fingerprintKey` = 同一 stripBearer+trim
后的 UTF-8 SHA-256 小写 hex（64 位）。

**restartRequired 精确公式**：

```
keysCount > 0
  ? appliedSource !== "db" || keyFingerprints.length === 0
    || appliedKeyFingerprints.length === 0
    || !sameFingerprintSets(keyFingerprints, appliedKeyFingerprints)
  : appliedSource === "db" && appliedKeyFingerprints.length > 0
```

同集合不同顺序视为已应用。`appliedAt` 仅在 stored 为 string 时使用；
`appliedSource` 仅 db/env/none，否则 null。

写入 `SystemSetting.value` 的形状：模型
`{enabled,baseUrl,internalToken,timeoutMs,maxRetries}`；密钥
`{openaiApiKeys:[{fingerprint,value}]}`；已应用
`{source,keyFingerprints,appliedAt}`。描述文案与 Nest 完全一致。

**审计**：`resource=system_settings`；`model_service_update`
metadata 精确字段 `enabled/baseUrl/timeoutMs/maxRetries/tokenUpdated/
tokenConfigured`（**不含 token**）；`model_service_reset` 与
`openai_keys_reset` 为 `{"ok":true}`；`openai_keys_update` 为
`{"keysCount":N}`。`AuditLog` 插入失败回退 `AuditLogOutbox`；两者都失败时
按本批 Nest helper 的实际行为**抛出原始错误**（→ 500），不像其他 Go 包那样
最后吞掉。内部上报不写管理审计。

## 4. 加密与存量兼容

`system-settings:v1` 信封：AES-256-GCM、32 字节 key、12 字节随机 IV、
独立 16 字节 tag、data 不含 tag、无 AAD、每次写入新随机数。

key 解码：先 trim；优先识别可选 `0x/0X` 前缀的 64 位 hex；否则按 **Node
`Buffer.from(x,"base64")` 的宽松语义**解码并要求 32 字节。Go 的
`encoding/base64` 是严格的（会拒绝未补 `=` 的 43 字符 key、遇到非法字符报错、
遇到 `=` 之后不再继续），因此本批实现了 Node 兼容解码器：接受 `+/` 与 `-_`
两套字母表、忽略其他字符、在第一个 `=` 停止、尾部 2/3 个字符分别产出 1/2 字节。

错误原句：`SYSTEM_SETTINGS_ENCRYPTION_KEY is empty` /
`SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars` /
`Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length` /
`Failed to decrypt system setting secret`（解密失败统一为同一句，不泄漏原因）。

编码策略决策表（只读 `system_security.secretEncryptionEnabled`，只有 boolean
有效，其他类型按未配置；**不写**该行也不写它的缓存）：

| key | configured | 结果 |
|---|---|---|
| 有效 | `false` | 明文 |
| 有效 | `true` / 未配置 | 加密 |
| 无效（存在但解不开） | `true` | 400 `Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid (<解码错误原句>)` |
| 缺失 | `true` | 400 `Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured` |
| 缺失/无效 | 非 `true` | `NODE_ENV === "production"`（精确相等）→ 400 `SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production`；否则明文 + 安全 warning |

「存在但非法」与「缺失」必须区分：`config.SettingsEncryptionKey` 是既有字段、
做过 TrimSpace，本批新增 `SystemSettingsEncryptionKeyRaw` 保存原文（不改既有
字段语义）。内部 token 同样保留 Nest EnvService 的「非空」语义：只有整串空白
才视为未配置，接受值不做 trim、比较用原文。

存量读取失败一律降级：模型 token 回退 env，OpenAI 列表跳过解不开的项，
公共计数不因此重写。

本批只读 `SystemSecuritySettingsService` 与其缓存，不修改它。

## 5. 两个全局锁与跨 Nest/Go 协议

| 锁名 | 保护对象 | 使用者 |
|---|---|---|
| `model-access:model-service:v1` | `SystemSetting.key=model_service` | 模型 PUT、模型 DELETE |
| `model-access:openai-keys:v1` | `SystemSetting.key=openai_keys` | 密钥 PUT、POST、按指纹 DELETE、集合 DELETE |

被保护的数据本身是全局单例，因此锁名不带 orgId/userId 后缀。协议：

* Nest（`apps/api/src/modules/system-settings/model-access-settings.lock.ts`）：
  只读复用 `withMysqlSessionLock(databaseURL, name, fn)`（专用连接
  `SELECT GET_LOCK(name,10)`，回调结束后 `RELEASE_LOCK`，会话关闭兜底）；
  获取失败映射 503，回调内错误原样透传。
* Go（`internal/modelaccesssettings/lock.go`）：每次获取开一条专用 MySQL 会话，
  `SELECT GET_LOCK(?, 10)` 必须返回 1 才执行写；释放用独立 3 秒超时
  （不依赖已被取消的请求 context）；无论释放是否确认都要关闭专用会话——
  MySQL 在会话结束时释放该会话持有的全部顾问锁，因此释放失败也不会泄漏。
* 锁保持到配置提交、审计处理与 cache invalidation 完成；写事务（若存在）
  必须先 COMMIT 再释放。
* 锁获取超时/失败：不绕过锁继续写，两侧映射 503，正文
  `message=Internal server error`、`error=Service Unavailable`
  （对应 Nest `ServiceUnavailableException` 经 GlobalExceptionFilter 的形状，
  与 Prisma 连接 503 的「无 error 字段」不同）。日志只记固定原因，不带
  body/secret。

MA2/MA3 的写基准一律是**锁内**从 MySQL 重读的权威值；30 秒缓存只服务普通
GET。写响应由本次写入快照组装（模型：写出的字节反解；密钥：写出的行 + 权威
applied 行），不再用写前旧缓存。

## 6. 三个缺陷（Nest 与 Go 同步修复）

* **MA1（P0）** 全局模型配置与密钥写接口缺平台管理员门禁。Nest：两个 service
  注入 `PlatformAccessService`，六个公开写方法第一步
  `assertPlatformAdmin(actorId)`。Go：`assertPlatformAdmin` 查
  `GlobalRoleAssignment(userId=真实 User.id, role='platform_admin')`，
  `machine:<id>` 直接 403 且不查库。普通 org 管理员、机器令牌 → 403 且无任何
  副作用；平台管理员 + `settings.manage` → 成功；有平台角色无权限 → 权限层
  403；错 body + 非平台用户 → 先 DTO 400。
* **MA2（P1）** 密钥追加/按指纹删除原为「缓存读改写 + 无跨实例互斥」。Nest/Go
  都改为同一把 `model-access:openai-keys:v1` 锁内重读权威值合并，append/remove
  走私有锁内持久化函数（不递归进入公开加锁方法）。确定性旧缓存
  （DB=[A,B]、Redis=[A]）下 POST C → [A,B,C]；DELETE A → 保留 B。真实跨进程
  并发（Nest/Nest、Go/Go、Nest/Go）取并集、两次删除都生效、删 A 与加 C →
  原集合去 A 加 C。
* **MA3（P1）** 模型 PUT 省略 token 时原会写回旧缓存 token。Nest/Go 都改为
  锁 `model-access:model-service:v1` 内读数据库当前记录作为保留基准，reset
  共用同一把锁。DB token B + 旧缓存 token A 时，不带 internalToken 的合法 PUT
  后仍为 B；并发 PUT（一个带新 token、一个省略）最终不得恢复旧缓存 token。

## 7. 回滚

把 `API_GO_MODEL_ACCESS_SETTINGS_MODE` 改回 `legacy`（或删除该变量）并重启
api-go：10 条路由恢复纯代理，NestJS 读写同一份 `SystemSetting` 与同一组 Redis
缓存，无需迁移数据或改格式。compose 的 api-go 默认即 legacy；生产 Web 入口
（`API_BASE_URL`）未改，canary 未启用。

## 8. 验证与未验证边界

* 真实栈：`.github/workflows/api-go-model-access-settings-smoke.yml`
  （label `api-go-model-access-settings-smoke`）。阶段：legacy 逐条对照 →
  go 接管（DTO/认证/平台门禁/MA2/MA3/锁/并发/内部 token/双向加解密/存量格式）
  → 加密失败矩阵（分开进程，必要时重启）→ 停 NestJS 后接管（10 条 + 未迁
  502）→ 回滚。
* 纯单测：`apps/api-go/internal/modelaccesssettings/*_test.go`（DTO 顺序与
  消息、四态 token、WHATWG 样例、三种旧 key 格式、三个算法差异、
  restartRequired 全分支、AES-GCM/hex/base64 key/损坏项、加密决策表、
  内部 guard、六条写门禁与顺序、锁名与锁失败不写、审计脱敏与 outbox 回退）。
  单测全部使用具名内存替身，不连接 MySQL/Redis。
* 路由测试：`internal/legacyproxy/model_access_settings_routes_test.go`。

明确未验证 / 刻意保留：

* **没有**连接真实 OpenAI、LiteLLM、model-service 或 crawl4ai 实网；本批不
  发起任何出站模型请求，也不做启动探测。
* applied 报告由 smoke 的测试客户端提交，只验证「配置分发/回报协议」，
  **不代表**真实 LiteLLM 已完成加载。
* `keysCount` 与「可解密 key 数量」在旧数据下的差异刻意保留（三个算法不合并）。
* 一般 GET 仍沿用原 30 秒 best-effort 缓存语义，**不**宣称全局强一致。
* 非 ASCII host（IDNA punycode）、非 UTF-8 百分号解码、非 16 字节 GCM tag
  的存量密文是已知边界；GCM tag 长度限制来自 Go `crypto/cipher`（只支持
  16 字节），本仓库所有写入方都产出 16 字节。
* `MODEL_SERVICE_ENABLED` / `MODEL_SERVICE_TIMEOUT_MS` /
  `MODEL_SERVICE_MAX_RETRIES` 的非法值只在 `go` 模式下启动失败；`legacy` 模式
  不新增任何启动期校验。Go 进程环境无法区分「未设置」与「显式空串」，
  两者都按未设置处理（Nest 的 zod 对空串 timeout 会判非法）——这是本批唯一的
  已知配置解析差异。
* `LITELLM_CONFIG_INTERNAL_TOKEN` 的长度下限（Nest env schema `min(16)`）未在
  Go 侧复刻：Go 只按「整串空白 = 未配置」判断。
