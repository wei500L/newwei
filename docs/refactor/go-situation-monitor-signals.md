# 态势监控信号读取与反馈 7 条 HTTP 迁入 Go

> 分支 `refactor/go-situation-monitor-signals` · 基线 `39ad5b55adb07c48ecd197816039cba8316780c4`（main，CI success）
> 开关 `API_GO_SITUATION_MONITOR_SIGNALS_MODE` · 默认 `legacy` · 回滚只改这一个变量
> 实现 `apps/api-go/internal/situationsignals/` · 路由 `apps/api-go/internal/legacyproxy/situation_signals_routes.go` · 接线 `apps/api-go/cmd/api/situation_signals.go`

## 0. 路由表

| # | 方法 | 路径 | 权限 | 成功码 | Nest 实现 |
|---|------|------|------|--------|-----------|
| 1 | GET | `/api/situation-monitor/catalog`（精确） | `items.read` | 200 | `controller.catalog` |
| 2 | POST | `/api/situation-monitor/feedback`（精确） | `items.write` | **201** | `feedback.recordFeedback` |
| 3 | GET | `/api/situation-monitor/refresh-runs/:refreshId`（恰好一段） | `items.read` | 200 / 404 | `refresh.getRefreshRun` |
| 4 | GET | `/api/situation-monitor/telegram-feed`（精确） | `items.read` | 200 | `signals.getTelegramFeed` + `monitors.augmentTelegramFeed` |
| 5 | GET | `/api/situation-monitor/oref-alerts`（精确） | `items.read` | 200 | `signals.getOrefAlerts` + `augmentOrefAlerts` |
| 6 | GET | `/api/situation-monitor/oref-history`（精确） | `items.read` | 200 | `signals.getOrefHistory` + `augmentOrefHistory` |
| 7 | GET | `/api/situation-monitor/live-hls-proxy-config`（精确） | `items.read` | 200 | `settings.getLiveHlsProxyRuntimeConfig` |

处理器注册键 `legacyproxy.SituationSignalsKey = "/api/situation-monitor#signals"`，与
`SituationMonitorsKey = "/api/situation-monitor/monitors"` 刻意不同：两个开关互不抢占，
同路径 `OPTIONS` 由 Go 回答（`cors.FinishOptions` 先于鉴权）。

**继续回落 NestJS 的路径**（`proxy_test.go` 有断言）：

- `GET /api/situation-monitor/insights`（重分析域，不迁）
- `GET/POST /api/situation-monitor/monitors**`（属于既有开关 `API_GO_SITUATION_MONITORS_MODE`）
- `POST /api/situation-monitor/refresh`（触发实网抓取与队列）
- `GET /api/system-settings/realtime-signals/runtime`（ADSB/AIS/opensky 深水区）
- 上表路径的其他方法、带尾斜杠（`/catalog/`）、多一段（`/refresh-runs/x/y`）
- `/refresh-runs`（无尾斜杠，没有动态段）

## 1. 开关语义

- 只接受空串、`legacy`、`go`。空串等价 `legacy`，默认 `legacy`。其他值启动失败，错误文本
  一字不差：`API_GO_SITUATION_MONITOR_SIGNALS_MODE must be one of legacy|go`。
- `go` 时必须有 `JWT_SECRET`、`DATABASE_URL`、`REDIS_HOST`、`MONGO_URI`（复用
  `config.appendAuthRequirements` 先例 + 一条 `MONGO_URI` 要求）。缺任一项启动失败：
  - `JWT_SECRET is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go`
  - `DATABASE_URL is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go`
  - `REDIS_HOST is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go`
  - `MONGO_URI is required when API_GO_SITUATION_MONITOR_SIGNALS_MODE=go`
- `legacy`（含空串）不追加任何路由规则、不注册 handler、不额外打开 Mongo 连接。
- 生产入口仍是 Web → NestJS；canary 保持关闭；不启用 shadow；不改前端；不改其他
  `API_GO_*` 默认值。回滚 = 把该变量改回 `legacy`。
- 身份在 Go 侧独立完成：HS256 验签 → Redis 撤销名单（fail-closed）→ MySQL
  membership/权限重推导；`mtk_` 机器令牌走 `MachineAccessToken.tokenHash` 的 SHA-256 查表
  （未撤销、未过期、`Org.isActive`，更新 `lastUsedAt`），权限与 orgId 来自令牌行。JWT 的
  `permissions` claim 一律不读。失败顺序与 NestJS 一致：401 → 403 → 400 → 404。

## 2. Redis 键与 TTL

| 键 | TTL | 写入方 | 本批读取用途 |
|---|---|---|---|
| `situation-monitor:signals:telegram:state:v1` | 24h | Nest Telegram 轮询器（Go 在 channelSet 失配时回写清空态） | `GET /telegram-feed` |
| `situation-monitor:signals:oref:alerts:v1` | 写入方 1h（Go 只读） | Nest OREF 轮询器 | `GET /oref-alerts`、以及两个 OREF 响应的 `lastPollAt` |
| `situation-monitor:signals:oref:history:v1` | 写入方 7d（Go 只读） | Nest OREF 轮询器 | `GET /oref-history`、`historyCount24h`/`totalHistoryCount` |
| `situation-monitor:refresh-run:<refreshId>` | 900s | Nest `POST /refresh`（Go 只回写 `terminal` 一位） | `GET /refresh-runs/:refreshId` |
| `situation-monitor:insights:learning-rev:v1:<orgId>` | 90 天 | 两侧 `recordFeedback`（INCR，仅首次设 TTL） | `POST /feedback` |
| `situation_monitor:settings` | 30s | 两侧 `loadStoredSettings`（信封 `{exists, value?}`） | `catalog` / `telegram-feed` / `live-hls-proxy-config` |

`POST /feedback` 的 Mongo 写入：`situationsignalfeedbacks` 插入一条；`situationsignallearningstates`
按 `{orgId, signalType, signalId}` upsert（`$setOnInsert` + `$inc` + 条件 `$addToSet`）。

## 3. 监控匹配管线与降级语义

`telegram-feed` / `oref-alerts` / `oref-history` 顶层追加 `monitorMatches`，逐段移植
`situation-monitor-monitors.service.ts`：

1. 候选为空 → `[]`。监控行按 `orgId AND userId` 读取（先跑 legacy 迁移），只保留
   `enabled`。**跨用户/跨租户的监控绝不出现在结果里。**
2. 所有监控都没有 `queryEmbeddingVector` → 直接空 Map，**不发起任何模型调用**。
3. 候选向量按 96 一批调 `llmembed.Embed`（meta：`situation-monitor-monitors` /
   `candidate-embedding`），任何失败或空结果 → 整批回退空 Map（丢弃前面已累积的批次，
   与 TS 的 `catch { return new Map() }` 一致），随后按 lexical 规则继续匹配。
4. `geoStatus === "conflict"` 硬排除；短名单 `dot ≥ 0.68` 降序取前 8；rerank
   （`monitor-rerank`）结果 min-max 归一（`max == min → 1`），失败 → 空 Map。
5. include 规则：`explicit.reasons 非空 || (rerank 非空 && rerank ≥ 0.55) ||
   (rerank 空 && semantic 非空 && semantic ≥ 0.82)`。
6. `finalScore = clamp01(baseScore + (semantic ?? 0) * 0.15 + (rerank ?? 0) * 0.2)`，输出
   `roundScore`（3 位小数）。
7. 条件键：`link` 与 `title` **总是存在**（falsy → `""`）；`itemMetaId`/`monitorColor`/
   `titleZh`/`summaryZh`/`summary`/`category` falsy 时省略键；`matchedTerms` 去重后取前 8。
8. 排序：`timestamp` 降序 → `score` 降序 → `monitorName` 升序（`localeCompare` 用
   `golang.org/x/text/collate` 的 English collator，照 `dashboardcharts/dataviz.go` 先例）。

**降级语义（重要）**：CI 无 LiteLLM 时 `llmembed.Embed` 必须失败并走 lexical 回退，与
Nest 在同一环境的行为一致——**不得伪装成语义匹配成功**。语义 / rerank 命中的路径在 CI
未验证（见 §6）。

## 4. 已知差异与刻意保留的行为

1. **Nest 进程内状态可能领先 Redis 一个轮询周期**：Nest 的 Telegram/OREF 缓存优先使用
   进程内状态（`restoreCachedTelegramState` 在 `items.length > 0` 时直接返回），Go 每次
   请求都读 Redis。因此刚完成一次轮询、尚未落盘时两侧可能不同；落盘后一致。
2. **Nest 还有一个不落盘的 `channels` 列表**参与 channelSet 失配时的 `hasCachedState`
   判定；Go 没有该列表，`hasCachedState` 只看 items / lastPollAt / cursorByHandle。
3. **无缓存时 OREF 的 `timestamp` 是当前时间**（`new Date().toISOString()`），非确定；
   smoke 一律用已 seed `lastPollAt` 的状态做逐字节比对。
4. **`/live-hls-proxy-config` 的重复 `channel` 参数**：控制器用 `@Query("channel")`，express
   会把重复参数变成数组，`channel?.trim()` 对数组抛 TypeError（500）。规格要求「非字符串 →
   `normalized = undefined`」，Go 因此返回未配置分支（200）。这是按规格的有意差异，未被
   smoke 覆盖。
5. **畸形缓存元素**：`warnings` 元素不是对象、缓存 item 缺 `text`、`items` 元素不是对象等
   情况下，Nest 会抛 TypeError（500），Go 取零值继续（200）。Go 侧更宽容，刻意保留。
6. `export.go` 适配：`situationmonitors.LoadEnabledMonitors` 直接包装既有私有实现
   （`ensureLegacyMigration` → `listRows` → `mapRow`），没有复刻行归一化逻辑，因此不存在
   与 monitors 包漂移的可能；该文件是 `situationmonitors` 包本批唯一允许的新增文件。
7. Go 侧的计数把 Nest 的 12 条 `... IN (activeSourceIds)` 查询换成每张表一条
   `GROUP BY sourceId, status` 再在 Go 里按 active 集合求和（`database/sql` 只接受变长参数
   列表，本包不使用无类型切片）。结果逐条等价，NULL/外部 sourceId 与 `IN` 一样被排除。
8. 设置里的国家表（`canonicalizeGeoValue` / `extractGeoCountryAlpha2`）复用已迁的
   `internal/contentsubscriptions` 导出表；`extractCountryCodeFromText` 的「别名/全名子串
   扫描」部分收窄为精确 token 查找（国家名、alpha2/alpha3、US/UK 缩写均覆盖）。

## 5. 缺陷修复

`docs/refactor/bug-ledger.md` 的 `SMSIG-01`（S1）与 `SMSIG-02`（S2）：Nest 与 Go 两侧同修，
证据均为基线 `39ad5b55` 的行号。

## 6. 验收与已/未验证清单

- CI：lint、typecheck、web 覆盖率、vector 测试、API vitest、OpenAPI 快照、auth-matrix
  快照、`@modular/api-go` go test（未改控制器，前两者应无漂移）。
- smoke：`.github/workflows/api-go-situation-monitor-signals-smoke.yml`（阶段 0 seed →
  阶段 1 Go 接管对比 → 阶段 2 S1/S2 回归 → 阶段 3 停 Nest）。
- **已由 smoke 覆盖**：7 条路由的 Nest/Go 逐字节等价（省略键断言）、权限与失败顺序、
  跨租户与跨用户隔离、refresh-run 12 个计数与状态机、telegram 的 topic/channel/limit
  边界、OREF 两份缓存的时间戳与计数、HLS 三分支、feedback 的 Mongo/学习态/Redis rev 断言、
  停 Nest 后 7 条仍 200 与三条未迁路径 502、与 `API_GO_SITUATION_MONITORS_MODE` 同时为
  `go` 时互不抢占。
- **CI 未验证**：语义 / rerank 命中路径（无 LiteLLM，两侧同环境降级；smoke 只验证「带假
  向量监控时 Embed 失败 → lexical 回退且无 500」）。
- **未做**：真实 Telegram/OREF 上游请求（本批不发）；`insights`、`POST /refresh`、
  `realtime-signals/runtime` 的迁移；前端改动；canary/shadow 启用；生产流量切换。
