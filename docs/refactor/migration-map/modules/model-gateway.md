# model-gateway · 模型接入、密钥与 LLM 网关

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

模型接入/OpenAI 密钥十路、网关配置与三路激活七路、代理负载均衡配置下发四路已接管；代理治理和真实远端模型探测没有因此迁完。

关键数据与副作用：MySQL SystemSetting、共享 Redis、SYSTEM_SETTINGS_ENCRYPTION_KEY、内部 LITELLM_CONFIG_INTERNAL_TOKEN；下发密钥/配置与实际 LiteLLM 应用成功分层。上游模型、LLM 请求/embedding 服务不等于其配置 CRUD。

真实剩余缺口：proxy-governance 的五路及 models/test/config/proxy-health/proxy-model-info/proxy-lb-test 等仍见 Nest 行。真实 LiteLLM/SMTP/model-service 连通与质量无本次验证证据。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#model-gateway) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithLLMGatewayProfiles](../../../../apps/api-go/internal/legacyproxy/llm_gateway_profiles_routes.go) | `API_GO_LLM_GATEWAY_PROFILES_MODE` | [llmgatewayprofiles](../../../../apps/api-go/internal/llmgatewayprofiles) | `${API_GO_LLM_GATEWAY_PROFILES_MODE:-legacy}` |
| [WithModelAccessSettings](../../../../apps/api-go/internal/legacyproxy/model_access_settings_routes.go) | `API_GO_MODEL_ACCESS_SETTINGS_MODE` | [modelaccesssettings](../../../../apps/api-go/internal/modelaccesssettings) | `${API_GO_MODEL_ACCESS_SETTINGS_MODE:-legacy}` |
| [WithProxyLoadBalancing](../../../../apps/api-go/internal/legacyproxy/proxy_load_balancing_routes.go) | `API_GO_PROXY_LOAD_BALANCING_MODE` | [modelaccesssettings](../../../../apps/api-go/internal/modelaccesssettings) | `${API_GO_PROXY_LOAD_BALANCING_MODE:-legacy}` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 33：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/internal/litellm/openai-keys` | 公开；核对内部 token Guard | [openai-keys-internal.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-internal.controller.ts) · `getOpenAiKeys` | WithModelAccessSettings |
| `POST /api/internal/litellm/openai-keys/applied` | 公开；核对内部 token Guard | [openai-keys-internal.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-internal.controller.ts) · `reportAppliedOpenAiKeys` | WithModelAccessSettings |
| `GET /api/internal/litellm/proxy-load-balancing` | 公开；核对内部 token Guard | [openai-keys-internal.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-internal.controller.ts) · `getProxyLoadBalancingSnapshot` | WithProxyLoadBalancing |
| `GET /api/system-settings/llm-gateways` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `list` | WithLLMGatewayProfiles |
| `POST /api/system-settings/llm-gateways` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `create` | WithLLMGatewayProfiles |
| `DELETE /api/system-settings/llm-gateways/:id` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `remove` | WithLLMGatewayProfiles |
| `PUT /api/system-settings/llm-gateways/:id` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `update` | WithLLMGatewayProfiles |
| `GET /api/system-settings/llm-gateways/:id/models` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `listModels` | Nest；尚未接管 |
| `GET /api/system-settings/llm-gateways/:id/proxy-health` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `proxyHealth` | Nest；尚未接管 |
| `POST /api/system-settings/llm-gateways/:id/proxy-lb-test` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `proxyLoadBalancingTest` | Nest；尚未接管 |
| `GET /api/system-settings/llm-gateways/:id/proxy-model-info` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `proxyModelInfo` | Nest；尚未接管 |
| `POST /api/system-settings/llm-gateways/:id/test` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `test` | Nest；尚未接管 |
| `PUT /api/system-settings/llm-gateways/active` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `setActive` | WithLLMGatewayProfiles |
| `PUT /api/system-settings/llm-gateways/embedding-active` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `setEmbeddingActive` | WithLLMGatewayProfiles |
| `POST /api/system-settings/llm-gateways/models-config` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `listModelsConfig` | Nest；尚未接管 |
| `DELETE /api/system-settings/llm-gateways/proxy-governance` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `resetProxyGovernanceSettings` | Nest；尚未接管 |
| `GET /api/system-settings/llm-gateways/proxy-governance` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `getProxyGovernanceSettings` | Nest；尚未接管 |
| `PUT /api/system-settings/llm-gateways/proxy-governance` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `updateProxyGovernanceSettings` | Nest；尚未接管 |
| `POST /api/system-settings/llm-gateways/proxy-governance/preflight` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `preflightProxyGovernanceSettings` | Nest；尚未接管 |
| `POST /api/system-settings/llm-gateways/proxy-governance/rotate-key` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `rotateProxyGovernanceKey` | Nest；尚未接管 |
| `DELETE /api/system-settings/llm-gateways/proxy-load-balancing` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `resetProxyLoadBalancingSettings` | WithProxyLoadBalancing |
| `GET /api/system-settings/llm-gateways/proxy-load-balancing` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `getProxyLoadBalancingSettings` | WithProxyLoadBalancing |
| `PUT /api/system-settings/llm-gateways/proxy-load-balancing` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `updateProxyLoadBalancingSettings` | WithProxyLoadBalancing |
| `PUT /api/system-settings/llm-gateways/rerank-active` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `setRerankActive` | WithLLMGatewayProfiles |
| `POST /api/system-settings/llm-gateways/test-config` | settings.manage | [llm-gateway-settings.controller.ts](../../../../apps/api/src/modules/system-settings/llm-gateway-settings.controller.ts) · `testConfig` | Nest；尚未接管 |
| `DELETE /api/system-settings/model-service` | settings.manage | [model-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/model-service-settings.controller.ts) · `reset` | WithModelAccessSettings |
| `GET /api/system-settings/model-service` | settings.manage | [model-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/model-service-settings.controller.ts) · `getSettings` | WithModelAccessSettings |
| `PUT /api/system-settings/model-service` | settings.manage | [model-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/model-service-settings.controller.ts) · `updateSettings` | WithModelAccessSettings |
| `DELETE /api/system-settings/openai-keys` | settings.manage | [openai-keys-settings.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-settings.controller.ts) · `reset` | WithModelAccessSettings |
| `GET /api/system-settings/openai-keys` | settings.manage | [openai-keys-settings.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-settings.controller.ts) · `getSettings` | WithModelAccessSettings |
| `POST /api/system-settings/openai-keys` | settings.manage | [openai-keys-settings.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-settings.controller.ts) · `appendKeys` | WithModelAccessSettings |
| `PUT /api/system-settings/openai-keys` | settings.manage | [openai-keys-settings.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-settings.controller.ts) · `updateSettings` | WithModelAccessSettings |
| `DELETE /api/system-settings/openai-keys/key/:fingerprint` | settings.manage | [openai-keys-settings.controller.ts](../../../../apps/api/src/modules/system-settings/openai-keys-settings.controller.ts) · `removeKey` | WithModelAccessSettings |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#56](https://github.com/wei500L/newwei/pull/56) | [c121b25c0271](https://github.com/wei500L/newwei/commit/c121b25c0271326118e6c78b4aa73f3159a4df66) | ✨ feat(api-go): 模型接入设置与 OpenAI 密钥分发 10 条接口迁入 Go（API_GO_MODEL_ACCESS_SETTINGS_MODE，默认 legacy）+ 修 MA1/MA2/MA3 |
| [#59](https://github.com/wei500L/newwei/pull/59) | [09240c7713b6](https://github.com/wei500L/newwei/commit/09240c7713b6c14c39053511160d43a32a4e89e4) | ✨ feat(api-go): LLM 网关配置与三路激活 7 条接口迁入 Go（API_GO_LLM_GATEWAY_PROFILES_MODE，默认 legacy）+ 修 GP1/GP2/GP3 |
| [#66](https://github.com/wei500L/newwei/pull/66) | [a2d961edd0c3](https://github.com/wei500L/newwei/commit/a2d961edd0c3962a88511d0cd6b5fca2d683308f) | ✨ feat(api-go): 迁移 LiteLLM 负载均衡配置管理与下发（LB0–LB4） |
| [#67](https://github.com/wei500L/newwei/pull/67) | [7fc17faa3dc5](https://github.com/wei500L/newwei/commit/7fc17faa3dc5043537bad4038299d11fdba4758d) | 🔀 integration(api-go): 一次性落地 #59/#62/#63/#65/#66 五个迁移批次（冲突统一并集解决 + 全量验证） |

- [docs/refactor/go-model-access-settings.md](../../go-model-access-settings.md)

- [docs/refactor/go-llm-gateway-profiles.md](../../go-llm-gateway-profiles.md)

- [docs/refactor/go-proxy-load-balancing.md](../../go-proxy-load-balancing.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
