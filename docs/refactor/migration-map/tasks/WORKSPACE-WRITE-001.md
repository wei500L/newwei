# WORKSPACE-WRITE-001 · 工作台交互 GraphQL 写入

所属模块：[workspace](../modules/workspace.md)；状态：**in_progress**。返回[认领索引](README.md)。

## 来源、基线与发布状态

- 来源：用户本次明确粘贴的“已发出的任务线索”A/B，历史提示词已发出；原始发出/认领时间和执行会话 ID 未提供，不补造。此文件是依用户线索和当前源码恢复的持久化记录。
- 规划/核对基线：`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`；首次入图：2026-10-18 13:51 MSK；任务更新时间：2026-10-18 14:03 MSK（UTC+03:00）。历史原始规划 SHA 未提供。
- 分支：`refactor/go-graphql-workspace-write`；worktree：`/Users/oo/project/newwei-go-graphql-workspace-write`；本机 HEAD 为 `7fc17faa3dc5043537bad4038299d11fdba4758d`。
- 核对：`gh pr list --state all --head refactor/go-graphql-workspace-write` 返回空；`git ls-remote --heads origin refactor/go-graphql-workspace-write` 无该远端分支。未发现对应业务 PR；没有 main 合并证据。
- 记录发布：本任务文档已随地图首版提交 `4e37f285` 推送至 origin/docs/backend-migration-map，并发布在 [Ready PR #69](https://github.com/wei500L/newwei/pull/69)（见[证据页](../EVIDENCE.md)）；本记录发布不等于业务分支已提交/推送。地图 PR 未合入前，main 上尚无本任务文档。
- 实际业务 merge SHA：无；业务 CI：无；额外集成验证：未核实。基线 CI 成功不覆盖未提交实现。
- main 生产实现/注册：这 8 个 Mutation 尚未迁入；main 不识别 `API_GO_GRAPHQL_WORKSPACE_WRITE_MODE`，不能把“拟新增开关”当成可用配置。独立写开关是已发出任务目标；部署启用与流量均未核实。
- 开工证据：14:03 MSK worktree 出现 `config.go`、`graphqlread/alerts/{channels,convert,events,models}.go` 修改及 `config_workspacewrite_test.go` 未跟踪文件，暂无业务提交/PR/远端分支。早期干净快照已过时，按匹配范围的开发证据升级 in_progress；执行器活动仍未核实。

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

允许业务范围：拟新增 `apps/api-go/internal/graphqlread/workspacewrite/`（执行前以最新 main 确认名称），复用 workspace/history/alerts 的具名模型；如需导出模型注册，只做必要函数拆分，保留既有注册和字段权限。已见共享 alerts/{channels,convert,events,models}.go 的强类型/序列化调整，后续其他 alerts 任务须避开这些文件或明确先后依赖。Nest 对应 Resolver/Service 仅作契约事实源。

不得覆盖：告警规则 upsert/delete/trigger、deleteAssistantRun、BullMQ worker/队列管理、[SETTINGS-WRITE-001](SETTINGS-WRITE-001.md) 的13个设置写与核心业务文件、已合并 orgaccesswrite。

共享接线：`apps/api-go/cmd/api/main.go`、`internal/config/config.go`、`internal/legacyproxy/proxy.go`（若 GraphQL 顶层路由条件需要扩展）、`apps/api-go/README.md`、`.env.example`、`infra/docker/.env.sample` 与 `docker-compose.yml`。共享只允许本任务开关、初始化 OR 条件、模型注册与最小文档增量；两个写任务和已合并组织写必须并存，不能覆盖整段配置或公共 Register。

开关目标：`API_GO_GRAPHQL_WORKSPACE_WRITE_MODE` 空/legacy/go、默认 legacy、非法值启动失败；只开写时必须初始化 MySQL/JWT/Redis 并接通精确 /graphql，不因读开关关闭强制 Mongo。写返回模型单独装配但避免与读注册重复；独立开关组合未完成前不能称为生产可用。

## 可直接恢复执行的提示词

继续执行 WORKSPACE-WRITE-001（工作台交互 GraphQL 写入）。先读 AGENTS.md、迁移地图、PLANNING.md 和本任务；fetch main 并查开放 PR、分支与认领，复用 `/Users/oo/project/newwei-go-graphql-workspace-write` / `refactor/go-graphql-workspace-write`，不要另开竞争性任务。若本地已有增量，保留并先审查，不 reset、不整段覆盖。以最新 main 源码核对上方精确 Mutation、权限、DTO/返回/缺省/null/错误语义，再实现上方业务与优化；其他范围严格排除。

Go 业务输入、返回、数据库 JSON、缓存和审计必须具名强类型；通用 GraphQL/驱动边界可沿用，扩展 JSON 叶子可用 json.RawMessage。按上方独立开关完成 config、路由 OR、资源初始化、Registry 与模型复用；与其他写任务共享接线取并集。保留现有鉴权、租户、校验与事务，不改 Nest 装饰器/签名，不扩建框架/锁/重试。源码注释英文、文档/提交/PR 中文。

本机不安装依赖、不运行 build/test/Docker/服务；做精简静态核对、正常 push 后查看现有普通 CI，不默认加 smoke workflow，不把未调用外部服务写成通过。更新自己的任务与所属模块的候选实现、PR/head SHA/CI/剩余项；未合 main 不能增加 main 覆盖数。中文 emoji 提交，仅提交本任务改动，创建 Ready PR，不合并、不 auto-merge、不 amend/rebase/force-push。

## 完成项、剩余项与恢复点

已完成：历史占用已恢复、main 注册缺口与本地证据已核对、文件边界及执行提示词已持久化。业务完成项：无可确认的已合并范围。

剩余：上方 8 个 Mutation 的实现/公共接线完整性、优化验收、业务提交/推送/Ready PR、普通 CI、地图更新；额外验证/部署各自记录。本次只建图，不修改或重新派发业务任务。下一次先复查 worktree 和对应 PR，再决定状态升级。
