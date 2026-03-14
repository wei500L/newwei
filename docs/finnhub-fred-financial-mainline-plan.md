# Finnhub / FRED 并入金融数据主线规划

更新日期：2026-03-14

## 背景与目标

当前仓库里已经存在一条成熟的“金融数据主线”：`EconomicDataItem` / `EconomicDataPoint` / `EconomicDataFetchConfig` 负责数据目录、持久化、调度、GraphQL 查询、Dashboard 图表和告警复用。该主线当前主要由 `Akshare` 驱动。

与此同时，`Finnhub` 和 `FRED` 只存在于 `SituationMonitorExternalService`，以短 TTL 缓存的外部快照形式服务 `situation-monitor` 页面，不进入主线数据模型，也不能被 `economic data` GraphQL、告警、历史图表、预设刷新、统一权限模型复用。

本规划的目标是：

- 将 `Finnhub` / `FRED` 数值型数据纳入现有金融数据主线，而不是继续作为 `situation-monitor` 专属旁路。
- 保持现有 `EconomicData*` 查询、Dashboard 图表、告警 provider、刷新预设机制继续作为统一消费面。
- 让 `situation-monitor` 改为消费主线数据快照，而不是直接依赖独占的第三方拉取逻辑。
- 保留 `Finnhub` / `FRED` “可选”属性：没有 API key 时不阻塞主线其它数据源。

不在本轮规划强推的范围：

- `Fed RSS` 新闻本身并不属于数值型金融主线，可继续保留在 `situation-monitor` 专属链路。
- `CoinGecko` 当前也在 `SituationMonitorExternalService` 中，但本次聚焦用户指定的 `Finnhub` / `FRED`。

## 当前架构理解

### 1. 现有金融数据主线

数据模型与持久化：

- `EconomicCategory`、`EconomicDataItem`、`EconomicDataPoint`、`EconomicDataFetchConfig` 已是独立主线模型，定义在 `packages/db/prisma/schema.prisma`。
- `EconomicDataItem` 保存 slug、显示名、源函数、endpoint、默认频率、metadata 等目录元数据。
- `EconomicDataPoint` 保存标准化后的时序点，唯一键是 `(itemId, recordedAt, sourceField)`。
- `EconomicDataFetchConfig` 保存采集频率、cron、启停、最后运行状态。

关键文件：

- `packages/db/prisma/schema.prisma:1021`
- `packages/db/prisma/schema.prisma:1031`
- `packages/db/prisma/schema.prisma:1066`
- `packages/db/prisma/schema.prisma:1082`

Akshare 入库主链路：

- `AKSHARE_DATA_DEFINITIONS` 是当前目录种子源，定义 provider 参数、parser、分类、默认频率等。
- `AkshareService.ensureCatalog()` 将 definitions 同步到 `EconomicDataItem` / `EconomicCategory` / `EconomicDataFetchConfig`。
- `AkshareQueueProcessor` 通过 BullMQ 调 `AkshareService.fetchAndPersist()`。
- `fetchAndPersist()` 负责请求上游、保存原始 payload 到 Mongo 的 `AkshareResponseModel`、解析数据点并 upsert 到 MySQL。

关键文件：

- `apps/api/src/modules/akshare/akshare.definitions.ts`
- `apps/api/src/modules/akshare/akshare.service.ts:287`
- `apps/api/src/modules/akshare/akshare.service.ts:552`
- `apps/api/src/modules/akshare/akshare.service.ts:824`
- `apps/api/src/modules/akshare/akshare.processor.ts:24`
- `packages/mongo/src/models/akshare-response.ts:3`

统一读取与消费面：

- GraphQL `EconomicDataResolver` 通过 `AkshareService.getDataByCategory()` 暴露 `getEconomicData` / `getEconomicDataWithInsights` / `getEconomicDataPaginated` / `economicDataFetchConfigs` / `triggerEconomicDataRefreshPreset`。
- Web 端 `useEconomicData()`、Dashboard widgets、Drilldown chart 都走这条 GraphQL 主线。
- Dashboard candlestick 直接从 `EconomicDataPoint` 读 OHLC。
- 告警 `EconomicDataMetricProvider` 直接从 `EconomicDataPoint` 取最新值与变化。

关键文件：

- `apps/api/src/graphql/resolvers/economic-data.resolver.ts:166`
- `apps/web/hooks/useEconomicData.ts:190`
- `apps/web/app/(app)/dashboard/charts/widget-renderer.tsx:21`
- `apps/web/app/(app)/dashboard/drilldown-chart.tsx:54`
- `apps/api/src/modules/dashboard/dashboard-charts.service.ts:4417`
- `apps/api/src/modules/alerts/providers/economic-data-metric.provider.ts:18`

刷新预设：

- 预设与主线分类是统一的，依赖 `EconomicCategory.key`，例如 `key-monitor`、`economic-alert`、`macro-us` 等。
- 当前所有手动刷新和轮询状态都复用这套预设机制。

关键文件：

- `packages/utils/src/economic-refresh-presets.ts:1`
- `apps/api/src/modules/akshare/akshare.service.ts:688`
- `apps/web/app/(app)/settings/system/system-settings-content.tsx:1388`

### 2. Finnhub / FRED 当前链路

当前实现位置：

- `SituationMonitorExternalService` 内同时负责 GDELT、CoinGecko、Finnhub、FRED、Fed RSS。
- `getMarketsSnapshot()` 在有 `finnhubApiKey` 时拉市场快照；没有 key 时直接返回 `hasFinnhubApiKey: false` 的空结构。
- `getFedSnapshot()` 在有 `fredApiKey` 时拉 FRED 指标，没有 key 时只保留 Fed RSS 新闻。
- 所有结果只走 `CacheService.wrap()` 做 Redis/缓存层短期缓存，不落 `EconomicDataPoint`。

关键文件：

- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:154`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:244`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:330`

Finnhub 当前拉取内容：

- 指数代理：`^DJI`, `^GSPC`, `^IXIC`, `^RUT`
- 行业 ETF：`XLK`, `XLF`, `XLE`, `XLV`, `XLY`, `XLI`, `XLP`, `XLU`, `XLB`, `XLRE`, `XLC`, `SMH`
- 商品代理：`^VIX`, `GC=F`, `CL=F`, `NG=F`, `SI=F`, `HG=F`
- 实际请求时又会把指数/商品映射为 ETF proxy：`DIA`, `SPY`, `QQQ`, `IWM`, `GLD`, `USO`, `UNG`, `SLV`, `CPER`

关键文件：

- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:73`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:80`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:95`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:110`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:117`

FRED 当前拉取内容：

- `FEDFUNDS`
- `CPIAUCSL`，并在服务端计算同比
- `DGS10`
- `WALCL`

关键文件：

- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:366`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:427`
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts:462`

返回形态：

- `SituationMonitorMarketsSnapshot`
- `SituationMonitorFedSnapshot`
- 这两种返回结构是面向页面卡片的 snapshot 结构，不是 `EconomicDataPoint`。

关键文件：

- `apps/api/src/modules/situation-monitor/situation-monitor.types.ts:54`
- `apps/api/src/modules/situation-monitor/situation-monitor.types.ts:118`

REST / UI 消费面：

- `SituationMonitorController` 提供 `/situation-monitor/insights`。
- Web 页面先请求 `sections=core`，再单独请求 `sections=external`，然后把 `crypto` / `markets` / `fed` merge 到页面状态。
- `markets`、`crypto`、`fed` 三块 UI 只存在于 `situation-monitor-content.tsx`，没有进入 GraphQL `economic data` 面。

关键文件：

- `apps/api/src/modules/situation-monitor/situation-monitor.controller.ts:135`
- `apps/api/src/modules/situation-monitor/situation-monitor.service.ts:263`
- `apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx:1069`
- `apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx:3478`
- `apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx:3684`

配置与持久化：

- `finnhubApiKey` / `fredApiKey` 通过 `SituationMonitorSettingsService` 读取，运行时从 `getExternalApiRuntimeConfig()` 提供。
- 密钥本身会通过 `SystemSetting` 持久化；但第三方返回的 snapshot 数据不会持久化到 DB。

关键文件：

- `apps/api/src/modules/system-settings/situation-monitor-settings.service.ts:223`
- `apps/api/src/modules/system-settings/situation-monitor-settings.service.ts:341`
- `apps/api/src/modules/system-settings/situation-monitor-settings.service.ts:788`

## 现状问题

1. 同一类金融数据存在两套体系

- `Akshare` 数据进入主线，可历史化、可告警、可 GraphQL 复用。
- `Finnhub/FRED` 数据停留在 `situation-monitor` 临时快照，无法复用。

2. `situation-monitor` 专属快照无法进入统一图表与告警

- 不能直接被 `getEconomicData` 查询。
- 不能直接被 `EconomicDataMetricProvider` 告警使用。
- 不能进入预设刷新和主线状态页。

3. 同一市场概念出现重复来源但没有统一标准

- 例如标普/纳指/道指，主线中已经有 `Akshare` 的 `index_global_hist_em` / `index_global_spot_em` / `futures_global_spot_em`，而 `SituationMonitorExternalService` 又维护了一套 `Finnhub` proxy 逻辑。
- 这些来源目前没有 canonical item、fallback 策略、质量优先级或元数据标记。

4. 配置被错误地限定在 `Situation Monitor` 上下文

- `Finnhub/FRED` key 虽然技术上是系统设置，但语义上仍被包装成态势监控专属配置。
- 页面提示和调用链也让人误以为这些 key 只能服务 `situation-monitor`。

5. 当前外部快照没有统一原始响应审计

- `Akshare` 原始 payload 会写入 `AkshareResponseModel`。
- `Finnhub/FRED` 当前只有缓存，没有类似的 provider response archive。

6. optional provider 不能沿用当前 catalog 默认启用逻辑

- 当前 catalog 同步会为新 item 自动创建 `EconomicDataFetchConfig(isEnabled=true)`。
- 这对 `Akshare` 适用，但对 `Finnhub/FRED` 这种依赖可选 key 的 provider 不适用。
- 如果直接照搬：
  - 没有 key 时 worker 会持续失败；
  - 运维会看到大量“系统异常”，但真实含义只是“provider 未配置”；
  - 新 provider item 会在用户未明确启用前就进入调度。

7. FRED 派生指标和多字段 item 与现有告警语义不完全兼容

- 当前 `EconomicDataMetricProvider` 只按 `slug` 读取最新点，不按 `sourceField` 精确指定目标序列。
- `FRED` 当前页面逻辑里的 `CPI YoY`、`WALCL money printer` 是服务端派生值，不在主线 catalog 中。
- 如果把 `price`、`changePercent`、`delta` 这类多字段混放进同一个 item，现有告警无法稳定表达“监控哪个字段”。

## 目标架构

## 总体原则

- 保留现有 `EconomicData*` MySQL 主线作为唯一的数值型金融数据 canonical store。
- `Finnhub` / `FRED` 进入主线后，不直接让页面独占调用第三方，而是先入主线，再由页面读取主线。
- `Situation Monitor` 的 `markets` / `fed` 面板改为主线只读视图；`Fed RSS` 新闻继续留在专用链路。
- 保持可选 key 行为：没有 key 时，相关 item 不报系统错误，只进入“未配置/跳过/降级”状态。

## 推荐方案：在主线中引入 Provider Registry，而不是继续把多 provider 硬塞进 Akshare 语义

推荐采用“增量抽象”而不是一次性大改：

### A. 复用现有主线存储与查询面

不新建第二套表，继续使用：

- `EconomicDataItem`
- `EconomicDataPoint`
- `EconomicDataFetchConfig`
- 现有 GraphQL `economic data` 查询和 Dashboard / Alert 消费面

理由：

- 当前主线已经覆盖目录、调度、历史点、分页、洞察、告警。
- 用户的诉求是“纳入主线”，不是再造一套旁路。

### B. 在采集侧引入 provider abstraction

建议新增统一 provider 接口，例如：

```ts
interface FinancialDataProvider {
  kind: 'akshare' | 'finnhub' | 'fred';
  execute(definition: FinancialDataItemDefinition): Promise<ProviderFetchResult>;
  isConfigured(): Promise<boolean>;
}
```

并通过 registry 管理：

- `AkshareProvider`
- `FinnhubProvider`
- `FredProvider`

这里不要求立刻大面积重命名现有模块，但建议把“provider 分发”从 `AkshareService.executeRequest()` 中抽出来。短期可以让 `AkshareService` 变成 façade，长期再演化为更中性的 `EconomicDataIngestionService`。

### C. 引入 provider-aware definition，但保留现有 item catalog 机制

现有 `AKSHARE_DATA_DEFINITIONS` 的核心价值不是“Akshare”本身，而是：

- item slug
- 类别
- 默认频率
- parser
- 默认参数
- filter
- 文档/元数据

建议新建更泛化的定义层，例如 `financial-data.definitions.ts`，字段至少包括：

- `provider: 'akshare' | 'finnhub' | 'fred'`
- `providerFunction` 或 `providerSeriesId`
- `endpoint` / `symbol` / `seriesId`
- `categories`
- `defaultFrequency`
- `parser`
- `requiresSecret?: 'finnhubApiKey' | 'fredApiKey'`
- `fallbackPolicy?`
- `dataViz` / `mainlineUsage` metadata

其中：

- 现有 Akshare 定义整体迁移或被 adapter 包裹。
- 新增 Finnhub / FRED item 直接进入相同 catalog 同步流程。

## 需要纳入主线的具体数据范围

### 1. Finnhub: 纳入主线的对象

不建议直接把 `SituationMonitorMarketsSnapshot` 原样塞进 DB；应拆成主线 item。

建议首批纳入：

- 指数 / proxy ETF
  - `SPY` 代理 `S&P 500`
  - `QQQ` 代理 `NASDAQ 100/IXIC`
  - `DIA` 代理 `Dow Jones`
  - `IWM` 代理 `Russell 2000`
- 行业 ETF
  - `XLK`, `XLF`, `XLE`, `XLV`, `XLY`, `XLI`, `XLP`, `XLU`, `XLB`, `XLRE`, `XLC`, `SMH`
- 商品 proxy
  - `VIXY`, `GLD`, `USO`, `UNG`, `SLV`, `CPER`

### 2. FRED: 纳入主线的对象

建议首批新增独立 canonical item，而不是硬套进现有 Akshare 宏观 slug：

- `FEDFUNDS` -> `us_fed_funds_rate`
- `DGS10` -> `us_10y_treasury_yield_fred`
- `CPIAUCSL` 计算同比 -> `us_cpi_yoy_fred`
- `WALCL` -> `fed_balance_sheet_total_assets`
- `WALCL` 派生变化/扩张强度 -> `fed_balance_sheet_change`, `fed_money_printer_percent_of_max`

原因：

- 当前 Akshare 的 `macro_usa_*` 主要是“事件/发布型”数据，带 `今值/预测值/前值` 语义。
- FRED 则是“连续观测型”时间序列，语义不同，不应强行覆盖旧 slug。
- `SituationMonitor` 目前依赖的并不只是原始 FRED 序列，还包括派生后的同比/资产负债表压力指标；如果这些值不进入主线，`Dashboard` / `Alert` / `GraphQL` 就无法复用。

### 3. 当前已有 Akshare 主线 item 的处理原则

对于已经存在的 Akshare mainline item：

- 标普 / 纳指 / 道指 / VIX / 金银油铜等，优先继续保持现有 canonical slug 不变。
- 若新增 Finnhub 同类来源，默认不要生成重复 slug；要么：
  - 作为 fallback provider 挂到现有 canonical item 上；要么
  - 作为新的 `*_proxy` / `*_finnhub` 技术项，仅供内部比对/降级，不直接暴露给默认大盘视图。

推荐：

- 对“用户可见主指标”采用 canonical slug + fallback provider 模式。
- 对“行业 ETF / FRED 新指标”采用新增 slug 模式。

## 配置与权限规划

### 1. 配置归属调整

当前 `finnhubApiKey` / `fredApiKey` 归属在 `SituationMonitorSettingsService`。

建议目标：

- 抽出共享配置服务，例如 `FinancialDataProviderSettingsService` 或 `EconomicDataProviderSettingsService`。
- 由该服务统一暴露：
  - `getFinnhubApiKey()`
  - `getFredApiKey()`
  - `getProviderRuntimeConfig()`
- `SituationMonitorSettingsService` 在过渡期可以代理到这个共享服务，保持 UI 兼容。

### 2. 迁移策略

建议分两步：

- 第一步：保留存储 key 不变，先把 runtime accessor 从 `SituationMonitorSettingsService` 抽成共享服务，底层仍读同一份 `SystemSetting` 数据。
- 第二步：若未来要从“态势监控设置”UI 中剥离，再迁移到更通用的系统设置入口。

这样可避免一开始做配置数据迁移。

### 3. 启停与缺 key 行为

建议定义 item 级别的 provider secret requirement：

- `requiresSecret: 'finnhubApiKey'`
- `requiresSecret: 'fredApiKey'`

调度执行时：

- 若缺 key，不抛全局异常。
- 只更新对应 `EconomicDataFetchConfig.lastStatus = failed/skipped` 与 `lastError = missing_api_key`。
- GraphQL 配置页可直观看到 item 未配置。
- `Finnhub/FRED` 首批 item 默认不应自动启用；需要 definition 级 `defaultEnabled` 或 provider-aware 默认禁用策略。

## 读取面改造规划

### 1. Situation Monitor 改为读取主线数据

当前 `situation-monitor-content.tsx` 通过 `/situation-monitor/insights?sections=external` 单独拉 `markets` / `fed` 快照。

目标改造：

- `markets` panel 不再依赖 `SituationMonitorExternalService.getMarketsSnapshot()` 直接访问 Finnhub。
- `fed` 指标面板不再依赖 `SituationMonitorExternalService.getFedSnapshot()` 中的 FRED 数值部分。
- 改由新的主线只读聚合服务从 `EconomicDataPoint` 读取最新数据并组装 snapshot view model。

建议新增：

- `EconomicDataSnapshotService` 或 `FinancialMainlineSnapshotService`

职责：

- 从 canonical slug 集合读取最新点
- 转换为 `SituationMonitorMarketsSnapshot`
- 转换为 `SituationMonitorFedSnapshot` 的 `indicators` 与 `moneyPrinter`
- 将 `hasFinnhubApiKey` / `hasFredApiKey` 仍作为 UI 辅助字段返回

注意：

- `fed.news` 仍由 Fed RSS 保留在 `SituationMonitorExternalService.fetchFedNews()`，不必强行入主线。

### 2. Dashboard / Alert 自动获益

一旦 Finnhub / FRED 数据写入主线：

- GraphQL `getEconomicData` 可直接查询这些新 item/category。
- Dashboard widgets / drilldown 无需为新 provider 单独造接口。
- `EconomicDataMetricProvider` 可直接对这些 slug 建告警。

### 3. 统一 freshness / fallback

建议在主线层补充 freshness 规则：

- 记录 provider 级更新时间与最近成功抓取时间。
- 当 canonical item 配置了多个来源时，按优先级和 freshness 选当前可用数据。

例如：

- `global_spx_index_spot`
  - primary: `akshare:index_global_spot_em`
  - fallback: `finnhub:SPY`

## 数据模型与元数据建议

### 最小改动方案

尽量不先改 Prisma schema，而把 provider 信息放进 `EconomicDataItem.metadata`：

- `providerKind`
- `providerConfig`
- `requiresSecret`
- `fallbackProviders`
- `mainlineRole`
- `snapshotGroup`
- `snapshotOrder`

优点：

- 不需要先做 DB migration。
- 与当前 `Akshare` metadata 兼容。

缺点：

- provider 信息不易被 SQL 直接筛选。

### 推荐中期方案

在稳定后加显式字段：

- `providerKind`
- `providerIdentity`（symbol/seriesId/function）
- 可选 `providerPriority`

短期先走 metadata，避免本轮规划落地时迁移成本过高。

## 原始响应与可观测性

当前 `Akshare` 会把原始 payload 存进 Mongo 的 `AkshareResponseModel`，但模型是 provider-specific。

建议：

- 不要把 Finnhub/FRED 原始 payload 硬写进 `AkshareResponseModel`。
- 新建一个通用的 raw response archive，例如：
  - `EconomicProviderResponseModel`
  - 字段：`dataItemId`, `providerKind`, `providerIdentity`, `requestParams`, `payload`, `fetchedAt`, `status`

如果想控制首期复杂度，也可以：

- Phase 1 先只写 MySQL 主点，不做原始 payload 归档；
- Phase 2 再补 raw archive。

## 分阶段实施计划

### Phase 1: 共享 provider 配置与 provider abstraction

目标：不改前端消费，先把拉数能力从 `SituationMonitorExternalService` 中拆成可复用 provider。

任务：

1. 提取共享设置访问服务，统一暴露 `finnhubApiKey` / `fredApiKey`
2. 定义 `FinancialDataProvider` 接口与 registry
3. 将 `Akshare` provider 接入 registry
4. 将 `Finnhub` provider / `Fred` provider 从 `SituationMonitorExternalService` 中拆出
5. 保留 `SituationMonitorExternalService` 作为调用方，但不再直接持有 provider 细节

产出：

- provider 层可独立被金融主线与 `situation-monitor` 复用

### Phase 2: 将 Finnhub / FRED item 注册进主线 catalog

目标：让 `Finnhub/FRED` 数据第一次进入 `EconomicDataItem` / `EconomicDataPoint` 主线。

任务：

1. 新建泛化 definitions 文件或为现有 definitions 增加 provider metadata
2. 首批加入：
   - FRED 4 条指标
   - Finnhub 4 个指数 proxy + 主要 sector ETF + commodity proxy
3. 为 definition 增加 `defaultEnabled`
4. 在 catalog sync 中生成对应 `EconomicDataItem` / `EconomicDataFetchConfig`
5. `Finnhub/FRED` 首批 item 默认 `defaultEnabled=false`
6. 让 BullMQ 只调度已启用 item
7. 缺 key 时把 status 打回 fetch config，而不是中断队列

产出：

- `getEconomicData` 可查询到新增 item 的历史点
- GraphQL fetch config 页面能看到这些 item 的运行状态

### Phase 3: Situation Monitor 改为主线只读视图

目标：去掉 `situation-monitor` 对 Finnhub/FRED 数值快照的独占依赖。

任务：

1. 新增 `EconomicDataSnapshotService`，从 `EconomicDataPoint` 组装 markets/fed 面板数据
2. `SituationMonitorService.getInsights(section=external)` 改为：
   - `crypto`: 暂时保持现状
   - `markets`: 读主线快照服务
   - `fed.indicators` / `fed.moneyPrinter`: 读主线快照服务
   - `fed.news`: 仍走 RSS
3. 保持 REST 响应 shape 不变，降低 UI 改动面

产出：

- 页面仍是 `/situation-monitor/insights`
- 但其 markets/fed 数值部分已经不是页面专属旁路

### Phase 4: UI 和运维入口去“页面专属”语义

目标：让用户理解 `Finnhub/FRED` 是金融主线 provider，而不是 `situation-monitor` 附件。

任务：

1. 在系统设置中把 `Finnhub/FRED` 文案调整为“共享金融数据 provider”
2. 在经济数据配置页展示 provider 来源和缺 key 状态
3. 允许对 Finnhub/FRED item 使用现有刷新预设或单项手动刷新
4. 必要时在 Dashboard / Finance 页面补充这些新 item 的可视化入口

### Phase 5: 清理与统一命名

目标：降低“Akshare 其实管理全主线”的命名负担。

候选动作：

- `AkshareService` -> `EconomicDataIngestionService`
- `AKSHARE_DATA_DEFINITIONS` -> `ECONOMIC_DATA_SOURCE_DEFINITIONS`
- `AkshareResponseModel` -> 通用 raw provider response model

此阶段不是必须阻塞项，但长期应做。

## 推荐的首批 item 映射

### FRED 新增 canonical item

- `us_fed_funds_rate`
- `us_cpi_yoy_fred`
- `us_10y_treasury_yield_fred`
- `fed_balance_sheet_total_assets`
- `fed_balance_sheet_change`
- `fed_money_printer_percent_of_max`

建议分类：

- `macro-us`
- `economic-alert`
- `key-monitor`（Fed Funds / 10Y / WALCL 可考虑）

补充建议：

- 原始 `CPIAUCSL` level 也建议保留一个内部 item，便于后续重算同比逻辑。
- 对会被 Dashboard、Alert、`SituationMonitor` 多处复用的派生值，不要继续锁在页面 service；应进入主线能力域。

### Finnhub 新增 canonical item

建议优先新增而不是直接覆盖现有 Akshare slug 的对象：

- 行业 ETF：`xlk_sector_etf`, `xlf_sector_etf`, `xle_sector_etf`, `xlv_sector_etf`, `smh_sector_etf` 等
- 商品 proxy ETF：`gld_proxy_etf`, `uso_proxy_etf`, `ung_proxy_etf`, `slv_proxy_etf`, `cper_proxy_etf`
- 如要纳入指数代理，可先作为 fallback-only internal item：
  - `spy_sp500_proxy_internal`
  - `qqq_nasdaq_proxy_internal`
  - `dia_dow_proxy_internal`
  - `iwm_russell2000_proxy_internal`

## 风险与注意事项

1. 语义重复风险

- Akshare 已有 `SPX` / `NDX` / `DJIA` / 美债 / 商品相关 item。
- Finnhub/FRED 引入时若不区分 canonical 与 fallback，会产生重复图表和重复告警源。

2. 频率与配额风险

- `Finnhub` 市场快照当前 TTL 是 60 秒。
- 若直接把主线采集频率设置为 `realtime` 30 秒，需要重新评估 API quota。
- 建议首批默认：`hourly` 或 `5-15 min` 等保守频率；若 schema 只允许现有枚举，则先用 `hourly` / `realtime`+provider-side throttle 的组合。

3. FRED 指标的派生计算责任

- `CPIAUCSL` 当前是在服务里计算同比。
- 需要决定：
  - 在 provider 层直接产出 `今值`
  - 还是存 raw CPI level，再由派生任务计算同比 item

建议首期把派生值正式纳入主线，但不要作为“直接抓取项”请求第三方：

- 原始 FRED 序列照常抓取并落库；
- 再通过 provider-side 或 post-fetch materializer 产出 canonical derived item；
- 这样 `Dashboard`、`Alert`、GraphQL 和 `SituationMonitor` 都能统一复用。

4. optional provider 默认启用风险

- `Finnhub/FRED` 进入 catalog 后，如果仍像 Akshare 一样自动 `isEnabled=true`，调度会在未配置 key 时持续失败。
- 这不是数据质量问题，而是 provider 可选性的建模问题。

建议：

- definition 增加 `defaultEnabled`
- optional provider 首批默认禁用
- 管理页显式展示“未配置 key / 未启用”与“抓取失败”的区别

5. 多字段 item 与告警兼容风险

- 现有告警规则只按 `slug` 取最新点。
- 如果一个 item 同时落多个 `sourceField`，告警语义会变得不稳定。

建议：

- Phase 1/2 尽量保证新引入的 provider item 为“单 item 单主字段”
- 对 `CPI YoY`、`money printer` 这类派生值采用 materialized canonical item
- 若后续确有需要，再扩展 alert rule 支持 `slug + sourceField`

6. 历史补数与回填策略

- FRED 支持历史拉取，适合一次性 backfill。
- Finnhub 若只用 quote endpoint，历史回填能力有限。
- 对 Finnhub 项建议先从“最新值 + 主线累积历史”开始，不承诺长历史回填。

7. 页面兼容性

- `situation-monitor` 目前按 `core -> external` 双请求加载。
- 若改成主线读取，REST shape 最好先保持不变，避免 UI 大改。

## 验证计划

实施时至少验证：

1. catalog
- 新 item 是否进入 `EconomicDataItem`
- 分类和 fetch config 是否生成

2. ingestion
- 缺 key 时状态是否为可诊断失败/跳过
- 有 key 时 `EconomicDataPoint` 是否按预期写入

3. GraphQL
- `getEconomicData` 是否能读到 FRED/Finnhub item
- `economicDataFetchConfigs` 是否能看到 provider item 状态

4. dashboard / alerts
- 新 slug 是否可被 Dashboard widget 读取
- `EconomicDataMetricProvider` 是否可对新 slug 建告警

5. situation monitor
- `markets` / `fed` 面板在保留现有 UI 的前提下改为主线来源
- `fed.news` 不受影响

## 建议的落地顺序

按性价比排序，建议：

1. 抽共享 settings accessor，解除 `Finnhub/FRED` 对 `situation-monitor` 语义绑定
2. 做 provider registry
3. 先把 `FRED` 4 条指标入主线
4. 再把 `Finnhub` 行业 ETF / commodity proxy 入主线
5. 最后把 `situation-monitor` markets/fed 改为主线只读视图

这样做的原因：

- `FRED` 语义清晰、历史序列稳定、最容易先打通主线
- `Finnhub` 指数/ETF 与 Akshare 存在概念重叠，应该在有主线框架后再纳入

## 文件级改造范围建议

后续实施大概率涉及：

- `apps/api/src/modules/akshare/akshare.service.ts`
- `apps/api/src/modules/akshare/akshare.processor.ts`
- `apps/api/src/modules/akshare/akshare.definitions.ts` 或新的 provider-agnostic definitions 文件
- `apps/api/src/modules/situation-monitor/external/situation-monitor-external.service.ts`
- `apps/api/src/modules/situation-monitor/situation-monitor.service.ts`
- `apps/api/src/modules/system-settings/situation-monitor-settings.service.ts`
- `apps/api/src/graphql/resolvers/economic-data.resolver.ts`
- `packages/db/prisma/schema.prisma`（若决定显式增加 provider 字段）
- `packages/mongo/src/models/*`（若补通用 raw response archive）
- `apps/web/app/(app)/situation-monitor/situation-monitor-content.tsx`
- `apps/web/app/(app)/settings/system/system-settings-content.tsx`

## 最终建议

建议不要把 `Finnhub/FRED` 继续视为 `situation-monitor` 的“外挂数据源”；应把它们视为现有 `EconomicData` 主线的新增 provider。

在当前代码库里，最务实的路线不是推翻 `Akshare` 主线，而是：

- 复用现有 `EconomicData*` 数据模型和 GraphQL / Dashboard / Alert 消费面
- 将 `Finnhub/FRED` provider 化
- 让 `situation-monitor` 改为主线消费者
- 逐步把命名从 `Akshare-only` 演进到 `provider-agnostic`

这样可以以最小破坏把“页面专属快照”升级为“全项目共享金融主线能力”。
