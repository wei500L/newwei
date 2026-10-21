# archive · 归档阅读与准备任务

本域限定续核：2026-10-19 Europe/Moscow，`origin/main 91e759b449c4511dc96d86539ea0eb258754d07e`；深度为三Query/搜索CSV/缓存分类与显示/准备生产及Nest消费边界，不把历史全域审查扩为当前验收。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

**覆盖更新（2026-10-21，基线 `dcbe563b`，更新至 #136）**：HTTP **1/1**、Query **3/3**、Mutation **—**（Go 注册/分母，C 类 0 条）；1 条状态 HTTP 与 3 个归档读 Query 已注册；剩余 Nest root 0 条（准备 worker 执行权见 async-runtime 与 GAP-ASYNC-001）。旧行为 `91e759b4`/`3cedce9a` 快照（HTTP 1/1、Query 0/3），差值即 #92–#136 的注册与接线增量；分子口径为“存在 `API_GO_*` 开关且 Go 规则/处理器/Register 就位”，**不是部署启用**。对账与 C 类清单见 [README 覆盖表](../README.md#注册覆盖) 与 [执行权审计](../../cutover/ownership-audit.md)。

## 范围与实施状态

仅 GET 准备运行状态经数据运行开关接管。archiveDigest/archiveCalendar/archiveDetail Query 均未在 Go Registry 注册；前两项读入口会在缺数据时入准备队列。

关键数据与副作用：MySQL ProcessedArticle/Article/归档分类/事件关联、Mongo completed ProcessedItem显示信号、Redis双层缓存/指标/准备状态及BullMQ archivePreparation。Digest/Calendar缺分类或信号会ensure coverage；搜索真实调用embedding/vector/rerank。getDetail只读显示资格、缓存分类（可stale）、时间线160/相关文章12，当前没有正文翻译或分类冷生成。

main剩余：三Query与准备生产/消费仍Nest；第一阶段[ARCHIVE-READING-001](../tasks/ARCHIVE-READING-001.md)已reserved并保存[提示词](../tasks/ARCHIVE-READING-001.prompt.md)，连同search整路两模式迁查询/原生生产者，含请求快照导出。准备worker/显示回填/分类生成仍Nest、第二阶段未认领；不绕过准备副作用，不关闭整链GAP。main注册0/3不变。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#archive) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[archive](../../../../apps/api/src/modules/archive)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：[ARCHIVE-READING-001](../tasks/ARCHIVE-READING-001.md) in_progress，规划Ready #93发布，业务refactor/go-archive-reading及/Users/oo/project/newwei-go-archive-reading已创建于91e759b4并出现vector/llmembed/规则端口开发，无业务PR。允许新archive_port/vector_port窄复用，避开NewsNow registry、条目hydration及四订阅contract/exec；共享接线最小并集。

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
