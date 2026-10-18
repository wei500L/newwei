# 目标

执行 LLM-GATEWAY-OPS-001：把网关治理与真实诊断的剩余 12 条 HTTP 完整迁入 apps/api-go。管理员可以检查治理启用条件、设置预算/并发、启用或停用受管密钥、轮换密钥，获取模型/健康/模型信息，并实际探测 completion、embedding、rerank 和负载分布。必须完成远端 team/key 操作及 Mongo 请求日志，不能只实现配置 CRUD、缓存读取或假成功。

专注迁移和必要功能，不堆防御性编程，不增设通用锁、重试、补偿框架或兼容平台。保留现有鉴权、业务校验、全局设置边界和必要事务。Go DTO、响应、数据库JSON、缓存、审计使用具名强类型，不用 any/interface{}/map[string]any/[]any 承载业务数据；扩展JSON叶子可用 json.RawMessage。新增或修改源码注释写英文，解释密钥顺序、fallback、并发汇总和日志时机等关键原因。文档、提交、PR 描述用中文。

# 基线、分支与恢复

- 仓库 /Users/oo/project/newwei；最新已核基线 origin/main 为 90765633ac6ba2b1d97a89d0ec33be90cb69bcb7。#70–#76 已由 #77 合入；#79 身份14路通过 f35ec572ccdf607b9224d88d1962cf792f9915be 合入，#78 旧身份规划也已合入。本 SHA 普通 CI 39149114456 最后查询仍在运行；旧 c39f282f 的 CI39142523834 成功不能替代新 SHA，不代表生产切流或真实外部验证。
- 先 git fetch origin main，读取适用 AGENTS.md；重新查 main SHA、开放 PR、最近五次 main CI、git worktree list。旧 checkout 停在历史分支，不能用它判断迁移进度。若 main 前进，只核本批和公共接线增量，不做全仓审计。
- 从 fetch 后 origin/main 创建 refactor/go-llm-gateway-ops，worktree 固定 /Users/oo/project/newwei-go-llm-gateway-ops。目录/分支已存在时先核归属与改动，不覆盖。不要在旧业务 worktree 开发。
- 地图主线来自已合 #69；本任务和完整提示词在独立规划分支 docs/plan-llm-gateway-ops 发布，未合时只读该分支的 docs/refactor/migration-map，不合入其文档历史。先读 README.md、PLANNING.md、tasks/README.md、GAPS.md 摘要、BACKLOG.md 的 BL-17、modules/model-gateway.md、AUDIT.md 对应域及 DEPENDENCIES.md 相关资源，再读本任务记录与源码。
- 发出前开放业务 PR 为空；#79 的 IDENTITY-ONBOARDING-001 已合入，不重复派发或改写。已读实际diff与main接线，本批业务与身份包隔离。执行前仍重新查新开放 PR/认领和 worktree；已有历史目录不自动代表活动占用，后续新增占用以实际改动为准。不开新对话、不向其他对话发消息。

# 精确接口与权限

公共前缀 /api/system-settings/llm-gateways。以下 12 路全部要求 settings.manage，复用现有 JWT 与 mtk_ 机器身份权限路径，不添加 platform_admin 限制。设置仍是全局 SystemSetting，不创造按 orgId 分片的设置；actor 的 orgId/userId 用于原有审计和日志归属。

| 方法 | 前缀后的路径 | 成功状态 |
|---|---|---|
| GET | /proxy-governance | 200 |
| PUT | /proxy-governance | 200 |
| DELETE | /proxy-governance | 200 |
| POST | /proxy-governance/preflight | 201 |
| POST | /proxy-governance/rotate-key | 201 |
| GET | /:id/models | 200 |
| POST | /:id/test | 201 |
| GET | /:id/proxy-health | 200 |
| GET | /:id/proxy-model-info | 200 |
| POST | /:id/proxy-lb-test | 201 |
| POST | /models-config | 201 |
| POST | /test-config | 201 |

不重迁 profile CRUD/三种激活 7 路、model-service/OpenAI keys 10 路、LB 配置/内部下发 4 路。已有 Go 覆盖这些 21 路，本批只补余下 12 路，不把注册数量当所有 LLM 执行能力已完成。

# 源码事实源与已有 Go 复用

Nest 事实源位于 apps/api/src：
- modules/system-settings/llm-gateway-settings.controller.ts：12 个 handler、权限、actor、force 查询值与响应状态。
- 同目录 litellm-proxy-governance.service.ts：getPublicSettings、getEnablePreflight、updateSettings、resetToDefaults、rotateManagedRuntimeKey、resolveTestingApiKey，以及全部远端同步/密钥存储/停用助手。
- 同目录 llm-gateway-test.service.ts：listModels/listModelsConfig、testProfile/testConfig、testProxyHealth、getProxyModelInfo、testProxyLoadBalancing、postLoggedModelProbe、错误转换及响应归一化。
- 同目录 llm-gateway-settings.service.ts：getProfileConfig、profile summary、resolveRuntimeBindingsSnapshot、completion/embedding/rerank 的有效配置选择；system-security-settings.service.ts 的密钥编码策略。
- 同目录 dto/llm-gateway-proxy-governance.dto.ts、llm-gateway-test.dto.ts、llm-gateway-test-config.dto.ts、llm-gateway-proxy-lb-test.dto.ts，以及 llm-gateway-error-codes.ts。
- common/llm-openai-compat.ts 与 modules/news-pipeline/llm-request-log.service.ts：兼容性错误、文本提取、请求日志和 metadata policy。

这些候选 Nest 源码相对旧地图 main 9d0462e1 到当前基线没有业务变化；c39f282f→90765633 的相关 Go 增量为身份接线，本批 gateway/profile/日志基础未变化。源码优先；不要只按本提示词复制类型而跳过实现分支。

Go 复用 apps/api-go 下：
- internal/llmgatewayprofiles 的 StoredSettings/StoredProfile、NormalizeSettings/NormalizeProfile、EnvDefaults、SecretValue 加密 envelope、配置缓存、system_security secret_encryption 策略和鉴权器。当前没有导出的 getProfileConfig/运行绑定/完整 secret codec；通过少量具名方法或窄端口暴露所需能力，不假设已有 public 方法，不复制整套 profile 默认值/加密实现。只读 profile 服务不需要为本批另开 GET_LOCK 连接池。
- internal/modelaccesssettings 的现有 LB/密钥协议仅参考复用必要小助手，不重写配置管理或内部 token 路由。LITELLM_MASTER_KEY 与 LITELLM_CONFIG_INTERNAL_TOKEN 用途不同。
- internal/publicportal/gateway.go、internal/llmembed/profile.go 已按同一治理文档应用 managed runtime key，缺失/不可读会报错。本批保持其兼容，不能另写运行时治理体系，也不重新迁其调用链。
- internal/llmlogs/completion.go 是简报日志 writer，RequestType 固定 completion，metadata 仅 Feature/EventTitle/Sources，不能直接拿它冒充三类探测日志。增加具名 probe writer，最小提取复用既有日志设置、归一化和 Mongo 存储，保持简报 writer 行为。
- 复用 sharedDB、Redis、Mongo、authhttp/machine/RBAC、审计写入及 legacyproxy 注册习惯；新增 internal/llmgatewayops/** 和 cmd/api/llm_gateway_ops.go 作为本批业务主体。

# DTO、缺省与返回契约

1. 治理默认 enabled=false、dailyBudgetUsd=25、monthlyBudgetUsd=500、maxParallelRequests=16、targetProfileId=null。预算 @Type(Number)，范围 0..1000000，落库按源四位小数；并发 @Type(Number)+IsInt，1..1024。必须区分 omitted 与 null：预算 omitted 继承、显式 null 按源 Number(null) 为 0；并发 null 按归一化为 1；enabled null 不当 false，仍继承；targetProfileId omitted 保留、null/空串清除。验证层与 service 层转换按源分别实现，不能统一空值处理。
2. 公共治理投影含 source(default/db)、enabled、apiBase、预算/并发、targetProfileId/name/enabled、adminKeyConfigured、hasManagedRuntimeKey、managedRuntimeKeyState(missing/available/unreadable)、managedTeamId、managedRuntimeKeyAlias、lastSyncedAt、lastSyncError。不可读 key 的 hasManagedRuntimeKey 仍为 true；只投影状态，绝不返回明文 key。目标不存在/停用、不可解密的 lastSyncError 按源覆盖。
3. 保存 profile 的测试 DTO：authMode=profile_key|managed_runtime_key；apiSurface=chat_completions|responses；responseFormatMode=none|json_object|json_schema；includeCompletion/Embeddings/Rerank/MetadataProbe 是可选布尔。model/embeddingModel/rerankModel 最长 256；prompt/embeddingInput/rerankQuery 最长 4000；rerankDocuments 最多 20、每项最长 4000。按 DTO 的可选/null 及 service 的 ??/|| 差异落地。
4. models-config/test-config：apiBase 必填，IsUrl(require_protocol=true,require_tld=false)，允许源支持的内部域名，不套用 crawl metadata 的公网 SSRF 规则；profileId 指定但不存在仍 404。apiKey omitted/null 复用 stored key，显式字符串空值清除，粘贴 Bearer 前缀按源归一化。timeoutMs 可选整数 1000..900000。test-config 的 temperature 0..2、topP 0..1、maxOutputTokens 整数 1..1000000；fallbackModels/rerankFallbackModels 各最多 20 项。其 prompt/embeddingInput 没有 saved-test DTO 的 4000 上限，不擅自统一收紧。
5. 测试缺省 includeCompletion=true，includeEmbeddings 未传时看有效 embeddingModel，includeRerank=false；authMode=profile_key；apiSurface/responseFormatMode/metadata 按输入→profile→chat_completions/json_schema/true 解析。临时配置默认 timeout 60000、temperature .2、topP .9、maxOutputTokens 1200；prompt 默认 Say "OK" and nothing else.，embeddingInput 默认 hello；rerank 默认 query/documents 逐字沿用源常量。保存但 disabled 的 profile 仍可诊断，不误套治理目标必须 enabled 的限制。
6. models 返回 {apiBase,models:string[]}，支持源的数组/data/models 字符串或 id 形状，trim 去重保序。health 返回 apiBase/checkedAt/liveliness/readiness，每项 ok/status?/message?；单项失败返回 ok=false 而非整个请求失败；tester 把 2xx HTML 判失败，治理 preflight health 保留自身逻辑。
7. proxy-model-info 返回 apiBase/checkedAt/cached?/cacheTtlSeconds?/models[{modelName,litellmParams?,modelInfo?}]，递归移除源指定 api_key/apiKey/Authorization/authorization，脱敏 Bearer/sk-；可扩展 JSON 叶子用 json.RawMessage。force 仅查询字符串 "1" 或 "true" 生效，源行为为同时跳过缓存读写，不是刷新缓存。
8. test 返回 apiBase、authModeUsed，completion 启用时 apiSurfaceUsed?，以及 completion/embedding/rerank 各自结果或各自 Error，按源省略不存在字段，不能统一写 null。三项按 completion→embedding→rerank 顺序执行；单项甚至全部探测失败仍返回 201 的分项诊断，外围 profile/base/DTO/managed key 错误照常失败。无项目可测为 400 LLM_GATEWAY_NOTHING_TO_TEST。
9. proxy-lb-test 默认 attempts=8、concurrency=2，DTO 范围 1..50、1..10；model/prompt 长度 256/4000。返回 apiBase/model/attempts/succeeded/failed/durationMs/checkedAt/modelIdDistribution/modelApiBaseDistribution/callIdSamples/errors；缺分布头记 unknown，callId 最多 20、errors 最多 10。全部失败仍是 201 汇总。
10. 错误结构保留 code/message/status?/axiosCode?/requestId?/upstreamType?/upstreamCode?/compatibilityError?。profile 缺失 404；外层上游 <500 映射 400、>=500 映射 502、无 HTTP 状态映射 503、兼容性错误 400。业务常量、认证提示、detail/message 提取与脱敏沿用 llm-gateway-error-codes.ts 和 toGatewayErrorInfo/throwGatewayError。兼容错误保留 UNSUPPORTED_METADATA/RESPONSE_FORMAT/JSON_SCHEMA、INVALID_MESSAGE_CONTENT、RESPONSES_API_UNSUPPORTED 等源字段，不简化成一个 500，也不把所有上游 404 当 profile 不存在。

# 治理持久化、远端协议与副作用

- 全局 MySQL SystemSetting key=litellm_proxy_governance；Redis 同名 key TTL 30，缓存 envelope {exists,value?} 与源一致。profile key=llm_gateway_profiles、缓存 llm_gateway:profiles TTL 60；system_security 缓存遵循现有实现。保留源缓存 best-effort 边界与失效时机，不加本地假状态。
- 密钥同时支持源 plaintext 和 system-settings:v1 AES-256-GCM envelope。复用 SYSTEM_SETTINGS_ENCRYPTION_KEY 与 secret_encryption 策略、生产约束，保留 missing/available/unreadable 区分；不强制所有启动场景必须配置 master key/可解密 key。
- preflight 依次给 admin_key、target_profile、runtime_traffic、proxy_health、managed_runtime_key 五项；前四项 required，最后一项只是 warning。按实际 completion/embedding/rerank 绑定快照判断目标流量，不把 activeProfileId 等同全部流量。并行检查 /health/liveliness、/health/readiness，timeout 10 秒；源 preflight 的 profile_key fallback 参数为空，不擅自改用 master。返回 checks/canEnable/blockingIssues/warnings/trafficBindings/health 等源投影。
- 启用或 enabled 状态更新：先检查 preflight/目标有效，再同步 LiteLLM team/key，成功后编码存储→失效共享缓存；切换归一化 base 后才 best-effort 停用旧实例资源。关闭：先保存 disabled 并清理受管 key/team/alias，再 best-effort block 旧资源；DELETE 先删设置和缓存再清理远端。不要在 DB 失败前停旧 key，也不要声称跨 MySQL/远端原子事务。
- rotate：治理 disabled、无 managedTeamId 分别按源 400；生成新 key→编码并保存新 key/alias/lastSyncedAt→失效缓存→best-effort block 旧 key。不能只生成但未保存，不能先 block 旧 key。
- 管理请求使用 LITELLM_MASTER_KEY，trim/去 Bearer，Bearer header+JSON、timeout 60 秒；缺失时相关管理请求 503，GET/preflight 可报告 adminKeyConfigured=false，profile_key 普通测试不因此全局禁用。
- 同步 POST /team/update，payload team_id/team_alias/max_budget(月预算)/budget_duration="30d"/blocked=false/metadata；只在 404 或 400 且 not found 时 fallback /team/new。team_alias="Modular Runtime Governance"，metadata={managed_by:"modular",scope:"runtime_governance"}。
- key 更新 POST /key/update，带 key/key_alias/team_id/max_budget(日预算)/budget_duration="1d"/max_parallel_requests/blocked=false/同 metadata；仅源指定 missing/recreate、404 或错误内容 not found|invalid key 分支走 /key/generate。生成 payload、teamId/alias 生成格式沿用源，缺返回 key 为 503。其他失败按源抛错，不盲目重复生成。
- 停用走 /key/update 或 /team/update 的 blocked=true、max_budget=0 及源 budget_duration；旧资源清理失败记录 warning，保留已成功保存的新状态。审计动作 litellm_proxy_governance_update/disable/reset/rotate_key 的实际字面量以源调用为准，resource=system_settings，actor/metadata 不丢失，不能输出 secret。
- managed_runtime_key 诊断仅支持 saved profile，必须治理 enabled、有效目标 id 和归一化 base 都匹配，否则按源 400；匹配但密钥不可读/缺失 503。profile_key 默认只使用 profile/临时 key，不自动替换成受管 key。

# 真实探测、缓存与具体并发实现

- 对源使用的 /v1/models、/v1/model/info、/v1/chat/completions、/v1/responses、/v1/embeddings、/v1/rerank，短路径 fallback 只在 404/405 触发；不对 401/429/5xx 添加重试，不为了成功删除 metadata/response_format、切 API surface 或跳过探测。
- completion：显式有效 model override 只测该 model，否则按 profile model+fallbackModels 去重保序尝试；沿用源兼容错误分类及何时停止 model fallback，不能无条件吞掉错误。Chat messages/Responses input、token 字段、text 提取、usage/cost、response_format none/json_object/json_schema 与 metadata={source:"gateway-test"} 精确按源。普通测试输出 token 上限 128；不要把 Responses 请求改成 Chat。
- embedding：按 override→embeddingModel→model 解析，检查首向量为非空数组，返回 dimensions/usage/成本及源头字段。rerank 用自身模型及 rerankFallbackModels，query/documents trim 去重，保留源默认文档；top_n 为 documents 长度。兼容 relevance_score/relevanceScore/score/similarity，合法 index/有限数值，结果按 index 升序，不改成按分数排序；无有效结果返回分项错误。
- cost/header 与 payload 的优先级、x-litellm-call-id/model-id/model-api-base/model-group/version、requestId 与 compatibilityError 都保留，未知成本为 null 而非 0。
- model-info Redis key=llm_gateway:proxy_model_info:v1:<profileId>:<sha256(normalizedBase)前16位>，TTL 60 秒，force 语义见上；模型列表/健康读取不伪造业务缓存。
- LB 每次 prompt 增加换行 #<1-based attempt>，temperature=0、top_p=1、max_tokens=16、stream=false，使用 Chat 端点。保留源“HTTP 成功即本次成功”的口径及实际日志，不额外验证正文改变统计。
- 采用小型固定 worker pool 执行 LB attempts：并发不超过请求值，复用 HTTP transport，所有 attempts 完成后单处汇总或等价无竞争聚合，确保 succeeded+failed=attempts、分布和样本限额正确。这是本批具体并发改进，不扩展成通用任务执行器，也不把三种普通探测改成并行。

# Mongo 日志是交付的一部分

- 对 test/test-config 与 LB 每个真实模型候选尝试写 llmrequestlogs；同一逻辑尝试的主路径404→短路径成功只记一条最终日志，不按两次网络请求重复记。embedding/rerank 先校验有效响应再写成功，失败只记错误，不能成功/失败双写。
- feature=gateway_test；requestType 分别 completion/embedding/rerank；apiSurface 分别 chat_completions/responses/embeddings/rerank；保留 model、orgId、profile、governanceApplied、authMode、governanceTargetProfileId、usage/cost/latency/error 及源 probe metadata 的 userId/source/operation/tags。源 metadata allowlist/prefix/长度策略仍生效，不为诊断绕开策略。_unknown_ 仅按源 actor 缺失场景使用。
- 增加具名 ProbeLogEntry/ProbeMetadata 等，不把 embedding/rerank 写成 completion，不往简报专属 metadata 生塞字段。复用 llmlogs 既有设置/存储/归一化；Mongo 插入失败 warning 后继续诊断，沿用 best-effort 边界。无需重迁日志查询/导出/设置。
- 本批无 BullMQ 入队、worker、repeat、cron。审计沿用当前基础，不领取 outbox 消费者或 moderation worker。没有本批真实 LiteLLM/model 调用验证记录，不虚写已验证。

# 文件所有权、独立开关与回退

- 允许：internal/llmgatewayops/**、cmd/api/llm_gateway_ops.go、独立 legacyproxy 路由文件；llmgatewayprofiles 内必要的 typed profile/secret/runtime-binding/auth 窄端口；llmlogs 内 probe writer 与最小共享提取；config/main、现有 env/compose/README 的本批条件增量，以及一份可选的独立交付说明。
- 不改 #79 的 internal/identityonboarding、authlogin/mail_port.go、orgaccesswrite bootstrap、rbacapi 业务；不重写 publicportal/llmembed/模型接入/LB/profile CRUD，不改 Nest 路由和 DTO、Web API 入口、GraphQL、爬虫、新闻简报算法和其他队列。复用已有授权入口不等于修改 RBAC 语义。
- 新 API_GO_LLM_GATEWAY_OPS_MODE 接受空串/legacy/go、默认 legacy、非法值启动失败。go 时独立初始化 MySQL/JWT/Redis/Mongo 和本批所需 profile/日志端口，不依赖 API_GO_LLM_GATEWAY_PROFILES_MODE、MODEL_ACCESS_SETTINGS、PROXY_LOAD_BALANCING、LLM_LOGS、PUBLIC_PORTAL 或 GraphQL 开为 go。secret 策略按既有写入时规则执行；master key 按管理请求需要校验，不作为全部12路的启动前置。
- Mongo 连接复用/初始化必须覆盖“只开本批模式”的情况；不能仅当日志查询开关 go 才提供 writer。资源 OR 条件、生命周期/close、诊断信息、config 校验、wire 和 production handler 注册形成完整链。
- 公共 main/config/env/compose 与 #79 及其他迁移按语义保留并集，不覆盖整段。后合者正常 merge 最新 origin/main，不 rebase。必要冲突只处理自己的增量。
- 只注册表中精确 METHOD/path；静态 /proxy-governance、/models-config、/test-config 不被旧动态 :id 规则误吞。旧 profile handler 已有 IsUnmigratedStaticPath 回退保护，使用更具体规则接管，保留其余旧回退。legacy 下整组仍转 Nest；go 下未迁路径/方法继续现状，不能接管整个前缀或用业务 handler 回调 Nest 冒充迁移。
- Web→NestJS 与 canary 默认保持现状；不修改部署开关、不自动启用治理、不真实生成/轮换生产 key。代码回退为模式 legacy；已保存治理状态与 LiteLLM 资源共享，不声称切回 legacy 会撤销远端副作用；源 disable/reset 是显式管理动作。

# 精简验证与交付

- 本机不安装依赖，不运行 build/test、Docker 或服务，不发真实外部/生产密钥请求。可以静态检查、gofmt、git diff --check。源码与构造的契约检查聚焦：omitted/null/key 状态、启停/轮换存储顺序与远端失败、只开本批资源/静态路由优先级、404/405 fallback、分项失败、三类日志及并发计数。需要测试时用现有结构和 mock HTTP/存储写少量高价值用例，交普通 CI 执行，不堆泛化测试体系。
- 使用现有普通 GitHub Actions，不新增专用 smoke workflow。记录最终 head SHA、实际执行的检查与链接，等待必要检查结束并修复本批错误；skipped 不是通过。无法做的真实 LiteLLM/模型验证清楚写未验证，不把 mock 当实测。
- 规划窗口集中维护共享地图；本编码窗口不要改 migration-map 的共享索引、BACKLOG、域页和其他任务，不要求现有任务重做文档。PR 说明或一份本批短交付说明给出 LLM-GATEWAY-OPS-001、12路、关键行为、文件/开关、复用端口、具体优化、PR/head/CI、未验证外部服务及剩余缺口，供规划窗口回填。未合并时只能 pr_open，不提前增加 main 完成数。
- 只提交本批改动，中文 emoji + type(scope) 正常 commit/push，创建 Ready PR，描述围绕最终实现与必要验证。禁止 amend/rebase/force-push、merge、auto-merge。创建后附上 PR 链接。
- 最终交付：Ready PR、分支/worktree、最终 SHA、12路完成情况、必要副作用与优化、普通 CI 链接/结果、开关/回退、明确未做真实外部验证。工作达到可审查交付，不启动下一批迁移。
