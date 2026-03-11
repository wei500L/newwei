# WorldMonitor Telegram OSINT + OREF + 直播视频 + Idle 自动暂停实现总结（复用导向）

## 1) 结论先看（可直接用于立项）

- Telegram OSINT 实时 feed 是“三层链路”：`Railway relay(GramJS/MTProto轮询)` -> `Vercel Edge proxy` -> `前端面板+调度器`。
- OREF 火箭警报同样是“三层链路”：`Railway relay(curl+住宅代理抓取)` -> `Vercel Edge proxy` -> `前端面板+轮询+告警分发`。
- 直播视频分为两类：
- `LiveNewsPanel`：新闻直播频道（YouTube + HLS混合，桌面端优先走本地 sidecar）。
- `LiveWebcamsPanel`：固定配置的 YouTube 网络摄像头网格（按地区 tab，含 Iran/Attacks 专用 2×2）。
- Idle 自动暂停不是“一个全局开关”，而是“面板级 + 可见性联动”：
- `LiveNewsPanel`：5 分钟无交互 -> 销毁播放器；恢复交互后自动拉起。
- `LiveWebcamsPanel`：5 分钟无交互或面板不可见 -> 销毁 iframe；恢复时重建。

## 2) 你提到的关键数字，当前代码实测值

> 以当前仓库代码为准（你本地时间 2026-03-02 检查）

- Telegram 频道：
- `data/telegram-channels.json` 的 `channels.full` 当前是 **26**（不是 27）。
- 该文件 `updatedAt` 为 `2026-02-23T18:37:10Z`。
- Webcam 网格：
- `LiveWebcamsPanel` 的 `WEBCAM_FEEDS` 当前是 **22 路**。
- 区域分布：`iran 4`、`middle-east 4`、`europe 5`、`americas 4`、`asia 5`。
- HLS：
- `DIRECT_HLS_MAP` 26 个 + `PROXIED_HLS_MAP` 1 个，合计 **27 个 HLS 映射键**。
- Full 变体默认 9 个直播频道中，命中 HLS 的是 **6 个**（`sky/euronews/dw/cnbc/france24/alarabiya`）。
- 结论：你说的“8+ HLS”在历史版本/README描述中成立，但当前实现已经扩展到更大的映射集。

## 3) Telegram OSINT 链路拆解

### 3.1 渠道配置（产品管理，不给终端用户改）

- 配置文件：`worldmonitor/data/telegram-channels.json`
- 支持 `channels.full | channels.tech | channels.finance` 三个桶。
- 当前只有 `full` 非空；`tech/finance` 为空。
- 每个频道可配置：`handle/label/topic/tier/region/enabled/maxMessages`。

### 3.2 Relay 采集（核心）

- 文件：`worldmonitor/scripts/ais-relay.cjs`
- 关键点：
- `TELEGRAM_ENABLED` 依赖 `TELEGRAM_API_ID + TELEGRAM_API_HASH`，其中 `TELEGRAM_SESSION` 应通过管理台授权流程保存到数据库。
- 轮询间隔默认 60s（`TELEGRAM_POLL_INTERVAL_MS`）。
- 单频道超时 15s，整轮超时 180s，卡死保护 3.5 分钟强制清 in-flight。
- 每频道按 `maxMessages` 拉取（1~50），并用 `minId` 做增量。
- 过滤媒体无文本消息（`if (!msg.message) mediaSkipped++`）。
- 文本截断到 800 字符（默认）。
- 全局去重（按 `${handle}:${msg.id}`）+ 时间排序 + 滚动保留 200 条。
- 容器重启时有 60s 启动延迟，避免 `AUTH_KEY_DUPLICATED`。

### 3.3 API 代理层（Edge）

- 文件：`worldmonitor/api/telegram-feed.js`
- 行为：
- `/api/telegram-feed` 转发到 relay 的 `/telegram/feed`。
- 支持 `limit/topic/channel` 查询参数。
- 支持 relay 鉴权透传（`RELAY_SHARED_SECRET`）。
- Edge 缓存 `max-age=10`（短缓存）。

### 3.4 前端消费层

- 文件：
- `worldmonitor/src/services/telegram-intel.ts`
- `worldmonitor/src/components/TelegramIntelPanel.ts`
- `worldmonitor/src/App.ts`
- `worldmonitor/src/app/data-loader.ts`
- 行为：
- 前端 service 内存缓存 TTL 30s。
- Panel 支持 topic tab：`all/breaking/conflict/alerts/osint/politics/middleeast`。
- App 调度器每 60s 刷一次 `loadTelegramIntel()`。
- `DataLoader` 负责取数并 `setData` 到面板。

## 4) OREF 火箭警报链路拆解

### 4.1 Relay 抓取（核心）

- 文件：`worldmonitor/scripts/ais-relay.cjs`
- 关键点：
- 开关：`OREF_ENABLED = !!OREF_PROXY_AUTH`。
- 源地址：
- 实时：`https://www.oref.org.il/WarningMessages/alert/alerts.json`
- 历史：`https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json`
- 使用 `curl + HTTP CONNECT 住宅代理`，不是 Node fetch（规避 Akamai/JA3 阻断）。
- 默认轮询 5 分钟（`OREF_POLL_INTERVAL_MS`）。
- 实时数据变化时写入 `history waves`（按拉取时刻入波）。
- 维护：
- `historyCount24h`（24h 告警覆盖量）
- `totalHistoryCount`
- 仅保留最近 7 天历史。

### 4.2 OREF 历史持久化（Redis）

- 文件：`worldmonitor/scripts/ais-relay.cjs`
- 行为：
- 启动先尝试从 Upstash Redis 恢复（Redis-first）。
- 失败/无数据再走 upstream 历史拉取（最多 3 次指数退避重试）。
- 持久化使用 version dirty-flag，避免无变化反复写入。
- 持久化最多 200 波（超出裁剪）。

### 4.3 API 代理层（Edge）

- 文件：`worldmonitor/api/oref-alerts.js`
- 行为：
- `/api/oref-alerts` 按 `?endpoint=history` 决定转 relay 的 `/oref/alerts` 或 `/oref/history`。
- alerts 缓存 5s；history 缓存 30s。
- relay 不可用时返回 `configured:false` 的降级结果。

### 4.4 前端消费 + 翻译 + 面板

- 文件：
- `worldmonitor/src/services/oref-alerts.ts`
- `worldmonitor/src/components/OrefSirensPanel.ts`
- `worldmonitor/src/app/data-loader.ts`
- 行为：
- 前端 service cache TTL 8s。
- 前端轮询 120s（`startOrefPolling`）。
- 支持两类翻译：
- 静态希伯来语词典替换。
- `translateText` 异步批量翻译（命中缓存后回调刷新）。
- 面板展示：
- 当前告警列表（最多 20）。
- 历史波次摘要（最多 50 波）。
- 24h 统计与 recent 标记。

### 4.5 告警联动（Breaking + CII）

- 文件：
- `worldmonitor/src/services/breaking-news-alerts.ts`
- `worldmonitor/src/services/country-instability.ts`
- 行为：
- OREF 告警会走 `dispatchOrefBreakingAlert()`，按 alert id 组合做去重。
- OREF 数据写入 CII：
- `ingestOrefForCII(alertCount, historyCount24h)`。
- 以色列冲突分数有 OREF 加权（即时与24h窗口）。

## 5) 直播视频实现（Live News + Webcams）

### 5.1 Live News：多源视频策略

- 文件：
- `worldmonitor/src/components/LiveNewsPanel.ts`
- `worldmonitor/src/services/live-news.ts`
- `worldmonitor/api/youtube/live.js`
- `worldmonitor/src-tauri/sidecar/local-api-server.mjs`
- 策略顺序：
- 默认频道（full/tech）先渲染。
- 命中 `DIRECT_HLS_MAP/PROXIED_HLS_MAP` 则优先 `<video>` 播 HLS。
- 否则走 YouTube（桌面端优先 sidecar `/api/youtube-embed`）。
- HLS 错误进入 5 分钟 cooldown，之后回退 YouTube。
- 桌面端 sidecar 提供：
- `/api/hls-proxy`：给特定 host 做 HLS 代理并重写 manifest。
- `/api/youtube-embed`：本地 origin iframe bridge，规避 YouTube 对 `tauri://` 的限制。

### 5.2 频道管理能力（可选频道 + 自定义）

- 文件：`worldmonitor/src/live-channels-window.ts`
- 能力：
- 可选频道按地区 tab 分类（NA/EU/LATAM/ASIA/ME/AFRICA/OC）。
- 支持拖拽排序、恢复默认、增删频道。
- 支持输入 YouTube handle 或 URL，先经 `/api/youtube/live` 校验后入库。

### 5.3 Live Webcams：22 路地区网格

- 文件：`worldmonitor/src/components/LiveWebcamsPanel.ts`
- 实现要点：
- 数据源是硬编码 `WEBCAM_FEEDS`（22 条）。
- 默认 region 是 `iran`，grid 模式最多 4 格（`MAX_GRID_CELLS=4`）。
- 所以 Iran/Attacks 天然是专用 2×2（4 路）。
- region tab：`IRAN ATTACKS / ALL / MIDEAST / EUROPE / AMERICAS / ASIA`。
- `ALL` 网格不是前 4 条，而是固定战略 4 点：`jerusalem/tehran/kyiv/washington`。

## 6) Idle 自动暂停机制（你重点关注）

### 6.1 LiveNewsPanel（播放器级）

- 文件：`worldmonitor/src/components/LiveNewsPanel.ts`
- 机制：
- 监听用户活动：`mousedown/keydown/scroll/touchstart/mousemove`。
- 5 分钟无活动触发 `pauseForIdle()`：
- 记录 `wasPlayingBeforeIdle`。
- 把 `isPlaying` 置 false。
- `destroyPlayer()` 释放 iframe/YouTube/native video。
- 页面从 hidden 回到 visible 或用户重新活动时：
- `resumeFromIdle()` 自动恢复并 `initializePlayer()`。

### 6.2 LiveWebcamsPanel（iframe级）

- 文件：`worldmonitor/src/components/LiveWebcamsPanel.ts`
- 机制：
- `IntersectionObserver` 检测面板可见性。
- 不可见就 `destroyIframes()`；可见再渲染。
- 5 分钟无活动置 `isIdle=true`：
- 销毁全部 iframe。
- 显示 `Webcams paused — move mouse to resume`。
- 一旦活动恢复，自动重渲染。

### 6.3 全局 Idle（非视频专用）

- 文件：`worldmonitor/src/app/event-handlers.ts`
- 全局还有一个 2 分钟 idle，仅用于暂停动画类负载（`animations-paused`），不是直播播放器暂停主逻辑。

## 7) 复用到你当前项目的建议落地

### 7.1 最小可复用模块拆分

- 后端采集层（建议独立服务）：
- Telegram 轮询 worker（GramJS + 增量 cursor + 去重 + 滚动缓存）。
- OREF 轮询 worker（curl+proxy + 历史波次 + Redis 持久化）。
- API 网关层：
- `/api/telegram-feed`
- `/api/oref-alerts`（支持 history endpoint）
- `/api/youtube/live`（频道直播检测）
- 前端层：
- TelegramPanel（topic tabs + 60s调度）
- OrefPanel（当前告警 + 历史波次）
- LiveNewsPanel（HLS优先 + YouTube fallback）
- LiveWebcamsPanel（地区tab + 2×2 grid）
- 桌面 sidecar（如你有桌面端）：
- `/api/hls-proxy`
- `/api/youtube-embed`

### 7.2 迁移时建议保持的参数

- Telegram：
- poll 60s、channel timeout 15s、cycle timeout 180s、startup delay 60s。
- frontend cache 30s、edge cache 10s。
- OREF：
- relay poll 300s、frontend poll 120s、frontend cache 8s。
- alerts/history edge cache 5s/30s。
- Video/Idle：
- idle pause 5 分钟。
- visibility + intersection observer 双判定。

### 7.3 需要先修正/注意的现有实现点（避免照搬问题）

- README 与当前频道配置有偏差：
- README 多处写 27，代码当前是 26（以 `telegram-channels.json` 为准）。
- OREF 前端回调有重复注册风险：
- `onOrefAlertsUpdate` 是 push-only，`loadIntelligenceSignals` 周期触发时会重复叠加回调。
- Webcam 的 `channelHandle` 目前未参与运行时探测，仅用 `fallbackVideoId` 直接嵌入。
- `fetchLiveVideoInfo` 返回的 `hlsUrl` 当前在 `LiveNewsPanel` 主播放路径没有直接消费（主要靠静态 HLS map 决策）。

## 8) 你可以直接抄的“架构骨架”

```text
[Telegram/OREF Worker]
  -> in-memory state + redis persistence
  -> expose /telegram/feed, /oref/alerts, /oref/history

[Edge/API Layer]
  -> auth/cors/cache wrapping
  -> frontend-friendly JSON contracts

[Frontend Scheduler]
  -> Telegram 60s
  -> OREF init + 120s polling callback
  -> hidden-tab aware refresh scheduler

[Video Panels]
  -> LiveNews: HLS-first + YouTube fallback + sidecar bridge
  -> Webcams: region tabs + 2x2 grid + idle/visibility destroy/rebuild
```

---

## 9) 关键代码索引（便于你二次阅读）

- Telegram 配置与采集：
- `worldmonitor/data/telegram-channels.json`（`updatedAt`、channel 列表）
- `worldmonitor/scripts/ais-relay.cjs:236-239`（Telegram 轮询参数）
- `worldmonitor/scripts/ais-relay.cjs:265`（`loadTelegramChannels`）
- `worldmonitor/scripts/ais-relay.cjs:377`（`pollTelegramOnce`）
- `worldmonitor/scripts/ais-relay.cjs:481`（startup delay）
- `worldmonitor/scripts/ais-relay.cjs:3051`（`/telegram` endpoint）
- `worldmonitor/api/telegram-feed.js:47`（转发 `/telegram/feed`）
- `worldmonitor/src/services/telegram-intel.ts:38`（前端 cache TTL）
- `worldmonitor/src/App.ts:618-623`（60s 刷新调度）

- OREF 采集与历史：
- `worldmonitor/scripts/ais-relay.cjs:77-81`（OREF env/interval 开关）
- `worldmonitor/scripts/ais-relay.cjs:560`（`orefFetchAlerts`）
- `worldmonitor/scripts/ais-relay.cjs:666`（Redis 持久化上限）
- `worldmonitor/scripts/ais-relay.cjs:696`（Redis-first + upstream fallback）
- `worldmonitor/scripts/ais-relay.cjs:755`（`startOrefPollLoop`）
- `worldmonitor/scripts/ais-relay.cjs:3303`（`/oref/alerts`）
- `worldmonitor/scripts/ais-relay.cjs:3315`（`/oref/history`）
- `worldmonitor/api/oref-alerts.js:60`（edge 转 relay）
- `worldmonitor/src/services/oref-alerts.ts:37`（前端 cache TTL 8s）
- `worldmonitor/src/services/oref-alerts.ts:287-291`（前端 120s 轮询）
- `worldmonitor/src/services/breaking-news-alerts.ts:160+`（OREF breaking alert）

- 视频与 idle：
- `worldmonitor/src/components/LiveNewsPanel.ts:60`（默认频道）
- `worldmonitor/src/components/LiveNewsPanel.ts:177`（`DIRECT_HLS_MAP`）
- `worldmonitor/src/components/LiveNewsPanel.ts:208`（`PROXIED_HLS_MAP`）
- `worldmonitor/src/components/LiveNewsPanel.ts:472-500`（idle 检测 + pause）
- `worldmonitor/src/components/LiveNewsPanel.ts:568`（idle 恢复）
- `worldmonitor/src/components/LiveWebcamsPanel.ts:20-48`（22 路 feed）
- `worldmonitor/src/components/LiveWebcamsPanel.ts:51`（`MAX_GRID_CELLS=4`）
- `worldmonitor/src/components/LiveWebcamsPanel.ts:117`（ALL 战略 4 点）
- `worldmonitor/src/components/LiveWebcamsPanel.ts:349`（IntersectionObserver）
- `worldmonitor/src/components/LiveWebcamsPanel.ts:365-389`（idle pause + placeholder）
- `worldmonitor/src-tauri/sidecar/local-api-server.mjs:947`（`/api/hls-proxy`）
- `worldmonitor/src-tauri/sidecar/local-api-server.mjs:1005`（`/api/youtube-embed`）

---

## 10) 基于当前项目状态的复用优化建议（新增）

### 10.1 先看你项目里“已具备的复用底座”

- 后端模块基础已就绪：
- `apps/api/src/app.module.ts` 已接入 `QueueModule`、`AlertsModule`、`SituationMonitorModule`、`NewsAggregatorModule`、`WebSocketModule`。
- 队列与可观测性基础已就绪：
- `apps/api/src/modules/queue/queue.module.ts` 已有 BullMQ 连接、重试、指数退避和事件发布。
- `apps/api/src/modules/queue/queue-admin.module.ts` 已接 Bull Board（可直接观察新 job）。
- 告警链路已就绪：
- `apps/api/src/modules/alerts/alerts.module.ts` + `apps/api/src/modules/alerts/providers/metric-provider.ts` 已支持可扩展 MetricProvider。
- 前端承载容器已就绪：
- `apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx` + `apps/web/store/situation-monitor-layout.ts` 已是可扩展多 panel 容器。
- 当前监控缓存节奏明确：
- `apps/api/src/modules/situation-monitor/situation-monitor.service.ts` 当前 `core=45s`、`external=300s`，已是“重轻分层”结构。
- 前端状态持久化已就绪：
- `apps/web/app/(app)/components/user-ui-settings-sync.tsx` 已把 `monitors/layout/settings` 与 `user-settings/ui/situation-monitor` 双向同步。
- 权限模型已就绪：
- `packages/config/src/rbac.ts` 已包含 `items.read`、`alerts.read`、`alerts.manage`、`queue.manage`。

### 10.2 WorldMonitor 组件 -> 本项目推荐落点（按当前结构）

| WorldMonitor 组件  | 本项目推荐落点                                                   | 复用策略                                                      | 避免事项                                                    |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Telegram 实时 feed | `apps/api` 新增轻量接口（建议挂在 `situation-monitor` 语义域下） | 用 `QueueModule` 跑 60s 轮询 worker，结果写缓存并提供只读 API | 不要把 60s 刷新塞进现有 `situation-monitor/insights` 大接口 |
| OREF 告警/历史     | 同上 + `AlertsModule`                                            | 5 分钟抓取 + 历史持久化，关键告警映射到 Alerts                | 不要从浏览器直连 OREF upstream                              |
| Breaking/通知分发  | `AlertsService` + `NotificationsService`                         | 复用已有 `alerts.read/manage` 与通知中心                      | 不要单独再造一套告警中心                                    |
| 实时推送           | 复用 `newsnow/notifications/queue` 的 Gateway 模式               | 参考 `registerListener -> unsubscribe` 生命周期管理           | 不要无清理地反复注册回调                                    |
| Webcam/直播 panel  | `situation-monitor` 新 panel + layout/store                      | 复用现有 panel 布局、preset、UI 同步机制                      | 不要单独做平行页面导致状态割裂                              |
| Idle 自动暂停      | 前端公共 hook（页面可见性 + IntersectionObserver + 活动检测）    | 面板级销毁/重建 iframe/video，5 分钟 idle                     | 不要只做 CSS 隐藏（资源仍在跑）                             |

### 10.3 三阶段落地（结合你当前仓库）

#### Phase 1：后端采集与接口（先跑通数据链路）

- 任务：
- 新增 Telegram/OREF ingest worker（基于 `QueueModule`）。
- 提供轻量 API（建议独立于 `situation-monitor/insights`）：如 `GET /situation-monitor/telegram-feed`、`GET /situation-monitor/oref-alerts`、`GET /situation-monitor/oref-history`。
- 做缓存分层：worker 内存态 + Redis/CacheService 快照。
- 验收标准：
- Bull Board 可见 worker 任务、失败重试、回退路径。
- API 在 upstream 不可用时返回 `configured:false` 或降级空数据，而不是 5xx 崩溃。
- `items.read` 用户可读；无权限用户被正确拒绝。

#### Phase 2：前端面板接入（先复用现有监控工作台）

- 任务：
- 在 `apps/web/store/situation-monitor-layout.ts` 扩展 panel id（示例：`telegram-feed`、`oref-alerts`、`live-webcams`）。
- 在 `situation-monitor-content.tsx` 注入新 panel 渲染和轻量轮询（Telegram 60s、OREF 120s）。
- 复用 `user-ui-settings-sync.tsx` 现有同步链路，不新增状态持久化协议。
- 验收标准：
- 面板显示/隐藏、布局调整、刷新后状态保持一致。
- 不影响现有 `insights` 核心刷新节奏（仍以 5 分钟为主）。

#### Phase 3：实时与告警中心联动（提升时效和可操作性）

- 任务：
- 新增实时 dispatcher（模式对齐 `newsnow-realtime.dispatcher.ts`）。
- OREF 高优先事件接入 Alerts（可新增 metric provider 或复用 system_event 语义）。
- 前端复用现有 socket hook 模式（`use-newsnow-stream.ts` / `use-notification-stream.ts`）。
- 验收标准：
- 实时事件与轮询结果一致，不重复、不乱序。
- OREF 严重事件能在 Alert Center 看到，并可按既有权限进行处理。

### 10.4 关键优化建议（基于当前实现细节）

- 轮询分层优化：
- 现在 `situation-monitor-content.tsx` 的主数据是 5 分钟周期；Telegram/OREF 请做“面板级轻轮询”，不要降低整页刷新周期。
- 缓存分层优化（建议）：
- worker 层：2~5s 去抖更新；
- API 层：Telegram 10~15s、OREF alerts 5~8s、history 30s；
- 前端层：Telegram 20~30s、OREF 8~15s；
- `insights` 主链路继续保持 core/external 分层策略。
- 回调生命周期优化：
- 统一采用 `registerListener` 返回 `unsubscribe` 的模式；React 侧确保 `useEffect` cleanup 完整解绑，防止重复订阅。
- 容错优化：
- 采集失败使用指数退避 + 熔断窗口；恢复后自动回切。
- 对上游异常返回“部分可用”数据，不阻塞整个 Situation Monitor 页面。
- 安全与权限优化：
- 读侧默认 `items.read`；告警运营能力走 `alerts.read/manage`；队列运维能力走 `queue.manage`。

### 10.5 与 WorldMonitor 的差异化取舍（当前项目建议）

- 先不上桌面 sidecar：
- 当前 `apps/web` 是 Next.js 控制台，无 Tauri 侧车上下文；第一期先做 Web 可用版本（YouTube iframe + 可选 HLS）。
- HLS 先补依赖再增强：
- 当前 `apps/web/package.json` 未引入 `hls.js`；建议 Phase 2 先做可播放兜底，Phase 3 再引入 HLS 优先策略。
- 告警模型优先复用：
- 你已有成熟 `AlertRule/AlertEvent/AlertDelivery` 数据模型，优先把 OREF 事件映射进去，而不是新建平行表。

## 11) 立即可执行的最小任务清单（建议顺序）

1. 在 `apps/api` 增加 Telegram/OREF ingest worker（复用 `QueueModule`）。
2. 新增 3 个轻量接口：`telegram-feed`、`oref-alerts`、`oref-history`（与 `insights` 解耦）。
3. 在 `situation-monitor-layout.ts` 增加 2~3 个新 panel id 与默认布局。
4. 在 `situation-monitor-content.tsx` 挂接 panel 组件与独立轻轮询。
5. 将 OREF 高优先事件接入 `AlertsService`，在 `alert-center.tsx` 验证可见性。
6. 增加“重复订阅回归测试”：验证多次进入/离开页面不会叠加监听器。
