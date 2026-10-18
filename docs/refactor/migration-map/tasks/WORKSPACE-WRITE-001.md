# WORKSPACE-WRITE-001 · 工作台交互 GraphQL 写入

所属模块：[workspace](../modules/workspace.md)；状态：**pr_open**。返回[认领索引](README.md)。

## 来源、基线与发布状态

- 历史提示词已发出并占用本任务8根；原始发出时间/执行会话未提供，不补造。首次入图13:51、14:18本地开发快照为历史；本轮任务证据刷新：2026-10-18 14:56 MSK。
- main 基线：`3cedce9aa3200436aba3596f63b559de5490cec8`。分支 `refactor/go-graphql-workspace-write`；worktree `/Users/oo/project/newwei-go-graphql-workspace-write`。
- [Ready PR #70](https://github.com/wei500L/newwei/pull/70)：OPEN，isDraft=false，autoMergeRequest=null；head 与本机 HEAD 均为 `adb765d0180e8b34910181e8c6fde8be400a2dff`；相比200ab944只追加历史交付报告文档，业务实现/接线未变。14:37曾只读看到合并冲突；14:49已由原执行任务正常 merge #68 并推送，worktree 干净。本地图未修改该目录；干净不证明执行器活跃。
- 初始业务提交 `db6339122263658148072f65dc641d9b769117e7` 基于 #67，`200ab944` 为同步 #68 的正常 merge。当前无实际业务 merge SHA，8写未进入 main，main 仍不识别 WORKSPACE_WRITE 模式；不得提前计8个注册。
- head `200ab944` 的[普通 CI 39124393842](https://github.com/wei500L/newwei/actions/runs/39124393842) 已success；当前 `adb765d0` 的[普通 CI 39125203024](https://github.com/wei500L/newwei/actions/runs/39125203024) 于14:56为in_progress，不继承旧head结果；两个smoke skipped不是通过。最新观察以 [EVIDENCE](../EVIDENCE.md) 为准；真实 SMTP/webhook/queue/部署未核实。
- 候选实现：workspacewrite/register.go 注册8写；#70 修改 main/config、alerts/history 的模型注册/序列化，并修改 Nest dashboard/notifications 优化。地图只确认生产接线差异与文件占用，**没有逐字段验收8写事务/版本/优化实现**，不把 PR 描述当验收。
- 共享接线：#70 候选中 workspace 写独立条件已有；合并 #68 后 needsCredentialedGo 补设置写，但 graphqlRouteMode/无效 DSN 列表仍漏设置写。详见 [GAP-GQL-001](../GAPS.md#gap-gql-001)；不要误记为 main 已修复，也不在本地图修业务。
- 记录随地图 [#69](https://github.com/wei500L/newwei/pull/69) 发布；文档发布与业务合并独立。状态保持 pr_open，业务范围持续占用，不重发任务。

## 业务范围、事实源与优化

复用 `workspace`、`history`、`alerts` 返回模型、MySQL 数据库和 Redis 鉴权链；只迁工作台交互写，保留 orgId/userId 范围。输入见 [dashboard.input.ts](../../../../apps/api/src/graphql/dto/dashboard.input.ts)、[alert.input.ts](../../../../apps/api/src/graphql/dto/alert.input.ts)；通知无独立输入 DTO，Resolver 参数和 Service 为契约。缺省/null/错误语义与返回字段看对应 Resolver/模型。

| Mutation（精确范围） | 权限 | 事实源符号 |
|---|---|---|
| `markNotificationRead` | 已认证 | [notification.resolver.ts](../../../../apps/api/src/graphql/resolvers/notification.resolver.ts) · `markNotificationRead` |
| `markAllNotificationsRead` | 已认证 | [notification.resolver.ts](../../../../apps/api/src/graphql/resolvers/notification.resolver.ts) · `markAllNotificationsRead` |
| `upsertDashboard` | dashboards.write | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `upsertDashboard` |
| `deleteDashboard` | dashboards.write | [dashboard.resolver.ts](../../../../apps/api/src/graphql/resolvers/dashboard.resolver.ts) · `deleteDashboard` |
| `createAlertChannel` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `createAlertChannel` |
| `updateAlertChannel` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `updateAlertChannel` |
| `deleteAlertChannel` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `deleteAlertChannel` |
| `updateAlertEventStatus` | alerts.manage | [alerts.resolver.ts](../../../../apps/api/src/graphql/resolvers/alerts.resolver.ts) · `updateAlertEventStatus` |

数据/缓存：Notification 按 orgId/userId 更新，Dashboard 与组件按租户隔离，AlertChannel/AlertDelivery/AlertEvent 保留关联与事务；`context.feedback` 合并，不覆盖其他 context。

实际优化目标：重复标记已读保留首次 readAt；只更新实际变化的看板组件；删除告警渠道用必要事务并保留投递历史；告警反馈合并 context.feedback。需按 [NotificationsService](../../../../apps/api/src/modules/notifications/notifications.service.ts)、[DashboardsService](../../../../apps/api/src/modules/dashboard/dashboard.service.ts)、[AlertsService](../../../../apps/api/src/modules/alerts/alerts.service.ts) 当前语义具体实现，功能未验收。

## 文件范围与并行边界

允许业务范围：`apps/api-go/internal/graphqlread/workspacewrite/`（目前存在 #70，不在 main），复用 workspace/history/alerts 的具名模型；如需导出模型注册，只做必要函数拆分，保留既有注册和字段权限。已见共享 alerts/{channels,convert,events,models}.go 的强类型/序列化调整，后续其他 alerts 任务须避开这些文件或明确先后依赖。Nest Resolver仅作契约事实源；实际PR对dashboard/notifications service的优化改动已在上方列明，后续按真实diff核对。

不得覆盖：告警规则 upsert/delete/trigger、deleteAssistantRun、BullMQ worker/队列管理、[SETTINGS-WRITE-001](SETTINGS-WRITE-001.md) 的13个设置写与核心业务文件、已合并 orgaccesswrite。

共享接线：`apps/api-go/cmd/api/main.go`、`internal/config/config.go`、`internal/legacyproxy/proxy.go`（若 GraphQL 顶层路由条件需要扩展）、`apps/api-go/README.md`、`.env.example`、`infra/docker/.env.sample` 与 `docker-compose.yml`。共享只允许本任务开关、初始化 OR 条件、模型注册与最小文档增量；两个写任务和已合并组织写必须并存，不能覆盖整段配置或公共 Register。

开关目标：`API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` 空/legacy/go、默认 legacy、非法值启动失败；只开写时必须初始化 MySQL/JWT/Redis 并接通精确 /graphql，不因读开关关闭强制 Mongo。写返回模型单独装配但避免与读注册重复；独立开关组合未完成前不能称为生产可用。

本轮候选接线差异与剩余缺口集中在 GAP-GQL-001；恢复时先查 #70 最新 head/diff 与 main，避免依据旧开发快照重新实施。#70 当前文件占用还包括 `alerts/register.go`、`alerts/replay.go`、`history/{models,notifications,register}.go`、Nest `modules/dashboard/dashboard.service.ts`、`modules/notifications/notifications.service.ts`。告警规则候选须等待这些共享模型稳定；不要在另一个窗口同时改它们。

## PR 阶段恢复提示词

继续审查/交付 WORKSPACE-WRITE-001（工作台交互 GraphQL 写入）现有 Ready PR #70，不重建已经提交的8写。先读 AGENTS.md、迁移地图、PLANNING.md 和本任务；fetch main 并查开放 PR、分支与认领，复用 `/Users/oo/project/newwei-go-graphql-workspace-write` / `refactor/go-graphql-workspace-write`，不要另开竞争性任务。若本地已有增量，保留并先审查，不 reset、不整段覆盖。以最新 main 源码核对上方精确 Mutation、权限、DTO/返回/缺省/null/错误语义，逐项核对现有PR中上方业务与优化，只补真实剩余项；其他范围严格排除。

Go 业务输入、返回、数据库 JSON、缓存和审计必须具名强类型；通用 GraphQL/驱动边界可沿用，扩展 JSON 叶子可用 json.RawMessage。按上方独立开关完成 config、路由 OR、资源初始化、Registry 与模型复用；与其他写任务共享接线取并集。保留现有鉴权、租户、校验与事务，不改 Nest 装饰器/签名，不扩建框架/锁/重试。源码注释英文、文档/提交/PR 中文。

本机不安装依赖、不运行 build/test/Docker/服务；做精简静态核对、正常 push 后查看现有普通 CI，不默认加 smoke workflow，不把未调用外部服务写成通过。更新自己的任务与所属模块的候选实现、PR/head SHA/CI/剩余项；未合 main 不能增加 main 覆盖数。中文 emoji 提交，仅提交本任务改动，创建 Ready PR，不合并、不 auto-merge、不 amend/rebase/force-push。

## 完成项、剩余项与恢复点

已完成：历史占用已恢复、main 注册缺口与本地证据已核对、文件边界及执行提示词已持久化。业务候选8写已提交/推送到 Ready #70；无可确认的已合并范围。

剩余：#70 8写实现/事务/版本与优化验收、公共接线并集和设置独立路由遗漏、当前 head 普通 CI、最终 main 合并状态及地图回写；额外验证/部署各自记录。本次只建图，不修改或重新派发业务任务。下一次先复查 worktree 和对应 PR，再决定状态升级。
