# SOURCE-POLICY-WRITE-001 · 来源策略版本管理完整写链

本轮占用刷新（2026-10-18）：状态pr_open，Ready [#82](https://github.com/wei500L/newwei/pull/82)，head `52340760fdedde3f914b384badd30aee2a5c6fbf`；实际业务和共享接线diff已核，包含GAP-GQL-001两处剩余条件。main仍90765633，PR未合、缺口不提前关闭；不要求运行中对话调整记录。下文in_progress/未开PR是历史快照。

最新开发增量（2026-10-18）：状态in_progress；/Users/oo/project/newwei-go-source-policy-write在90765633，已见settingscrawl/policy.go/register.go、policywritesupport.go和settingswrite/sourcepolicy_input.go/sourcepolicy_store.go改动；无业务PR，继续占用四root及GAP-GQL-001两处接线。下文未创建是发出时快照，不干预编码对话。

- 状态reserved，2026-10-18；基线origin/main 90765633ac6ba2b1d97a89d0ec33be90cb69bcb7，普通CI39149114456 success。
- [完整提示词](SOURCE-POLICY-WRITE-001.prompt.md)；业务分支refactor/go-source-policy-write，目录/Users/oo/project/newwei-go-source-policy-write，规划时未创建。文档复用规划分支docs/plan-llm-gateway-ops/Ready PR #80发布，无业务实现新增。
- 精确范围：updateNewsEventSourcePolicy、updateNewsEventSourcePolicyPresets、rollbackNewsEventSourcePolicy、resetNewsEventSourcePolicy；四Mutation均settings.manage+本组织内置system admin。完整差量、60版历史、20条Mutation响应、preset及两组分类权重、Redis同步warning和审计/outbox。已有Query/13写不重迁。
- 另认领GAP-GQL-001/BL-01具体剩余：main graphqlRouteMode与无效DSN分支补旧settingsWrite；资源OR/handler已有，不重写13业务。新独立API_GO_GRAPHQL_SOURCE_POLICY_WRITE_MODE默认legacy，JWT/MySQL/Redis，无Mongo/外部服务/队列/cron。

## 本次限定核实

读完四Resolver/DTO/helper/返回投影、NewsEventSourcePolicyService四写及state/preset读存储、legacy迁移、差量/历史/类别存储/缓存和审计边界；classifier归一化与默认策略、Go policy读端/私有helper/普通模型与policy模型注册、settingswrite存储审计及main/config/exec预检。相关业务相对3cedce9a至当前main无变化，未扩展全仓审计。

明确契约：rollback创建新revision且不回滚分类权重；reset清delta并保留历史/分类/preset；categoryAuthority omitted保留、null/[]清除；expectedRevision null不检查、expectedUpdatedAt null仍比较；持久化60条、Mutation20条、Query30条分层。源是读后校验+upsert，不宣称CAS/总事务，不增加锁/补偿框架。复用已有线性保序差量，不要求虚构优化。

settingscrawl多数policy helper私有，需小型具名写支持端口；RegisterSettingsModelTypes不含policy嵌套模型，需独立注册表面。Go现有Query以DB读为主，不能把30条Query响应当完整可持久化state；settingswrite.cacheSet吞错误，不足以承载syncWarnings。

## 占用与交接

LLM-GATEWAY-OPS-001继续有效，业务目录已创建在90765633且见llmgatewayprofiles/ports.go未提交开发；无业务PR不释放。该批profiles/llmlogs/wire与本批settingswrite/settingscrawl核心文件隔离；main/config/env/compose保留并集。当前仅开放规划#80。

本窗口只保存认领和提示词，不改业务、不创建业务worktree、不操作编码对话。编码窗口交业务和PR说明，规划窗口维护共享地图。GAP-GQL-001仍开放，实际落地/CI后才能按证据关闭；真实DB/跨进程同步未验证。
