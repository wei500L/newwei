# SETTINGS-WRITE-001 · GraphQL 设置中心写入

所属模块：[settings](../modules/settings.md)；状态：**merged**。返回[认领索引](README.md)。

## 来源、基线与发布状态

- 来源：用户本次明确粘贴的“已发出的任务线索”A/B，历史提示词已发出；原始发出/认领时间和执行会话 ID 未提供，不补造。此文件是依用户线索和当前源码恢复的持久化记录。
- 规划/核对基线：`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`；首次入图：2026-10-18 13:51 MSK；任务更新时间：2026-10-18 14:18 MSK（UTC+03:00）。历史原始规划 SHA 未提供。
- 分支：`refactor/go-graphql-settings-write`；worktree：`/Users/oo/project/newwei-go-graphql-settings-write`；14:03 MSK 本机与远端 HEAD 为 `a1c96172b7ebf44a18ca71429d29dca8f9096d02`。
- 远端增量核对：[PR #68](https://github.com/wei500L/newwei/pull/68) 于 2026-10-18 14:15:41 MSK 合并；实际 merge SHA 为 `3cedce9aa3200436aba3596f63b559de5490cec8`。14:18 MSK 已 fetch 并按 main 实际实现/生产注册复核；原任务实现不得重复派发。
- 记录发布：本任务文档已随地图首版提交 `4e37f285` 推送至 origin/docs/backend-migration-map，并发布在 [Ready PR #69](https://github.com/wei500L/newwei/pull/69)（见[证据页](../EVIDENCE.md)）；本记录发布不等于业务分支已提交/推送。地图 PR 未合入前，main 上尚无本任务文档。
- 实际业务 merge SHA：`3cedce9aa3200436aba3596f63b559de5490cec8`；[PR head CI 39121676887](https://github.com/wei500L/newwei/actions/runs/39121676887) 对应 a1c96172，success；最新 main [CI 39122519950](https://github.com/wei500L/newwei/actions/runs/39122519950) 在14:18快照进行中。外部集成/实际部署/生产流量仍未核实。
- main 实现/注册：13个业务写及开关已合入，生产 settingswrite.Register 已接在 main 构造中；settingscrawl 模型复用已实现。**独立写启用仍不完整**：graphqlRouteMode 和 needsCredentialedGo 漏 settingsWriteGo。只开本开关会缺鉴权/Redis或仍走legacy；当前实际需总读 go 或组织写 go，具体源码/症状见[设置域缺口](../modules/settings.md)。
- 开工/提交证据：`50b8399d` 提交设置写实现，`a1c96172` 追加修复；PR 包含 settingswrite、settingscrawl、main/config 接线、共享 runtime 缓存及四个 Nest 设置服务优化、env/报告。已合并且 PR 普通 CI 通过，不等于完整开关组合或真实部署已通过；本地图未执行业务运行验证。

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

实际优化目标：分类 taxonomy 规范化；去重规则规范化并优化排序计算；保留现有含义而非引入兼容层。已在 main 源码看到缓存共享、taxonomy 规范化和去重规范化实现；普通 CI 通过，跨运行时真实服务/开关组合尚未做本次额外验证。

## 文件范围与并行边界

允许业务范围：`apps/api-go/internal/graphqlread/settingswrite/`；`settingscrawl` 仅共享设置模型/默认值/必要写支持，优先最小增量；Nest Resolver/DTO 继续只读、不改签名。PR 已实际修改 `modules/crawl/crawl-settings.service.ts`、`modules/system-settings/audit-log-settings.service.ts`、`modules/news-pipeline/news-classification-settings.service.ts`、`modules/news-pipeline/news-dedupe-settings.service.ts`，以及 Go `internal/runtimesettings/{auditlog,store}.go`，用于共享缓存/规范化；后续评审按这些真实文件边界复核，不据旧提示词遗漏它们。

不得覆盖：来源策略四写 `updateNewsEventSourcePolicy/updateNewsEventSourcePolicyPresets/resetNewsEventSourcePolicy/rollbackNewsEventSourcePolicy`；证据复核写；采集写；[WORKSPACE-WRITE-001](WORKSPACE-WRITE-001.md) 的业务文件/8 roots；orgaccesswrite 已合并实现；BullMQ/cron/真实外部刷新。

共享接线：`apps/api-go/cmd/api/main.go`、`internal/config/config.go`、`internal/legacyproxy/proxy.go`（若 GraphQL 顶层路由条件需要扩展）、`apps/api-go/README.md`、`.env.example`、`infra/docker/.env.sample` 与 `docker-compose.yml`。共享只允许本任务开关、初始化 OR 条件、模型注册与最小文档增量；两个写任务和已合并组织写必须并存，不能覆盖整段配置或公共 Register。

开关目标：`API_GO_GRAPHQL_SETTINGS_WRITE_MODE` 空/legacy/go、默认 legacy、非法值启动失败；只开写时必须初始化 MySQL/JWT/Redis 并接通精确 /graphql，不因读开关关闭强制 Mongo。写返回模型单独装配但避免与读注册重复；独立开关组合未完成前不能称为生产可用。

## 已合并后的恢复提示词

SETTINGS-WRITE-001 已经 #68 合入 main，不重新执行/重发这13个业务 Mutation，也不继续向已合并 PR 推送。先读地图、任务及最新 main 差异，核对上方独立开关剩余接线与 WORKSPACE-WRITE-001 的 main/config 共享增量。如果用户继续规划，另立最小且具体的接线任务或明确由工作台写在共享接线取并集，不自动扩展整批范围。本记录的精确13入口与历史文件范围保留作避免重复和契约追踪依据。

遵循 PLANNING 的强类型、独立 worktree、中文 emoji 提交、普通 CI、Ready PR 和不合并/不 auto-merge/不 amend/rebase/force-push要求；本机不安装或运行 build/test/Docker/服务。源码注释英文、文档中文。未授权前不在本地图任务实施接线修复。

## 完成项、剩余项与恢复点

已完成：历史任务和13个精确root已持久化；#68实现、开关、模型注册、共享Redis/规范化优化已合入 main，实际 merge SHA 和 PR CI 有证据。

剩余：设置写独立启用的顶层路由 OR 与鉴权/Redis 初始化缺口、完整契约和优化额外验证、main当前CI结果、实网调用/部署。merged 仅表示实际落地主体，不能掩盖这些剩余项；不自动重新认领13写。
