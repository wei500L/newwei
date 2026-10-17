# LLM 网关配置与三路激活（Go 接管）

本批把 `/api/system-settings/llm-gateways` 下**七条配置 / 激活 HTTP** 从 NestJS
迁到 `apps/api-go`，默认仍由 NestJS 响应。开关
`API_GO_LLM_GATEWAY_PROFILES_MODE` 默认 `legacy`，只有显式设为 `go` 时这七条
才由 Go 执行。回滚只改这一个开关。

Go 侧实现：`internal/legacyproxy/llm_gateway_profiles_routes.go`（路由规则）、
`internal/llmgatewayprofiles/`（handler / 鉴权 / DTO / 加密协议 / 锁 / 服务）、
`cmd/api/llm_gateway_profiles.go`（装配）。整包只用命名的强类型 struct 与具名
字符串 / 切片类型：无 schema 的 JSON 列用 `json.RawMessage` 在“存储值本身没有
schema”的边界出现并随即解码成具名 struct；非 struct 的容器只有一处——具名接口
`encodedResponse`（响应自渲染，`handler.go:352-355`）。**没有 `any`、
`interface{}` 或 `map[string]any`**；新增 GoDoc / 注释一律英文。

## 开关与路由

`API_GO_LLM_GATEWAY_PROFILES_MODE` 只接受空字符串、`legacy` 或 `go`（空串与
`legacy` 等价；其他值让**进程启动失败**，错误文本是
`API_GO_LLM_GATEWAY_PROFILES_MODE must be one of legacy|go`，
`internal/config/config.go:1154-1160`）。`go` 时复用 `appendAuthRequirements`
（`config.go:1633-1635`），要求 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`
（缺一即启动失败，错误文本形如
`JWT_SECRET is required when API_GO_LLM_GATEWAY_PROFILES_MODE=go`，
`config.go:1692-1702`）；**不要求 `MONGO_URI`**，不启动 worker / 定时任务，不
打开 shadow、canary 或真实模型上游探测。

`go` 时由 `WithLLMGatewayProfiles` 追加规则（
`internal/legacyproxy/llm_gateway_profiles_routes.go:40-56`），全部要求权限
`settings.manage`，其中六条写路径另外要求平台管理员：

| 方法 | 路径 | 权限 | 平台管理员 | 成功码 | 响应体 |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/system-settings/llm-gateways` | `settings.manage` | 否 | 200 | `SettingsPublic`（列表投影） |
| POST | `/api/system-settings/llm-gateways` | `settings.manage` | 是 | 201 | `PublicProfile` |
| PUT | `/api/system-settings/llm-gateways/active` | `settings.manage` | 是 | 200 | `SettingsPublic` |
| PUT | `/api/system-settings/llm-gateways/embedding-active` | `settings.manage` | 是 | 200 | `SettingsPublic` |
| PUT | `/api/system-settings/llm-gateways/rerank-active` | `settings.manage` | 是 | 200 | `SettingsPublic` |
| PUT | `/api/system-settings/llm-gateways/:id` | `settings.manage` | 是 | 200 | `PublicProfile` |
| DELETE | `/api/system-settings/llm-gateways/:id` | `settings.manage` | 是 | 200 | `{"ok":true}` |

注册顺序与形态是语义的一部分（`:46-56`）：

- 集合路径 `/llm-gateways`（GET/POST）与三条激活路径 `/active`、
  `/embedding-active`、`/rerank-active`（各 PUT）是 **exact 规则**，按前缀长度
  自然胜过动态规则，handler 也在 `:id` 查找之前先按 `switch r.URL.Path` 精确
  分发（`handler.go:71-87`）；
- 动态规则是 `appendSegmentRule(..., base+"/", one=true, two=false, tail="",
  PUT, DELETE)`：**恰好一个非空路径段、无尾段**，方法白名单是
  `PUT`/`DELETE` + 共享 `OPTIONS` 预检；
- 因此 `GET`/`POST /:id`、带尾斜杠的 `/:id/`、以及所有更长路径都不会落进
  本批规则（`handler.go:93-103` 的 `profileIDFromPath` 也要求不含 `/`）。

`legacy` / 空串不追加任何规则、不注册 handler，默认部署与生产入口不变；
回滚是纯配置变更。

## 静态例外（未迁移路径）

`/llm-gateways` 下**未迁移的静态路径**（NestJS controller 仍有实现、
`apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts`）：

- `GET/PUT/DELETE /proxy-governance`（`:107-134`）
- `POST /proxy-governance/preflight`（`:122-128`）
- `POST /proxy-governance/rotate-key`（`:136-140`）
- `GET/PUT/DELETE /proxy-load-balancing`（`:142-163`）
- `POST /test-config`（`:198-208`）
- `POST /models-config`（`:246-250`）

Go 侧用 `IsUnmigratedStaticPath`（`handler.go:25-49`）登记同一组精确路径：
`/proxy-governance`、`/proxy-governance/preflight`、
`/proxy-governance/rotate-key`、`/proxy-load-balancing`、`/test-config`、
`/models-config`。

**为什么只有部分路径真正需要这层例外**：`PUT`/`DELETE`（以及预检 `OPTIONS`）
作用在“恰好一段”的静态路径上时形态与 `/:id` 完全相同，动态规则会命中并把
`proxy-governance`、`proxy-load-balancing`、`test-config`、`models-config`
当成 profile id；其余条目（`/proxy-governance/preflight`、`rotate-key` 是更长
路径，`POST /test-config`、`POST /models-config` 的方法不在动态规则白名单里）
本来就会回落到通用 `/api/` legacy 规则，列出它们只是为了“静态路径白名单”
完整。`handler.go:27-33` 的注释只点名了 `proxy-governance` 与
`proxy-load-balancing` 两条，措辞偏窄；路由测试明确覆盖了 `PUT/DELETE`
`/test-config` 与 `/models-config` 也经这层检查回 legacy
（`internal/legacyproxy/llm_gateway_profiles_routes_test.go:160-193`）。

**转发发生在认证 / body / CORS 之前**：装配层在调用 handler 之前先判断
`llmgatewayprofiles.IsUnmigratedStaticPath(r.URL.Path)`，命中就直接
`gateway.ServeLegacy(w, r)` 并 return（`cmd/api/llm_gateway_profiles.go:64-82`）。
也就是说静态路径既不会进入 Go 的鉴权链，也不会被 DTO 解析、CORS 预检应答或
平台门禁触碰；`OPTIONS` 也走同一条早退分支，本批的 CORS 预检逻辑永远不会
“认领”一个未迁移路径（测试 `:194-224`）。

**为什么没有加永久 `ModeLegacy` 精确规则**：路由表里加永不迁移的 legacy 精确
规则会让后续迁移 proxy governance / load balancing 的批次无法再用“更具体的
规则自然胜出”的方式登记 Go 规则；这里选择在 wiring 层按静态路径表转发，迁移
那批只要删掉对应表项即可，不需要先拆一条 legacy 规则
（`llm_gateway_profiles_routes.go:31-36`）。

**Nest 不可用时**：被转发的请求照常走反向代理；`legacyURL` 连不上时反向代理
的 `ErrorHandler` 返回 502 `{"statusCode":502,"message":"Bad Gateway",
"error":"Bad Gateway","traceId":...,"path":...}`
（`internal/legacyproxy/proxy.go:453-464`）。

**Go profile 404 是怎样避免的**：如果静态路径落到 Go handler，动态分支会把它
当成 profile id；在鉴权、DTO 与平台门禁都通过后（治理 body 还可能先在 DTO 层
因未知属性 400），`PUT/DELETE /proxy-governance` 之类会拿到 404
`LLM gateway profile not found`。wiring 的早退分支让这些请求根本不到 handler，
所以这里既不会出现 Go 的 profile 404，也不会出现 Go 的 400 / 401 / 403。

**永远不会命中本批规则**的路径还包括带 `:id` 前缀的未迁移路由：
`POST /:id/test`、`GET /:id/models`、`GET /:id/proxy-health`、
`GET /:id/proxy-model-info`、`POST /:id/proxy-lb-test`（controller
`:185-244`）——它们都是两个及以上路径段，`profileIDFromPath` 与动态规则都
不匹配，直接回落 `/api/` legacy。路由测试同样把 `GET/POST/PATCH /:id`、
`/:id/test`、`/:id/models`、`/:id/proxy-health`、`/:id/proxy-model-info`、
`/:id/proxy-lb-test`、`/:id/extra`、带尾斜杠等列为必须 legacy
（`llm_gateway_profiles_routes_test.go:33-58,123-159`）。

## 认证与门禁

七条统一要求 `settings.manage`，与 NestJS 的 Guard 链一致
（`internal/llmgatewayprofiles/auth.go:41-72`）：

- 缺少 `Authorization` 或不是 Bearer → 401（`rawBearer` 只认
  `bearer ` 前缀，`auth.go:124-130`）；
- `mtk_` 前缀 → **机器令牌路径**（`auth.go:84-119`）：SHA-256 十六进制查
  `MachineAccessToken.tokenHash` 并 `JOIN Org` 校验 `Org.isActive`，撤销
  （`revokedAt` 非空）/ 过期（`expiresAt` 早于当前）/ 组织停用任一命中即 401
  `Invalid machine token`；命中后 `UPDATE MachineAccessToken SET lastUsedAt`；
  权限只从令牌行的 `permissions` 数组展平（非数组按“零权限”处理，绝不变成
  通配），`orgId` 只来自令牌行，身份字符串是 `machine:<tokenId>`；
- 其他 token → `authhttp.Authenticate`（`auth.go:56-64`）：HS256 验签 +
  `iss`/`aud`/`exp` + Redis 撤销名单（查询失败 fail-closed）+ MySQL
  membership 重推导；**人类 `orgId` 与权限来自 membership 重推导，不看 JWT 的
  `permissions` claim，也不看 body / query 里的 `orgId`**；
- 缺少 `settings.manage` → 403 `INSUFFICIENT_PERMISSIONS`。

**平台管理员门禁**（`auth.go:139-157`）：六条写路径在进入锁、读权威文档、
加密、写库、写审计、删缓存**之前**，以
`SELECT id FROM GlobalRoleAssignment WHERE userId = ? AND role = 'platform_admin'
LIMIT 1` 判定；无行 → 403 `Platform admin access required`。机器令牌**永远不能
满足**这一条：`GlobalRoleAssignment.userId` 是指向 `User(id)` 的外键，而机器
身份是 `machine:<tokenId>`，不是用户行；`actorIsMachine`（`store.go:61-63`）
在查询前就把 `machine:` 前缀与空串判为 403，因此也不可能写出
`machine:<id>` 外键造成 MySQL 1452 / 500。`actorIsMachine` 同时决定审计与
`SystemSetting.updatedById` 的 actor 写法（`nullableActorID`，
`store.go:68-73`）。

**固定失败顺序**：authentication（401）→ permission（403）→ DTO（400）→
service 平台门禁（403）→ 业务规则（404 / 400）。这是 Go handler 的调用顺序
（`handler.go:108-183` 先 `authorize`，再 `readBodyOrFail` +
`parseProfileInput`，最后才进 service），与 NestJS 的
Guard → ValidationPipe → handler → service 顺序一致；因此“非平台管理员 +
`settings.manage`”时，非法 DTO 先得到 400，合法 DTO 才得到 403。

**两条 403 的精确正文**（`content-type: application/json; charset=utf-8`）：

- 缺权限（`authhttp.WriteForbidden`）：
  `{"statusCode":403,"message":"Insufficient permissions","error":"Forbidden","code":"INSUFFICIENT_PERMISSIONS","detail":"Requires any permission: settings.manage","requiredPermissions":["settings.manage"],"permissionsMode":"any","traceId":"…","path":"…","timestamp":"…"}`；
- 平台门禁失败（`forbidden("Platform admin access required")` 经
  `WriteHTTPException(403, …)`）：`{"statusCode":403,"message":"Platform admin
  access required","error":"Forbidden","traceId":"…","path":"…","timestamp":"…"}`
  （无 `code` / `detail` / `requiredPermissions`）。

其余错误形状沿用既有 Go 契约错误：401
`{"statusCode":401,"message":"…","error":"Unauthorized",…}`；400 由
class-validator 消息用 `"; "` 拼接后带 `"error":"Bad Request"`；404
`"error":"Not Found"`；锁超时 503
`{"statusCode":503,"message":"Internal server error","error":"Service
Unavailable",…}`；MySQL 连接类失败 503、非预期错误 500（`errors.go:92-121`）。

## DTO

`internal/llmgatewayprofiles/dto.go` 逐字段复刻
`apps/api/src/modules/system-settings/dto/llm-gateway.dto.ts` 的
`ValidationPipe`（whitelist + forbidNonWhitelisted + 无隐式转换）语义。创建与
更新共用同一字段集与声明顺序（`profileFieldOrder`，`dto.go:45-65`），唯一区别
是 **create 时 `name` 与 `apiBase` 必填**（`dto.go:426`）。

| 字段 | 约束（class-validator 等价） | 创建必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `@IsOptional`(update) `@IsString` | 是 | trim 后空 = 缺失；服务层 `name is required` |
| `apiBase` | `@IsUrl({require_protocol:true,require_tld:false})` | 是 | 消息 `apiBase must be a URL address` |
| `apiKey` | `@IsOptional` `@IsString` | 否 | 见「secret 协议」 |
| `model` | `@IsOptional` `@IsString` | DTO 否 / 服务层是 | 缺失 → 400 `apiBase and model are required` |
| `embeddingModel` | `@IsOptional` `@IsString` | 否 | 显式 `null` 清除 |
| `rerankModel` | `@IsOptional` `@IsString` | 否 | 显式 `null` 清除 |
| `rerankFallbackModels` | `@IsArray` `@ArrayMaxSize(20)` `@IsString({each:true})` | 否 | trim / 去空 / 稳定去重 |
| `assistantModel` | `@IsOptional` `@IsString` | 否 | 显式 `null` 清除 |
| `assistantWebSearchEnabled` | `@IsBoolean` | 否 | 显式 `null` 保留为 null（见「明确保留的行为」） |
| `apiSurface` | `@IsIn(["chat_completions","responses"])` | 否 | 非法 → 枚举消息 |
| `timeoutMs` | `@IsInt` `@Min(1000)` `@Max(900000)` | 否 | 越界消息为 `must not be greater than 900000` / `must not be less than 1000` |
| `temperature` | `@Min(0)` `@Max(2)` | 否 | 无 `@IsInt`，小数合法 |
| `topP` | `@Min(0)` `@Max(1)` | 否 | 同上 |
| `maxOutputTokens` | `@IsInt` `@Min(1)` `@Max(1000000)` | 否 | |
| `maxRetries` | `@IsInt` `@Min(1)` `@Max(20)` | 否 | |
| `fallbackModels` | `@IsArray` `@ArrayMaxSize(20)` `@IsString({each:true})` | 否 | |
| `sendMetadata` | `@IsBoolean` | 否 | 显式 `null` 保留为 null |
| `responseFormatMode` | `@IsIn(["json_schema","json_object","none"])` | 否 | |
| `enabled` | `@IsBoolean` | 否 | 服务层用 `??`：null / 缺失都继承 |

三个激活 DTO（`dto.go:482-526`）：

| DTO / 路由 | 字段 | 约束 |
| --- | --- | --- |
| `SetActiveLlmGatewayDto`（`PUT /active`） | `activeId` | `@IsOptional` `@IsString`；**不声明 `mode`**（传 `mode` → `property mode should not exist`） |
| `SetEmbeddingActiveLlmGatewayDto`（`PUT /embedding-active`） | `activeId`、`mode` | 均 `@IsOptional` `@IsString`；`mode` 另有 `@IsIn(["follow_completion","use_default"])` |
| `SetRerankActiveLlmGatewayDto`（`PUT /rerank-active`） | `activeId`、`mode` | 同上 |

**消息文本与顺序规则**（对齐 class-validator 0.14.2）：

- 未知属性：`property <name> should not exist`，按 body 出现顺序；**在属性约束
  消息之前**（whitelist pass 先跑），然后才是类体声明顺序的字段约束；
- 单个属性的约束是**自下而上注册**的（TypeScript 装饰器从属性向上应用），所以
  **声明在最后的装饰器产出第一条消息**：
  - `@IsInt` + `@Min` + `@Max` → `must not be greater than <max>` →
    `must not be less than <min>` → `must be an integer number`；
  - `@IsArray` + `@ArrayMaxSize(n)` + `@IsString({each:true})` →
    `each value in <field> must be a string` →
    `<field> must contain no more than <n> elements` → `<field> must be an array`；
  - `@IsString` + `@IsIn`（仅激活 `mode`）→
    `<field> must be one of the following values: follow_completion, use_default`
    → `<field> must be a string`；
- 具体文案：`must be a string`、`must be a boolean value`、
  `must be a URL address`、`must be an integer number`、
  `must not be greater than <n>`、`must not be less than <n>`、
  `must contain no more than 20 elements`、`each value in <field> must be a
  string`、`<field> must be one of the following values: a, b, c`；
- 数值约束不转换字符串：`"maxRetries":"3"` 报
  `maxRetries must not be greater than 20; maxRetries must not be less than 1;
  maxRetries must be an integer number`，与 NestJS 一致
  （`dto_test.go:139-144`）。

单体处理（`handler.go:276-346`）：`Content-Type` 不是 `application/json`
（`mime.ParseMediaType` 拒绝畸形头）按空对象 `{}` 处理；非空但不是合法 JSON →
400 `Unexpected token in JSON body`；超过 10 MiB（`maxBodyBytes = 10<<20`，
对齐 `apps/api/src/main.ts` 的 `json({limit:"10mb"})`）→ 500
`{"statusCode":500,"message":"Internal server error"}`（生产形态）；body 不是
JSON 对象（`[]`、`5`、`"x"`、`null`、`true`）→ 400
`an unknown value was passed to the validate function`。重复键按 JavaScript 对象
字面量语义处理：保留首次出现的位置、最后一次的值（`dto.go:101-140`）。

## 默认值与优先级（`LITELLM_*` 投影）

Go 侧 `EnvDefaults`（`normalize.go:21-49`）与
`cmd/api/llm_gateway_profiles.go:44-58` 从与 NestJS 相同的环境变量取值，优先级
逐条对齐 `EnvService.liteLlmConfig`（`config.service.ts:933-975`）与
`env.schema.ts:254-284`：

| 字段 | 取值 | zod schema 细节造成的结果 |
| --- | --- | --- |
| `apiBase` | `LITELLM_API_URL` → `LITELLM_API_BASE` → `http://localhost:4001` | `LITELLM_API_URL` 只要非空就胜出；`LITELLM_API_BASE` 有 schema 默认值 `http://localhost:4001` |
| `timeoutMs` | `LITELLM_TIMEOUT_MS`，默认 60000 | |
| `temperature` | `LITELLM_TEMPERATURE`，默认 0.2 | |
| `topP` | `LITELLM_TOP_P`，默认 0.9 | |
| `maxOutputTokens` | `LITELLM_MAX_TOKENS`，schema 默认 **2048** | `LITELLM_MAX_TOKENS` 永远有值（否则取默认），所以 `LITELLM_MAX_OUTPUT_TOKENS` **永远不生效** |
| `maxRetries` | `LITELLM_RETRY_ATTEMPTS`，schema 默认 **3** | `LITELLM_MAX_RETRIES` 同理永不生效 |
| `model` | `LITELLM_MODEL`，默认 `openai/gpt-4o-mini` | 只用于记录 / 对照；**从不回填缺失的 `input.model`** |
| `fallbackModels` | `LITELLM_FALLBACK_MODELS` 按逗号切分、丢空项 | 只用于记录 / 对照；`normalizeProfile` 与创建路径都**从空数组起**，env 从不种入 profile |
| `embeddingModel` | `LITELLM_EMBEDDING_MODEL` | **不会**变成 profile 字段 |
| `rerankModel` | `undefined` | **不会**从 env 创建 |
| `rerankFallbackModels` | `[]` | **不会**从 env 创建（rerank 备份路由只存 MySQL） |
| `apiKey` | `LITELLM_API_KEY` | **不会**变成 profile 字段，也**不是**读取 fallback |

创建路径用 env 作为 `profileDefaults`（`service.go:74-88`），更新路径用现有
normalized profile 作为 fallback（`service.go:93-107`），与 NestJS
`buildProfileFromInput(base, fallback, input)` 的“create 传 env、update 传
existing”一致。

## 三路选择（completion / embedding / rerank）

**激活写规则**（`activation.go`，与 NestJS `setActiveProfile` /
`setEmbeddingActiveProfile` / `setRerankActiveProfile` 一致）：

- completion：`activeId` 非空（JS truthiness，即非空字符串）时，必须存在该
  profile 且 `enabled`，否则 404 `LLM gateway profile not found` / 400
  `Cannot activate a disabled LLM gateway profile`；`activeId` 为空串或
  `null` 时直接写入（空串会先落库、再由响应投影归 null）；
- embedding：在 completion 的两条检查之后，还要 `embeddingModel` 非空，否则
  400 `Embeddings gateway profile must configure embeddingModel`；
- rerank：同理，缺 `rerankModel` → 400
  `Rerank gateway profile must configure rerankModel`；
- **mode 语义**（`:78-84`、`:124-130`）：只有在 `activeId` 为 falsy 时才应用
  `mode`；`mode` 缺省写 `follow_completion`；`activeId` 非空时 **mode 被忽略**
  （body 里给的 mode 不落库、也不报错）；completion 路由没有 mode；
- 三路互不干扰：completion 激活不改 embedding / rerank 选择与 mode，反之亦然。

**读归一化清除不可用 id**（`normalize.go:60-130`）：

- `activeId` 只有指向一个**存在且 `enabled`** 的 profile 才保留，否则归 `null`
  （`resolveActiveID`，`activeKindCompletion`）；
- `embeddingActiveId` 额外要求该 profile 的 `embeddingModel` 非空；
- `rerankActiveId` 额外要求 `rerankModel` 非空；
- `embeddingMode` / `rerankMode` 只认 `use_default`，其余（含缺失、非法、非
  字符串）一律 `follow_completion`。

注意读归一化与**运行时解析**是两回事：NestJS 的
`resolveDefaultProfile` / `resolveRuntimeProfile`（`activeId` 为空或不可用时
回落到第一个 enabled、embedding/rerank 还要有对应模型，`use_default` 时找
MySQL 默认）属于**未迁移的调用方**，Go 本批只负责把文档写成同样的归一化形态，
不实现模型调用链。

## profiles / cache 结构

**SystemSetting 全局单例**：`key = "llm_gateway_profiles"`，没有 org 维度，
一行影响所有租户（`store.go:19-27`）。`value` 的精确形状
（`StoredSettings` / `StoredProfile`，`model.go:219-255`）：

```json
{
  "activeId": "…|null",
  "embeddingActiveId": "…|null",
  "embeddingMode": "follow_completion|use_default",
  "rerankActiveId": "…|null",
  "rerankMode": "follow_completion|use_default",
  "profiles": [
    {
      "id": "…", "name": "…", "apiBase": "…", "apiKey": "…",
      "model": "…", "embeddingModel": "…", "rerankModel": "…",
      "rerankFallbackModels": [], "assistantModel": "…",
      "assistantWebSearchEnabled": true,
      "timeoutMs": 60000, "temperature": 0.2, "topP": 0.9,
      "maxOutputTokens": 2048, "maxRetries": 3, "fallbackModels": [],
      "sendMetadata": true, "responseFormatMode": "json_schema",
      "apiSurface": "chat_completions", "enabled": true,
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

字段顺序即 Go struct 的序列化顺序，与 NestJS `normalizeProfile` 的对象字面量
一致；`embeddingModel` / `rerankModel` / `assistantModel` 缺失时键被
`omitempty` 省略（对应 `undefined` 被 `JSON.stringify` 丢掉），
`apiKey` 缺失时同样省略；两个 fallback 列表与
`assistantWebSearchEnabled` / `sendMetadata` 永远存在。

**读缓存**：Redis 键 `llm_gateway:profiles`，TTL 60 秒，存的是**归一化后的完整
文档本身（不是 `{exists,value}` 信封）**（`store.go:24-27`、`cache.go:117-137`）。
GET 先读缓存（命中后仍再 `NormalizeSettings` 一次，所以缓存里即使是旧形状也会
被重新归一化），未命中读 MySQL 并把归一化文档写回缓存；Redis 读/写/删失败只记
日志并继续（best-effort），**GET 不因缓存故障失败**（MySQL 故障仍冒泡）。
写路径不读缓存：锁内 `loadSettingsAuthoritative` 直读 MySQL
（`cache.go:142-148`），写成功后先 upsert、再 best-effort 写审计、最后 `DEL`
缓存（`cache.go:166-181`）。

**两个只读治理 / 安全信封**：本包不使用这两个缓存做写入，只读：

- `litellm_proxy_governance`（SystemSetting）/ `litellm_proxy_governance:settings`
  （Redis，`{exists:boolean,value?:{enabled,targetProfileId,…}}` 信封，TTL 30
  秒，由 `litellm-proxy-governance.service.ts:149-150` 写入）；Go 只解码
  `enabled` 与 `targetProfileId` 两个字段（`cache.go:66-113`）；
- `system_security`（SystemSetting）/ `system_security:settings`（Redis，
  `{exists,value?}` 信封，由 `system-security-settings.service.ts:38-39`
  写入）；Go 只解码 `secretEncryptionEnabled`（`cache.go:18-64`）。
- **本包从不写这两个键**：它们的缓存里装的是各自服务的完整文档，只写回一个
  两字段投影会把其他读方看到的完整配置毁掉；miss 时读 MySQL，也不回填缓存
  （`cache.go:8-16`、`:81-83`）。Go 侧声明的
  `GovernanceCacheTTLSeconds=30` / `SecurityCacheTTLSeconds=60`
  （`store.go:32-40`）只是文档常量，从未被写入路径使用（本包只读这两个缓存）；
  **实际 TTL 由各自的 Nest 写入方决定**——governance 是 30 秒
  （`litellm-proxy-governance.service.ts:150`），security 也是 **60 秒**
  （`system-security-settings.service.ts:39`）。

## secret 协议（`apiKey`）

**算法与信封**（`crypto.go:111-180`、`model.go:9-27`）：AES-256-GCM、32 字节
密钥、随机 12 字节 IV、**分离式 16 字节 tag**、**无 AAD**（`gcm.Seal(nil, iv,
plaintext, nil)`）。信封字段顺序固定：

```json
{ "__enc": "system-settings:v1", "alg": "aes-256-gcm",
  "iv": "<base64>", "tag": "<base64>", "data": "<base64>" }
```

`decodeEnvelope` 只有 `__enc === "system-settings:v1"`、`alg === "aes-256-gcm"`
且 `iv`/`tag`/`data` **都是字符串**时才认作 v1 信封；否则归入 opaque 原样保留。

**密钥解码**（`crypto.go:29-47`，逐字对齐
`storage-settings.crypto.ts:27-42`）：先 `trim`；空 → 错误
`SYSTEM_SETTINGS_ENCRYPTION_KEY is empty`；可选 `0x`/`0X` 前缀后是 64 位
十六进制 → 按 hex 解 32 字节；否则按 **Node 兼容 base64** 解码
（`Buffer.from(value,"base64")`：非字母表字符忽略、遇 `=` 停止），解码结果
**恰好 32 字节**才接受；否则
`SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars`。
信封字段的解码用宽松 base64（先带 padding 再不带，`crypto.go:102-109`）。

**编码策略分支表**（`encodeSecretForStorage`，`secret_value.go:54-89`；对应
Nest `SystemSecuritySettingsService.encodeSecretForStorage` +
`encodeSecretValue`）：

| `secretEncryptionEnabled` 存储值 | 密钥状态 | 结果 |
| --- | --- | --- |
| `true` | present 但 invalid | 400 `Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid (<decode error>)` |
| `true` | valid | 加密成 v1 信封 |
| `false` | valid | 明文（显式逃生门） |
| `true` | 无 | 400 `Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured` |
| 其他（`false` / 非 boolean / 缺失） | 无有效 key（缺失或 invalid） | 生产（`NODE_ENV=production`）→ 400 `SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production`；非生产 → 明文 + 日志告警 |

注意 `secretEncryptionEnabled` 只有**真 boolean** 才算配置（其余按“未配置”
处理），且 `SYSTEM_SETTINGS_ENCRYPTION_KEY` 的存在性判断是原始字符串
truthiness（纯空白算 present 但 invalid），因此 Go 的
`resolveKeyStatus`（`crypto.go:182-206`）保留未 trim 的原文。

**读取行为**（`resolveSecret`，`secret_value.go:95-117`）：

- 缺失键 / 显式 `null` / opaque（object / array / number / boolean）→
  `hasApiKey=false`；
- 明文字符串 → `stripBearerPrefix` 后非空才 `true`；
- v1 信封 → 无有效密钥时记日志并 `false`；解不开（错 key、截断、tag 坏）时
  记日志并 `false`，**不让请求失败**；
- **从不回落到 `LITELLM_API_KEY`**，响应里也没有密钥、密文或指纹。

**`stripBearerPrefix` 的顺序**（`secret_value.go:14-29`）：先 `TrimSpace`，
空的返回 `""`；整体等于 `Bearer`（大小写不敏感，`^bearer$`）返回 `""`；否则
删除开头 `Bearer` + 至少一个空白（大小写不敏感；Go 用
`[[:space:]\x{00a0}]` 补齐 JS `\s` 的 NBSP），再 `TrimSpace`。
**为什么不复用 OpenAI keys helper**：
`openai-keys-settings.service.ts:269-271` 的 `stripBearerPrefix` 只有
`value.replace(/^bearer\s+/i,"").trim()`，既没有“单独 Bearer → 空”的规则，
也不先 trim，行为与这里的 helper 不同。`normalizeAPIKeyInput`
（`secret_value.go:139-154`）据此实现：键缺失 → 保留旧值（含旧密文）原样；
显式 `null`、空串、纯空白、单独 `Bearer` → 写 `null`（清除）；其他值先
strip 再按上表编码。

**日志策略**：密钥、明文、密文、指纹都不进日志 / 响应 / 审计；日志只出现
“缺少密钥”“解密失败”“RELEASE_LOCK 失败”“审计写失败转 outbox”这类**不带值**
的事实（`secret_value.go:87,105,111`、`lock.go:73-76`、`store.go:231`）。
响应中的 `PublicProfile` 只有 `hasApiKey:boolean`；审计 metadata 也只有
`hasApiKey`（`audit.go:9-44`）。

## 治理保护（governance guard）

`governance_guard.go` 复刻 `LiteLlmProxyGovernanceService.assertProfileUpdateAllowed`
/ `assertProfileDeletionAllowed`（`litellm-proxy-governance.service.ts:515-558`）：

- 只有“治理启用（`enabled` 严格 boolean，其余按 false）且
  `targetProfileId` 命中当前 profile”时保护才生效；
- update 时：把目标 profile 改成 disabled → 400
  `Disable LiteLLM managed governance or choose a different target profile before disabling this gateway profile`；
- update 时：`normalizeOpenAiApiBase` 后 apiBase 发生变化 → 400
  `Disable LiteLLM managed governance or choose a different target profile before changing this gateway profile apiBase`；
- delete 时 → 400
  `Disable LiteLLM managed governance or choose a different target profile before deleting this gateway profile`；
- delete 的检查在**存在性检查之前**，所以治理目标即使已从文档里消失，也返回
  治理 400 而不是 404（`profiles.go:372-387`）。

`normalizeOpenAiApiBase`（`governance_guard.go:26-52`，对齐
`apps/api/src/common/llm-openai-compat.ts:107-132`）：trim → 去尾部 `/` →
按**有序**后缀表匹配（长后缀优先）`/v1/chat/completions`、`/chat/completions`、
`/v1/embeddings`、`/embeddings`、`/v1/models`、`/models`、`/v1/responses`、
`/responses`，命中就截掉再去尾部 `/` → 若结尾是 `/v1` 再截掉 → 最后再去尾部
`/`。比较规则：两侧归一化后都非空且不相等才算变化。该函数只用于**比较**，
绝不回写存储的 apiBase。

## 缺陷修复（GP1 / GP2 / GP3，Nest 与 Go 两侧同修）

三条缺陷的完整证据见 `docs/refactor/bug-ledger.md` §8（行号以基线
`2672b62e` 工作区为准；本节引用台账原文行号）。

**GP1：全局 LLM 网关配置写入缺平台管理员门禁（P0）**。根因：六条写方法只声明
`@Permissions("settings.manage")`（`llm-gateway-settings.controller.ts:57-64,66-77,79-91,93-105,165-173,175-183`），
service 构造函数未注入 `PlatformAccessService`
（`llm-gateway-settings.service.ts:130-141`），六个公开写方法
（`:155-357`）没有任何平台角色判断。修法：Nest 侧注入既有
`PlatformAccessService` 并在六个写方法首行
`await this.platformAccess.assertPlatformAdmin(actorId)`（门禁在读配置、加锁、
编码、写 DB、审计、删缓存之前返回）；Go 侧 `assertPlatformAdmin` 查
`GlobalRoleAssignment.userId = 真实 User.id AND role='platform_admin'`，且
`machine:` actor 直接 403。覆盖（bug-ledger §8 中**计划**的 smoke 阶段，
workflow 尚未落地）：smoke 阶段 2（GP1 权限回归）。

**GP2：缓存整体读改写无跨实例互斥，丢失更新与旧 apiKey 恢复（P1）**。根因：
六条写都是“读 60 秒缓存 → 内存整体改写 → 整体 upsert”
（`llm-gateway-settings.service.ts:160/178、203/233、253/270、278/290、303/321、334/352`），
`loadSettings()`（`:620-646`）优先返回 Redis，`saveSettings()`（`:648-673`）
是无条件整行 upsert，没有锁、没有版本条件。修法：Nest 新增
`llm-gateway-profiles.lock.ts`（包装 `withMysqlSessionLock`），六个写方法改成
“平台门禁 → 全局锁 → `loadSettingsAuthoritative()`（直读 MySQL + normalize）
→ 业务校验 → 保存 + 审计 + 删缓存 → 从本次结果投影响应”；Go 侧专用
`*sql.Conn` 持同一锁名，锁内直读 SystemSetting 权威 JSON。覆盖（计划）：smoke
阶段 3。

**GP3：存量非 boolean `enabled` 被 truthiness 当作启用（P1）**。根因：
`normalizeProfile` 的 `enabled: record.enabled ?? true`
（`llm-gateway-settings.service.ts:790`）原样透传 `"false"` / `1` / `{}` / `[]`，
而 `activeProfile.enabled`（`:718`）、`:724`、`:731`，`resolveDefaultProfile`
（`:549`）与 `resolveRuntimeProfile`（`:573/:588/:607`）都用 truthiness，导致被
禁用的 profile 仍被选中服务流量；公共模型却声明
`enabled:boolean`（`:57`）。修法：`normalizeEnabled(value)` —— boolean 原样；
`undefined`/`null` 保持历史默认 `true`；其他任何类型一律 `false`（不解析
`"true"`/`"false"` 字符串、不把数字 truthiness 当启用）。Go 侧同名
`NormalizeEnabled`（`jsvalue.go:206-217`）。覆盖（计划）：smoke 阶段 4。

## 锁

**锁名**：`llm-gateway:profiles:write:v1`
（Go `lock.go:15`；Nest `llm-gateway-profiles.lock.ts:14`），刻意不含
orgId/userId，因为底层是**一行全局文档**。

**Go 侧**（`lock.go:42-88`）：从**专用连接池**取一个 `*sql.Conn`，在该会话上
`SELECT GET_LOCK('llm-gateway:profiles:write:v1', 10)`；返回 1 才继续，否则
返回 `errLockUnavailable`（且 `fn` 不执行）。请求处理完成后用**独立短超时
context**（`context.WithoutCancel(ctx)` + 5 秒，`lock.go:70-72`）执行
`RELEASE_LOCK`，所以客户端断连 / 请求 context 取消后仍会尝试释放。锁连接
来自 `usersettings.OpenMySQLFromURL` 且 `lockDB.SetMaxIdleConns(0)`
（`cmd/api/llm_gateway_profiles.go:35-42`、`service.go:48-53`）：连接关闭就是
关闭物理会话，**释放失败时直接关闭物理连接而不是把可能仍持锁的连接放回池**。

**NestJS 侧**（`llm-gateway-profiles.lock.ts:19-42`）：
`withLlmGatewayProfilesLock` 包装既有的 `withMysqlSessionLock`
（`../situation-monitor/situation-monitor-user-lock`），固定同一锁名、同一
10 秒等待；把 `SituationMonitorLockError` 映射成
`ServiceUnavailableException()`。

**锁超时 503 正文（两侧一致）**：
`{"statusCode":503,"message":"Internal server error","error":"Service
Unavailable",…}`（Go `errors.go:81-90`；Nest 是 `ServiceUnavailableException()`
经 GlobalExceptionFilter 的生产形态）。

**范围声明（重要）**：这把锁只串行化**本批的六条 profile 写**
（create / update / delete 与三路激活）。它**不是**一个覆盖所有配置写入的
跨配置事务：`proxy-governance`、`proxy-load-balancing`、`test-config`、
`models-config` 等未迁移写路径仍由 NestJS 各自处理，不参与这把锁；本批也不在
profiles 锁内做任何治理文档的写操作。

## 回滚

只把 `API_GO_LLM_GATEWAY_PROFILES_MODE` 改回 `legacy` 并重启：`legacy` 时不
注册 handler、不追加规则、不额外打开锁连接，七条全部回到 NestJS 代理路径。
**无数据迁移**（不改表、不改 SystemSetting 形状、不迁移 Redis 键）。Web 入口
不变（生产仍是 Web → NestJS）；canary 保持 0（路由表没有任何 `ModeCanary`
条目）；**未启用 shadow**。

## CI / smoke 证据

- 基线：`origin/main` 基线 SHA
  `2672b62e35ed7235604c65939bcd335c81bf7d27`；基线 CI run
  `https://github.com/wei500L/newwei/actions/runs/39061326703`（success）。开工
  后 PR #55（基础设施设置批次）先合入 `origin/main`，本分支以
  `git merge origin/main` 同步并保留双方追加内容。
- 普通 CI（lint / typecheck / `api-go` 单测 / 契约漂移等）：
  `https://github.com/wei500L/newwei/actions/runs/39073721070`，head
  `8d998ac5`，结论 **success**（`verify` 与 `api-go-user-settings-integration`
  均通过）。
- 新增真实栈 smoke `.github/workflows/api-go-llm-gateway-profiles-smoke.yml`
  （`name` 与 PR label 同为 `api-go-llm-gateway-profiles-smoke`；
  `workflow_dispatch` + `pull_request[labeled]`；mysql:8.4 + redis:7.2 +
  mongo:7.0 + 真实 NestJS + api-go 容器；`timeout-minutes: 60`；无
  `continue-on-error`）：`https://github.com/wei500L/newwei/actions/runs/39073741508`，
  head `8d998ac5`，结论 **success**。阶段 1a（legacy/unset 代理对照）、1b
  （go 模式逐接口对照）、2（GP1 权限回归）、3（GP2 陈旧缓存 + 真实并发 + 锁
  证据）、4a/4b/4c（GP3、密钥互通、策略分支、脱敏）、5（停 NestJS 后接管 +
  未迁移路径 502）、6（单变量回滚无数据迁移）全部 success。
- 未执行的既有 smoke 未在本批触发（只在本批最终 head 上跑本批 smoke 与普通
  CI）；相邻批次回归（`api-go-runtime-settings-smoke` 等）本批**未复跑**，不
  声称通过。

本批工作区内已落地、可被普通 CI 执行的**纯单测**（不连 MySQL / Redis / NestJS）：

- `internal/legacyproxy/llm_gateway_profiles_routes_test.go`：默认 legacy、
  go 接管七条、更长路径与方法回落、静态路径与预检 `OPTIONS` 转发、与其他开关
  共存；
- `internal/llmgatewayprofiles/dto_test.go`：创建必填、约束消息与顺序、数值
  边界、数组约束、URL 契约、重复键、激活 DTO、JS Number 语义、
  `stripBearerPrefix`；
- `internal/llmgatewayprofiles/service_test.go`：`TestNormalizeEnabledGP3`、
  三路 active id 的清除/保留、profile 过滤与默认值/字段顺序、数值与字符串
  列表归一化、创建 fallback 与更新继承/清除、可空 boolean 的“即时 vs 下次
  GET”、重复 id 删除、`normalizeOpenAiApiBase`、三条治理文案、
  `withProfilesLock` fail-closed / 错误透传 / 请求取消后仍释放、审计 metadata
  与 outbox 载荷；
- `internal/llmgatewayprofiles/crypto_test.go`：密钥解码、AES-GCM 往返、
  五种 `SecretKind`、读取状态、编码策略分支、缺失 apiKey 保留 opaque 值、
  编码失败不覆盖旧值；
- `internal/config/config_test.go`：`TestLLMGatewayProfilesModeDefaultsToLegacy` /
  `...RejectsInvalid` / `...GoRequiresCredentialsButNotMongo`、
  `TestLLMGatewayProfileEnvProjectionDefaults` / `...Priorities`、
  `TestLLMGatewaySettingsEncryptionKeyKeepsRawValue`。

**未提供任何 MySQL / Redis / NestJS 联调的仓库内集成测试**；锁的真实跨进程
争用、真实存量库形状与真实登录态都只能由真实栈 smoke 覆盖。

## 明确保留的行为

- **创建仍然要求 `model`**：DTO 里 `model` 可选，但
  `buildProfileFromInput` 在 `model` 缺失时返回 400
  `apiBase and model are required`（`profiles.go:49-56`）。
- **可空 boolean 的即时响应与下一次 GET 不同**：
  `assistantWebSearchEnabled` / `sendMetadata` 显式 `null` 时，写响应（以及当次
  审计 metadata）保留 `null`；文档落库后，下一次 GET 的归一化会把它读成
  `false` / `true`（`profiles.go:125-137`、`normalize.go:203,210`）。
- **重复 id**：update 只替换**第一个**匹配项（`profiles.go:328-334`），delete
  删除**全部**匹配项（`profiles.go:389-397`）——与 NestJS `findIndex` /
  `filter` 相同。
- **GET 仍是 best-effort 缓存**：60 秒 Redis，缓存故障只记日志不失败；本批不
  宣称 GET 具备全局强一致。
- **空串 `activeId` 先落库再归 null**：`PUT /active` 传 `""` 会把
  `activeId:""` 写入 SystemSetting，但响应经 `persistedView` 归一化后是
  `null`；下一次 GET 也是 `null`。
- **治理写不在 profiles 锁内**：见「锁」的范围声明。
- **创建时第一个 profile 自动成为 completion active**：仅当 `activeId` 为
  falsy；被禁用的新 profile 仍会先写入并把 `activeId` 指向它，随后**读取时的
  归一化**再把 activeId 归 null（`profiles.go:295-301`、`normalize.go:104-130`）。
- `DeleteProfile` 删掉最后一个 profile 时仍持久化空文档（`profiles.go:408-411`）。
- **审计 metadata 字段集固定**：create/update 只记
  `id/name/apiBase/model/assistantModel/assistantWebSearchEnabled/rerankModel/rerankFallbackModels/enabled/hasApiKey/sendMetadata/responseFormatMode/apiSurface`，
  不含 `embeddingModel` 与数值参数（`audit.go:9-44`）；delete 只记 `{id}`；
  三路激活各记对应的 id 字段；机器 actor 写 SQL `NULL`，审计写失败回退
  `AuditLogOutbox`（`store.go:174-232`）。

## 明确未验证

以下各项在本批工作区里**没有**可复现的真实运行证据（不写“应该没问题”）：

- **没有真实模型上游调用**：本包只读写 `SystemSetting` 文档，不调用
  completion / embedding / rerank 上游；`GET /:id/models`、
  `POST /:id/test`、`GET /:id/proxy-health`、`GET /:id/proxy-model-info`、
  `POST /:id/proxy-lb-test`、`POST /test-config`、`POST /models-config` 仍由
  NestJS 执行，本批未触碰、未验证。
- **没有真实 LiteLLM proxy governance 操作**：`proxy-governance` 的
  preflight / rotate-key / sync（`POST /proxy-governance/preflight`、
  `POST /proxy-governance/rotate-key`、`PUT/DELETE /proxy-governance`）仍全部
  留在 NestJS；Go 只读治理文档的 `enabled` / `targetProfileId` 两个字段，未
  执行任何治理副作用，也没有对真实 LiteLLM 管理端点做过验证。
- 没有仓库内真实 MySQL / Redis 的 Go 集成测试；锁在 Nest/Go 两进程间的真实
  并发争用、`RELEASE_LOCK` 失败驱逐连接等均由单测与代码审查覆盖，**未在真实
  栈运行**（留待 smoke 阶段 3）。
- 没有真实 NestJS 生产态下的登录 / 撤销 / membership 重推导联调（同类
  SEC-01 限制）；`settings.manage`、平台管理员、`mtk_` 机器令牌三条路径的
  真实数据库状态未在本批验证。
- 存量文档形状（非 boolean `enabled`、opaque `apiKey`、重复 id）的修复只做了
  代码与单测级验证；**真实存量库的端到端行为未验证**（留待 smoke 阶段 4）。
- 加密协议只做了代码级对齐；用**真实 NestJS 产生的 v1 信封**在 Go 侧解密的
  端到端一致性、以及反向（Go 加密、Nest 解密）都未在真实栈验证。
- 未验证超过 10 MiB 体上限、非法 JSON、非 JSON `Content-Type` 等边界在生产
  环境下的逐字节一致性（依据既有 authhttp 契约实现）。
- 生产流量未切换；canary 未激活；shadow 未启用；Web 入口未改。
