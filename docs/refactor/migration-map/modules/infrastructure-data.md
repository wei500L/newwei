# infrastructure-data · 基础设施、采集凭据与数据运行

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

存储/vector 配置及采集运行凭据七路，Nominatim/归档/实时信号等数据运行设置九路已接管；归档 status 是读已有队列状态，不代表归档生产与消费迁移。

关键数据与副作用：MySQL SystemSetting、Redis、存储 S3/MinIO、Nominatim、vector、crawl4ai 与归档状态。真实外部连接测试、Telegram 授权/快照刷新、situation 设置整体仍有 Nest 路径。

真实剩余缺口：存储 test 在 `API_GO_STORAGE_DIAGNOSTICS_MODE=go` 时已由 Go 接管（默认 legacy 仍回 Nest，见 [STORAGE-MEDIA-001](../tasks/STORAGE-MEDIA-001.md) 与 [Ready PR #73](https://github.com/wei500L/newwei/pull/73)；PR 未合 main、无实桶验证）；Nominatim test、vector diagnostics、situation-monitor 设置与 Telegram 授权/外部刷新尚在 Nest；启用必须按本域开关，不能改生产 Web 入口。main.go 的 wireDataRuntimeSettings 吞错已核；当前合法路径先保证资源，未证明可触发，见 [OBS-DATA-001](../GAPS.md#观察项与缺少验证不计入已确认业务缺口)，不写成当前九路不可用。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#infrastructure-data) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

当前认领与交付：[STORAGE-MEDIA-001](../tasks/STORAGE-MEDIA-001.md) 仅 storage/test 子范围及必要运行配置导出（与采集媒体链共用同一 S3 能力），不认领其余诊断或配置 CRUD。业务实现已在 `refactor/go-storage-media`（[Ready PR #73](https://github.com/wei500L/newwei/pull/73)）：新增独立开关、诊断 handler、`StorageRuntimeConfig` 与新 `objectstorage` 窄包；7 条配置路由与平台管理员写权限不变，PR 未合 main。旧 worktree 不自动视为活动任务。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithDataRuntimeSettings](../../../../apps/api-go/internal/legacyproxy/data_runtime_settings_routes.go) | `API_GO_DATA_RUNTIME_SETTINGS_MODE` | [dataruntimesettings](../../../../apps/api-go/internal/dataruntimesettings) | `${API_GO_DATA_RUNTIME_SETTINGS_MODE:-legacy}` |
| [WithInfrastructureSettings](../../../../apps/api-go/internal/legacyproxy/infrastructure_settings_routes.go) | `API_GO_INFRASTRUCTURE_SETTINGS_MODE` | [infrastructuresettings](../../../../apps/api-go/internal/infrastructuresettings) | `${API_GO_INFRASTRUCTURE_SETTINGS_MODE:-legacy}` |
| [WithStorageDiagnostics](../../../../apps/api-go/internal/legacyproxy/storage_diagnostics_routes.go) | `API_GO_STORAGE_DIAGNOSTICS_MODE` | [infrastructuresettings](../../../../apps/api-go/internal/infrastructuresettings)（`storage_diagnostics.go`）+ [objectstorage](../../../../apps/api-go/internal/objectstorage) | `${API_GO_STORAGE_DIAGNOSTICS_MODE:-legacy}` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 25：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `GET /api/admin/settings/storage` | settings.manage | [storage-settings.controller.ts](../../../../apps/api/src/modules/storage/storage-settings.controller.ts) · `getSettings` | WithInfrastructureSettings |
| `PATCH /api/admin/settings/storage` | settings.manage | [storage-settings.controller.ts](../../../../apps/api/src/modules/storage/storage-settings.controller.ts) · `updateSettings` | WithInfrastructureSettings |
| `POST /api/admin/settings/storage/test` | settings.manage；**无**平台管理员二次门槛 | [storage-settings.controller.ts](../../../../apps/api/src/modules/storage/storage-settings.controller.ts) · `testConnection` | [WithStorageDiagnostics](../../../../apps/api-go/internal/legacyproxy/storage_diagnostics_routes.go)（独立开关 `API_GO_STORAGE_DIAGNOSTICS_MODE`，默认 legacy；HTTP 201，mode=mysql 真实 SELECT 1 / mode=s3 三步 check） |
| `DELETE /api/system-settings/archive-preparation` | settings.manage | [archive-preparation-settings.controller.ts](../../../../apps/api/src/modules/system-settings/archive-preparation-settings.controller.ts) · `resetSettings` | WithDataRuntimeSettings |
| `GET /api/system-settings/archive-preparation` | settings.manage | [archive-preparation-settings.controller.ts](../../../../apps/api/src/modules/system-settings/archive-preparation-settings.controller.ts) · `getSettings` | WithDataRuntimeSettings |
| `PUT /api/system-settings/archive-preparation` | settings.manage | [archive-preparation-settings.controller.ts](../../../../apps/api/src/modules/system-settings/archive-preparation-settings.controller.ts) · `updateSettings` | WithDataRuntimeSettings |
| `GET /api/system-settings/geo/nominatim` | settings.manage | [geo-nominatim-settings.controller.ts](../../../../apps/api/src/modules/system-settings/geo-nominatim-settings.controller.ts) · `getSettings` | WithDataRuntimeSettings |
| `PUT /api/system-settings/geo/nominatim` | settings.manage | [geo-nominatim-settings.controller.ts](../../../../apps/api/src/modules/system-settings/geo-nominatim-settings.controller.ts) · `updateSettings` | WithDataRuntimeSettings |
| `POST /api/system-settings/geo/nominatim/test` | settings.manage | [geo-nominatim-test.controller.ts](../../../../apps/api/src/modules/system-settings/geo-nominatim-test.controller.ts) · `test` | Nest；尚未接管 |
| `GET /api/system-settings/news-source-runtime-secrets` | settings.manage | [news-source-runtime-secrets.controller.ts](../../../../apps/api/src/modules/system-settings/news-source-runtime-secrets.controller.ts) · `getSettings` | WithInfrastructureSettings |
| `PUT /api/system-settings/news-source-runtime-secrets` | settings.manage | [news-source-runtime-secrets.controller.ts](../../../../apps/api/src/modules/system-settings/news-source-runtime-secrets.controller.ts) · `updateSettings` | WithInfrastructureSettings |
| `DELETE /api/system-settings/realtime-signals` | settings.manage | [realtime-signals-settings.controller.ts](../../../../apps/api/src/modules/system-settings/realtime-signals-settings.controller.ts) · `reset` | WithDataRuntimeSettings |
| `GET /api/system-settings/realtime-signals` | settings.manage | [realtime-signals-settings.controller.ts](../../../../apps/api/src/modules/system-settings/realtime-signals-settings.controller.ts) · `getSettings` | WithDataRuntimeSettings |
| `PUT /api/system-settings/realtime-signals` | settings.manage | [realtime-signals-settings.controller.ts](../../../../apps/api/src/modules/system-settings/realtime-signals-settings.controller.ts) · `updateSettings` | WithDataRuntimeSettings |
| `DELETE /api/system-settings/situation-monitor` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `reset` | Nest；尚未接管 |
| `GET /api/system-settings/situation-monitor` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `getSettings` | Nest；尚未接管 |
| `PUT /api/system-settings/situation-monitor` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `updateSettings` | Nest；尚未接管 |
| `POST /api/system-settings/situation-monitor/external-snapshot/refresh` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `forceExternalSnapshotRefresh` | Nest；尚未接管 |
| `DELETE /api/system-settings/situation-monitor/telegram-auth` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `clearTelegramAuth` | Nest；尚未接管 |
| `POST /api/system-settings/situation-monitor/telegram-auth/complete` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `completeTelegramAuth` | Nest；尚未接管 |
| `POST /api/system-settings/situation-monitor/telegram-auth/start` | settings.manage | [situation-monitor-settings.controller.ts](../../../../apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts) · `startTelegramAuth` | Nest；尚未接管 |
| `DELETE /api/system-settings/vector-service` | settings.manage；handler 平台管理员 | [vector-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/vector-service-settings.controller.ts) · `reset` | WithInfrastructureSettings |
| `GET /api/system-settings/vector-service` | settings.manage | [vector-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/vector-service-settings.controller.ts) · `getSettings` | WithInfrastructureSettings |
| `PUT /api/system-settings/vector-service` | settings.manage；handler 平台管理员 | [vector-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/vector-service-settings.controller.ts) · `updateSettings` | WithInfrastructureSettings |
| `GET /api/system-settings/vector-service/diagnostics` | settings.manage | [vector-service-settings.controller.ts](../../../../apps/api/src/modules/system-settings/vector-service-settings.controller.ts) · `getDiagnostics` | Nest；尚未接管 |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#55](https://github.com/wei500L/newwei/pull/55) | [57d1d4baa5f8](https://github.com/wei500L/newwei/commit/57d1d4baa5f8432686c8db396968633fd559d43e) | ✨ feat(api-go): 基础设施连接与采集运行凭据 7 条接口迁入 Go（默认 legacy）+ 修 IS1–IS4 |
| [#61](https://github.com/wei500L/newwei/pull/61) | [776d17bb75ba](https://github.com/wei500L/newwei/commit/776d17bb75ba718ae756fe9e5b8edd6f261ceb30) | ✨ feat(api-go): 数据运行设置与归档状态 9 条接口迁入 Go（API_GO_DATA_RUNTIME_SETTINGS_MODE，默认 legacy）+ 修 DS1/DS2/DS3/DS4 |

- [docs/refactor/go-infrastructure-settings.md](../../go-infrastructure-settings.md)

- [docs/refactor/go-data-runtime-settings.md](../../go-data-runtime-settings.md)

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
