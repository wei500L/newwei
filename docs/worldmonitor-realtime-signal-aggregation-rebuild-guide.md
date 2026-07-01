# WorldMonitor 实时信号聚合实现拆解与复现指南

## 1. 目标与范围

本文聚焦 WorldMonitor 的 8 条实时信号链路，目标是帮助你在当前项目中按“可运行、可扩展、可降级”的方式复现：

1. 军事飞行（OpenSky）
2. 船舶（AIS）
3. 抗议（ACLED + GDELT）
4. 互联网中断（Cloudflare Radar）
5. 关键词激增（Keyword Spike）
6. PizzINT DEFCON
7. GDELT 双边紧张指数
8. Polymarket 领先指标（Prediction Leads News）

本文基于代码实现解读，不是产品层面描述。

## 2. 总体架构（先看这个）

WorldMonitor 的实时聚合不是“单一后端流式管道”，而是**前端编排 + 多源拉取 + 多层缓存 + 相关性二次信号生成**。

核心分层：

1. **上游数据源层**  
   OpenSky、AIS Relay、ACLED、GDELT、Cloudflare、Polymarket、PizzINT。

2. **服务端适配层（BFF / RPC）**  
   `api/[domain]/v1/[rpc].ts` 统一路由到 `server/worldmonitor/**` handler，做缓存、鉴权、降级、错误映射。  
   另有 `/api/opensky`、`/api/ais-snapshot`、`/api/polymarket` 这类直接代理端点。

3. **客户端 service 层**  
   `src/services/**` 做协议适配、回退策略、断路器缓存、数据形态转换。

4. **前端编排层**  
   `DataLoaderManager` 负责拉取、注入地图/面板、写入 `signalAggregator`、触发 `runCorrelationAnalysis`。

5. **二次分析层**  
   `analysis-core.ts` 把“原始流”转换成“情报信号”（如 `prediction_leads_news`、`keyword_spike`）。

## 3. 调度与刷新节奏（决定“实时感”）

主要调度在 `App.setupRefreshIntervals()`：

- 新闻：15 分钟
- Predictions：10 分钟
- PizzINT：10 分钟
- AIS（地图层）：10 分钟（但 AIS service 内部自身是 5 分钟轮询）
- Full variant 的 `intelligence` 总刷新：15 分钟（含 outages/protests/military 等）

隐藏标签页时，`RefreshScheduler` 会做退避与抖动；AIS 还会单独暂停轮询。

---

## 4. 八条信号链路拆解

## 4.1 军事飞行（OpenSky）

### 数据入口

- 客户端主路径：`src/services/military-flights.ts`
- 代理端点：`api/opensky.js` -> `${WS_RELAY_URL}/opensky`
- 服务器 RPC 备选路径：`server/worldmonitor/military/v1/list-military-flights.ts`

### 关键实现

1. **区域拉取**  
   使用固定 bbox 区域（`MILITARY_QUERY_REGIONS`）批量请求 OpenSky，而不是全球全量拉。

   当前项目实现里，军机链路使用 OpenSky REST `GET /states/all`，并通过 OAuth2 client credentials 获取 access token。

2. **军机识别规则**  
   `isMilitaryFlight()` 同时用：

- callsign 模式（军方前缀）
- ICAO hex 军用区段
- 国家 + 扩展 callsign 正则

3. **结构化转换**  
   OpenSky state array 转 `MilitaryFlight`（高度、速度单位换算，track 历史保留）。

   当前项目对上游继续暴露兼容字段：`icao24/callsign/lat/lng/heading/altitudeFt/groundSpeedKt/observedAt/sourceUpdatedAt`；`registration/aircraftType` 允许为空。

4. **增强（可选）**  
   如果 Wingbits 可用，按 hex 批量补充 owner/operator/typecode，并提升置信度。

5. **聚类**  
   基于热点区域（INDO-PACIFIC/CENTCOM/EUCOM/ARCTIC）做聚类输出。

### 缓存与降级

- 本地 flight cache：15 分钟
- 当前项目在 OpenSky 上游前新增了本地 credits 预算统计。预算按香港时间自然日汇总，默认上限为 `4000 credits/day`。
- 军事快照默认采用香港时间双档调度：`08:00-22:00` 每 10 分钟轮询，`22:00-08:00` 每 30 分钟轮询。
- 当日剩余额度低于 `20%` 时，会自动阻断 War Map 的 `all` 模式；低于 `10%` 时，军事快照强制降到夜间频率；额度耗尽后暂停新的军事上游请求，直到下一个香港自然日。
- 区域 stale fallback：10 分钟（单区域失败可回退旧数据）
- circuit breaker：失败 3 次，冷却 5 分钟

### 在聚合中的位置

`DataLoader` 会把 flights + vessel 合并进 `intelligenceCache.military`，并喂给：

- `signalAggregator.ingestFlights()`
- `ingestMilitaryForCII()`
- `analyzeFlightsForSurge()`（额外告警）

### 复现建议

先复现“OpenSky -> 规则识别 -> 缓存 -> 聚类”闭环，再接 Wingbits；否则复杂度会陡增。

---

## 4.2 船舶（AIS）

这条链路有两层：

1. 航运扰动（AIS disruptions + density）
2. 军事舰船识别（从 AIS 候选报告中再筛）

### 4.2.1 航运扰动主链

- 客户端：`src/services/maritime/index.ts`
- 代理：`api/ais-snapshot.js`
- RPC fallback：`server/worldmonitor/maritime/v1/get-vessel-snapshot.ts`

实现路径：

1. 优先请求 `/api/ais-snapshot?candidates=false`
2. localhost 下尝试直连 relay / 本地 `3004`
3. 再失败走 proto `getVesselSnapshot`

解析后得到两类结果：

- `disruptions`（如 gap_spike / chokepoint_congestion）
- `density`（密度区）

### 4.2.2 轮询与可见性优化

- AIS 快照轮询：5 分钟
- 视图 stale 判定：6 分钟
- 标签页 hidden 时暂停轮询，恢复时防并发重入

### 4.2.3 军事舰船链（AIS 派生）

- `src/services/military-vessels.ts` 通过 AIS callback 接 candidate reports
- 用 MMSI 模式 + 已知舰名 + AIS shipType 识别军政船
- 检测“暗船”：同一 MMSI 超过 60 分钟空窗后返回
- 可与 USNI Fleet 报告非阻塞合并

### 缓存与降级

- maritime snapshot breaker：10 分钟
- server in-memory snapshot：5 分钟 + in-flight 去重
- military vessel 本地缓存 30 秒（避免 UI 高频抖动）

### 复现注意

`disruptions/density` 的上游“如何计算”不在本仓库内（在 relay 侧）。  
这里可确认的是**消费协议与轮询编排**，而非完整检测算法。  
这点属于基于代码边界的明确推断。

---

## 4.3 抗议（ACLED + GDELT）

### 入口与组合

- 客户端：`src/services/unrest/index.ts`
- 服务端：`server/worldmonitor/unrest/v1/list-unrest-events.ts`
- ACLED 共享层：`server/_shared/acled.ts`

### 关键实现

1. **ACLED 拉取**

- 事件类型固定 `Protests`
- 默认窗口近 30 天
- 缓存 15 分钟（共享缓存层，避免多 handler 重复打 ACLED）

2. **GDELT 拉取**

- `geo/geo?query=protest&format=geojson&timespan=7d&maxrecords=250`
- 过滤低噪：`count < 5` 丢弃
- 按 location name 去重

3. **融合去重**

- 键：`round(lat, 0.1) + round(lon, 0.1) + date`
- ACLED 优先（高置信）
- 双 GDELT 记录会合并 source，并在 source>=2 时提升置信度

4. **排序**

- 先 severity，再 recency

### 缓存与降级

- `unrest:events:v1:*` Redis TTL 900s
- 任一源失败返回空数组，不阻塞另一源
- 客户端 `acledConfigured` 采用启发式（true/false/null）

### 复现建议

重点复刻“共享 ACLED 缓存层 + 跨源去重键”，这是稳定性与成本关键。

---

## 4.4 互联网中断（Cloudflare）

### 入口

- 客户端：`src/services/infrastructure/index.ts` 的 `fetchInternetOutages()`
- 服务端：`server/worldmonitor/infrastructure/v1/list-internet-outages.ts`

### 关键实现

1. 调 Cloudflare Radar 注释接口：

- `https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&limit=50`
- 依赖 `CLOUDFLARE_API_TOKEN`

2. 地理映射：

- 用 `locations[0]` 国家码映射到静态国家质心 `COUNTRY_COORDS`

3. 严重度映射：

- `NATIONWIDE -> total`
- `REGIONAL -> major`
- 其他 -> `partial`

4. 富化：

- categories 拼接 outageCause/outageType/ASN 名称

### 缓存与降级

- Redis TTL 1800s
- 内存 fallback 缓存（上次成功）用于 upstream 失败时兜底
- 客户端 breaker 30 分钟 + hydration

---

## 4.5 关键词激增（Keyword Spike）

### 入口

- `src/services/trending-keywords.ts`
- 注入点：`DataLoader.loadNewsCategory()`、`rss.ts` 调用 `ingestHeadlines()`
- 输出点：`drainTrendingSignals()` 在 `runCorrelationAnalysis()` 合并展示

### 核心算法

1. **窗口**

- 滚动窗口：2 小时
- 基线窗口：7 天
- 基线刷新：1 小时

2. **触发条件**

- `recentCount >= minSpikeCount`（默认 5）
- 且 `recentCount > baseline * spikeMultiplier`（默认 3x）  
  无基线时走冷启动阈值（`recentCount >= minSpikeCount`）
- 去重源数至少 2（`MIN_SPIKE_SOURCE_COUNT`）
- 同 term 冷却 30 分钟

3. **term 提取**

- tokenize
- regex 实体：CVE/APT/FIN、领导人名单
- 可选 ML NER（PER/ORG/LOC/MISC，置信>=0.75）
- 大规模 suppressed terms 过滤 + 用户自定义屏蔽词

4. **信号输出**

- 类型：`keyword_spike`
- 可选自动摘要（每小时最多 5 次）
- confidence 随 multiplier/cold-start 规则计算

### 复现关键

要保留三件事：

1. 2h vs 7d 的双窗口
2. source diversity 约束（否则噪声很高）
3. suppressed terms 机制（否则词云会被“新闻套话”淹没）

---

## 4.6 PizzINT DEFCON

### 入口

- 客户端：`src/services/pizzint.ts` -> `client.getPizzintStatus(include_gdelt=false)`
- 服务端：`server/worldmonitor/intelligence/v1/get-pizzint-status.ts`
- 上游：`https://www.pizzint.watch/api/dashboard-data`

### DEFCON 计算逻辑（服务端）

1. 统计：

- `openLocations`
- `activeSpikes`
- `avgPop`（仅 open locations 平均人流）

2. 调整值：

- `adjusted = min(100, avgPop + activeSpikes * 10)`

3. 映射 DEFCON：

- > =85 => 1
- > =70 => 2
- > =50 => 3
- > =25 => 4
- else => 5

### 缓存与降级

- Redis TTL 600s（10 分钟）
- 仅在拿到 pizzint 数据时写缓存
- 客户端 breaker（30 分钟）有 default fallback

---

## 4.7 GDELT 双边紧张指数

该能力与 PizzINT 共用同一个 RPC（`include_gdelt=true`）。

### 上游

- `https://www.pizzint.watch/api/gdelt/batch`
- 参数：
  - `pairs=usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela`
  - `method=gpr`

### 算法

每个 pair：

1. 取最新值 `latest.v` 与上一个值 `prev.v`
2. `change% = ((latest - prev) / prev) * 100`（prev=0 则 0）
3. 趋势：

- `change > 5` => rising
- `change < -5` => falling
- 否则 stable

### 输出

- `id`、`countries`、`label`、`score`、`trend`、`changePercent`

---

## 4.8 Polymarket 领先指标

这部分分两层：

1. **市场抓取层**：`fetchPredictions()` 得到 prediction markets
2. **领先信号层**：相关性引擎产出 `prediction_leads_news`

### 4.8.1 市场抓取层

文件：`src/services/prediction/index.ts`

`polyFetch()` 是四级回退：

1. 浏览器直连 `gamma-api.polymarket.com`（先 probe 能力）
2. Desktop 走 Tauri native TLS
3. `/api/polymarket` 代理到 relay
4. localhost 直连 relay / sebuf fallback

抓取策略：

- 按 tag 批量拉 events（地缘版 vs 科技版 tag 集合）
- 过滤：`event.volume >= 1000`、未过期、非排除主题
- 选每个 event 中成交量最高的 active market
- 不足则补 top markets
- 最终保留：
  - `|yesPrice - 50| > 5` 或 `volume > 50000`
  - 按 volume 排序取 Top 15

### 4.8.2 领先信号层（核心）

文件：`src/services/analysis-core.ts`

`prediction_leads_news` 触发条件：

1. 同一 prediction（按标题前 50 字符 key）相对上一快照价格变化 `shift >= 5`
2. 根据 `TOPIC_MAPPINGS` 找 related topics
3. 相关 topic 的新闻活跃度 `newsActivity < 3`
4. 通过去重 TTL（该类型默认 2 小时）后发信号

信号输出：

- type=`prediction_leads_news`
- description: 市场已动但新闻覆盖低
- confidence: `min(0.9, 0.5 + shift/20)`

这就是你提到的“Polymarket 领先指标”的实现本体。

---

## 5. 统一缓存/降级模式（建议复用）

这个项目几乎每条链路都遵循同一模板：

1. 服务端 Redis TTL（抗上游抖动）
2. 客户端 breaker + persist cache（抗会话抖动）
3. stale fallback（尽量返回“旧但可用”）
4. feature gate（缺 secret 时优雅下线）

建议你复现时统一抽象一个 `ResilientDataSource`：

- `fetcher`
- `cacheKey`
- `ttl`
- `fallbackPolicy`
- `featureToggle`

---

## 6. 复现落地蓝图（按优先级）

## 阶段 A：先打通“可见结果”

1. OpenSky（军机）
2. Unrest（ACLED+GDELT）
3. Cloudflare outages
4. Polymarket 基础拉取

## 阶段 B：补全“情报化能力”

1. Keyword Spike（2h/7d 双窗口）
2. prediction_leads_news
3. PizzINT + GDELT tension pairs

## 阶段 C：补齐“高复杂度流”

1. AIS disruptions + density
2. 军事舰船 AIS 派生识别
3. USNI 合并（可选）

---

## 7. 环境与依赖清单（最小集合）

复现这 8 条链路，建议至少准备：

- `REALTIME_SIGNALS_AIS_BASE_URL`
- `REALTIME_SIGNALS_AIS_SHARED_SECRET`
- `AIS_RELAY_SHARED_SECRET`
- `AIS_RELAY_PORT`
- `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`
- `AISSTREAM_API_KEY`（若要复现 AIS）
- `AISSTREAM_URL`（可选，用于 AIS mock / 回放 / 内网代理）
- `AIS_RELAY_HEALTH_NO_MESSAGES_AFTER_CONNECT_MS` / `AIS_RELAY_HEALTH_STALE_MESSAGES_MS`（可选，用于明确 relay 降级阈值）
- `REALTIME_SIGNALS_ACLED_USERNAME`
- `REALTIME_SIGNALS_ACLED_PASSWORD`
- `REALTIME_SIGNALS_ACLED_CLIENT_ID`
- `CLOUDFLARE_API_TOKEN`
- `WINGBITS_API_KEY`（可选）

无需密钥（公开接口为主）：

- PizzINT dashboard
- PizzINT GDELT batch
- Polymarket gamma（但服务端可能被 Cloudflare JA3 策略限制）

---

## 8. 与原项目保持一致的关键验收项

建议做 8 条对齐验收：

1. OpenSky 军机数量随 10~15 分钟刷新波动，且支持热点聚类
2. AIS 在 hidden tab 时停止请求，恢复后继续
3. Protests 同时出现 ACLED 与 GDELT 源，且有去重
4. Outages 可在 Cloudflare token 缺失时优雅降级为空
5. Keyword Spike 不是单源刷屏，至少 2 源才触发
6. PizzINT DEFCON 阈值与原规则一致
7. GDELT tension trend 在 +/-5% 阈值切换 rising/falling/stable
8. prediction_leads_news 在“价格变动大+新闻低”时触发

---

## 9. 关键代码索引（对照用）

- 军机主链：`worldmonitor/src/services/military-flights.ts`
- 军机代理：`worldmonitor/api/opensky.js`
- AIS 主链：`worldmonitor/src/services/maritime/index.ts`
- AIS 代理：`worldmonitor/api/ais-snapshot.js`
- 军舰识别：`worldmonitor/src/services/military-vessels.ts`
- 抗议聚合：`worldmonitor/server/worldmonitor/unrest/v1/list-unrest-events.ts`
- ACLED 共享缓存：`worldmonitor/server/_shared/acled.ts`
- 互联网中断：`worldmonitor/server/worldmonitor/infrastructure/v1/list-internet-outages.ts`
- 关键词激增：`worldmonitor/src/services/trending-keywords.ts`
- PizzINT + tensions：`worldmonitor/server/worldmonitor/intelligence/v1/get-pizzint-status.ts`
- Polymarket 抓取：`worldmonitor/src/services/prediction/index.ts`
- 领先信号算法：`worldmonitor/src/services/analysis-core.ts`
- 前端编排入口：`worldmonitor/src/app/data-loader.ts`
- 刷新调度：`worldmonitor/src/App.ts`, `worldmonitor/src/app/refresh-scheduler.ts`

---

## 10. 结论（复现策略一句话）

先把“多源采集 + 缓存降级 + 前端编排”复刻出来，再叠加“关键词激增 + prediction_leads_news”这类二次信号；AIS 检测算法本体可后置，因为当前仓库主要提供的是消费协议与聚合逻辑。

---

## 11. 基于当前仓库状态的复用能力盘点（可直接借力）

你当前仓库并不是“从零开始”，而是已经具备 WorldMonitor 复现所需的大部分底座。核心是把外部实时源接到现有模块，而不是再造一套新系统。

### 11.1 事件归并与聚类底座：`news-events` 已可复用

现状能力（已在线）：

1. `news-events-ingestion.service.ts` 每 5 分钟按 org 增量 ingest 已处理文章。
2. `buildNewsSignalFromProcessedArticle()` 已完成 signal 归一化（topic/entity/sentiment/category）。
3. `NewsEventsService.assignNewsSignalToEvent()` 已支持向量匹配 + overlap 回退 + 分类 gate。
4. 事件分类分布、来源权威度、缓存与 prune 机制已存在。

复用意义：

- 抗议（ACLED+GDELT）与部分地缘信号可以走“事件归并”，直接接入现有 `/events` 页面能力，不需要重建 event clustering。

### 11.2 二次信号分析底座：`situation-monitor` 已接近目标形态

现状能力：

1. `SituationMonitorService.getInsights()` 已有 core/external 分段缓存（45s/300s）。
2. 已有按分钟 topic counts（`CORRELATION_COUNTS_KEY_PREFIX`）+ 10 分钟 momentum 窗口。
3. 已有 `analyzeCorrelations` / `analyzeNarratives` / `predictiveSignals` 输出结构。
4. 已有用户反馈学习回路（boost/block/suppress）与学习版本缓存失效机制。

复用意义：

- 关键词激增、Polymarket 领先指标优先并入这里最稳，不建议另起分析引擎。

### 11.3 告警底座：`alerts` 的 provider 模式可直接扩展

现状能力：

1. `MetricProvider` 接口稳定（`supports + fetch`）。
2. `AlertsService.evaluateRule()` 已包含阈值判断、冷却、投递、订阅推送。
3. `alertEvents` GraphQL Subscription 已被前端 `alerts` 和 `dashboard/live-alerts` 消费。

复用意义：

- 八类信号都可先落到统一告警事件流，再由 dashboard/map 复用，最快形成“可见结果”。

### 11.4 地图与实时流底座：`dashboard` + SSE 已可承接

现状能力：

1. `dashboard-charts.service.ts#getWarMapEvents()` 已将 `alertEvent + processedArticle` 聚合成国家级事件强度。
2. `dashboard.controller.ts@Sse("stream")` 已实现指纹增量推送（`updatedAt + count`）。
3. 前端 `use-dashboard-stream.ts` 已完成自动重连、离线感知、查询缓存写回。

复用意义：

- 只要外部信号能形成带 `countryCode` 的 alert context，就能直接进入现有 war-map 聚合链路。

### 11.5 WebSocket 实时分发底座：`newsnow` 可复用但需一处优化

现状能力：

1. `newsnow.gateway.ts` 已具备 token 鉴权、限流、会话管理。
2. `newsnow-realtime.dispatcher.ts` 已支持内存 listener 发布。
3. 前端 `use-newsnow-stream.ts` 已可消费 `newsnow:update` 并驱动 UI。

建议优化：

- 当前 `broadcast()` 使用 `this.server.emit(...)` 为全局广播。若复用到多租户实时信号，建议改为按 `org room` 定向广播（`UserSessionManager.emitToOrg`）。

---

## 12. 八条信号到当前仓库的“最小接入点”映射

| WorldMonitor 信号        | 当前仓库最小接入点（API）                                                                 | 优先复用模块                        | UI 承接位                           | 实施优先级 |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ---------- |
| 军事飞行（OpenSky）      | 新增 ingest provider（定时拉取 + normalize），写入告警上下文 `countryCode/lat/lng`        | `alerts` + `dashboard war-map`      | `/dashboard` + `/alerts`            | P0         |
| 船舶（AIS）              | 新增 ingest provider（disruptions/density/军事舰船），同样先走告警事件流                  | `alerts` + `dashboard war-map`      | `/dashboard` + `/alerts`            | P0         |
| 抗议（ACLED+GDELT）      | provider 拉取后分两路：告警流 + `NewsEventsService.assignNewsSignalToEvent`（事件归并）   | `news-events` + `alerts`            | `/events` + `/dashboard`            | P0         |
| 互联网中断（Cloudflare） | provider 拉取 outage 注释并映射 severity，直接落告警流                                    | `alerts` + `dashboard war-map`      | `/dashboard` + `/alerts`            | P0         |
| 关键词激增               | 在 `situation-monitor/analysis` 增加 keyword spike 分析器（复用已有 topicCount/momentum） | `situation-monitor`                 | `/situation-monitor`                | P1         |
| PizzINT DEFCON           | 作为外部指数接入（类似 external section），并映射为可订阅告警指标                         | `situation-monitor` + `alerts`      | `/situation-monitor` + `/alerts`    | P1         |
| GDELT 双边紧张指数       | 以 pair 维度写入信号，接入 `predictiveSignals` 或独立 tensions 面板                       | `situation-monitor` + `alerts`      | `/situation-monitor` + `/dashboard` | P1         |
| Polymarket 领先指标      | 先拉市场数据，再在 `situation-monitor` 内做“价格变化 vs 新闻活跃度”比较                   | `situation-monitor` + `news-events` | `/situation-monitor`                | P1         |

关键原则：

1. 能走 `alerts` 的先走 `alerts`，最快形成统一实时主线。
2. 需要事件语义（timeline/聚类）的信号，再接 `news-events`。
3. 二次推理信号（keyword spike / prediction leads）优先并入 `situation-monitor`。

---

## 13. 优化后的实施路线（按阶段 + 可并行）

### 阶段 0（1-3 天）：先统一契约与接入框架

目标：避免 8 条链路“各写各的”。

任务：

1. 定义统一 `RealtimeSignal` 契约（建议放 `packages/utils/src`，供 api/web 共享）。
2. 新建 `realtime-signals` 模块（scheduler + provider registry + normalize + dedupe）。
3. 约定统一 cache key、dedupe key、org 维度隔离规则。
4. 加 feature flags（逐源开关）和“未配置密钥时优雅降级”。

### 阶段 1（1-2 周）：先复现 4 条基础源，打通可视化闭环

范围：OpenSky、AIS、ACLED+GDELT、Cloudflare。

任务：

1. Provider 拉取 + normalize + 落告警流。
2. `dashboard/war-map` 直接复用已有聚合（读取 alert context 国家信息）。
3. ACLED+GDELT 额外接 `news-events`，让 `/events` 能展示抗议事件聚类。

验收口径：

1. 告警流中可看到 4 类信号；
2. 地图热点随信号刷新变化；
3. 任一上游失败不影响其它源输出（降级可见）。

### 阶段 2（1 周）：接二次分析信号

范围：关键词激增、Polymarket 领先指标。

任务：

1. 在 `situation-monitor/analysis` 新增 spike 与 leads 计算。
2. 复用已有 `topicCounts + previousCounts` 做窗口比较，不新建统计管线。
3. 输出并接入现有 `correlation/predictiveSignals` 展示结构。

### 阶段 3（1 周）：补全指数类与稳定性

范围：PizzINT DEFCON、GDELT tensions + 全链路稳定性优化。

任务：

1. 指数类信号接 external/alerts。
2. 推送层从“全量广播”升级到“org 定向广播”。
3. 增加 freshness/延迟/失败率观测与回归测试。

### 并行拆包建议（可同时推进）

1. 数据接入组：8 个 provider + normalize + 缓存。
2. 分析组：keyword spike / prediction leads / tension scoring。
3. 告警与实时组：alerts provider + SSE/WS 分发。
4. 前端组：dashboard/situation-monitor/alerts 视图整合。

---

## 14. 技术优化建议（基于现状做最小增量）

### 14.1 统一信号契约（避免后续维护失控）

建议字段（最小集合）：

- `signalType`, `source`, `orgId`
- `occurredAt`, `ingestedAt`
- `severity`, `confidence`
- `countryCode`, `location(lat/lng)`
- `metrics`（数值指标）
- `metadata`（原始扩展）
- `dedupeKey`

建议把 `dedupeKey` 标准化为：

`{signalType}:{source}:{entity_or_geo}:{time_bucket}`

### 14.2 缓存与降级统一模板（复用 `CacheService.wrap`）

推荐分层：

1. L1 内存短 TTL（10-30s）防抖；
2. L2 Redis TTL（按源特性 2-30min）；
3. stale fallback（返回上次成功快照）；
4. breaker（连续失败阈值 + 冷却时间）。

多租户要求：

- cache key 必带 `orgId`，例如：`realtime-signals:{orgId}:{source}:{window}`。

### 14.3 实时推送优化：SSE + WS 双通道协同

1. dashboard 数据继续走 SSE（已有指纹增量策略，成本低）。
2. 高频轻量通知（如 newItemsCount）走 WS。
3. WS 广播建议从全局 `server.emit` 改为 `emitToOrg`，避免跨 org 泄漏风险。

### 14.4 告警体系复用策略

优先方案（低成本）：

1. 先复用现有 `AlertMetricProvider` 体系，新增 realtime signal provider；
2. 规则用统一 slug 命名：`realtime.{source}.{metric}`；
3. context 固定包含 `countryCode/source/signalType/dedupeKey`。

进阶方案（语义更清晰）：

1. 在 Prisma `AlertMetricProvider` 增加新枚举（如 `realtime_signal`）；
2. 更新 GraphQL 枚举与前端筛选项。

### 14.5 观测与质量控制

建议至少落四类指标：

1. `pull_success_rate` / `pull_latency_ms`
2. `signal_freshness_seconds`（当前时间 - 最新信号时间）
3. `dedupe_hit_rate`
4. `fallback_served_rate`（走 stale 的比例）

并将高风险阈值接入现有 `alerts` 规则体系（用系统内部告警监控你的信号系统本身）。

---

## 15. 最小变更清单（先复用再扩展）

以下清单按“先拿结果、后做重构”排序：

1. 新增 `apps/api/src/modules/realtime-signals/*`（provider + scheduler + normalize + sink）。
2. 在 `apps/api/src/app.module.ts` 注册 `RealtimeSignalsModule`。
3. 在 `apps/api/src/modules/config/env.schema.ts` 与 `config.service.ts` 增加 8 类数据源配置与开关。
4. 在 `apps/api/src/modules/alerts/providers` 新增 realtime signal metric provider，并在 `alerts.module.ts` 注入。
5. （可选）Prisma 新增 `AlertMetricProvider` 枚举值并生成迁移；若要极简首版，可先复用已有 provider 类型 + slug 约定。
6. 在 `apps/api/src/modules/situation-monitor/analysis/*` 增加 keyword spike 与 prediction leads 分析器，挂入 `getInsights()` 的 core 分支。
7. 在 `apps/api/src/modules/news-events` 增加外部信号到事件的轻量适配入口（重点用于 protests）。
8. 在 `apps/web/app/(app)/situation-monitor` 与 `apps/web/app/(app)/dashboard` 增加对应面板与筛选，不新建独立页面。
9. 在 `apps/web/app/(app)/alerts` 增加新信号类型展示与过滤项。
10. 补齐测试：provider 单测、规则触发回归、SSE/WS 集成测试、跨 org 隔离测试。

一句话执行策略：

先把 8 条信号统一进“同一契约 + 同一告警流 + 同一地图流”，跑通后再做事件深度融合与模型增强。
