# LLM-GATEWAY-OPS-001 · 网关治理与真实探测十二路

- 状态 reserved；2026-10-18 继续选批。基线 origin/main c39f282f11952b487c3ef6fefb14882db265ed9e，普通 CI 39142523834 success。此处只规划，无业务实现/注册/外部验证新增。
- 分支 refactor/go-llm-gateway-ops；worktree /Users/oo/project/newwei-go-llm-gateway-ops，发出前尚未创建；[完整执行提示词](LLM-GATEWAY-OPS-001.prompt.md)。认领与提示词通过现有[规划 PR #78](https://github.com/wei500L/newwei/pull/78)发布。
- 精确范围：/api/system-settings/llm-gateways 下 proxy-governance GET/PUT/DELETE/preflight/rotate-key 五路，:id/models/test/proxy-health/proxy-model-info/proxy-lb-test 五路，models-config/test-config 两路；共12，全部 settings.manage，无新增平台角色限制。POST201，其余成功200。BL-17 全范围由本任务占用。

## 已核事实与依赖

仅深入本域：读 Controller/四组DTO、LitellmProxyGovernanceService 的完整管理协议/密钥状态/启停与轮换分支；LlmGatewayTestService 的模型列表、健康、模型信息缓存、三类探测、LB并发/错误/日志；配置有效绑定选择、兼容错误和模型日志源。与当前 Go llmgatewayprofiles/modelaccesssettings、publicportal/llmembed 治理消费者、llmlogs/completion writer、config/main/legacyproxy 对照。候选 Nest 源码相对9d0462e1无业务变化，不扩展全仓审计。

已有21路配置/激活/密钥与LB接口不重迁。profiles 私有能力需少量 typed 端口，不能假设已有 public getProfileConfig；现有简报 writer 固定 completion，三类探测需要独立具名 probe writer并复用日志策略。真实远端 team/key 管理、三类模型请求、Mongo日志都是交付范围；不能只迁缓存/配置。

MySQL全局SystemSetting、Redis治理TTL30与model-info TTL60、共享JWT/机器身份、Mongo日志、SYSTEM_SETTINGS_ENCRYPTION_KEY写入策略、请求时LITELLM_MASTER_KEY与真实LiteLLM/模型。无BullMQ/cron/worker。本批独立API_GO_LLM_GATEWAY_OPS_MODE，默认legacy/非法值启动失败，单开时完整初始化资源，无须profile/日志查询等其他模式go。外部未验证。

具体改进：LB固定小型worker pool、复用transport、完整尝试与无竞争汇总，保留源分布/样本限额、错误和日志；不扩通用调度/重试框架。普通三类探测保持顺序与分项失败契约。

## 并行边界与记录

已核唯一开放业务PR [#79](https://github.com/wei500L/newwei/pull/79)，Ready，head e105b3abdb3fa084356918cb29f8385cb5fb4ddb，IDENTITY-ONBOARDING-001继续占用。读实际diff：身份业务、SMTP端口、组织bootstrap/RBAC不与本批业务包重叠；main/config/env/compose按最小条件并集合并。#70–#76已由#77合入，不因旧worktree存在当作活动占用。

本批允许新llmgatewayops/wire/精确路由、profiles窄复用端口、llmlogs probe writer和必要共享接线。排除profileCRUD、LB配置/下发、modelservice/OpenAIkeys、publicportal/llmembed重迁、新闻与身份业务。规划窗口维护地图，编码窗口只交业务与PR/短交付说明，不打断正在运行窗口。发出前正常提交/推送本记录，不自动创建编码目录或实施。
