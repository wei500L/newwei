# situation · 态势监控、地理与实时信号

最近核对：2026-10-18 13:51 MSK（UTC+03:00）；`origin/main 7fc17faa3dc5043537bad4038299d11fdba4758d`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

## 范围与实施状态

自定义 monitor 五路、信号缓存读/反馈七路已接管；地图/时空 HTTP 归看板域。Go 信号服务读取 Telegram/Oref 已有缓存与状态，不代表轮询器或主动同步已迁。

关键数据与副作用：MySQL SituationMonitorMonitor；Mongo 反馈和运输；Redis Telegram/Oref/刷新状态；Nominatim、Telegram/Oref、AIS relay、ADS-B/OpenSky、HLS。settings 中的 Telegram 授权/外部快照刷新仍在治理域。

真实剩余缺口：insights、POST refresh、geo/geocode、realtime runtime 诊断仍为 Nest；后台 refresh/signals worker 与外部轮询需要另立边界。

状态分层：下表“Go”仅表示该 SHA 已有生产注册、接线及已有业务实现，完整性须看本页具体缺口；“Nest”表示该入口尚无 Go 接管注册。已注册代码已在 main，历史 PR 见证据表。契约完整性、实网验证和部署另行核对；没有业务完成百分比。

验证：基线[普通 CI](https://github.com/wei500L/newwei/actions/runs/39118934491) 的 verify 成功；真实 MySQL/Redis 集成仅覆盖 user-settings/authz，真实 Qdrant 差分仅覆盖 vector。其余域本次仅静态核对，历史报告的 smoke 声明未逐次复验；没有证据则额外集成验证为“未核实”。

启用：实际部署及生产切流均“未核实”。可见 compose 是可选 pilot，Web 默认仍指 Nest，CANARY_PERCENT=0；模块开关默认 legacy 的例外和当前注入见下文。

Nest 功能目录：[situation-monitor](../../../../apps/api/src/modules/situation-monitor)、[realtime-signals](../../../../apps/api/src/modules/realtime-signals)、[geo](../../../../apps/api/src/modules/geo)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

## HTTP 开关、实现与生产接线

所有新迁移单元接受空串/legacy/go、空串视为 legacy、非法值启动失败；用户 UI 读历史兼容模式是例外。启动依赖以 [config.Load](../../../../apps/api-go/internal/config/config.go) 的对应校验为准，不能用配置样例代替启动校验。普通认证接管通常要求 JWT_SECRET、DATABASE_URL、REDIS_HOST；读取 Mongo 的域还要求 MONGO_URI。

| 路由组符号 | 开关（须 go 才接管） | Go 业务实现 | 可见 pilot 注入 |
|---|---|---|---|
| [WithSituationMonitors](../../../../apps/api-go/internal/legacyproxy/proxy.go) | `API_GO_SITUATION_MONITORS_MODE` | [situationmonitors](../../../../apps/api-go/internal/situationmonitors) | `legacy` |
| [WithSituationSignals](../../../../apps/api-go/internal/legacyproxy/situation_signals_routes.go) | `API_GO_SITUATION_MONITOR_SIGNALS_MODE` | [situationsignals](../../../../apps/api-go/internal/situationsignals) | `${API_GO_SITUATION_MONITOR_SIGNALS_MODE:-legacy}` |

生产装配：[cmd/api](../../../../apps/api-go/cmd/api) 中 main.run 组合上述 With 路由规则，各域 wire* 或 main 中 RegisterGoHandler 注入本地 Handler/Service。业务包未发现通过 legacyproxy 回调 Nest 的实现；不支持的方法/路径与普通 OPTIONS 的代理不算业务迁移。默认回滚把对应模式改回 legacy；不要修改整段 /api 前缀。

## 精确 HTTP 清单

分母 16：当前 Nest Controller（含 @Sse）与 auth-matrix 快照交叉核对；METHOD + 完整路径去重，不含 CORS、/graphql、Socket.IO、Bull Board。源码链接保留 handler 符号；权限来自装饰器，平台与内部 token 校验另外标注。

| HTTP 入口 | 根权限 / 额外约束 | Nest 事实源与符号 | Go 接管组 / 缺口 |
|---|---|---|---|
| `POST /api/geo/geocode` | items.read | [geo.controller.ts](../../../../apps/api/src/modules/geo/geo.controller.ts) · `geocode` | Nest；尚未接管 |
| `GET /api/situation-monitor/catalog` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `catalog` | WithSituationSignals |
| `POST /api/situation-monitor/feedback` | items.write | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `recordFeedback` | WithSituationSignals |
| `GET /api/situation-monitor/insights` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `insights` | Nest；尚未接管 |
| `GET /api/situation-monitor/live-hls-proxy-config` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `liveHlsProxyConfig` | WithSituationSignals |
| `GET /api/situation-monitor/monitors` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `listMonitors` | WithSituationMonitors |
| `POST /api/situation-monitor/monitors` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `createMonitor` | WithSituationMonitors |
| `DELETE /api/situation-monitor/monitors/:id` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `deleteMonitor` | WithSituationMonitors |
| `PATCH /api/situation-monitor/monitors/:id` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `updateMonitor` | WithSituationMonitors |
| `POST /api/situation-monitor/monitors/preview` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `previewMonitor` | WithSituationMonitors |
| `GET /api/situation-monitor/oref-alerts` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `orefAlerts` | WithSituationSignals |
| `GET /api/situation-monitor/oref-history` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `orefHistory` | WithSituationSignals |
| `POST /api/situation-monitor/refresh` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `refresh` | Nest；尚未接管 |
| `GET /api/situation-monitor/refresh-runs/:refreshId` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `getRefreshRun` | WithSituationSignals |
| `GET /api/situation-monitor/telegram-feed` | items.read | [situation-monitor.controller.ts](../../../../apps/api/src/modules/situation-monitor/situation-monitor.controller.ts) · `telegramFeed` | WithSituationSignals |
| `GET /api/system-settings/realtime-signals/runtime` | settings.manage | [realtime-signals-runtime.controller.ts](../../../../apps/api/src/modules/realtime-signals/realtime-signals-runtime.controller.ts) · `getRuntimeDiagnostics` | Nest；尚未接管 |

## 合并、CI 与历史报告证据

PR 记录只作索引；实际功能状态已按本页 SHA 的源码/注册核对。下列实际 merge commit 均验证为 main 祖先；integration 合并包含在内。

| PR | 实际 merge commit | 说明 |
|---|---|---|
| [#34](https://github.com/wei500L/newwei/pull/34) | [59e68d8ca7ac](https://github.com/wei500L/newwei/commit/59e68d8ca7acf1f383e97d1f8d13b6cbde5fb791) | ✨ feat(api-go): 用独立开关接管态势监控自定义监控 |
| [#57](https://github.com/wei500L/newwei/pull/57) | [3c9ce2f5614c](https://github.com/wei500L/newwei/commit/3c9ce2f5614c91c789b9fc42d2c96b629c30900d) | ✨ feat(api-go): 态势监控信号读取与反馈 7 条接口迁入 Go（API_GO_SITUATION_MONITOR_SIGNALS_MODE，默认 legacy） |

- [docs/refactor/go-situation-monitor-signals.md](../../go-situation-monitor-signals.md)

后续任务：只将上表 Nest 缺口作为候选；先查任务认领和最新代码，再按完整产品链路选批。未记录的部署配置、所有外部真实调用结果均不能推定。
