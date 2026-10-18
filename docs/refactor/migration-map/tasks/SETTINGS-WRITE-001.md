# SETTINGS-WRITE-001 · GraphQL 设置中心写入

所属模块：[settings](../modules/settings.md)；状态：**pr_open**。返回[认领索引](README.md)。

## 来源、基线与发布状态

- 来源：用户本次明确粘贴的“已发出的任务线索”A/B，历史提示词已发出；原始发出/认领时间和执行会话 ID 未提供，不补造。此文件是依用户线索和当前源码恢复的持久化记录。
- 规划/核对基线：`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`；首次入图：2026-10-18 13:51 MSK；任务更新时间：2026-10-18 14:03 MSK（UTC+03:00）。历史原始规划 SHA 未提供。
- 分支：`refactor/go-graphql-settings-write`；worktree：`/Users/oo/project/newwei-go-graphql-settings-write`；14:03 MSK 本机与远端 HEAD 为 `a1c96172b7ebf44a18ca71429d29dca8f9096d02`。
- 远端增量核对：[Ready PR #68](https://github.com/wei500L/newwei/pull/68) 为 OPEN、isDraft=false；head `a1c96172b7ebf44a18ca71429d29dca8f9096d02`，base 为地图 main 基线。已推送 origin/refactor/go-graphql-settings-write；本机干净。早期“无 PR/未提交”快照已被此事实替代。
- 记录发布：本任务文档已随地图首版提交 `4e37f285` 推送至 origin/docs/backend-migration-map，并发布在 [Ready PR #69](https://github.com/wei500L/newwei/pull/69)（见[证据页](../EVIDENCE.md)）；本记录发布不等于业务分支已提交/推送。地图 PR 未合入前，main 上尚无本任务文档。
- 实际业务 merge SHA：无；[业务普通 CI 39121676887](https://github.com/wei500L/newwei/actions/runs/39121676887) 对应上述 head，14:03 MSK verify/用户设置集成进行中，vector 集成排队，按需 regen skipped。结果需刷新；额外外部验证未核实。基线 CI 不能替代该 PR 的结果。
- main 生产实现/注册：这 13 个 Mutation 尚未迁入；main 不识别 `API_GO_GRAPHQL_SETTINGS_WRITE_MODE`，不能把“拟新增开关”当成可用配置。独立写开关是已发出任务目标；部署启用与流量均未核实。
- 开工/提交证据：`50b8399d` 提交设置写实现，`a1c96172` 追加修复；PR 包含 settingswrite、settingscrawl、main/config 接线、共享 runtime 缓存及四个 Nest 设置服务优化、env/报告。已提交/推送/开 PR，不等于完整契约或 CI 已通过；本地图未执行业务运行验证。

## 业务范围、事实源与优化

复用 `settingscrawl` 的设置返回模型和默认值；13 个写入口保持 settings.manage 根权限。Nest 输入见 [settings.input.ts](../../../../apps/api/src/graphql/dto/settings.input.ts)，返回与默认值见 [settings.model.ts](../../../../apps/api/src/graphql/models/settings.model.ts)、[SettingsResolver](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) 及其注入服务。读取/写入需保留缺省/null、范围校验和错误语义，不能只按 SDL 类型实现。

| Mutation（精确范围） | 权限 | 事实源符号 |
|---|---|---|
| `updateRateLimitSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateRateLimitSettings` |
| `updateAuthCacheSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateAuthCacheSettings` |
| `updateCrawlClientSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateCrawlClientSettings` |
| `updateAuditLogRetention` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateAuditLogRetention` |
| `updateEntityImpactGraphSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateEntityImpactGraphSettings` |
| `updateKnowledgeGraphSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateKnowledgeGraphSettings` |
| `updateNewsEventSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsEventSettings` |
| `updateNewsIndicatorSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsIndicatorSettings` |
| `updateNewsClassificationSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsClassificationSettings` |
| `updateClassificationQualitySettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateClassificationQualitySettings` |
| `updateNewsDedupeSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsDedupeSettings` |
| `updateNewsExtractionSettings` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsExtractionSettings` |
| `updateNewsPromptConfig` | settings.manage | [settings.resolver.ts](../../../../apps/api/src/graphql/resolvers/settings.resolver.ts) · `updateNewsPromptConfig` |

数据/缓存：现有 SystemSetting 与既有组织设置键；必须与 Nest 共享 `crawl_client:settings`、`audit_log:retention_days`，核对 TTL/失效，不能另起 Go 私有键。事务、updatedBy/审计与授权保持现状。

实际优化目标：分类 taxonomy 规范化；去重规则规范化并优化排序计算；保留现有含义而非引入兼容层。已看到本地实现文件不表示这些目标已经验收。

## 文件范围与并行边界

允许业务范围：`apps/api-go/internal/graphqlread/settingswrite/`；`settingscrawl` 仅共享设置模型/默认值/必要写支持，优先最小增量；Nest Resolver/DTO 继续只读、不改签名。PR 已实际修改 `modules/crawl/crawl-settings.service.ts`、`modules/system-settings/audit-log-settings.service.ts`、`modules/news-pipeline/news-classification-settings.service.ts`、`modules/news-pipeline/news-dedupe-settings.service.ts`，以及 Go `internal/runtimesettings/{auditlog,store}.go`，用于共享缓存/规范化；后续评审按这些真实文件边界复核，不据旧提示词遗漏它们。

不得覆盖：来源策略四写 `updateNewsEventSourcePolicy/updateNewsEventSourcePolicyPresets/resetNewsEventSourcePolicy/rollbackNewsEventSourcePolicy`；证据复核写；采集写；[WORKSPACE-WRITE-001](WORKSPACE-WRITE-001.md) 的业务文件/8 roots；orgaccesswrite 已合并实现；BullMQ/cron/真实外部刷新。

共享接线：`apps/api-go/cmd/api/main.go`、`internal/config/config.go`、`internal/legacyproxy/proxy.go`（若 GraphQL 顶层路由条件需要扩展）、`apps/api-go/README.md`、`.env.example`、`infra/docker/.env.sample` 与 `docker-compose.yml`。共享只允许本任务开关、初始化 OR 条件、模型注册与最小文档增量；两个写任务和已合并组织写必须并存，不能覆盖整段配置或公共 Register。

开关目标：`API_GO_GRAPHQL_SETTINGS_WRITE_MODE` 空/legacy/go、默认 legacy、非法值启动失败；只开写时必须初始化 MySQL/JWT/Redis 并接通精确 /graphql，不因读开关关闭强制 Mongo。写返回模型单独装配但避免与读注册重复；独立开关组合未完成前不能称为生产可用。

## 可直接恢复执行的提示词

继续执行 SETTINGS-WRITE-001（GraphQL 设置中心写入）。先读 AGENTS.md、迁移地图、PLANNING.md 和本任务；fetch main 并查开放 PR、分支与认领，复用 `/Users/oo/project/newwei-go-graphql-settings-write` / `refactor/go-graphql-settings-write`，不要另开竞争性任务。若本地已有增量，保留并先审查，不 reset、不整段覆盖。以最新 main 源码核对上方精确 Mutation、权限、DTO/返回/缺省/null/错误语义，再实现上方业务与优化；其他范围严格排除。

Go 业务输入、返回、数据库 JSON、缓存和审计必须具名强类型；通用 GraphQL/驱动边界可沿用，扩展 JSON 叶子可用 json.RawMessage。按上方独立开关完成 config、路由 OR、资源初始化、Registry 与模型复用；与其他写任务共享接线取并集。保留现有鉴权、租户、校验与事务，不改 Nest 装饰器/签名，不扩建框架/锁/重试。源码注释英文、文档/提交/PR 中文。

本机不安装依赖、不运行 build/test/Docker/服务；做精简静态核对、正常 push 后查看现有普通 CI，不默认加 smoke workflow，不把未调用外部服务写成通过。更新自己的任务与所属模块的候选实现、PR/head SHA/CI/剩余项；未合 main 不能增加 main 覆盖数。中文 emoji 提交，仅提交本任务改动，继续维护现有 Ready PR #68，不另建重复 PR；不合并、不 auto-merge、不 amend/rebase/force-push。

## 完成项、剩余项与恢复点

已完成：历史占用已恢复、main 注册缺口与本地证据已核对、文件边界及执行提示词已持久化。业务完成项：PR #68 已有候选实现；无可确认的 main 合并范围。

剩余：上方 13 个 Mutation 的实现/公共接线完整性、优化验收、PR 后续修复/普通 CI、地图更新；额外验证/部署各自记录。本次只建图，不修改或重新派发业务任务。下一次先复查 worktree 和对应 PR，再决定状态升级。
