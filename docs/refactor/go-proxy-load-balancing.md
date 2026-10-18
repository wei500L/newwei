# LiteLLM 负载均衡配置管理与下发（Go · 4 条接口）

> 基线 `f5648fab`（origin/main）· 分支 `refactor/go-proxy-load-balancing` · 开关
> `API_GO_PROXY_LOAD_BALANCING_MODE`（空串/`legacy`/`go`，默认 `legacy`，非法值
> 启动失败）。生产入口仍是 Web → NestJS；canary 关闭，不启用 shadow，不改前端。
> 本批同时修 4 个缺陷（LB1–LB4），Nest 与 Go 两侧同步；并为本配置补齐全局设置的
> 平台管理员写入门禁（LB0）。
>
> 本批只迁移**配置管理与下发**：实际请求路由仍由 LiteLLM 执行，Go 侧不重写
> `simple-shuffle`/`least-busy`/`usage-based-routing`/`latency-based-routing`
> 四种策略。

## 1. 路由与三层边界

| # | 方法 | 精确路径 | 认证 | 权限 | 平台门禁 | 成功码 |
|---|---|---|---|---|---|---|
| 1 | GET | `/api/system-settings/llm-gateways/proxy-load-balancing` | JWT 或 `mtk_` | `settings.manage` | 否 | 200 |
| 2 | PUT | `/api/system-settings/llm-gateways/proxy-load-balancing` | JWT 或 `mtk_` | `settings.manage` | 是（LB0） | 200 |
| 3 | DELETE | `/api/system-settings/llm-gateways/proxy-load-balancing` | JWT 或 `mtk_` | `settings.manage` | 是（LB0） | 200 |
| 4 | GET | `/api/internal/litellm/proxy-load-balancing` | 内部 bearer token | 不使用 JWT/RBAC | 否 | 200 |

失败顺序与模型接入批次一致：认证（401/403）→ DTO（400，有 body 时先于 service
门禁）→ 平台门禁（403 `Platform admin access required`，service 内）→ 业务校验/
写库。管理端必须同时具备 `settings.manage` 与平台管理员全局角色。

内部接口沿用既有实现：未配置 → 403 `LITELLM_CONFIG_INTERNAL_TOKEN is not
configured`；无可提取 bearer → 401 `Missing bearer token`；不匹配 → 401
`Invalid bearer token`（常量时间比较）。内部 token 缺失不阻止启动。

**路由边界**：两个路径都是 exact path。`/api/system-settings/llm-gateways/:id`
（PR #59 的 Profile 动态段规则）比静态路径更短，因此
`PUT/DELETE .../proxy-load-balancing` 不会被当作 Profile ID；Profile 规则、
`proxy-governance`、未列出的方法、尾斜杠与更长路径继续回落 `/api/` 代理。
Go 侧只在 `API_GO_PROXY_LOAD_BALANCING_MODE=go` 时追加这两条 exact 规则。

## 2. PUT 输入与更新语义

必填：`enabled`（boolean）、`routingStrategy`（四个精确枚举之一）、`redisHost`
（string，trim 后非空）、`redisPort`（整数 1–65535）。

`routingStrategy` 枚举：`simple-shuffle`、`least-busy`、`usage-based-routing`、
`latency-based-routing`。

可选：`anthropicApiKeys`（string[]，DTO 原始数组最多 100 项）、
`clearAnthropicApiKeys`（boolean）、`redisPassword`（string 或 `null`）、
`deploymentRpm`（整数或 `null`，1–1000000）、`deploymentTpm`（整数或 `null`，
1–10000000）。沿用既有 DTO 校验，不增加额外格式限制；数组长度校验仍在去重之前
（`@ArrayMaxSize(100)` 作用于原始数组），service 内 `normalized.length > 100`
的兜底保留。

业务错误原句：`redisHost is required`、`routingStrategy is invalid`、
`Too many Anthropic API keys (max 100)`。

密钥语义：

| 输入 | 语义 |
|---|---|
| 提供 `anthropicApiKeys` 数组 | 整体替换（stripBearer + trim + 首次出现顺序去重） |
| 显式 `[]` | 清空 |
| 提供数组且 `clearAnthropicApiKeys=true` | 以数组为准 |
| 未提供数组且 `clearAnthropicApiKeys=true` | 清空 |
| 其他（省略或 `null`） | 保留数据库既有条目（原样写回，不解密、不重加密） |

Redis 密码语义：省略 → 保留；空字符串或纯空白 → 清空；显式 `null` → 清空；
非空字符串 → trim 后按既有加密策略保存。`deploymentRpm`/`deploymentTpm` 沿用
当前可选字段语义：省略或 `null` 均保存为 `null`（**不是**「省略保留」）。

## 3. 存储、加密、缓存与锁

* MySQL `SystemSetting`：`key=litellm_proxy_load_balancing`，`isPublic=false`，
  `description="LiteLLM proxy load balancing configuration (Anthropic keys + router
  settings)"`，`updatedById` 为真实用户 ID（机器/空身份写 NULL）。
* `value` 固定字段：`enabled`、`anthropicApiKeys`、`routingStrategy`、`redisHost`、
  `redisPort`、`redisPassword`、`deploymentRpm`、`deploymentTpm`。
* 新写入的密钥条目为 `{fingerprint, value}`；`fingerprint` 是既有归一化密钥
  （stripBearer + trim）的 SHA-256 小写 hex，保持首次出现顺序。
* 读取兼容三种存量形状：旧明文字符串、旧的直接加密对象、
  `{fingerprint,value}` 包装条目；包装备份条目直接使用已存 fingerprint，**不**
  为算指纹解密其 value。
* 加密沿用 `secretEncryptionEnabled` 策略与既有 `system-settings:v1` 信封
  （AES-256-GCM / 32 字节 key / 12 字节 IV / 独立 tag / 无 AAD），不另造协议。
  `SYSTEM_SETTINGS_ENCRYPTION_KEY` 缺失或无效沿用已有运行时策略与错误，不改全局
  启动条件。
* Redis：`litellm_proxy_load_balancing:settings`，TTL 30 秒，
  `{exists, value?}` 信封；没有数据库行时 `exists=false`；缓存保存既有存储表示，
  不新增明文密钥缓存。
* 全局 MySQL 会话锁：`model-access:proxy-load-balancing:v1`（Nest 与 Go 同名字面
  量）。PUT 与 DELETE 使用同一把锁；锁内先读 MySQL 权威行，再合并、写库、失效
  缓存，并基于刚写入（或删除后的默认）对象构造响应。

DELETE 只删除 `litellm_proxy_load_balancing` 这一行并失效对应缓存，返回
`source=none` 的默认负载均衡配置；`openai_keys` 等其它 `SystemSetting` 行不动，
公开响应继续附带独立的 OpenAI 元数据。不调用 LiteLLM。

## 4. 公开响应与内部快照

公开响应完整保留：`source`、`enabled`、`openai`、`anthropicKeysCount`、
`anthropicKeyFingerprints`、`routingStrategy`、`redisHost`、`redisPort`、
`hasRedisPassword`、`deploymentRpm`、`deploymentTpm`。其中 `openai` 是完整的
`OpenAiKeysSettingsPublic`（`source`、`keysCount`、`hasKeys`、`keyFingerprints`、
`internalTokenConfigured`、`appliedAt`、`appliedSource`、`appliedKeyFingerprints`、
`restartRequired`），不是简化的 `{keysCount}`。

没有数据库配置时的默认值：`source=none`、`enabled=false`、
`routingStrategy=simple-shuffle`、`redisHost=redis`、`redisPort=6379`、
`hasRedisPassword=false`、`anthropicKeysCount=0`、`anthropicKeyFingerprints=[]`、
`deploymentRpm=null`、`deploymentTpm=null`。

内部快照完整保留：`hasStoredConfig`、`enabled`、`openaiApiKeys`、
`anthropicApiKeys`、`routingStrategy`、`redisHost`、`redisPort`，以及可选的
`redisPassword`、`deploymentRpm`、`deploymentTpm`。规则：

* `openaiApiKeys` 复用已有明文密钥读取，不把「读 OpenAI 密钥」实现成 HTTP 回调
  Nest，也不要求先开启 `API_GO_MODEL_ACCESS_SETTINGS_MODE`；
* 没有 Redis 密码时省略 `redisPassword`，没有 RPM/TPM 时省略对应字段（公开响应
  中对应字段仍为 `null`）；
* `hasStoredConfig` 与 `enabled` 是两个独立状态；`enabled=false` 时不省略配置或
  密钥列表；
* 明文只出现在内部快照契约允许的位置。

## 5. 本批修复（Nest 与 Go 同步）

* **LB0 写入门禁**：`litellm_proxy_load_balancing` 是全局 `SystemSetting`，PUT/
  DELETE 在 service 内复用 `PlatformAccessService.assertPlatformAdmin`
  （Go 侧查 `GlobalRoleAssignment(userId, role='platform_admin')`，`machine:` 身份
  直接 403 且不查库）。DTO 校验仍先于门禁。GET 只要求 `settings.manage`。
* **LB1 重复解密**：公开读取原来先解密明文密钥、再单独遍历计算指纹，旧格式
  （直接加密对象）条目会被解密两次。改为**一次**分类：每个条目只解析一次，需要
  解密时只解一次，明文列表与指纹列表都从同一结果投影。
* **LB2 陈旧缓存合并**：PUT 原来从 30 秒缓存读旧配置再整份写回，省略的
  `anthropicApiKeys`/`redisPassword` 可能被旧缓存覆盖。改为锁内直接读 MySQL 权威
  行作为合并基准；仅省略密钥或密码时原样保留既有存储条目，不解密、不重加密整份
  配置。
* **LB3 写后返回**：更新后原来再次经由 `getPublicSettings` 读缓存构造响应，返回
  内容可能不是刚写入的配置。改为以刚写入对象（DELETE 为默认对象）构造 LB 响应；
  OpenAI 元数据仍按它自己的契约独立读取。
* **LB4 显式 null**：`resolveNextRedisPasswordRaw` 原来对显式 `null` 调用 `trim`
  （TypeError → 500）。Nest 与 Go 两侧统一为：省略保留、`null`/空串/纯空白清空、
  非空字符串 trim 后加密。

## 6. 解析与去重优化（不改变三种口径）

每份配置快照：条目结构只解析一次；同一条目需要解密时最多解密一次；不建立跨请求
的明文缓存；不为计算已有包装指纹强制解密包装 value。稳定去重用 Set/具名集合，
保持首次出现顺序，不按字母或指纹重排。

三种口径刻意保留差异，不合并：

1. OpenAI `keysCount`：已存储条目计数（按结构，不解密；包装项按 value 的 JS
   truthy 计数），**不是**成功解密的明文数量。
2. `anthropicKeysCount`：当前成功解析、去重后的有效密钥数量。
3. fingerprint 列表：包装条目沿用已存 fingerprint；旧明文或直接加密条目按当前
   算法计算；保留既有缺失密钥与解密失败行为。

本批实际减少的工作量（只描述减少的解析/解密与重复遍历，不宣称延迟或吞吐倍数）：

* Nest `LiteLlmProxyLoadBalancingSettingsService.getPublicSettings`：旧实现先
  `resolveAnthropicKeys`（解密）再 `listAnthropicKeyFingerprints`（对旧加密条目
  再解密一次）；现在同一条目最多解密一次。
* Nest/Go `openai_keys` 公开投影：旧实现 `countStoredKeys` 与
  `listKeyFingerprints` 各自遍历并分类整份数组两次；现在解析一次后复用。
* Go `anthropicApiKeys` 审计计数与公开/内部投影共用同一套分类规则；保留路径只用
  结构计数，不触发解密。

## 7. 开关独立性与回滚

两组开关相互独立，底层复用同一 `modelaccesssettings` 服务与 OpenAI 密钥读取：

| 模型接入 | 负载均衡 | 行为 |
|---|---|---|
| legacy | legacy | 全部 14 条路径回落 NestJS（默认） |
| go | legacy | 已有 10 个模型接入入口由 Go 接管 |
| legacy | go | 只接管本批 4 个负载均衡入口；仍读取真实 OpenAI 配置 |
| go | go | 各自接管各自入口 |

Go 只需要现有 JWT、MySQL、Redis，不要求 Mongo；内部 token 未配置时内部接口返回
既有 403，不阻止无关服务启动。回滚只把 `API_GO_PROXY_LOAD_BALANCING_MODE` 改回
`legacy`（或删除该变量）并重启 api-go：4 条路由恢复纯代理，NestJS 读写同一份
`SystemSetting` 与同一组 Redis 缓存，无需迁移数据或改格式。生产 Web 入口
（`API_BASE_URL`）未改，canary 未启用。

## 8. 审计

审计 `resource=system_settings`。PUT 动作为 `litellm_proxy_lb_update`，metadata 保留
`enabled`、`anthropicKeysCount`、`routingStrategy`、`redisHost`、`redisPort`、
`hasRedisPassword`、`deploymentRpm`、`deploymentTpm`、`anthropicKeysUpdated`、
`redisPasswordUpdated`，**不写入密钥或密码**。DELETE 动作为
`litellm_proxy_lb_reset`，metadata 为 `{ok:true}`。沿用既有审计写入与 outbox 回退
行为。

## 9. 远端验证结果

待普通 GitHub Actions CI（lint/typecheck/web 覆盖率/vector/API Vitest/OpenAPI 漂移/
auth-matrix 漂移/api-go 测试）在最终 head 上完成后回填。本批不新增专用 smoke
workflow。

## 10. 明确未验证 / 刻意保留

* 没有连接真实 LiteLLM/OpenAI；不对「LiteLLM 已完成加载」作任何声明，只验证配置
  分发与回报协议本身。
* 实际请求路由（四种策略）仍由 LiteLLM 执行，Go 侧不重写、不验收。
* 一般 GET 仍沿用原 30 秒 best-effort 缓存语义，不宣称全局强一致。
* 未迁移 `proxy-governance`、`rotate-key`、模型测试接口、worker/cron 与 Prisma
  schema。
* 未改动 controller 装饰器、公开方法签名与权限声明；未改前端。
