# situation · 态势监控、地理与实时信号

最近核对：2026-10-18 14:18 MSK（UTC+03:00），由 13:51 全域核对增量复查 #68；`origin/main 3cedce9aa3200436aba3596f63b559de5490cec8`。返回[地图入口](../README.md) / [规划规则](../PLANNING.md)。

**覆盖更新（2026-10-21，基线 `dcbe563b`，更新至 #136）**：HTTP **16/16**、Query **—**、Mutation **—**（Go 注册/分母，C 类 0 条）；16 条全部注册（其中 `GET /api/geo/geocode` 与 `GET /api/system-settings/realtime-signals/runtime` 按本表归属计入）；剩余 Nest 入口 0 条（信号 worker/Telegram 登录见 async-runtime）。旧行为 `91e759b4`/`3cedce9a` 快照（HTTP 12/16），差值即 #92–#136 的注册与接线增量；分子口径为“存在 `API_GO_*` 开关且 Go 规则/处理器/Register 就位”，**不是部署启用**。对账与 C 类清单见 [README 覆盖表](../README.md#注册覆盖) 与 [执行权审计](../../cutover/ownership-audit.md)。

## 范围与实施状态

自定义 monitor 五路、信号缓存读/反馈七路已接管；地图/时空 HTTP 归看板域。Go 信号服务读取 Telegram/Oref 已有缓存与状态，不代表轮询器或主动同步已迁。

关键数据与副作用：MySQL SituationMonitorMonitor；Mongo 反馈和运输；Redis Telegram/Oref/刷新状态；Nominatim、Telegram/Oref、AIS relay、ADS-B/OpenSky、HLS。settings 中的 Telegram 授权/外部快照刷新仍在治理域。

真实剩余缺口：insights、POST refresh、geo/geocode、realtime runtime 诊断仍为 Nest；后台 refresh/signals worker 与外部轮询需要另立边界。

候选实现见 PR #129，未合 main：态势信号 worker（`situationMonitorSignals` 的 Telegram/Oref 轮询、重复任务注册、`situation-monitor:signals:events:v1` 事件桥，`API_GO_SITUATION_SIGNALS_WORKER_MODE`）与 Telegram 登录两条 POST（`API_GO_SITUATION_TELEGRAM_AUTH_MODE`）。

本域注册、实现、接线、合并、验证和启用分别读取：[实现核对与具体未审范围](../AUDIT.md#situation) · [开关/资源](../DEPENDENCIES.md#开关与资源装配) · [普通 CI 与部署证据](../EVIDENCE.md)。下表 Go 仅为接管注册，不自动意味着全部分支实现或所有开关组合可用；实际 merge 提交保留在本页历史表。

Nest 功能目录：[situation-monitor](../../../../apps/api/src/modules/situation-monitor)、[realtime-signals](../../../../apps/api/src/modules/realtime-signals)、[geo](../../../../apps/api/src/modules/geo)。Controller 装配入口见 [AppModule](../../../../apps/api/src/app.module.ts)；GraphQL providers 见 [ApiGraphqlModule](../../../../apps/api/src/graphql/graphql.module.ts)。

当前认领：未发现本域开放 PR；旧 worktree 不自动视为活动任务，后续按[认领核对记录](../tasks/README.md)增量检查。

Go 版 AIS relay 迁移（reserved/in_progress，分支 `refactor/go-ais-relay`，基线 `origin/main dc48abc1`）：Node `apps/ais-relay` 的契约等价实现落在 `apps/api-go/internal/aisrelay` + `apps/api-go/cmd/ais-relay`（同环境变量、同 `GET /healthz/live` / `GET /health` / `GET /ais/snapshot` 路径、同 JSON 形状），并新增镜像 `infra/docker/ais-relay-go.Dockerfile` 与 `go-pilot` profile 的 pilot 服务 `ais-relay-go`（宿主 `3005` → 容器 `3004`，健康检查 `/ais-relay healthcheck`）。**不改变默认切换**：`REALTIME_SIGNALS_AIS_BASE_URL` 仍指向 Node `http://ais-relay:3004`，本批不删 Node 版、不新增开关，回滚只需把该变量指回 Node 服务；本条不计入本页 HTTP 覆盖统计。

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

后续任务先读[缺口](../GAPS.md)与[候选队列](../BACKLOG.md)，同时检查未迁入口、已注册部分实现、接线和必要 Nest 执行步骤；再核[占用](../tasks/README.md)及最新源码。
