# LLM 网关治理与真实探测（Go · 12 条接口）

本批把 `/api/system-settings/llm-gateways` 下**剩余 12 条 HTTP** 从 NestJS 迁到
`apps/api-go`：治理配置五路 + 模型信息两路 + 三类真实探测四路 + LB 探测一路。
默认仍由 NestJS 响应，开关 `API_GO_LLM_GATEWAY_OPS_MODE` 默认 `legacy`，只有
显式设为 `go` 时这 12 条才由 Go 执行。回滚只改这一个开关。

本批**不重迁**已迁移的 21 条（7 条 profile CRUD/激活、10 条 model-service /
OpenAI keys、4 条 LB 配置与内部下发），也不改 Nest 路由、DTO、Web、GraphQL、
爬虫与简报算法。

Go 侧实现：

| 路径 | 职责 |
|---|---|
| `internal/llmgatewayops/` | 本批业务主体（governance / 探测 / DTO / 上游客户端 / handler） |
| `internal/llmgatewayprofiles/ports.go` | profile、secret、runtime-binding、auth 的窄端口 |
| `internal/llmlogs/probe.go` | 具名 probe writer（completion / embedding / rerank） |
| `internal/legacyproxy/llm_gateway_ops_routes.go` | 精确路由规则 |
| `cmd/api/llm_gateway_ops.go` | 装配 |

Go DTO、响应、数据库 JSON、缓存 envelope、审计 metadata 全部是具名强类型；
唯一的开放容器是 `proxy-model-info` 的两个扩展叶子，用有序 `flexValue`
（`flexjson.go`）承载并在编码前递归脱敏。**没有 `any` / `interface{}` /
`map[string]any` / `[]any`**。新增注释为英文。

## 开关与路由

`API_GO_LLM_GATEWAY_OPS_MODE` 只接受空串、`legacy`、`go`（空串等价 `legacy`；
其他值启动失败，文本 `API_GO_LLM_GATEWAY_OPS_MODE must be one of legacy|go`）。
`go` 复用 `appendAuthRequirements` 并要求 `MONGO_URI`（每次真实探测都写
`llmrequestlogs`）。`LITELLM_MASTER_KEY` 与 `SYSTEM_SETTINGS_ENCRYPTION_KEY`
**不是**启动前置：缺失时管理调用 503、密钥状态 `unreadable`。

| # | 方法 | 路径 | 成功码 |
|---|---|---|---|
| 1 | GET | `/proxy-governance` | 200 |
| 2 | PUT | `/proxy-governance` | 200 |
| 3 | DELETE | `/proxy-governance` | 200 |
| 4 | POST | `/proxy-governance/preflight` | 201 |
| 5 | POST | `/proxy-governance/rotate-key` | 201 |
| 6 | GET | `/:id/models` | 200 |
| 7 | POST | `/:id/test` | 201 |
| 8 | GET | `/:id/proxy-health` | 200 |
| 9 | GET | `/:id/proxy-model-info` | 200 |
| 10 | POST | `/:id/proxy-lb-test` | 201 |
| 11 | POST | `/models-config` | 201 |
| 12 | POST | `/test-config` | 201 |

全部要求 `settings.manage`，复用现有 JWT + `mtk_` 机器令牌权限路径，
**没有**新增 `platform_admin` 限制。设置仍是全局 `SystemSetting`，actor 的
orgId/userId 只用于审计与日志归属。

**路由优先级**：五条静态路径是 exact 规则，前缀比 profile 动态规则长，因此
`PUT/DELETE /proxy-governance` 永远不会被读成 profile id；五条子资源是
“一个动态段 + 固定 tail”的规则，更长的路径继续回落 `/api/`。profile 处理器里
的 `IsUnmigratedStaticPath` 回退**保留不动**，两个开关各自独立、可只开其一。

## 认证与错误契约

鉴权链与 7 条 profile 路由完全一致（`Authenticator.Authorize` 窄端口），
所以机器令牌的 SQL、权限判定和 401/403 顺序只有一份实现。

错误体沿用 `GlobalExceptionFilter` 形状：`{statusCode, message, error, code?,
traceId, path, timestamp}`。5xx 只保留状态、错误名和（源端为对象负载时的）
`code`——Nest 会把这些 5xx 的 `message` 统一替换成 `Internal server error`，
所以远端 LiteLLM 的原始 detail 不会回显。诊断分项错误另有一套
`{code, message, status?, axiosCode?, requestId?, upstreamType?,
upstreamCode?, compatibilityError?}`。

## DTO、缺省与 null

`PUT /proxy-governance` 的三态是**故意不一致**的，按源逐字段实现：

| 字段 | 省略 | 显式 null | 值 |
|---|---|---|---|
| `enabled` | 继承 | 继承（不是 false） | 采用 |
| `dailyBudgetUsd` / `monthlyBudgetUsd` | 继承 | `Number(null)` = 0 | clamp 0..1000000，落库四位小数 |
| `maxParallelRequests` | 继承 | clamp 到 1 | clamp 1..1024 |
| `targetProfileId` | 保留 | 清除 | trim，空串同样清除 |

预算与并发带 `@Type(() => Number)`，因此字符串 `"30.5"` 合法；`timeoutMs`、
`attempts`、`concurrency`、`temperature`、`topP`、`maxOutputTokens` 没有
`@Type`，字符串一律 400。诊断 DTO 的可选布尔在 `null` 时等同省略。

两套 DTO 的长度限制**不统一**：保存 profile 的 test DTO 对
`model/embeddingModel/rerankModel` 限 256、`prompt/embeddingInput/rerankQuery`
限 4000、`rerankDocuments` 最多 20 项且每项 4000；`test-config` 的
`model/prompt/embeddingInput/embeddingModel/rerankModel` **没有长度上限**。
`models-config` / `test-config` 的 `apiBase` 用与 profile DTO 相同的
`@IsUrl({require_protocol:true, require_tld:false})`（允许 `litellm:4000`
这类内部域名），不套爬虫 metadata 的公网 SSRF 规则。

`apiKey` 三态：省略或 `null` 复用已存 key；显式字符串（含空串）替换；
`Bearer sk-...` 归一化。

## 治理持久化与远端协议

存储：MySQL `SystemSetting` key `litellm_proxy_governance`；Redis 同名 envelope
`{exists,value}` TTL 30。读取顺序是 cache → MySQL → 回填 cache；**任何 cache
失败只记 warning**，不把 Redis 故障变成治理不可读。

**启用/更新**（顺序即契约）：

1. 由已存文档解析出 next；
2. 若 `next.enabled`：先跑 preflight（blocking 即 400，**不碰 LiteLLM**），
   解析 target profile，`GET admin client`（无 master key → 503），
   `POST /team/update`（仅 404 或 400+`not found` 时回落 `/team/new`），
   再 `POST /key/update`（仅 404 或响应含 `not found`/`invalid key` 时回落
   `/key/generate`）；
3. 编码并写入新文档 → 失效共享缓存；
4. **之后**才 best-effort 停用旧实例资源（仅当归一化 apiBase 变化）；
5. 写审计 `litellm_proxy_governance_update` / `_disable`，返回投影。

远端失败发生在第 2 步，因此不会出现"DB 已保存但 LiteLLM 从未见过这个 key"。
关闭（`enabled=false`）先清空内存中的 key/team/alias 并落库，再 best-effort
block 旧资源。**DELETE** 先删行 + 失效缓存，再清理远端。
**rotate**：未启用 400、无 `managedTeamId` 400；生成新 key → 落库 → 失效缓存
→ best-effort block 旧 key。**任何一支都不声称跨 MySQL/远端原子事务。**

审计动作字面量与源一致：`litellm_proxy_governance_update`、`_disable`、
`_reset`、`_rotate_key`，`resource=system_settings`，metadata 为具名 struct，
不含 secret。

`managedRuntimeKey` 同时接受明文（trim，不剥 Bearer）与
`system-settings:v1` AES-256-GCM envelope；状态三分为 `missing` /
`available` / `unreadable`，**unreadable 的 `hasManagedRuntimeKey` 仍为 true**，
投影绝不返回明文。

## 真实探测

- `/v1/models`（回落 `/models`）、`/v1/model/info`（回落 `/model/info`）、
  `/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`（回落
  `/embeddings`）、`/v1/rerank`（回落 `/rerank`）：**短路径只在 404/405 触发**，
  401/429/5xx 不重试、不删字段、不切 API surface。
- completion：显式 override 只测该 model，否则 profile model + fallbackModels
  去重保序逐个尝试；遇到兼容性错误立刻停止（不再试下一个 model）。
  输出 token 上限 128，`response_format` 三态、`metadata={source:"gateway-test"}`
  按源。
- embedding：override → embeddingModel → model；首向量必须是**非空数组**，
  否则是分项错误。
- rerank：自身模型 + rerankFallbackModels，query/documents trim 去重，
  `top_n = len(documents)`；接受 `relevance_score`/`relevanceScore`/`score`/
  `similarity`，结果**按 index 升序**（不是按分数）；无有效结果即分项错误。
- 三项按 completion → embedding → rerank 顺序执行，单项失败（甚至全失败）仍是
  201 的分项诊断；只有 profile/ apiBase / DTO / managed key 错误才整体失败。
- `proxy-model-info` 缓存 key = `llm_gateway:proxy_model_info:v1:<profileId>:<sha256(normalizedBase) 前 16 位>`，
  TTL 60；`force` 只认查询串 `"1"`/`"true"`，语义是**同时跳过读和写**。
- 成本/头部：`x-litellm-response-cost` > `x-litellm-cost` > `litellm-cost` >
  body `response_cost`，未知成本是 `null` 不是 0；`x-litellm-call-id` /
  `-model-id` / `-model-api-base` / `-model-group` / `-version` 原样透出。

## 日志

`llmlogs.ProbeWriter` 对每次真实尝试写一行 `llmrequestlogs`：
`feature=gateway_test`；`requestType` 为 `completion`/`embedding`/`rerank`；
`apiSurface` 为 `chat_completions`/`responses`/`embeddings`/`rerank`；
metadata 为 `source=gateway-test`、`feature`、`operation`、`model`（请求模型）、
`profileid`、`userid`、失败时 `tags=["diagnostic","error"]`。metadata 仍走
`llm_request_log_settings` 的 allowlist/prefix/长度策略（与简报 writer 共用同一
过滤函数，不绕开策略）。

时机：completion/LB 在 2xx 后立即记成功；embedding/rerank 只有在响应体校验通过
后才记成功，失败只记一条错误——**同一次逻辑尝试（主路径 404 → 短路径成功）只
记一条最终日志**。Mongo 写失败只记 warning，不影响已完成的诊断。

`_unknown_` 只在 actor 缺失时出现。本批**不写**简报专属 metadata，也不改简报
writer 的行为。

## 并发（本批的具体改进）

`proxy-lb-test` 用**固定大小 worker pool**：worker 数 = min(concurrency,
attempts)，每个 worker 复用同一个 HTTP transport，所有 attempt 写入按 index
预分配的 slice（无锁、无竞争），池排空后**单处汇总** succeeded / failed /
两个分布 / callId 样本（≤20）/ errors（≤10）。因此
`succeeded + failed == attempts`、分布只统计成功尝试、样本上限精确。
这只是一个请求内的固定 worker pool，不是通用任务执行器；三类普通探测仍保持
源顺序执行。

## 复用端口（不复制）

| 能力 | 来源 | 说明 |
|---|---|---|
| profile 读取 / 运行绑定 | `llmgatewayprofiles.RuntimeProfileConfig`、`RuntimeBindings` | 复用既有 normalization 与三路选择规则；只读，不再开 GET_LOCK 连接池 |
| secret 加解密 | `EncodeSecretForStorage`、`DecryptSecretEnvelope` | 复用写入策略与 `SYSTEM_SETTINGS_ENCRYPTION_KEY` 解码；不复制默认值/加密实现 |
| apiBase 归一化 / URL 校验 | `NormalizeAPIBase`、`ValidateAPIBaseURL` | 与 profile DTO 同一份实现（缓存 key、治理目标比较都依赖它） |
| 鉴权 | `Authenticator.Authorize` | 与 7 条 profile 路由同一链 |
| 日志存储与过滤 | `llmlogs`（`ProbeWriter` + 共享过滤） | 复用日志设置、归一化、Mongo 存储 |

## 验证

- 静态：`gofmt -l`（干净）、`go build ./...`、`go vet ./...`、
  `go test ./...`（全绿）。
- 用例（`internal/llmgatewayops`、`internal/legacyproxy`）：
  omitted/null/三态、class-validator 消息顺序、`apiKey` 三态、两个 DTO 的
  长度差异、`attempts:null` → 1、静态路由优先级与未接管路径回退、
  404 → 短路径只记一条日志、embedding/rerank 无效 2xx 只记错误、
  LB worker pool 的并发上界与汇总不变量（含全失败）、密钥三态与投影覆盖、
  model-info 脱敏。
- 未执行：本机不跑 Docker、不连真实 MySQL/Redis/Mongo、不发任何真实
  LiteLLM/模型请求。

## 明确未验证

- 真实 LiteLLM `/team/*`、`/key/*`、`/v1/*` 的行为与字段差异（含
  `not found` / `invalid key` 的真实措辞）。
- 真实 Mongo 写入与 TTL、真实 Redis envelope 共享。
- 生产切换、canary、Web→NestJS 路由变更均未发生。

## 回滚

把 `API_GO_LLM_GATEWAY_OPS_MODE` 改回 `legacy`（或删除该变量）即可让 12 条
路由回到 NestJS。已保存的治理状态、已生成的 LiteLLM team/key 与已写入的
`llmrequestlogs` **不会**因回滚被撤销；需要清理时用治理自身的 disable/reset 或
rotate 动作。
