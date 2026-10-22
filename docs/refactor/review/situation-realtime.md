# 态势监控、实时信号、经济数据与归档 —— Go 对照 Nest 静态审查报告

- 审查窗口：本批 6 个并行窗口之一（5 个领域审查 + 1 个 ais-relay 移植）。
- 分支：`review/go-situation-realtime`；worktree：`/Users/oo/project/newwei-review-situation-realtime`。
- 实施基线：`origin/main = dc48abc18c2a5921ace8189db6471c5a3ef0a3c2`（PR #141 合并后）。
- 开工前复核（2026-10-22）：`git fetch origin main` 后 `origin/main` 仍为 `dc48abc1`；`gh pr list --state open` 为空；main 上该 SHA 的普通 CI [run 39664944449](https://github.com/wei500L/newwei/actions/runs/39664944449) 为 success；`git worktree list` 中本窗口路径/分支此前均未占用。
- 映射依据：`docs/refactor/cutover/ownership-audit.md`（situation 14 条、economic 3 条、archive/economic GraphQL 段）、`docs/refactor/cutover/switch-matrix.md`（situation 10 个开关、economic 2 个、archive 2 个）、`docs/refactor/migration-map/modules/{situation,economic,archive,workspace}.md`。
- 审查方式：纯静态阅读两侧源码 + 对抗式复核（`.workflow/reviews/static-audit.md` 的方法：每个疑点先写两侧 `file:line`，再尝试用守卫、中间件、默认值、调用约束推翻自己）。本机未安装依赖，未运行 `go build` / `go test` / `go vet` / `pnpm` / Docker / 任何服务，也没有连接真实 Telegram、OREF、OpenSky、AIS relay、Nominatim、AkShare、LiteLLM、MySQL、Redis、Mongo。验证只到 `gofmt -l` 与静态一致性核对，正确性由现有普通 CI 判定。
- 结论摘要：**P0 = 0，P1 = 0**；P2 已修 10 条、只记录 8 条；P3 已修 1 条（注释不实）、只记录 29 条；被推翻的疑点 45 条（见 §4）。

## 1. 审查范围与组织方式

本窗口按 5 条工作流切分，每条由独立执行者完成「建立清单 → 逐项比对 → 对抗式复核 → 分级 → 修复+测试」，改动写入同一 worktree 的不同包，由 Lead 逐条复核 diff、`gofmt` 与跨文件符号一致性后分别提交。

| 工作流 | Nest 侧 | Go 侧 | 发现编号前缀 |
|---|---|---|---|
| W1 信号 worker 与实时事件桥 | `modules/situation-monitor/signals/**` | `internal/situationsignalsworker`、`internal/realtimeevents/{situation,sources}.go`、`internal/situationsignals/{oref,orefdate}.go` | `W-` |
| W2 Telegram 登录与态势设置 | `system-settings/situation-monitor-telegram-auth.service.ts`、`situation-monitor-settings.controller.ts`、`situation-monitor-user-lock.ts` | `internal/situationsettings`、`internal/situationsignals/{telegram,settings}.go` | `G-` |
| W3 自定义监控 CRUD | `situation-monitor-monitors.service.ts`、`dto/situation-monitor-monitor.dto.ts`、controller 五条 monitors 路由 | `internal/situationmonitors`、`internal/situationsignals/monitors.go` | `M-` |
| W4 实时信号与地理编码 | `modules/realtime-signals/**`、`modules/geo/**` | `internal/realtimesignals`、`internal/geocoding`、`internal/runtimediagnostics/realtime*` | `RT-` |
| W5 经济数据与归档 | `modules/akshare/**`、`modules/archive/**` | `internal/economic{data,queue}`、`internal/archive{preparation,preparationworker,reading}`、`graphqlread/{economic,economicdata,archivereading}` | `EA-` |
| 刷新 / insights / 缓存（Lead 自审） | `situation-monitor-refresh.service.ts`、`situation-monitor.service.ts`（insights 链）、`situation-monitor-feedback.service.ts`、`situation-monitor-translation.service.ts` | `internal/situationsignals/{refresh,refresh_handler,refreshrun,cacheops,insights_*,feedback,realtime_augment,catalog,handler}.go`、`internal/situationinsights/analysis` | `R-` |

不属于本窗口：`apps/ais-relay` 自身（只审 `internal/realtimesignals/ais.go` 对 relay 的调用）、Socket.IO 传输层（`internal/realtimesocket`，由「工作区、GraphQL 与异步运行时」窗口审查，本窗口只读其接口）、身份与设置域、新闻与爬取。

## 2. 入口清单

「深度」列：**全文** = 该入口背后服务方法逐分支读完；**重点** = 只读与契约/鉴权/副作用相关的分支；**未审** = 未读。开关默认值一律 `legacy`，本批未新增、未改动任何开关。

### 2.1 HTTP 入口（16 条 situation + 3 条 akshare + 1 条 archive search + 1 条 geo + 1 条实时诊断 + 7 条设置）

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| `GET /api/situation-monitor/catalog` | `situationsignals`（`catalog.go:74`，`handler.go:51`） | `API_GO_SITUATION_MONITOR_SIGNALS_MODE` | 全文 | 契约一致；修 G-02（`orefConfigured` 遮蔽语义） |
| `POST /api/situation-monitor/feedback` | `situationsignals`（`feedback.go`、`handler.go:52`） | 同上 | 全文 | 一致：Mongo 文档形状、学习状态 upsert、learning-rev 自增与 TTL、201 `{ok:true}`、body 10MiB 上限 |
| `GET /api/situation-monitor/refresh-runs/:refreshId` | `situationsignals`（`refreshrun.go`、`handler.go:55`） | 同上 | 全文 | 一致：跨租户/损坏记录同样 404、状态机与 terminal 写回逐分支相同 |
| `GET /api/situation-monitor/telegram-feed` | `situationsignals`（`telegram.go`、`handler.go:62`） | 同上 | 重点（读 + 增强链路） | 一致；受益于 W-01（错误落缓存） |
| `GET /api/situation-monitor/oref-alerts` / `oref-history` | `situationsignals`（`oref.go:126/152`） | 同上 | 重点 | 一致；受益于 W-01 |
| `GET /api/situation-monitor/live-hls-proxy-config` | `situationsignals`（`handler.go:223`） | 同上 | 全文（小） | 一致：非法 channel 的未配置响应形状相同 |
| `POST /api/situation-monitor/refresh` | `situationsignals`（`refresh.go`、`refresh_handler.go`） | `API_GO_SITUATION_REFRESH_MODE`（另需 signals worker + news scheduler 为 go） | 全文 | 一致 + B1 修正（Nest 的 `scheduleCron()` 返回 void，`=== null` 分支是死代码；Go 用返回「是否拿到锁」的入口，正忙分支才真正生效） |
| `GET /api/situation-monitor/insights` | `situationsignals`（`insights_handler.go:93`） | `API_GO_SITUATION_INSIGHTS_MODE` | 全文（core/external/translate/augment） | 一致：query 校验与 `Number()` 语义、缓存键 `…:core:{org,wh,mi,sc,gd,dbg,lr}` / `…:external:{org}`、45s/300s TTL、`${key}` 锁与续期、`generatedAt`、translation `{target,applied,error?}`、augment 候选键；见 R-01/R-02 |
| `GET/POST/PATCH/DELETE /api/situation-monitor/monitors`、`POST /monitors/preview` | `situationmonitors`（`handler.go`、`service.go`、`preview.go`） | `API_GO_SITUATION_MONITORS_MODE` | 全文 | 修 M-01/M-02/M-03/M-05/M-06；M-04（未复用 geocoding.Client）只记录 |
| `GET /api/system-settings/situation-monitor`、`PUT`、`DELETE`、`DELETE telegram-auth`、`POST telegram-auth/start`、`POST telegram-auth/complete`、`POST external-snapshot/refresh` | `situationsettings`、`situationsignals/settings.go` | `API_GO_SITUATION_SETTINGS_MODE` / `API_GO_SITUATION_TELEGRAM_AUTH_MODE` / `API_GO_GDELT_SNAPSHOT_REFRESH_MODE` | 全文（settings/telegram auth） | 修 G-01/G-02；加密信封与限速与 Nest 等价；G-03（go 模式强制 `SYSTEM_SETTINGS_ENCRYPTION_KEY`）列为切流前置 |
| `GET /api/system-settings/realtime-signals/runtime` | `runtimediagnostics`（`realtime.go`、`handler.go:13`） | `API_GO_RUNTIME_DIAGNOSTICS_MODE` | 重点 | 一致：`settings.manage` + orgId 隔离 |
| `GET /api/geo/geocode` | `geocoding`（`handler.go`、`geocode.go`） | `API_GO_GEOCODING_MODE` | 重点 | 修 RT-01（UTF-16 长度）；RT-02/03/08 只记录 |
| `GET /api/admin/akshare/{status,version}`、`POST /api/admin/akshare/upgrade` | `economicdata` | `API_GO_ECONOMIC_DATA_MODE` | 全文 | 一致：三条只有 `settings.manage`（Nest 本就没有平台管理员校验，Go 未放宽） |
| `POST /api/analysis/exports/search` | `archivereading` | `API_GO_ARCHIVE_READING_MODE` | 重点 | 组织过滤与缓存键一致 |

### 2.2 GraphQL 根字段

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| 经济读 6 root（`getEconomicData`、`WithInsights`、`Insights`、`Paginated`、`fetchConfigs`、`refreshPresetStatus`） | `graphqlread/{economic,economicdata}` | `API_GO_GRAPHQL_READ_MODE` + `API_GO_ECONOMIC_DATA_MODE` | 重点 | 一致（read 与 `economicdata.manage` 的划分两侧相同）；EA-07（缓存提示头）只记录 |
| 经济写 3 Mutation（`updateEconomicDataFetchConfig`、`triggerDataFetch`、`triggerEconomicDataRefreshPreset`） | `graphqlread/economicdata` | 同上 | 重点 | 一致 |
| 归档读 3 root（`archiveDigest`、`archiveCalendar`、`archiveDetail`） | `graphqlread/archivereading` | `API_GO_ARCHIVE_READING_MODE` | 全文 | 一致：8 条查询逐条 `orgId` 过滤，跨租户 detail → `null`，缓存键含 orgId |

### 2.3 Socket 事件（本窗口只审态势载荷语义，传输层归其他窗口）

| Nest 事件 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| `situation:telegram.update` / `situation:oref.update`（namespace `situation-monitor-signals`） | `realtimeevents/situation.go:87-120`（`Sink.PublishUser`）+ `situationsignals/realtime_augment.go` | `API_GO_REALTIME_SOCKET_MODE` | 全文 | 载荷形状、`monitorMatches`/`alertMonitorMatches`/`historyMonitorMatches` 注入与字段顺序一致；Nest 的 `broadcast()` 在 legacy 下恒为空操作（W-03） |
| 事件桥 `situation-monitor:signals:events:v1`（生产 `signals/dispatcher.ts:88-118`，消费 `…-events.subscriber.ts:78-155`） | `situationsignalsworker/events.go:12-119`、`realtimeevents/situation.go:27-120` | `API_GO_REALTIME_SOCKET_MODE`（桥本身随 worker） | 全文 | 同形 `{"version":1,"type","payload","timestamp"}`，ISO 毫秒 `Z`；双端开关互斥、不回环 |
| Telegram clear 广播 `situation-monitor:telegram-clear:v1` | `situationsignalsworker/service.go:277-338`（消费）、`situationsettings`（发布） | 同上 | 全文 | 同形（`version:1` + `clearItems`），清理键集合与 Nest 相同 |

### 2.4 BullMQ 队列、定时任务与启动任务

| Nest 入口 | Go 实现 | 开关 | 深度 | 结论 |
|---|---|---|---|---|
| worker `situationMonitorSignals`（concurrency 1） | `situationsignalsworker/queue.go` | `API_GO_SITUATION_SIGNALS_WORKER_MODE` | 全文 | 10 个 vendored Lua 的 KEYS/ARGV、锁 30s/续 15s、stalled 30s/max1、重试退避、停机 grace 一致；`go` 时 Nest 不建 Worker |
| repeat 注册（Telegram JobScheduler、Oref legacy repeat、两个 `:bootstrap`） | `repeatables.go:66-313` | 同上 | 全文 | repeat key `md5(name:jobId:::every)`、`nextMillis`、`repeat:<md5>:<millis>` 与 `bullmq@5.63.2` 逐字符吻合；只注册一份 |
| Telegram 轮询 + 跨实例租约 | `telegram.go`、`telegramclient.Manager.WithLease`、`poll_handover.go` | 同上 | 全文 | #134 的租约+转交解决了「N 实例轮询频率 ≈ 1/N」；W-02 的阻塞窗口只记录 |
| OREF 轮询 + 历史 bootstrap + 默认告警规则 | `oref.go`、`alerts.go` | 同上 | 全文 | 速率/退避/TTL/裁剪/时区一致；规则 id、tick gate、节流、指标键一致 |
| GDELT 外部快照 cron 与强刷 | `gdeltsnapshot`、`cmd/api/gdelt_snapshot.go` | `API_GO_GDELT_SNAPSHOT_MODE` / `…_REFRESH_MODE` | 重点 | 共享 `lock:cron:situation-monitor:external-snapshot:gdelt` 一致 |
| 实时信号采集 cron（8 来源） | `realtimesignals`（`scheduler.go`、`service.go`） | `API_GO_REALTIME_SIGNALS_MODE` | 全文 | tick gate/组织租约/预算账本与 Nest 同 Lua；RT-05（计数粒度）只记录 |
| worker `akshare-data` + 目录/repeat 同步 | `economicqueue`、`economicdata` | `API_GO_ECONOMIC_DATA_WORKER_MODE` | 全文 | repeat 创建/重排、job hash、delayed 槽位与 BullMQ 等价；EA-02/EA-03 只记录 |
| worker `archivePreparation` | `archivepreparationworker` | `API_GO_ARCHIVE_PREPARATION_WORKER_MODE` | 全文 | 修 EA-01（退避）；分批/断点/幂等一致 |
| 队列保留清理（`-queue-cleanup.service.ts`） | `bullmqcleanup/inventory.go:96` | `API_GO_BULLMQ_CLEANUP_MODE` | 只读确认 | 有对应实现，Nest 定时器在 go 时关闭，无双清理 |

### 2.5 第三方调用

| Nest 调用点 | Go 实现 | 深度 | 结论 |
|---|---|---|---|
| Telegram（MTProto 轮询、登录、2FA、会话加密） | `situationsignalsworker/telegram.go`、`telegramclient`、`situationsettings` | 重点 | 加密信封 AES-256-GCM 12B IV 两侧相同（有跨实现解密测试）；2FA 已实现；限速三键/Lua 逐字节一致；**gotd/gramjs 内部的 DC 迁移与 FLOOD_WAIT 未审**（无 module cache） |
| OREF（alerts/history HTTP） | `situationsignalsworker/oref.go` | 全文 | 非 2xx/超大/非 JSON 视为失败且不覆盖数据（Nest 会写空列表，Go 已修正） |
| Nominatim | `geocoding`、`situationmonitors/location.go` | 重点 | geocoding 侧 1 rps + UA + 缓存一致；monitors 侧自建调用绕过缓存/限流（M-04 只记录） |
| AIS relay / OpenSky / ADS-B / Polymarket / unrest | `realtimesignals/{ais,opensky,adsb,keyword,unrest,transport}.go` | 全文 | 超时/退避/缓存 TTL/降级形状/额度 Lua 逐值一致 |
| AkShare Python 网关 + Finnhub/FRED/Yahoo | `economicdata`（`fetch.go`、`parser.go`、providers） | 重点 | 超时/错误映射一致；EA-04/05/06 只记录 |
| LiteLLM（embedding / rerank） | `llmembed`、`situationmonitors`、`archivepreparationworker` | 只读 | 预检与降级路径一致 |

## 3. 发现列表

级别定义：P0 数据损坏/丢失、越权跨租户、鉴权绕过、密钥泄露；P1 功能结果错误、重复副作用、事务缺失、后台任务停摆；P2 响应契约差异（字段/顺序/null/时间格式/错误消息与状态码）、性能退化；P3 可读性/注释/日志。

**P0 = 0，P1 = 0。** 本窗口没有发现数据损坏、跨租户越权、鉴权绕过、密钥泄露，也没有发现重复副作用、事务缺失或后台任务停摆。

### 3.1 已修复（P2 10 条 + P3 1 条）

| 编号 | 级别 | 标题 | 两侧证据 | 影响 | 提交 | 测试 |
|---|---|---|---|---|---|---|
| EA-01 | P2 | 归档准备 worker 忽略配置的指数退避 | Nest `archive/archive-preparation-queue.service.ts:138-142`（`attempts:5` + `backoff:{type:"exponential",delay:15000}`）↔ Go 改前 `archivepreparationworker/worker.go:392-396` 无条件 `retryJob`，`protocol.go` 连 `backoff` 都没解析 | 4 次重试全部立即执行，缺少 15s/30s/60s/120s 退避；外部失败时对 AkShare/模型网关的压力与 Nest 不同 | `a7145183` | `TestJobRetryDelayMatchesBullMQExponentialBackoff`、`TestJobRetryDelayWithoutBackoffIsImmediate`、`TestJobRetryDelayFixedNumberBackoff`、`TestJobFinalFailureBoundary`、`TestJobDeferredFailureIsTerminal`、`TestMoveToDelayedScriptIsEmbedded` |
| RT-01 | P2 | `/api/geo/geocode` 的 query 长度按字节而非 UTF-16 码元 | Nest `geo/dto/geo-geocode.dto.ts:8` `@MaxLength(200)`（class-validator 用 `String.length`）与 `geocoding.service.ts:186` `slice(0,200)` ↔ Go 改前 `geocoding/handler.go:127` `len(query)>200`、`geocode.go:609` 按 rune 截断 | 67~200 个汉字的地名 Nest 接受、Go 400；超长截断长度也不同 | `f2d76225` | `TestNormalizeQueryTruncatesByUTF16CodeUnits`、`TestParseGeoDTOValidatesLengthInUTF16CodeUnits` |
| G-01 | P2 | Telegram `channelSet` 的旧别名优先级错 | Nest `system-settings/situation-monitor-settings.service.ts:974-980` + `readStringEnv:1042-1054` + `env.schema.ts:994`（zod 默认 `"full"` 先遮蔽 `TELEGRAM_CHANNEL_SET`）↔ Go 改前 `situationsignals/settings.go:253` 首个非空胜（canonical 缺省时落到别名） | 读侧与 worker/Nest 对同一部署得到不同 channelSet，`telegram.go:107-120` 每轮清空并改写共享 state key → feed 长期为空 + 重复清空副作用 | `2766c573` | `TestTelegramRuntimeConfigChannelSetEnvPrecedence` |
| G-02 | P2 | `GET /catalog` 的 `orefConfigured` 遮蔽语义错 | Nest `settings.service.ts:252-259`（`env.get(canonical) ?? env.get(alias)`，空 canonical 遮蔽别名）↔ Go 改前 `settings.go:282` 用首个非空胜 | `.env.sample:1252` 正好留空 canonical，旧别名有值时 Go catalog 报 `configured:true`，还与 Go 自己的 settings GET 矛盾 | `2766c573` | `TestCatalogOrefConfiguredShadowing` |
| W-01 | P2 | 轮询失败/守卫拒绝的错误只留内存，切流后 HTTP 读侧看不到 | Nest 写侧 `signals/situation-monitor-signals.service.ts:557-560` 只写内存、读侧同进程可见 `:224-226,243-244,260-261`；Go 读侧只读缓存 `situationsignals/oref.go:72-74,126-128,152-154`、`telegram.go:92-94`，改前写侧 `situationsignalsworker/oref.go:70-97`、`telegram.go:251-274` 不写缓存 | `API_GO_SITUATION_MONITOR_SIGNALS_MODE=go` 后，OREF 抓取失败、Telegram 禁用/缺凭据时响应 `error` 消失，Web 横幅（`situation-monitor-signals-panels.tsx:109-110,298-299`）不再提示「数据为何陈旧」 | `15b6fdd9` | 改写 `TestPollOrefB3KeepsLastGoodState`、扩展 `TestPollOrefDisabledAndNotConfigured`、新增 `TestPollTelegramGuardErrorsAreCached` |
| M-01 | P2 | preview 响应缺 `modelInfo.rerankModel` | Nest `situation-monitor-monitors.service.ts:393,402-407` 无条件返回配置的 rerank 模型 ↔ Go 改前 `situationmonitors/preview.go:46,126` 只有 `embeddingModel` | 启用 rerank 的组织在 Go 下 `modelInfo` 少字段，前端/诊断契约不一致 | `e8d9ab20` | `TestPreviewModelInfoReportsConfiguredRerankModel` |
| M-02 | P2 | preview 的 `taxonomyDisplayName` 丢默认 taxonomy | Nest `situation-monitor-monitors.service.ts:1938-1955` 走 `NewsClassificationSettingsService.getSettings`，无配置回落 `DEFAULT_TAXONOMY`（`news-classification-settings.service.ts:76,325-340`）↔ Go 改前直接读 `SystemSetting` 行，无行即空表 | 未自定义分类的组织（常态）在 Go 下 `taxonomyDisplayName` 退化成原始 path | `e8d9ab20` | `TestTaxonomyLabelsSkipsNonPaths`、`TestFilterSuggestionsUsesDefaultTaxonomyLabel` |
| M-03 | P2 | PATCH 显式 `null` 语义相反 | Nest `dto/situation-monitor-monitor.dto.ts:111-133` 全 `@IsOptional()`（跳过 null）+ service `:479-495` `patch.x ?? existing.x` ↔ Go 改前 `dto.go` 对 `name:null`/数组 null 返回 400 | 老客户端/脚本发显式 null 时 Nest 200 不改、Go 400（`color:null`、`location:null` 两侧都是清空，保持不变） | `e8d9ab20` | `TestUpdateKeepsStoredValuesOnNull`、`TestUpdateNullStillTripsSystemSyncGuard`、`TestUpdateNullClearsColorAndLocation`、`TestCreateNullApprovedLexicalDefaultsToKeywords` |
| M-05 | P2 | 从地点文本推导国家缺 Nest 的「短 token 必须大写」规则 | Nest `packages/utils/src/geo.ts:220-259`（≤3 字符 token 非全大写则跳过）、`resolveLocationInput:2026-2028`（`??` 而非 `\|\|`）↔ Go 改前 `situationmonitors/location.go:64-77` | `Lago de Atitlan`、`Mar de la Plata` 会把 `de`/`la` 误判成国家，写进 `locationCountryCode` 并在匹配时产生假 `conflict`；客户端传非法国家码时 Go 额外猜国家 | `e8d9ab20` | `TestCountryFromTextIgnoresLowercaseShortTokens`、`TestResolveLocationCountryResolution` |
| M-06 | P2 | preview 建议在「同分同计数」时顺序随 map 迭代随机 | Nest `rankCatalogRowsByEmbedding:2086`/`tryRerankCatalogRows:2157`/`previewMonitor:310-327` 是 JS 稳定排序 + Map 插入序（确定）↔ Go 改前 `preview.go:166-184` 对 map 迭代结果 `sort.SliceStable`，全平局无兜底 | 同一请求多次调用/多实例返回顺序不同，UI 建议抖动 | `e8d9ab20` | `TestOrderCandidatesIsDeterministicOnTies` |
| RT-09 | P3 | `geocoding.Client` 注释声称身份缓存「data race-free」，实际未同步 | 改前 `geocoding/geocode.go:142-145` 注释 ↔ 该缓存两个字段无锁访问 | 注释误导后续维护者（并发为良性竞态，最坏多一次 settings 读） | `f2d76225` | —（注释修正，无行为变化） |

### 3.2 只记录（P2 8 条）

| 编号 | 级别 | 标题 | 两侧证据 | 为何不修 |
|---|---|---|---|---|
| R-01 | P2 | `POST /refresh` 的 external 前缀永不匹配任何键 | Nest `situation-monitor-refresh.service.ts:17` `situation-monitor:external:` ↔ 真实键是 `situation-monitor:external-snapshot:gdelt:{fresh,stale}:v1`（`situation-monitor-external-snapshot.service.ts:39-41`、`gdeltsnapshot/model.go:35-37`）；Go `situationsignals/refresh.go:47-52` 保留了同一缺陷并在注释里记录 | `cache.externalCleared` 恒为 0、刷新不会失效 GDELT 快照缓存。**Nest 既有问题**；修它需要跨域确认 GDELT 快照刷新所有权（属 gdelt 窗口），且会把 `externalCleared` 从 0 变成 N，属可见行为变化，本批只记录 |
| R-02 | P2 | `GET /insights` 对未知 query 参数的处理与 Nest 不同 | Nest `main.ts:69-75` 全局 `ValidationPipe{whitelist,forbidNonWhitelisted:true}` + `@Query() SituationMonitorInsightsQueryDto` → `?foo=1` 返回 400 `property foo should not exist`；Go `insights_cache.go:parseInsightsQuery` 只读声明过的键，未知键忽略 → 200 | 这是全仓 Go 路由的统一约定（`telegram-feed` 等 Nest 侧同样用 `Record<string, unknown>` 不校验），只在 insights 一条上收紧会造成同域不一致；应由整合窗口统一决定「是否全量模拟 forbidNonWhitelisted」 |
| W-02 | P2 | 跨实例 Telegram 转交期间持有共享 mutex，最长阻塞 210s | `poll_handover.go:218-226,343`（等待上限 `PollCycleTimeoutMS+30s`）、同一把锁 `service.go:221,334`；Nest 的 clear 订阅者异步、轮询在 worker 里无共享锁 | 需改锁/线程模型（把 clear 广播与轮询解耦），本机无 build/test 无法验证并发正确性；不丢数据、不写坏数据，只推迟 |
| M-04 | P2 | monitors 地理编码未复用 `internal/geocoding.Client` | Nest `geo/geocoding.service.ts:105-260`（Redis 正/负缓存、`rate:geocode:nominatim` 1 rps、`GEO_NOMINATIM_BASE_URL/ACCEPT_LANGUAGE`、settings UA/email）↔ Go `situationmonitors/location.go:113-163` 硬编码公网 URL、固定 UA、无缓存/限流；仓库已有等价实现 `geocoding/geocode.go:105-201` | 修复要改 `cmd/api/situation_monitors.go:16` 的构造与 `cmd/api/main.go` 调用点（约束：共享文件只做最小改动且需说明）；且会让 preview/create 多一次 Redis 依赖。风险面是自建/代理 Nominatim 部署下打公网与 1 rps 政策，已列入 §6 切流前置 |
| M-10 | P2 | signals 读路径按用户触发 legacy 迁移（含零监控用户建 `system_sync` 行） | Nest 批量路径 `matchCandidatesForUsers:910-968` 不迁移（`findMany` 直接读），单用户 `matchCandidates:881-904` → `loadMonitorRows:1693-1694` 才迁移；Go `situationsignals/match.go:78`、`realtime_augment.go:217` → `monitors.go:44` → `situationmonitors/export.go:53-57` → `migrate.go:10` 每次都迁移 | **部分推翻**：insights 单用户路径 Nest 也迁移，Go 与之相同；只有批量（实时增强）路径 Nest 不迁移。影响是每用户多 2–4 条 SQL 与读路径写副作用，批量改造需动 `situationsignals/{service,realtime_augment}.go` 且无法本机编译验证，记录待有 CI 的批次 |
| EA-02 | P2 | `economicqueue` worker 不读 `meta.paused` | Nest worker（`akshare.processor.ts:38-44`）受 bull-board 暂停影响；Go moveToActive 未用 `getTargetQueueList`（对比 `archivepreparationworker:291-297` 的 `isPaused`） | 该包无 Redis 假实现，交付不了可运行测试；属「暂停后仍抽干 wait 列表」的运维语义差异 |
| EA-03 | P2 | `economicqueue` 无 stalled 恢复 | Go 独占消费后 Nest 不建 Worker（`akshare.processor.ts:39`），无人跑 `moveStalledJobsToWait`（对比 `archivepreparationworker:560-600` 的 stalledLoop） | 崩溃/部署留下的在途 job 会留在 active 列表直到下次手工处置；需 Redis 集成用例，与 EA-02 同批 |
| EA-07 | P2 | 经济读 root 未复现 `setPrivateResponseCacheHint` | Nest `graphql/resolvers/economic-data.resolver.ts:175-177,212-214` 设置私有缓存提示；Go `graphqlread` 对应 root 未设置 | 属 `graphqlread` 共享执行器契约，跨领域改动，本批只记录 |

### 3.3 只记录（P3 29 条，按域合并列出）

| 编号 | 标题 | 证据要点 |
|---|---|---|
| G-03 | go 模式启动强制 `SYSTEM_SETTINGS_ENCRYPTION_KEY`（+Mongo），Nest 该键可选 | `config.go:6377-6384,6419-6426` ↔ `env.schema.ts:1296`、`storage-settings.crypto.ts:127-154`。fail-closed 方向正确，列入切流前置 |
| G-04 | 限速求值超时硬编码 100ms，Nest 读 `RATE_LIMIT_REDIS_EVAL_TIMEOUT_MS`，且熔断/超时补偿未移植 | `situationsettings/telegram_auth_service.go:37,710` ↔ `rate-limiter.service.ts:83,105-215` |
| G-05 | 失败日志粒度：Nest 记整对象，Go 只记 message | `situationsettings/errors.go:149-155` ↔ `auth.service.ts:360`（两侧错误链都不含 session/code/password） |
| G-06 | Body 上限 1MiB vs 10mb、错误 `path` 用 `URL.Path` vs `request.url`、脏缓存标量 `source` 判定 | `situationsettings/handler.go`、`store.go:97-124` ↔ `settings.service.ts:1395-1397` |
| M-07 | 用户锁获取失败 Go 503 vs Nest 500 | `situationmonitors/errors.go:30` → `handler.go:231` ↔ `situation-monitor-user-lock.ts:135`；本仓「DB 不可用=503」既有约定需统一 |
| M-08 | legacy 迁移的国家推导比 Nest 多算 | `situationmonitors/location.go:79-95` ↔ `normalizeLegacyLocation:2548-2568` |
| M-09 | preview 响应用 `[]any` 承载业务数据（违反强类型规范） | `situationmonitors/preview.go:42-44,342,390,444`；精确强类型化会改变 `taxonomyPath:null` 的存在性 |
| M-11 | `includeTaxonomy` 死字段、历史中文注释 | `situationmonitors/preview.go:25` 等 |
| W-04 | 事件桥用 `time.Now()` 而非注入时钟 | `situationsignalsworker/events.go:74,97`（仅影响测试可注入性） |
| W-03 | Nest 网关 `getConnectedUsersByOrg()` 恒 `undefined`，纯 legacy 下态势实时事件从未到浏览器 | `signals/situation-monitor-signals.gateway.ts:548-552` ↔ `:258-261`。**Nest 既有缺陷，Go 已修复，行为变化**（回退即恢复缺陷，写入 runbook） |
| RT-02 | 诊断探测端点 Nest 走 `geocode()`（读写缓存）、Go 走 `Probe()` | 有意设计，写入切流说明 |
| RT-03 | 瞬时失败不写负缓存 | **Nest 既有问题，Go 已修复，行为变化** |
| RT-04 | Polymarket 价格缓存 JSON 键序（数字样式键 JS 前置） | 无语义影响 |
| RT-05 | 预算账本计数粒度（Go 每轮 1 次 vs Nest 每 org 1 次） | `openskyBudget.skippedMilitaryCount/errorCalls` 跨实现不可比 |
| RT-06 | 诊断响应 `sources[].context` 键序（map 字母序 vs 插入序） | 无语义影响 |
| RT-07 | `Date.parse` 兼容面（数字串 epoch、1e12 分界） | 无现存触发路径 |
| RT-08 | Nominatim 基址带子路径时 Nest 丢路径、Go `JoinPath` 保留 | **Nest 既有问题，Go 保留更严格语义，行为变化** |
| EA-04 | 失败文案差异 + 191 按码点 vs UTF-16 截断 | `akshare.service.ts:2541-2558` ↔ `economicdata/fetch.go:106-116` |
| EA-05 | 数值型 category 拼进 `sourceField` 用 `%v`（`1e+08`）≠ JS `String`（`100000000`） | `parser.go:145-150` ↔ `base.parser.ts:210-212`；当前 definitions 多为字符串，风险低 |
| EA-06 | provider 归一化不一致（去 `%`、NaN 大小写） | 仅影响 `filter mode=best` 的选记录 |
| EA-补-A1..A7 | repeat 调度 7 条 P3：缺「scheduler 仍在 repeat ZSET」守卫、不写 `ic`、不 `INCR` 自动 id、`count` 恒 1、cron 忽略 `TZ`、清理可能删掉刚领取的 job hash、slug 排序 `localeCompare` vs `strings.Compare` | `economicqueue/cron.go` ↔ `bullmq@5.63.2 updateJobScheduler-12.lua` / `addRepeatableJob-2.lua`；A-1（已删 repeat 被在途 job 复活）建议与 EA-02/EA-03 同批收敛 |
| R-03 | learning-state token 排序：JS `Object.entries` 对纯数字键先行排序，Go 用 BSON 存储序 | `situationsignals/insights_core.go:476-518` ↔ `situation-monitor-feedback.service.ts:219-235`；仅影响全数字 token 的并列顺序与 25 条上限边界 |

## 4. 被推翻的疑点

以下疑点按规划提示逐条查证后**不成立**，记录原因以免后续重复审查。

**刷新与 insights（Lead 自审）**

1. 「insights 缓存前缀只清理本组织」——不成立：两侧前缀都是 `situation-monitor:insights:`（无 org 段），包含 `…:core:*`、`…:external:{org}` 与 `…:insights:learning-rev:v1:{org}`，因此一次刷新会清理**所有组织**的 insights 缓存与 learning-rev（Nest 与 Go 同缺陷，`refresh.go:40-45` 注释已记录，属既有跨租户清缓存行为）。
2. 「learning-rev 键未被清理」——不成立：`learning-rev:v1` 键以 `situation-monitor:insights:` 开头，被同一前缀 SCAN 覆盖。
3. 「`scheduleCron` 正忙分支未修」——已修（#134/B1）：Nest `scheduleCron(): void` 使 `=== null` 分支是死代码；Go 用返回「是否拿到锁」的 `RunScheduleOnce`，正忙时 `schedulerTriggered=false` 并给出 `situation_monitor_crawl_scheduler_busy` 警告。属 **Nest 既有问题，Go 已修复，行为变化**。
4. 「insights 查询参数被简化」——不成立：Go 复现了 `Number()`（含十六进制、NaN/Inf、整数化）、`<input> must be an integer number` 文案、重复参数 400、`sections` 去重保序、`parseBoolean` 词表、`parseTranslateTarget` 词表，逐项与 Nest controller 辅助函数一致。
5. 「external 段数据源不同」——不成立：Nest 的 `FinancialMainlineSnapshotService.getMarketsSnapshot/getFedSnapshot` 同样直连 Finnhub/FRED，`getCryptoSnapshot` 直连 CoinGecko，`getFedNews()` 恒返回 `[]`；Go 的数据源、字段与 `[].` 语义相同。
6. 「feedback 的 learning-rev TTL/自增语义不同」——不成立：`CacheService.incr` 只在值为 1 时 `EXPIRE`，Go `bumpInsightsLearningRevision` 同语义；`$setOnInsert/$set(updatedAt)/$inc/$addToSet` 与 Mongoose timestamps 产物一致。

**信号 worker 与事件桥（W1）**

7. 事件桥形状不一致——不成立：`{"version":1,"type","payload","timestamp"}`、ISO 毫秒 `Z`、telegram `{count,updatedAt,items[:30]}`、oref `{alerts,historyCount24h,totalHistoryCount,updatedAt,historyEntry|null}` 字段与顺序逐项相同。
8. 事件会重复推送——不成立：桥消费者与队列/运维事件流都只推本进程连接并显式绕过 Socket.IO adapter，无需 message id 去重。
9. repeat 会被每个实例各注册一份——不成立：repeat key 为 `md5("oref-poll:oref-poll:repeat:::300000")`，与 `bullmq@5.63.2 repeat.js:170-177` 逐字符一致。
10. Telegram N 实例下轮询降为 1/N——不成立（已在 #134 修复）：只有租约持有者建 MTProto，其他实例通过 `…:telegram-poll:v1` 转交，`LPUSH+BLPOP` 回执、120s TTL，`subscribers==0` 时回退再抢租约；混合期（Nest 持租约）只能超时，runbook 已要求先 api 后 api-go。
11. Oref 速率/退避/TTL 不一致——不成立：`alerts` 2MiB 上限、history 无上限、500 条 bootstrap、7d/200 波、时区回读逐项对齐。
12. 队列保留清理没有 Go 实现——不成立：`bullmqcleanup/inventory.go:96`，Nest 定时器在 go 时关闭。

**Telegram 登录与设置（W2）**

13. session 未加密或算法不等价——不成立：两侧同一 `system-settings:v1` 信封（AES-256-GCM、12B 随机 IV、分离 tag、无 AAD），有跨实现解密测试。
14. 「密钥缺失时 Nest 启动失败」——方向反了：Nest 不校验启动、非生产写明文；Go 写入策略相同，只在 go 模式加了启动校验（G-03）。
15. 明文会话/密钥进日志（P0）——不成立：待处理请求里的 `session/apiHash` 是 Nest 既有 Redis 设计，两侧共享同一键；完成后不回显；错误链不含敏感值。
16. 2FA 未实现——不成立（Nest `:163-175` ↔ Go `:474-487` + `auth.Password`）。
17. 限速三键/哈希/TTL/429 不同——不成立：`start:user/ip/phone` 键、`phoneHash`、TTL、Lua 逐字节一致。
18. user-lock 泄漏导致永久无法登录——不成立：该锁只被 MFA/模型设置使用，与本链路无关。
19. `situation-monitor:telegram-clear:v1` 漏清键——不成立：Nest 只删单个 state key，Go 同 payload 同 key；refresh-run/oref/metrics 本就不在清理集合。
20. 设置路由存在跨租户 id——不成立：设置是全局单键，无租户资源 id。
21. 设置写入不触发调度/缓存键不一致——不成立：两侧 PUT/DELETE 都热同步 telegram + economic 定时任务。
22. `?limit=0` 契约差异——不成立：两侧都落默认 50。

**监控 CRUD（W3）**

23. 未知字段/类型转换/数组上限/嵌套白名单不一致——不成立：Go `dto.go` 逐项对齐 `forbidNonWhitelisted`/`forbidUnknownValues`/`@Type(()=>Number)`/`ArrayMaxSize`，且 `MaxLength` 用 UTF-16 长度；错误消息以 `"; "` 合并是本仓 Go 统一约定（`crawlprofile/validate.go:360` 等）。
24. 请求体上限不同——不成立：Nest `main.ts:110-112` `10mb` == Go `dto.go:15` `10<<20`。
25. 租户/所有权被放宽——不成立：`store.go` 与 `reconcile.go/migrate.go` 全部 `orgId AND userId`（catalog 仅 orgId，与 Nest 相同），跨租户 404，平台管理员无旁路。
26. 并发创建重复或突破 20 条上限——不成立：两侧都用同一把 MySQL `GET_LOCK("ucs:<orgId>:<userId>",10)`，锁名算法逐字一致。
27. 删除/更新遗漏副作用——不成立：Nest 该服务内无 AuditLog、无缓存失效、无刷新状态清理、无服务端广播；`situation-monitor:monitors-updated` 只是 Web 端 `window` CustomEvent。
28. 排序/分页/空结果差异——不成立：`kind ASC, createdAt DESC`、无分页、空结果 `[]`。
29. preview 打分/归一无差异——不成立：词法打分、embedding 截断 16、rerank min-max 归一（`max==min→1`）、建议 6+keywords、`matchedTerms` 4 条上限逐项一致。
30. 坐标精度差异——不成立：Nest 直接 `Number(lat/lon)`，Go 不舍入。
31. 迁移/reconcile 非幂等——不成立：`count>0` 短路、差集增删；两侧都没有启动期 reconcile。

**实时信号与地理编码（W4）**

32. 并发越界/整轮失败是 Go 新缺陷——不成立（Nest 同样 `ConflictException` 整轮失败）。
33. tick gate 键/TTL、`lock:` 前缀、续期区间不一致——不成立。
34. 多实例会重复打上游——不成立（共享 tick gate 与组织租约）。
35. geocode 存在 SSRF——不成立（无用户可控 URL）。
36. `localeCompare` 与码元序对 `icao24` 有差异——不成立（已小写 ASCII）。
37. `toFixed`/`jsRound` 有可达差异——不成立。
38. 上下文写入用无类型容器——不成立（全为具名结构体）。
39. OpenSky token/预算 Lua/降级阈值不一致——不成立。
40. 诊断路由缺鉴权或跨租户——不成立（`settings.manage` + orgId 隔离）。
41. 日志含密钥——不成立。

**经济与归档（W5）**

42. 「Go producer 不写 marker 导致 Nest worker 永不唤醒」——不成立：`bullmq@5.63.2 worker.js:421-442` 在无 delayed job 时 `bzpopmin` 最多 5s 超时轮询，只损失 ≤5s。
43. 归档准备出现双消费——不成立：Nest processor 按开关 return，不建 Worker。
44. 管理/升级接口 Go 放宽权限——不成立：Nest 三条 HTTP 只有 `settings.manage`，本就没有平台管理员校验；3 个 Mutation 与 6 个读 root 的 read/manage 划分两侧一致。
45. 归档读存在跨租户或越权对象访问——不成立：8 条查询占位符与参数顺序逐个核过（含子查询 orgId 前置），缓存键全含 orgId，Mongo 查询带 orgId；归档链**完全不使用对象存储**（三个 Go 包对 `objectstorage` 零导入，Nest `modules/archive` 也无 storage 调用），`cleanedMarkdownRef` 只是 Mongo `processeditems._id`，查询带 `orgId`；`internal/objectstorage` 本身不做租户校验（key 原样透传），真实风险面在 crawlreadtelemetry/crawlexecution/accountdata/infrastructuresettings（见 §5）。

## 5. 未覆盖部分与建议的后续审查

**覆盖率如实说明**：本窗口 `apps/api/src` 范围内约 3.9 万行、Go 侧相关约 3.1 万行，**不是逐行通读**。按「写路径、鉴权、后台任务优先，纯读格式化其次」分配。

已全文审查（对应服务方法逐分支读完）：

- `internal/situationsignals`：`refresh.go`、`refresh_handler.go`、`refreshrun.go`、`cacheops.go`、`insights_cache.go`、`insights_handler.go`、`insights_augment.go`、`feedback.go`、`catalog.go`、`handler.go`、`monitors.go`、`realtime_augment.go`、`match.go`（重点段）、`jsnumber.go`。
- `internal/situationsignalsworker`：`queue.go`、`oref.go`、`telegram.go`、`poll_handover.go`、`events.go`、`repeatables.go`、`alerts.go`、`doc.go`。
- `internal/situationmonitors` 全部 13 个源文件；`internal/situationsettings` 全部；`internal/archivepreparationworker` 全部；`internal/realtimesignals` 全部；`internal/geocoding` 全部。
- Nest：`situation-monitor-refresh.service.ts`、`situation-monitor.controller.ts`、`situation-monitor-feedback.service.ts`、`situation-monitor.service.ts`（insights 主链）、`signals/{processor,dispatcher,scheduler,constants}`、`situation-monitor-monitors.service.ts`（1–600、827–880、1359–2060、2167–2290、2327–2734）、`dto/**`、`archive-preparation*`、`akshare.service.ts`/`processor`/admin controller（重点段）、`realtime-signals/**`（重点段）、`geo/**`。

**未审查或只抽读**：

- `gotd`/`gramjs` 内部实现（DC 迁移、`FLOOD_WAIT` 重试、重连次数）：无 module cache，无法静态比对；Telegram 真实登录/2FA/DC 迁移未验证。
- `situation-monitor-monitors.service.ts:598-1340` 的匹配算法细节（归 `situationsignals/match.go`，只核了只读性、enabled 过滤与租户契约）。
- `situationsignals/insights_core.go`、`insights_external.go`、`insights_translate.go` 未逐行读（约 1900 行），只核了缓存键/TTL/返回形状/翻译状态字段。
- `akshare.definitions.ts`(3897 行)/`financial-data.definitions.ts`(645 行) vs `catalog_defs.go`(380 行) 未逐条 diff 183 个条目；5 个 parser 子类与 3 个 provider 未逐行读。
- 归档分类/检索数值等价（`archive-classification.service.ts` 1445 行、`classifier` 557、`taxonomy` 706、`archivereading/search.go` 894）未做公式级比对；`archivepreparationworker/{hybrid,anchor,display,bsonjson}.go` 未审。
- `dashboardwarmap`（`opensky.go` 998 行、`realtime.go`、`layers*.go`，未迁包且用 `map[string]any` 承载快照）、`dataruntimesettings` 全量解析、`realtimesocket` 传输层、`cmd/api/main.go` 装配细节：只读调用点。
- 所有 `*_integration_test.go`（situationsignals/refresh、situationsignalsworker、archivepreparationworker、realtimesignals）只浏览未执行；多实例 Redis/MySQL 行为、真实 Nominatim/LiteLLM/AkShare 未验证。
- 本机未运行任何 build/test/vet：所有「已修」结论都是静态推断，最终以普通 CI 的 `go test ./...` 为准。

**建议后续审查**（按风险排序）：

1. `economicqueue` 的 paused 语义（EA-02）与 stalled 恢复（EA-03）+ repeat 守卫（A-1）、迭代计数（A-2）：一个带 Redis 夹具的小任务，一并收敛。
2. `internal/objectstorage` 的租户边界：`crawlreadtelemetry`（媒体预览/下载 presign）、`crawlexecution`（`media_store` PutObject）、`accountdata`（头像上传）、`infrastructuresettings`（诊断探针）逐个核「键是否嵌 orgId」「presign 前是否校验对象行归属」——`objectstorage` 本身不做校验。
3. `situationmonitors` 接入 `internal/geocoding.Client`（M-04），涉及 `cmd/api/situation_monitors.go` 与 `main.go` 调用点。
4. `situationsignals` 批量监控读取（M-10）：一次 `orgId + userId IN (...)` 且不迁移，消掉读路径的写副作用与每用户 2–4 条 SQL。
5. `insights_core.go` / `insights_external.go` / `insights_translate.go` 的逐行等价性（本窗口最大未读面，约 1900 行）。
6. `akshare` definitions 全量 diff 与 5 个 parser（数值/日期解析的 JS 等价）。

## 6. 删除 Nest 前必须确认的事项

1. **进程内状态已无残留的假设不成立，但有对应落点**：Nest 的 `SituationsignalsService` 把 Telegram/OREF 的 `lastError` 放在进程内存（W-01 已由 Go 写入 Redis 文档补齐）；删除 Nest 后这类「只有 Nest 内存里才有」的状态必须全部改为 Redis 文档，本批已覆盖 Telegram/Oref 错误，`insights` 的临时告警数组本来就是请求内的。
2. **GDELT 外部快照缓存不会被 `POST /refresh` 失效**（R-01）：Nest 既有缺陷，Go 保留。删 Nest 后若要「刷新即失效外部快照」，需要一个明确 claim 的任务，不能假定现行为正确。
3. **Nominatim 政策**：`situationmonitors` 自建调用未走 `internal/geocoding.Client`（M-04），既无限流也无缓存；若部署使用自建/代理 Nominatim，必须先做 M-04 的接线，否则切流后地理编码会打公网并可能触发限流。
4. **`SYSTEM_SETTINGS_ENCRYPTION_KEY` 成为硬性前置**（G-03）：`API_GO_SITUATION_SETTINGS_MODE` / `…_TELEGRAM_AUTH_MODE` / archive preparation worker 在 go 模式下启动即校验该键，没有密钥的预发环境会启动失败；同时确认 Telegram 会话与网关密钥都已有加密信封（两侧格式相同，可互读）。
5. **切换顺序与回退缺陷**：`API_GO_SITUATION_SIGNALS_WORKER_MODE`（先 api=go → api-go=go）、`API_GO_REALTIME_SIGNALS_MODE`、`API_GO_GDELT_SNAPSHOT_MODE`、`API_GO_ARCHIVE_PREPARATION_WORKER_MODE`、`API_GO_ECONOMIC_DATA_WORKER_MODE` 都是「双端读同一变量」，顺序写错会出现双轮询/双消费；回退 legacy 会**恢复** Nest 基线缺陷（W-03 态势实时事件实际不推送、RT-03 负缓存缺失、RT-08 丢弃基址路径、R-01 的外部缓存前缀）。
6. **Telegram 租约是 Go 新机制**：混合期（Nest 持租约 + Go 订阅转交）只能超时退化，runbook 已要求先 api 后 api-go；删除 Nest 后不再有第二个 MTProto 使用者，但 `telegram-poll:v1` 转交频道与 `…-done:<id>` 回执属于新的跨实例协议，需要保留在部署文档里。
7. **只有 Nest 才写的数据**：`situation-monitor:external-snapshot:*` 已由 `gdeltsnapshot` 接管；`situationsignal*` Mongo 集合两侧同形（本批核过 insert/upsert 字段与 timestamps）；`situationMonitorSignals` 队列与 repeat key 两侧同格式。仍需确认的是 **Nest 的 `redis` 键 `situation-monitor:signals:telegram:state:v1` 历史值**能否被 Go 直接读取（本批核过字段与游标形状相同，但线上历史值未抽样）。
8. **监控的 Web 侧导入与迁移可能双写**（M-10/§3）：Web 会按 signature 逐条 POST localStorage 旧监控，与 Go 的 `ensureLegacyMigration` 并行；两者在同一用户锁内串行，但建议切流后抽查一个历史用户的 `SituationMonitorMonitor` 行数。
9. **invalidate 语义**：`insights` 前缀会清理**所有组织**的缓存与 learning-rev（§4.1/4.2，Nest 既有）。删 Nest 后该跨租户缓存失效副作用依然存在，若产品不接受，需要在 Go 侧改成按 org 段清理——这属新的行为变更，需要单独任务。
10. **事件桥与 namespace 必须同批**：`situation-monitor:signals:events:v1` 的发布侧属于 `API_GO_SITUATION_SIGNALS_WORKER_MODE`，消费侧属于 `API_GO_REALTIME_SOCKET_MODE`，两者不同值为 go 时态势实时更新不会到达浏览器（本窗口只核形状与互斥，传输层归其他窗口）。

## 7. 验证与提交

- 提交（基线 `dc48abc1`）：
  - `a7145183` `🐛 fix(archivepreparation): EA-01 按 BullMQ 退避策略延迟归档准备任务的重试`
  - `f2d76225` `🐛 fix(geo): RT-01 地理编码 query 长度按 UTF-16 码元校验与截断`（含 RT-09 注释修正）
  - `2766c573` `🐛 fix(situation): G-01 G-02 修正 Telegram channelSet 与 OREF 凭据的环境变量优先级`
  - `15b6fdd9` `🐛 fix(situation): W-01 轮询失败与守卫拒绝的错误写入缓存供读侧返回`
  - `e8d9ab20` `🐛 fix(situation): M-01/M-02/M-03/M-05/M-06 修正监控 preview 与 PATCH 的契约差异`
- 验证方式：`gofmt -l` 对 `situationsignals`、`situationsignalsworker`、`situationsettings`、`situationmonitors`、`geocoding`、`archivepreparationworker`、`realtimesignals`、`economicdata`、`archivereading` 均无输出；跨文件符号（`persistOrefAlerts`/`persistTelegramState`/`contentcatalog.LoadTaxonomy`/`llmembed.Client.RuntimeRerankModel`/`situationmonitors.NewService`）逐个核对调用点与签名。
- 明确未做的验证：未运行 `go build`/`go test`/`go vet`/`pnpm`/Docker/服务；未连接真实 Telegram、OREF、OpenSky、AIS relay、Nominatim、AkShare、LiteLLM、MySQL、Redis、Mongo；未验证多实例并发。所有正确性结论以普通 CI 的 `go test ./...` 与集成 job 为准。
