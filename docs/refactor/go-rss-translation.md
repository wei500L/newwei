# RSS 阅读批量翻译（Go 接管说明）

> 任务：`RSS-TRANSLATION-001`。分支 `refactor/go-rss-translation`；worktree `/Users/oo/project/newwei-go-rss-translation`。
> 基线：`origin/main` = `90765633ac6ba2b1d97a89d0ec33be90cb69bcb7`（普通 CI run 39149114456 success）。
> 事实源：`apps/api/src/modules/items/items-rss-translation.service.ts`、
> `apps/api/src/modules/situation-monitor/situation-monitor-translation.service.ts`、
> `apps/api/src/modules/news-pipeline/litellm.service.ts`、
> `apps/api/src/modules/system-settings/{llm-gateway-settings,rss-translation-metrics,situation-monitor-settings}.service.ts`、
> `apps/api/src/common/llm-openai-compat.ts`、`apps/api/src/graphql/{dto/item.input.ts,models/item.model.ts,resolvers/items.resolver.ts}`、
> `apps/api/schema.gql`、`packages/db/prisma/schema.prisma`、`packages/db/prisma/migrations/20260215194000_add_rss_translation_metrics_daily`。

## 1. 范围与开关

- 新增单个 Mutation `translateRssItems(input: TranslateRssItemsInput!): TranslateRssItemsPayloadModel!`，根权限 `items.read`（不是 `items.write`）。
- 已迁 Query `rssTranslationStatus` 不重迁；仍由 `API_GO_GRAPHQL_READ_MODE + API_GO_ITEMS_READING_MODE` 控制。本批只修它的共享缓存写回缺口（GAP-RSS-001）。
- 新开关 `API_GO_GRAPHQL_RSS_TRANSLATION_MODE`：只接受空串 / `legacy` / `go`，空串等同 `legacy`，非法值启动失败；默认 `legacy`。与 `READ`、`ITEMS_READING`、`ITEMS_LIST`、`PUBLIC_PORTAL`、`LLM_LOGS`、网关管理及其他写模式完全独立。
- 仅本开关 `go` 时：登记这一个 mutation 与其两个返回模型；不注册旧 items Query，不强开其他 HTTP，不改 canary，不启用 shadow。
- 启动要求：`JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`。provider URL、密钥、profile 与加密 key 均为请求时语义；启动不做实网探测，未选 provider 不形成额外启动配置要求。
- 回滚：把本变量改回 `legacy`，该 Mutation 整份回 NestJS；旧 status Query 仍由原开关控制；GAP-RSS-001 修复无需恢复有害写回。不清缓存、不改 schema、不部署。

## 2. 输入契约（DTO/默认/null）

| 字段 | 类型 | 规则 |
|---|---|---|
| `itemIds` | `[String!]!` | DTO 原始数组上限 50（`itemIds must contain not more than 50 elements`），先查原始长度再 trim/删空/保序去重；service 上限仍 50（`RSS translation accepts at most 50 itemIds per request.`）。不要求非空数组 |
| `provider` | `RssTranslationProvider!` | SDL 默认 `deeplx`，仅 `deeplx`/`llm`；显式 null 由非空 SDL 拒绝 |
| `targetLanguage` | `String!` | SDL 默认 `zh-CN`，DTO 最长 16（UTF-16），trim 后空串归 `zh-CN`；显式 null 由非空 SDL 拒绝 |
| `fields` | `[RssTranslationField!]` | 可省略/null，最多 4；枚举 `title`/`summary`/`key_points`/`cleaned_markdown`；省略/null/`[]` 都使用 `title+summary+key_points`，保序去重。显式 `[]` 不等于"不翻译" |

规范化后 `itemIds` 为空时立即返回 `translations=[]`：不检查 provider、不访问 Mongo、不计请求指标。

返回契约：`provider`/`targetLanguage`/`translations` 非空，`translations` 可为 `[]`；每项 `itemId` 非空，`title`/`summary`/`keyPoints`/`cleanedMarkdown` 可空；未请求或源字段不存在投影为 `null`，不补空字符串/空数组；找到记录但无有效字段，或无本组织记录，返回仅 `itemId` 的项；不返回其他组织内容。

## 3. 执行链

1. `assertProviderAvailable`：调用 `itemsreading.RssTranslationStatus` 一次性计算 deeplx 与 llm 两个 provider 状态（保持 deeplx→llm 顺序），全局设置读取/治理解析抛错按源层级返回请求级错误，不因"只选一个 provider"吞错；不可用按 `BadRequestException` 语义返回 400 并沿用源消息（`No enabled LLM gateway profile is active.`、DeepLX/fallback 状态消息、`DeepLX API translation currently supports Chinese (zh-CN) target language only.`）。
2. provider 检查先于翻译缓存读取，旧缓存不能绕过已禁用 provider。状态只反映配置可用性，不做实网探测。
3. Mongo 选记录：`{orgId, status:"completed", itemMetaId:{$in:normalizedItemIds}}`，在数据库侧 `$sort {createdAt:-1, _id:-1}` + `$group {_id:"$itemMetaId", result:{$first}}` 每个 item 只取最新一条；`createdAt DESC` 保留，同毫秒用 `_id DESC` 确定性兜底（JS 原实现依赖同键未定义顺序）。不新增 `duplicateOf` 等原服务没有的限制，不新建索引/迁移。
4. `result` 可为对象或 JSON 字符串（含双重编码）：非法/空/数组/标量成为空字段 payload，不回退更老版本。`title→headline`、`summary→abstract` 取 trim 后非空回退，`key_points` 取非空字符串列表，`cleaned_markdown` 取非空字符串。输出按规范化 `itemIds` 顺序，与 Mongo 返回顺序解耦。
5. 字段顺序 `title→summary→key_points→cleaned_markdown`；普通文本上限 12000，Markdown 总上限 120000、目标块 1600、最多 80 块，全部按 JS UTF-16 `length`/`slice` 语义核对（`internal/rsstranslation/markdown.go`）。Markdown 按连续空行分段、长段按单换行拆、超长单行按 1600 切，翻译后双换行拼接并 trim；超限直接返回原 Markdown 并 `skipTooLongCount+1`，不改变原分块/顺序。
6. 部分失败采用原 `Promise.allSettled` 语义：逐项独立，某项抛错只移除该项，保留其他成功项。普通上游单段失败走 best-effort：原文回退、不缓存失败。缓存、Mongo、全局 provider 配置错误按源层级处理（缓存错误按逐项失败、Mongo/全局按请求级失败），不统一改成整批失败或全部成功。

## 4. 两层缓存

- 外层：`rss:translation:v1:<providerKey>:<language>:<sha256(trimmedText)>`，JSON 字符串值，TTL 7 天。`language=trim/lowercase targetLanguage`；DeepLX `providerKey=deeplx`；LLM `providerKey=llm:<trim/lowercase 主模型名或 default>`（用源服务取得的主模型，不用实际 fallback 模型）。同一次 `translateTextList` 内保序去重后一次 MGET，回填原顺序与重复位置；只缓存有效成功文本，失败/null 不缓存。
- DeepLX 内层：`situation-monitor:translation:v3:zh-cn:multi:<sha256(text)>`，JSON 字符串，TTL 30 天。任一内层任务失败时 best-effort 接口返回空映射，但已成功的内层缓存保留；不改成部分映射契约。
- 超 12000 的普通文本返回原文、不外调、不缓存，计 `skipTooLongCount`。

## 5. DeepLX 主备与 LLM

配置取 `SystemSetting situation_monitor_settings`，stored→env→default：timeout 默认 15000（1000–120000，env `SITUATION_MONITOR_TRANSLATION_TIMEOUT_MS`）；maxRetries 默认 2（0–5，env `SITUATION_MONITOR_TRANSLATION_MAX_RETRIES`）；DeepLX 并发默认 2（1–5000）；LLM 并发复用 `translationMaxConcurrency`，clamp 1–20，读取失败回退 2。两个限流器是服务实例共享上限，不是每 item 放大，不是分布式锁。

- DeepLX：`POST <baseUrl>/<encodeURIComponent(apiKey)>/translate`，JSON `{text, source_lang:"auto", target_lang:"ZH"}`；primary 不可用或失败后 `POST fallbackBaseUrl`，JSON `{source_lang, target_lang:"zh-CN", text_list:[text]}`。源语言按日→韩→中→法→德→英检测；中文直接返回原文，不支持语言按原失败分支。保留 response 提取 `string`/`data`/`translation`/`alternatives`、fallback `translations[].text`、数值 `code` 与 HTTP 错误语义。每端 `maxRetries+1` 次、300ms×attempt 退避、现有超时、等待可取消；不追加重试/熔断/凭据探测，不记录含 API key 的 URL。
- LLM：复用启用 completion profile 选择、managed runtime key、fallback models、API surface、timeout/topP/sendMetadata 配置；prompt 逐字迁移（`professional translation engine` system，user 含 Target language / 已是目标语言则原文返回 / Text 与正文）；`temperature=0`；`max_tokens=max(512,min(4000,ceil(JS长度*1.6)))`；`metadata={source:"rss_translation", targetLanguage}`；`maxRetries:1` 表示每模型最多一次 attempt（不是额外重试），模型 fallback 仍执行；保留 `/v1` 路径 404/405 短路径回退；同时支持 `chat_completions` 与 `responses`；不发 brief schema；RSS 未传 `response_format`，profile `none`/`json_schema` 省略 format，`json_object` 按 Nest 显式发送。空 choices/content、网络/模型错误按单文本原文回退、不缓存失败；guardrail/兼容性错误停止该次模型 fallback，不能绕过阻断尝试下一模型。`rss_translation` 不在自动 moderation feature 集合，不新增 moderation 调用。

模型每个真实 attempt 按 Nest 日志边界写 `llmrequestlogs`（`orgId`、`requestType=completion`、`feature=rss_translation`、model、success/error、延迟、usage/cost、apiSurface、profile/governance/authMode 等）；metadata 只带 source/targetLanguage 并按既有 allowlist/prefix/长度策略过滤，未上报值保持 null，不写完整翻译正文；写日志失败 best-effort。

## 6. 每日指标与副作用

`finally` 记录 `RssTranslationMetricsDaily`，唯一键 `orgId/date/provider/targetLanguage`；`date` 为 UTC 日，provider/language trim 小写；计数原子累加，`maxLatencyMs` 用 `GREATEST`，更新 `updatedAt`，不读取后整体覆盖。保留 `requestCount/itemCount/textCount/cacheHitCount/cacheMissCount/translatedCount/failureCount/skipTooLongCount/totalLatencyMs/maxLatencyMs`，计数层级与源 `createMetricsAccumulator/translateTextList/recordMetricsBestEffort` 一致。provider 全局检查失败等仍在 finally 记请求，尚无 `failureCount` 时至少为 1；空 itemIds 早返不记。表/列缺失（MySQL 1146/1054）及写失败不阻断翻译。

翻译结果只写缓存、指标与日志：不覆盖 `processeditems` 原文/result，不写 ItemMeta/read-model，不重建 ES，不入队，不启动 worker/Cron，不发邮件或通知；数据库写仅指标原子 upsert，外部 HTTP 不放长事务。

## 7. GAP-RSS-001 与查询改善

`itemsreading.loadLLMGatewaySettings` 原在共享 `llm_gateway:profiles` miss 后把只含 `activeId` 和 profile `id/model/enabled` 的窄结构 Marshal 后写回同一 key；Nest `LlmGatewaySettingsService` 在该 key 存完整 normalized settings（含 apiBase/apiKey/协议及其他用途配置），状态查询会破坏共享完整缓存。本批修复为：状态 reader 保留 canonical 缓存读取；miss 从 DB 规范化仅供状态返回；不再回填窄结构；不重做 profile CRUD，不盲目 DEL 共享 key。新翻译 runtime 读完整 profile（`publicportal.NewMySQLStore(db).GatewaySettings` 公开完整 DB reader），绝不把状态 DTO 当连接配置。

## 8. 复用与文件

- `internal/itemsreading/translation_support.go`：窄导出 `TranslationRuntimeConfig` 与 `TranslationRuntime`，补齐 timeout/retries/concurrency，不跨包调用私有符号，不强开 items HTTP。
- `internal/publicportal/rss_completion.go`：RSS 专用具名端口，选择性复用 `resolveCompletionProfile`/治理/API base/usage/cost/禁用文本等等价 helper；`GatewayEnv`/`completionProfile` 仅新增 `TopP` 兼容字段，不改 brief 行为。
- `internal/llmlogs/rss_translation.go`：RSS 专用 typed writer，复用稳定 `MetadataPolicy`/归一化 helper，自带 `RssTranslationMetadata` 叶子，不引用 #81 变动中的私有表面，不修改 `completion.go`。
- 新 `internal/rsstranslation`（records/markdown/deeplx/cache/metrics/service）与 `internal/graphqlread/rsstranslation`（mutation/models/input adapter）。
- `cmd/api/rss_translation.go` 窄 wire；main 补齐 `/graphql` 路由 OR、无效 DSN 阻断、资源 OR、handler OR、Mongo 创建/复用/关闭与 `RegisterMutation`。
- `internal/classificationrssops` 的每日指标查询不重派；GraphQL 复用 `contract.Registry/RegisterMutation/Bind/Failure` 与现有 executor，不重写引擎。

## 9. 验证与未核实项

- 本机只做 `gofmt`、`git diff --check` 与只读静态审查，未安装依赖、未运行 `go build`/`go test`/Docker/服务。
- 交远端现有普通 CI 执行。DeepLX/fallback/LLM 实网调用、Redis/Mongo/MySQL 真实读写、生产启用与流量均**未执行、未核实**；不能用 CI 或 fake 推断实网/生产启用。
