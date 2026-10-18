# archive · 归档阅读与准备任务

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

仅 GET 准备运行状态经数据运行开关接管。archiveDigest/archiveCalendar/archiveDetail Query 均未在 Go Registry 注册；前两项读入口会在缺数据时入准备队列。

关键数据与副作用：MySQL ProcessedArticle/归档分类、Mongo 内容、Redis 准备状态/BullMQ archivePreparation、分类/翻译模型。ArchiveService.getDigest 调 ensureDigestCoverage，getCalendar 调 ensureCalendarCoverage；detail 需继续沿服务检查字段来源。

真实剩余缺口：三个归档 Query、准备任务生产/消费仍需独立迁移规划。不能仅在 Go 返回空集合而绕过缺口准备，也不能把 status 接口当归档 worker 完成。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#archive) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[archive](../../../../apps/api/src/modules/archive)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithDataRuntimeSettings](../../../../apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go) | `API_GO_DATA_RUNTIME_SETTINGS_MODE` | [dataruntimesettings](../../../../apps/api-go/internal/dataruntimesettings) | `${API_GO_DATA_RUNTIME_SETTINGS_MODE:-legacy}` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 1：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/archive-preparation/status` | settings.manage | [archive-preparation.controller.ts](../../../../apps/api/src/modules/archive/archive-preparation.controller.ts) · `getStatus` | WithDataRuntimeSettings |

## GraphQL 精确 root 清单

所有 root 还受组织身份重推导及[传输与模型注册规则](graphql-runtime.md)约束。SDL 在 [apps/api/schema.gql](../../../../apps/api/schema.gql)，可执行注册仅计算生产 Register 调用，测试示例不计。多个权限用 OR 或 +（ALL）区分。

| 类型 / root | 根权限 | Nest 事实源与符号 | Go 实现 / 开关条件 |
|---|---|---|---|
| Query `archiveCalendar` | items.read | [archive.resolver.ts](../../../../apps/api/src/graphql/resolvers/archive.resolver.ts) · `archiveCalendar` | Nest；未注册 |
| Query `archiveDetail` | items.read | [archive.resolver.ts](../../../../apps/api/src/graphql/resolvers/archive.resolver.ts) · `archiveDetail` | Nest；未注册 |
| Query `archiveDigest` | items.read | [archive.resolver.ts](../../../../apps/api/src/graphql/resolvers/archive.resolver.ts) · `archiveDigest` | Nest；未注册 |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#61](https://github.com/wei500L/newwei/pull/61) | [776d17bb75ba](https://github.com/wei500L/newwei/commit/776d17bb75ba718ae756fe9e5b8edd6f261ceb30) | ✨ feat(api-go): 数据运行设置与归档状态 9 条接口迁入 Go（API_GO_DATA_RUNTIME_SETTINGS_MODE，默认 legacy）+ 修 DS1/DS2/DS3/DS4 |

- [docs/refactor/go-data-runtime-settings.md](../../go-data-runtime-settings.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
